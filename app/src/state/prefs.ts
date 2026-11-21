/**
 * What the app remembers between launches about the interface (`ui-spec.md`, 4.2), in
 * `app-prefs.json` next to `server-connection.json` and `device-id.json`. Same store
 * pattern as `appStore.ts`.
 */
import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

export interface Prefs {
  /** The welcome cards have been shown. */
  onboardingDone: boolean;
  /** Developer options switched on (seven taps on the version line). */
  developerOptions: boolean;
  /** Developer: one line of diagnostics on the AR screen. */
  diagnosticsLine: boolean;
  /** Developer: the box and the sphere of assignment task 1 near the session origin. */
  testObjects: boolean;
  /**
   * Developer: keep the AR view mounted (covered) while other screens are shown, instead
   * of mounting it only for the AR and scan screens. For a phone on which restarting the
   * AR session proves unstable.
   */
  keepArView: boolean;
  /** Search the Wi-Fi for a server when none is known. */
  findAutomatically: boolean;
  visitorMode: boolean;
  pinHash: string | null;
  /** Room to try first. */
  lastRoomId: string | null;
  /** Chosen space per room, until the server stores it. */
  spaceByRoom: Record<string, string>;
  /** Folder of the newest scan, so "Send again" survives a restart. */
  lastCapture: string | null;
  /** Chosen language, else the phone's. */
  language: string | null;
}

export interface PrefsState extends Prefs {
  /** False until the file has been read: the first screen is not known before. */
  loaded: boolean;
}

const FILE_NAME = 'app-prefs.json';

const DEFAULTS: Prefs = {
  onboardingDone: false,
  developerOptions: false,
  diagnosticsLine: true,
  testObjects: false,
  keepArView: false,
  findAutomatically: true,
  visitorMode: false,
  pinHash: null,
  lastRoomId: null,
  spaceByRoom: {},
  lastCapture: null,
  language: null,
};

let state: PrefsState = { ...DEFAULTS, loaded: false };
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPrefs(): PrefsState {
  return state;
}

export function usePrefs<T>(selector: (s: PrefsState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}

function save(): void {
  const { loaded: _loaded, ...prefs } = state;
  void (async () => {
    try {
      const file = new File(Paths.document, FILE_NAME);
      if (!file.exists) {
        file.create();
      }
      await file.write(JSON.stringify({ version: 1, ...prefs }));
    } catch {
      // The choice still holds for this run.
    }
  })();
}

export const prefsActions = {
  /** Reads the saved choices. Never throws; without a file the defaults apply. */
  async load(): Promise<void> {
    if (state.loaded) {
      return;
    }
    const saved: Record<string, unknown> = {};
    try {
      const file = new File(Paths.document, FILE_NAME);
      if (file.exists) {
        const json = JSON.parse(await file.text()) as Record<string, unknown>;
        for (const key of Object.keys(DEFAULTS) as (keyof Prefs)[]) {
          const value = json[key];
          const fallback = DEFAULTS[key];
          // Only values of the expected kind are taken over from the file.
          const fits =
            fallback === null ? value === null || typeof value === 'string' : value !== null && typeof value === typeof fallback;
          if (value !== undefined && fits) {
            saved[key] = value;
          }
        }
      }
    } catch {
      // A broken file only means the defaults.
    }
    state = { ...DEFAULTS, ...(saved as Partial<Prefs>), loaded: true };
    emit();
  },

  set(patch: Partial<Prefs>): void {
    state = { ...state, ...patch };
    emit();
    save();
  },
};
