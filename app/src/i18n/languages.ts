/**
 * Which language the app speaks (`docs/product/ui-spec.md`, 4.2: "chosen language, else
 * the phone's"). Pure; the phone's own language is read in `src/state/language.ts`.
 */

/** Each language under its own name, as the list and the chips show it. */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hr: 'Hrvatski',
};

/** "hr-HR", "hr_HR" and "HR" are all `hr`. */
function languageOf(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * The language to show: the one chosen in the app if the app has it, else the phone's if
 * the app has it, else English.
 */
export function pickLanguage(chosen: string | null, phoneLocale: string | null, available: readonly string[]): string {
  for (const tag of [chosen, phoneLocale]) {
    if (tag) {
      const code = languageOf(tag);
      if (available.includes(code)) {
        return code;
      }
    }
  }
  return 'en';
}
