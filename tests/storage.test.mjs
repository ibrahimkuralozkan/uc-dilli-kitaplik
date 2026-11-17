import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
function adapter() {
  const data = new Map([['risale_words_v8', 'legacy-private']]);
  const opened = [];
  const context = { window: {}, document: { querySelector: () => null }, navigator: {},
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) },
    indexedDB: { open: (name, version) => { opened.push([name, version]); return {}; } }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../web/reader-storage.js', import.meta.url), 'utf8'), context);
  return { create: context.window.createReaderStorage, data, opened };
}
test('two accounts cannot read, overwrite or delete each other’s local keys', () => {
  const { create, data } = adapter(), a = create(alice), b = create(bob);
  assert.equal(a.getItem('risale_words_v8'), null);
  a.setItem('words', 'alice notes'); b.setItem('words', 'bob notes');
  assert.equal(a.getItem('words'), 'alice notes'); assert.equal(b.getItem('words'), 'bob notes');
  b.removeItem('words'); assert.equal(a.getItem('words'), 'alice notes');
  assert.equal(data.get('risale_words_v8'), 'legacy-private');
});
test('all reader databases receive an immutable account namespace', () => {
  const { create, opened } = adapter();
  for (const id of [alice, bob]) for (const db of ['three_language_reader_data_v44', 'three_language_pdf_library_v29', 'risale_words_db_v11']) create(id).database.open(db, 1);
  assert.equal(new Set(opened.map(([name]) => name)).size, 6);
  assert.ok(opened.every(([name]) => name.includes('::account::')));
  assert.throws(() => create('../another-account'));
  assert.throws(() => create(alice).database.open('unapproved-db'));
});
test('cross-tab vocabulary events only match the correct account', () => {
  const { create } = adapter(); const a = create(alice), b = create(bob);
  const event = { key: `reader-account:${alice}:words` };
  assert.equal(a.matchesEvent(event, 'words'), true); assert.equal(b.matchesEvent(event, 'words'), false);
});
test('unsupported legacy migration refuses without deleting or reading legacy content', async () => {
  const { create, data, opened } = adapter();
  await assert.rejects(create(alice).importLegacy(), /tarayıcı/);
  assert.equal(data.get('risale_words_v8'), 'legacy-private'); assert.equal(opened.length, 0);
});
