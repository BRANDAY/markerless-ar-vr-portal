/**
 * The app's language, tied to the phone and to the preferences (`ui-spec.md`, 4.2 and
 * 5.12): the one chosen in Settings or on the visitor's welcome panel, else the phone's,
 * else English. The rule itself is `i18n/languages.ts`.
 */
import { I18nManager } from 'react-native';

import { availableLanguages, getLanguage, setLanguage } from '../i18n';
import { pickLanguage } from '../i18n/languages';
import { prefsActions, usePrefs } from './prefs';

/** The phone's own language as Android reports it ("hr_HR"), or null when it does not say. */
function phoneLocale(): string | null {
  try {
    const identifier = (I18nManager.getConstants() as { localeIdentifier?: string | null }).localeIdentifier;
    if (identifier) {
      return identifier;
    }
  } catch {
    // fall through to the JavaScript engine's own answer
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || null;
  } catch {
    return null;
  }
}

/**
 * Sets the language for everything drawn below the caller. Called in the render of the
 * root component, before any text is looked up: a new choice draws the root anew, and
 * with it every screen. Returns the language's code.
 */
export function useAppLanguage(): string {
  const chosen = usePrefs((s) => s.language);
  const code = pickLanguage(chosen, phoneLocale(), availableLanguages());
  if (code !== getLanguage()) {
    setLanguage(code);
  }
  return code;
}

export function chooseLanguage(code: string): void {
  prefsActions.set({ language: code });
}
