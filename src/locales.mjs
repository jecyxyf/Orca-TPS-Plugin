import { readFile } from 'node:fs/promises';

// Menu order follows each flag country's nominal GDP (IMF WEO, October 2026).
const flags = {
  en: 'us', 'zh-CN': 'cn', de: 'de', ja: 'jp', hi: 'in', fr: 'fr',
  ru: 'ru', it: 'it', 'pt-BR': 'br', es: 'es', ko: 'kr', id: 'id', 'zh-TW': 'tw', ar: 'sa', bn: 'bd', ur: 'pk', 'pt-PT': 'pt'
};
const defaultCode = 'en';
const preferencesKey = 'panel-language';
const dictionaries = new Map();
const argumentsIn = /\{(\d+)\}/g;

function readLocale(code) {
  if (!dictionaries.has(code)) dictionaries.set(code, loadLocale(code));
  return dictionaries.get(code);
}

async function loadLocale(code) {
  const source = await readFile(new URL('locales/' + code + '.json', import.meta.url), 'utf8');
  const messages = JSON.parse(source);
  if (!messages || typeof messages !== 'object' || Array.isArray(messages) ||
      Object.entries(messages).some(([id, text]) => !/^[a-z][a-z0-9.-]*$/.test(id) || typeof text !== 'string')) {
    throw new Error('Invalid locale messages: ' + code);
  }
  return Object.assign(Object.create(null), messages);
}

function format(text, values) {
  return text?.replace(argumentsIn, (_, index) => values[index] ?? '') ?? '';
}

const sourceStrings = await readLocale('zh-CN');
export function sourceMessage(id, ...values) {
  return format(sourceStrings[id], values);
}

function formatNotice(value, t, depth = 0) {
  if (!Array.isArray(value)) return value;
  if (depth > 2) return '';
  const [code, ...args] = value;
  return t(code, ...args.map(arg => formatNotice(arg, t, depth + 1)));
}

export function sourceNotice(value) {
  return formatNotice(value, sourceMessage);
}

let languageOptions;
function loadLanguageOptions() {
  languageOptions ??= Promise.all(Object.entries(flags).map(async ([language, flag]) => {
    const [strings, png] = await Promise.all([
      readLocale(language), readFile(new URL(`locales/flags/${flag}.png`, import.meta.url))
    ]);
    return { code: language, name: strings['language-name'], flag: 'data:image/png;base64,' + png.toString('base64') };
  }));
  return languageOptions;
}
export async function createLocalePreferences(storage) {
  let code = await storage.get(preferencesKey).catch(() => undefined);
  if (typeof code !== 'string' || !Object.hasOwn(flags, code)) code = defaultCode;
  const [english, initial, options] = await Promise.all([readLocale(defaultCode), readLocale(code), loadLanguageOptions()]);
  let strings = initial;
  let writing = Promise.resolve();

  const t = (id, ...values) => format(strings[id] ?? english[id], values);
  const notice = value => formatNotice(value, t);

  function response(includeOptions) {
    const result = { code, strings: { ...english, ...strings } };
    if (includeOptions) result.options = options;
    return result;
  }

  function select(requested, onChange) {
    if (typeof requested !== 'string' || !Object.hasOwn(flags, requested)) {
      return Promise.reject(new Error('Unsupported locale'));
    }
    const selected = writing.then(async () => {
      if (code !== requested) {
        const next = await readLocale(requested);
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
