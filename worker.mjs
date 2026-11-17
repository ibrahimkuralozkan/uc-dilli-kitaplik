// Account data only. Reader content never passes through this API.
const ACCESS = '__Host-reader-access';
const REFRESH = '__Host-reader-refresh';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const publicAssets = new Set(['/auth.css', '/auth.js', '/reader-storage.js', '/reader-account.css']);
class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function redirect(path) { return new Response(null, { status: 303, headers: { Location: path } }); }
function cookie(name, value, age) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
}
function cookies(request) {
  const result = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1)); } catch {} }
  }
  return result;
}
function setSession(response, session) {
  if (!session?.access_token || !session?.refresh_token) throw new AuthError(502, 'Oturum oluşturulamadı.');
  response.headers.append('Set-Cookie', cookie(ACCESS, session.access_token, Math.min(Number(session.expires_in) || 3600, 86400)));
  response.headers.append('Set-Cookie', cookie(REFRESH, session.refresh_token, 60 * 60 * 24 * 30));
  return response;
}
function clearSession(response) {
  response.headers.append('Set-Cookie', cookie(ACCESS, '', 0));
  response.headers.append('Set-Cookie', cookie(REFRESH, '', 0));
  return response;
}
function configuration(env) {
  if (env.AUTH_ENABLED !== 'true') return null;
  let url;
  try { url = new URL(env.SUPABASE_URL); } catch { throw new AuthError(503, 'Hesap hizmeti henüz yapılandırılmadı.'); }
  if (url.protocol !== 'https:' || !env.SUPABASE_PUBLISHABLE_KEY || url.pathname !== '/' || url.search || url.username || url.password) {
    throw new AuthError(503, 'Hesap hizmeti henüz yapılandırılmadı.');
  }
  return { url: url.origin, key: env.SUPABASE_PUBLISHABLE_KEY };
}
async function upstream(config, path, { method = 'GET', body, token } = {}) {
  let response;
  try {
    response = await fetch(config.url + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { apikey: config.key, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch { throw new AuthError(503, 'Hesap hizmetine ulaşılamadı. Lütfen tekrar deneyin.'); }
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
async function requireUser(request, config) {
  const stored = cookies(request);
  let token = stored[ACCESS];
  if (token) {
    const result = await upstream(config, '/auth/v1/user', { token });
    if (result.response.ok && UUID.test(result.data.id) && result.data.email_confirmed_at) return { user: result.data, token };
    if (result.response.status >= 500) throw new AuthError(503, 'Hesap hizmeti geçici olarak kullanılamıyor.');
  }
  if (stored[REFRESH]) {
    const refreshed = await upstream(config, '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: stored[REFRESH] } });
    if (refreshed.response.ok && refreshed.data.access_token) {
      token = refreshed.data.access_token;
      const verified = await upstream(config, '/auth/v1/user', { token });
      if (verified.response.ok && UUID.test(verified.data.id) && verified.data.email_confirmed_at) return { user: verified.data, token, refreshed: refreshed.data };
    }
    if (refreshed.response.status >= 500) throw new AuthError(503, 'Hesap hizmeti geçici olarak kullanılamıyor.');
  }
  throw new AuthError(401, 'Devam etmek için giriş yapın.');
}
async function membership(config, auth) {
  const result = await upstream(config, `/rest/v1/reader_memberships?user_id=eq.${auth.user.id}&select=status,expires_at`, { token: auth.token });
  if (!result.response.ok || !Array.isArray(result.data)) throw new AuthError(503, 'Üyelik bilgisi doğrulanamadı.');
  const row = result.data[0];
  const active = row?.status === 'active' && (row.expires_at === null || (Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > Date.now()));
  return { active, status: active ? 'active' : 'inactive', expiresAt: row?.expires_at ?? null };
}
async function bodyJSON(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new AuthError(415, 'JSON isteği gerekli.');
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'İstek boş.');
  let size = 0, chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw new AuthError(413, 'İstek çok büyük.'); }
    chunks.push(value);
  }
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    const allowed = new Set(['email', 'password', 'code']);
    if (Object.keys(data).some(key => !allowed.has(key))) throw new Error();
    return data;
  } catch { throw new AuthError(400, 'Geçersiz hesap isteği.'); }
}
function email(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new AuthError(400, 'Geçerli bir e-posta adresi girin.');
  return value.trim().toLowerCase();
}
function password(value, isNew = false) {
  if (typeof value !== 'string' || !value || value.length > 128 || (isNew && value.length < 12)) throw new AuthError(400, isNew ? 'Şifreniz 12–128 karakter olmalı.' : 'E-posta ve şifrenizi girin.');
  return value;
}
async function authAPI(request, env, config, path) {
  if (path === '/api/auth/me' && request.method === 'GET') {
    const auth = await requireUser(request, config);
    const member = await membership(config, auth);
    const response = json({ user: { id: auth.user.id, email: auth.user.email }, membership: member });
    return auth.refreshed ? setSession(response, auth.refreshed) : response;
  }
  if (request.method !== 'POST') throw new AuthError(405, 'Bu işlem POST gerektirir.');
  const origin = new URL(request.url).origin;
  if (request.headers.get('Origin') !== origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new AuthError(403, 'İstek kaynağı doğrulanamadı.');
  if (env.AUTH_LIMITER) {
    const { success } = await env.AUTH_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) throw new AuthError(429, 'Çok fazla deneme. Bir dakika sonra tekrar deneyin.');
  }
  if (path === '/api/auth/logout') {
    const stored = cookies(request);
    // Local cookie removal must succeed even when the upstream service is unavailable.
    if (stored[ACCESS]) { try { await upstream(config, '/auth/v1/logout?scope=local', { method: 'POST', token: stored[ACCESS] }); } catch {} }
    return clearSession(json({ ok: true }));
  }
  const data = await bodyJSON(request);
  if (path === '/api/auth/login') {
    const result = await upstream(config, '/auth/v1/token?grant_type=password', { method: 'POST', body: { email: email(data.email), password: password(data.password) } });
    if (!result.response.ok) throw new AuthError(result.response.status === 429 ? 429 : 401, 'Giriş yapılamadı. Bilgilerinizi ve e-posta doğrulamanızı kontrol edin.');
    if (!result.data.user?.email_confirmed_at) throw new AuthError(403, 'Önce e-posta adresinizi doğrulayın.');
    return setSession(json({ ok: true }), result.data);
  }
  if (path === '/api/auth/signup') {
    if (env.ALLOW_SIGNUP !== 'true') throw new AuthError(403, 'Kayıtlar şu anda davetle açılıyor.');
    const result = await upstream(config, '/auth/v1/signup', { method: 'POST', body: { email: email(data.email), password: password(data.password, true) } });
    if (result.response.status === 429) throw new AuthError(429, 'Çok fazla deneme. Daha sonra tekrar deneyin.');
    if (!result.response.ok) throw new AuthError(400, 'Kayıt tamamlanamadı. Şifrenizi kontrol edip tekrar deneyin.');
    return json({ message: 'Kayıt uygunsa e-posta adresinize doğrulama kodu gönderildi.' });
  }
  if (path === '/api/auth/confirm') {
    if (!/^\d{6,10}$/.test(data.code)) throw new AuthError(400, 'E-postadaki doğrulama kodunu girin.');
    const result = await upstream(config, '/auth/v1/verify', { method: 'POST', body: { email: email(data.email), token: data.code, type: 'signup' } });
    if (!result.response.ok) throw new AuthError(400, 'Kod geçersiz veya süresi dolmuş.');
    return setSession(json({ ok: true }), result.data);
  }
  if (path === '/api/auth/recover') {
    const result = await upstream(config, '/auth/v1/recover', { method: 'POST', body: { email: email(data.email) } });
    if (result.response.status >= 500) throw new AuthError(503, 'E-posta hizmeti geçici olarak kullanılamıyor.');
    if (result.response.status === 429) throw new AuthError(429, 'Çok fazla deneme. Daha sonra tekrar deneyin.');
    return json({ message: 'Bu adres için işlem yapılabiliyorsa şifre yenileme kodu gönderildi.' });
  }
  if (path === '/api/auth/reset') {
    const newPassword = password(data.password, true);
    if (!/^\d{6,10}$/.test(data.code)) throw new AuthError(400, 'E-postadaki yenileme kodunu girin.');
    const verified = await upstream(config, '/auth/v1/verify', { method: 'POST', body: { email: email(data.email), token: data.code, type: 'recovery' } });
    if (!verified.response.ok || !verified.data.access_token) throw new AuthError(400, 'Kod geçersiz veya süresi dolmuş.');
    const updated = await upstream(config, '/auth/v1/user', { method: 'PUT', token: verified.data.access_token, body: { password: newPassword } });
    // Revoke refresh sessions following password reset. Existing access JWTs expire at provider TTL.
    try { await upstream(config, '/auth/v1/logout?scope=global', { method: 'POST', token: verified.data.access_token }); } catch {}
    if (!updated.response.ok) throw new AuthError(400, 'Şifre güncellenemedi. Yeni bir kod isteyin.');
    return clearSession(json({ message: 'Şifreniz yenilendi. Yeni şifrenizle giriş yapın.' }));
  }
  throw new AuthError(404, 'İşlem bulunamadı.');
}
async function asset(request, env, path) {
  const url = new URL(request.url); url.pathname = path; url.search = '';
  return env.ASSETS.fetch(new Request(url, { method: 'GET' }));
}
function secure(response, app = false) {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store, private');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  result.headers.set('Content-Security-Policy', app
    ? "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; img-src 'self' data: blob:; worker-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    : "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return result;
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    let isApp = false;
    try {
      // Explicit rollout switch. No configuration error can accidentally bypass an enabled gate.
      if (env.AUTH_ENABLED !== 'true') {
        if (path.startsWith('/api/')) return secure(json({ error: 'Hesap sistemi henüz etkinleştirilmedi.' }, 503));
        return env.ASSETS.fetch(new Request(new URL('/legacy.html', request.url), { method: request.method }));
      }
      const config = configuration(env);
      let response;
      if (path.startsWith('/api/auth/')) response = await authAPI(request, env, config, path);
      else if (!['GET', 'HEAD'].includes(request.method)) throw new AuthError(405, 'Yöntem desteklenmiyor.');
      else if (publicAssets.has(path)) response = await asset(request, env, path);
      else if (['/', '/index.html', '/account'].includes(path)) response = await asset(request, env, '/account.html');
      else if (path === '/app' || path === '/app/') {
        const auth = await requireUser(request, config);
        const member = await membership(config, auth);
        if (!member.active) response = redirect('/account?membership=inactive');
        else {
          const raw = await asset(request, env, '/reader.html');
          if (!raw.ok) throw new AuthError(503, 'Okuyucu yüklenemedi.');
          const html = (await raw.text()).replace('<!--READER_ACCOUNT-->', `<meta name="reader-account" content="${auth.user.id}">`);
          response = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
          if (auth.refreshed) setSession(response, auth.refreshed);
          isApp = true;
        }
      } else if (path === '/reader-session.js') {
        const auth = await requireUser(request, config);
        response = await asset(request, env, path);
        response = new Response(response.body, response);
        if (auth.refreshed) setSession(response, auth.refreshed);
      } else throw new AuthError(404, 'Sayfa bulunamadı.');
      return secure(response, isApp);
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 503;
      const message = error instanceof AuthError ? error.message : 'Hesap hizmeti geçici olarak kullanılamıyor.';
      if ((path === '/app' || path === '/app/') && status === 401) return secure(clearSession(redirect('/account?expired=1')));
      return secure(json({ error: message }, status));
    }
  }
};
