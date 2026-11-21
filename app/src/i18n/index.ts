/**
 * Text lookup: `t('home.openDoor')`, `t('connect.found.title', { server: 'PC' })`.
 * One dictionary per language, keyed by name; a key missing in a language falls back to
 * English. Pure, so the texts can be checked in the unit tests.
 */
import { BRAND } from '../brand';
import { en, type TextKey } from './en';

export type { TextKey } from './en';
export type Dictionary = Partial<Record<TextKey, string>>;

const dictionaries: Record<string, Dictionary> = { en };
let language = 'en';

export function registerLanguage(code: string, dictionary: Dictionary): void {
  dictionaries[code] = dictionary;
}

export function setLanguage(code: string): void {
  language = dictionaries[code] ? code : 'en';
}

export function getLanguage(): string {
  return language;
}

export function availableLanguages(): string[] {
  return Object.keys(dictionaries);
}

export function t(key: TextKey, params: Record<string, string | number> = {}): string {
  const template: string = dictionaries[language]?.[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (name in params) {
      return String(params[name]);
    }
    if (name === 'app') {
      return BRAND.name;
    }
    if (name === 'serverApp') {
      return BRAND.serverName;
    }
    return whole;
  });
}
