/**
 * The spaces that can stand behind the door (`docs/product/ui-spec.md`, 5.10): a list in
 * the app for the built-in ones. What a space is made of is in `src/environments/` and
 * `src/ar/VirtualRoom.tsx`; here is what the screens say about it. Texts are keys of the
 * dictionary.
 */
import type { TextKey } from '../i18n';
import type { EnvironmentId } from '../state/appStore';

export interface SpaceInfo {
  id: EnvironmentId;
  name: TextKey;
  /** Where the real place is, and from when; null for a space that is no real place. */
  place: TextKey | null;
  date: TextKey | null;
  /** One paragraph for "About this place". */
  about: TextKey | null;
  /** Who made the model, and its licence. */
  credit: TextKey | null;
  /** `walk-in` has depth (one can step inside); `360` surrounds the viewer but stays flat. */
  kind: 'walk-in' | '360';
  /** Size of its files in the app, MB. */
  megabytes: number;
  /** Shown only with developer options on. */
  developerOnly: boolean;
}

export const SPACES: readonly SpaceInfo[] = [
  {
    id: 'sponza',
    name: 'space.sponza.name',
    place: 'space.sponza.place',
    date: 'space.sponza.date',
    about: 'space.sponza.about',
    credit: 'space.sponza.credit',
    kind: 'walk-in',
    megabytes: 22,
    developerOnly: false,
  },
  {
    id: 'test-room',
    name: 'space.test-room.name',
    place: null,
    date: null,
    about: null,
    credit: null,
    kind: 'walk-in',
    megabytes: 0,
    developerOnly: true,
  },
];

export function spaceInfo(id: EnvironmentId): SpaceInfo {
  return SPACES.find((space) => space.id === id) ?? SPACES[0];
}
