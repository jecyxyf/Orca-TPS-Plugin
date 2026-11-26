import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLocalePreferences } from '../src/locales.mjs';

const codes = ['en', 'zh-CN', 'de', 'ja', 'hi', 'fr', 'ru', 'it', 'pt-BR', 'es', 'ko', 'id', 'zh-TW', 'ar', 'bn', 'ur', 'pt-PT'];
const storage = () => {
  const data = new Map();
  return {
    get: async key => data.get(key),
    set: async (key, value) => { data.set(key, value); }
  };
};

test('every shipped locale has the same message IDs and placeholders', async () => {
  const dictionaries = await Promise.all(codes.map(async code => {
    const messages = JSON.parse(await readFile(new URL(`../src/locales/${code}.json`, import.meta.url), 'utf8'));
    return Object.entries(messages).map(([id, text]) => [
      id, [...new Set(text.match(/\{\d+\}/g) ?? [])].sort()
    ]);
  }));
  const english = dictionaries[codes.indexOf('en')];
  assert.ok(english.length > 150);
  for (const [index, dictionary] of dictionaries.entries()) {
    assert.deepEqual(dictionary, english, codes[index]);
  }
});

test('language preferences default to English and persist a selected language across restarts', async () => {
  const store = storage();
  const first = await createLocalePreferences(store);
  const initial = first.response(true);
  assert.equal(initial.code, 'en');
  assert.equal(initial.strings['current-data'], 'Current Data');
  assert.deepEqual(initial.options.map(option => option.code), codes);
  for (const { flag } of initial.options) assert.match(flag, /^data:image\/png;base64,iVBORw0KGgo/);
  const usFlag = await readFile(new URL('../src/locales/flags/us.png', import.meta.url));
  assert.equal(initial.options[0].flag, 'data:image/png;base64,' + usFlag.toString('base64'));
  const changes = [];
  const readCurrent = () => changes.push(first.code);
  await Promise.all([first.select('ar', readCurrent), first.select('zh-CN', readCurrent)]);
  assert.deepEqual(changes, ['ar', 'zh-CN']);
  await assert.rejects(first.select('../en', readCurrent), /Unsupported locale/);
  const restored = await createLocalePreferences(store);
  assert.equal(restored.code, 'zh-CN');
  assert.equal(restored.t('personal-stats'), '个人统计');
});

test('failed storage writes preserve the active language and notice IDs and nested arguments can be translated', async () => {
  const locale = await createLocalePreferences({
    get: async () => 'not-a-language',
    set: async () => { throw new Error('could not write'); }
  });
  assert.equal(locale.code, 'en');
  await assert.rejects(locale.select('ar', () => assert.fail('unexpected language change')), /could not write/);
  assert.equal(locale.code, 'en');
  assert.equal(
    locale.notice(['notice.partial-session-scan', 'codex', ['notice.read-failed']]),
    'codex: Some session folders could not be read (Read failed).'
  );
});
