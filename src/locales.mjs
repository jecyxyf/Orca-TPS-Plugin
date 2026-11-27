import { readFile } from 'node:fs/promises';

// Menu order follows each flag country's nominal GDP (IMF WEO, October 2026).
const LOCALES = {
  en: ['us', 'English'], 'zh-CN': ['cn', '简体中文'], de: ['de', 'Deutsch'], ja: ['jp', '日本語'],
  hi: ['in', 'हिन्दी'], fr: ['fr', 'Français'], ru: ['ru', 'Русский'], it: ['it', 'Italiano'],
  'pt-BR': ['br', 'Português (Brasil)'], es: ['es', 'Español'], ko: ['kr', '한국어'],
  id: ['id', 'Bahasa Indonesia'], 'zh-TW': ['tw', '繁體中文'], ar: ['sa', 'العربية'],
  bn: ['bd', 'বাংলা'], ur: ['pk', 'اردو'], 'pt-PT': ['pt', 'Português (Portugal)']
};
const defaultCode = 'en';
const preferencesKey = 'panel-language';
const argumentsIn = /\{(\d+)\}/g;

async function loadLocale(code) {
  const messages = JSON.parse(await readFile(new URL(`locales/${code}.json`, import.meta.url), 'utf8'));
  if (!messages || typeof messages !== 'object' || Array.isArray(messages) ||
      Object.entries(messages).some(([id, text]) => !/^[a-z][a-z0-9.-]*$/.test(id) || typeof text !== 'string')) {
    throw new Error('Invalid locale messages: ' + code);
  }
  return Object.assign(Object.create(null), messages);
}

const format = (text, values) => text?.replace(argumentsIn, (_, index) => values[index] ?? '') ?? '';
const formatNotice = (value, t, depth = 0) => !Array.isArray(value) ? value : depth > 2 ? ''
  : t(value[0], ...value.slice(1).map(arg => formatNotice(arg, t, depth + 1)));

const sourceStrings = await loadLocale('zh-CN');
export const sourceMessage = (id, ...values) => format(sourceStrings[id], values);
export const sourceNotice = value => formatNotice(value, sourceMessage);

let languageOptions;
const loadLanguageOptions = () => languageOptions ??= Promise.all(
  Object.entries(LOCALES).map(async ([code, [flag, name]]) => ({
    code, name, flag: 'data:image/png;base64,' + (await readFile(new URL(`locales/flags/${flag}.png`, import.meta.url))).toString('base64')
  }))
);

export async function createLocalePreferences(storage) {
  let code = await storage.get(preferencesKey).catch(() => undefined);
  if (typeof code !== 'string' || !Object.hasOwn(LOCALES, code)) code = defaultCode;
  const english = await loadLocale(defaultCode);
  let strings = code === defaultCode ? english : code === 'zh-CN' ? sourceStrings : await loadLocale(code);
  const options = await loadLanguageOptions();
  let writing = Promise.resolve();

  const t = (id, ...values) => format(strings[id] ?? english[id], values);
  const notice = value => formatNotice(value, t);
  const response = includeOptions => ({ code, strings: code === defaultCode ? { ...english } : { ...english, ...strings }, ...(includeOptions ? { options } : {}) });

  function select(requested, onChange) {
    if (typeof requested !== 'string' || !Object.hasOwn(LOCALES, requested)) {
      return Promise.reject(new Error('Unsupported locale'));
    }
    const selected = writing.then(async () => {
      if (code !== requested) {
        const next = requested === defaultCode ? english : requested === 'zh-CN' ? sourceStrings : await loadLocale(requested);
        await storage.set(preferencesKey, requested);
        code = requested;
        strings = next;
        onChange();
      }
      return response(false);
    });
    writing = selected.catch(() => {});
    return selected;
  }
  return { t, notice, response, select, flush: () => writing, get code() { return code; } };
}
