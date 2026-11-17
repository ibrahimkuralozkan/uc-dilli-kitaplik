import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.mjs';
import fs from 'node:fs';
const actualFetch = globalThis.fetch;
const origin = 'https://kitaplik.example';
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const env = {
  AUTH_ENABLED: 'true', ALLOW_SIGNUP: 'true', SUPABASE_URL: 'https://auth.example', SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
  ASSETS: { fetch: async request => new Response(new URL(request.url).pathname === '/reader.html' ? '<head><!--READER_ACCOUNT--></head><body>reader</body>' : 'public asset') }
};
function req(path, { token, refresh, method = 'GET', data, headers = {} } = {}) {
  return new Request(origin + path, {
    method,
    headers: { ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(token || refresh ? { Cookie: [token && `__Host-reader-access=${token}`, refresh && `__Host-reader-refresh=${refresh}`].filter(Boolean).join('; ') } : {}), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
}
function mockProvider({ status = 'active', expires = null, verified = true, outage = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (outage) throw Error('network');
    const parsed = new URL(url), bearer = options.headers.Authorization;
    const user = { id: bearer === 'Bearer bob' ? bob : alice, email: 'person@example.com', email_confirmed_at: verified ? '2026-01-01' : null };
    if (parsed.pathname === '/auth/v1/user') return Response.json(['Bearer alice', 'Bearer bob', 'Bearer refreshed'].includes(bearer) ? user : { error: 'invalid' }, { status: ['Bearer alice', 'Bearer bob', 'Bearer refreshed'].includes(bearer) ? 200 : 401 });
    if (parsed.pathname === '/auth/v1/token') return Response.json({ access_token: parsed.searchParams.get('grant_type') === 'refresh_token' ? 'refreshed' : 'alice', refresh_token: 'refresh-secret', expires_in: 3600, user });
    if (parsed.pathname === '/rest/v1/reader_memberships') return Response.json([{ status, expires_at: expires }]);
    if (parsed.pathname === '/auth/v1/verify') return Response.json({ access_token: 'alice', refresh_token: 'refresh-secret', expires_in: 3600, user });
    return Response.json({});
  };
  return calls;
}
afterEach(() => { globalThis.fetch = actualFetch; });

test('unauthenticated reader is redirected and raw reader files cannot bypass the gate', async () => {
  mockProvider();
  const response = await worker.fetch(req('/app'), env);
  assert.equal(response.status, 303); assert.match(response.headers.get('Location'), /expired/);
  for (const path of ['/reader.html', '/legacy.html', '/%72eader.html', '/dist/reader.html']) assert.equal((await worker.fetch(req(path), env)).status, 404);
});
test('forged user cookie cannot authorize a reader', async () => {
  mockProvider();
  assert.equal((await worker.fetch(req('/app', { token: alice }), env)).status, 303);
});
test('verified active member receives only their server-selected storage scope', async () => {
  const calls = mockProvider();
  for (const [token, userId] of [['alice', alice], ['bob', bob]]) {
    const response = await worker.fetch(req('/app', { token }), env);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(`content="${userId}"`));
    assert.equal(response.headers.get('Cache-Control'), 'no-store, private');
  }
  const memberCalls = calls.filter(call => call.url.includes('reader_memberships'));
  assert.ok(memberCalls[0].url.includes(alice)); assert.ok(memberCalls[1].url.includes(bob));
  assert.equal(memberCalls[0].options.headers.Authorization, 'Bearer alice');
});
test('suspended, expired, invalid-expiry and unconfirmed users cannot open reader', async () => {
  for (const options of [{ status: 'suspended' }, { expires: '2020-01-01' }, { expires: 'garbage' }, { verified: false }]) {
    mockProvider(options);
    const response = await worker.fetch(req('/app', { token: 'alice' }), env);
    assert.equal(response.status, 303);
    assert.notEqual(await response.text(), '<head></head><body>reader</body>');
  }
});
test('provider outage and missing config fail closed when auth enabled', async () => {
  mockProvider({ outage: true });
  assert.equal((await worker.fetch(req('/app', { token: 'alice' }), env)).status, 503);
  assert.equal((await worker.fetch(req('/app'), { ...env, SUPABASE_URL: '' })).status, 503);
});
test('expired access can refresh server-side without exposing tokens to JavaScript', async () => {
  mockProvider();
  const response = await worker.fetch(req('/api/auth/me', { token: 'expired', refresh: 'refresh' }), env);
  assert.equal(response.status, 200);
  const value = await response.json(); assert.equal(value.user.id, alice);
  assert.ok(!JSON.stringify(value).includes('refresh-secret'));
  const set = response.headers.getSetCookie(); assert.equal(set.length, 2);
  for (const entry of set) for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(entry.includes(flag));
});
test('cross-origin and missing-origin auth submissions never contact provider', async () => {
  const calls = mockProvider();
  for (const Origin of ['', 'https://attacker.example']) {
    const response = await worker.fetch(req('/api/auth/login', { method: 'POST', data: { email: 'a@example.com', password: 'secret' }, headers: { Origin } }), env);
    assert.equal(response.status, 403);
  }
  assert.equal(calls.length, 0);
});
test('login credentials become HttpOnly cookies, not JSON session data', async () => {
  mockProvider();
  const response = await worker.fetch(req('/api/auth/login', { method: 'POST', data: { email: 'a@example.com', password: 'secret' } }), env);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.getSetCookie().length, 2);
});
test('reader content and membership changes cannot be submitted through account endpoints', async () => {
  const calls = mockProvider();
  for (const extra of [{ books: ['private'] }, { status: 'active' }, { user_id: bob }]) {
    const response = await worker.fetch(req('/api/auth/signup', { method: 'POST', data: { email: 'a@example.com', password: 'a-long-password', ...extra } }), env);
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 0);
});
test('IP limiter blocks auth attempts before provider use', async () => {
  const calls = mockProvider();
  const response = await worker.fetch(req('/api/auth/login', { method: 'POST', data: { email: 'a@example.com', password: 'secret' } }), { ...env, AUTH_LIMITER: { limit: async () => ({ success: false }) } });
  assert.equal(response.status, 429); assert.equal(calls.length, 0);
});
test('logout clears both cookies even when provider is down', async () => {
  mockProvider({ outage: true });
  const response = await worker.fetch(req('/api/auth/logout', { method: 'POST', token: 'alice' }), env);
  assert.equal(response.status, 200);
  assert.ok(response.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
});
test('large account submissions rejected before upstream use', async () => {
  const calls = mockProvider();
  const response = await worker.fetch(req('/api/auth/login', { method: 'POST', data: { email: 'a@example.com', password: 'x'.repeat(5000) } }), env);
  assert.equal(response.status, 413); assert.equal(calls.length, 0);
});
test('signup respects invitation-only setting and new password length', async () => {
  const calls = mockProvider();
  assert.equal((await worker.fetch(req('/api/auth/signup', { method: 'POST', data: { email: 'a@example.com', password: 'a-long-password' } }), { ...env, ALLOW_SIGNUP: 'false' })).status, 403);
  assert.equal((await worker.fetch(req('/api/auth/signup', { method: 'POST', data: { email: 'a@example.com', password: 'short' } }), env)).status, 400);
  assert.equal(calls.length, 0);
});
test('email code confirmation uses provider verification, not a local flag', async () => {
  const calls = mockProvider();
  const response = await worker.fetch(req('/api/auth/confirm', { method: 'POST', data: { email: 'a@example.com', code: '123456' } }), env);
  assert.equal(response.status, 200); assert.equal(response.headers.getSetCookie().length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: 'a@example.com', token: '123456', type: 'signup' });
});
test('password recovery verifies code before updating and revokes refresh sessions', async () => {
  const calls = mockProvider();
  const response = await worker.fetch(req('/api/auth/reset', { method: 'POST', data: { email: 'a@example.com', code: '123456', password: 'a-new-long-password' } }), env);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(calls[0].options.body).type, 'recovery');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer alice');
  assert.ok(calls[2].url.endsWith('/logout?scope=global'));
  assert.ok(response.headers.getSetCookie().every(value => value.includes('Max-Age=0')));
});
test('invalid recovery code never updates password', async () => {
  const calls = mockProvider();
  globalThis.fetch = async () => Response.json({ error: 'invalid code' }, { status: 400 });
  const response = await worker.fetch(req('/api/auth/reset', { method: 'POST', data: { email: 'a@example.com', code: '123456', password: 'a-new-long-password' } }), env);
  assert.equal(response.status, 400); assert.equal(calls.length, 0);
});
test('explicit rollout switch preserves standalone reader and disables account endpoints', async () => {
  assert.equal((await worker.fetch(req('/'), { ...env, AUTH_ENABLED: 'false' })).status, 200);
  assert.equal((await worker.fetch(req('/api/auth/me'), { ...env, AUTH_ENABLED: 'false' })).status, 503);
});
test('build routes every storage operation to the account adapter, without changing original', () => {
  const compiled = fs.readFileSync(new URL('../dist/reader.html', import.meta.url), 'utf8');
  const original = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const legacy = fs.readFileSync(new URL('../dist/legacy.html', import.meta.url), 'utf8');
  assert.equal(original, legacy);
  assert.ok(!/\blocalStorage\b|\bindexedDB\.open\(/.test(compiled));
  assert.match(compiled, /window.readerStorage.matchesEvent\(e,FALLBACK_PREFIX\+VOCAB_STATE_KEY\)/);
  assert.ok(!fs.existsSync(new URL('../dist/index.html', import.meta.url)));
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.assets.run_worker_first, true);
});
