/**
 * Credits and licences (`docs/product/ui-spec.md`, 5.12): whose work the spaces and the
 * door are made from, and the software the app is built with. The facts come from
 * `assets/environments/sponza_atrium/LICENSES.md`, `assets/environments/door_casing/LICENSES.md`
 * and the `LICENSE` files of the packages; names of works, of people and of licences are
 * proper names and are not translated - only what the app says about them is a text of
 * the dictionary.
 *
 * NOT LISTED: software that comes in indirectly (the AR engine and the other libraries
 * the packages below bring along), and the full texts of the licences.
 */
import packageJson from '../../package.json';
import type { TextKey } from '../i18n';

export interface WorkCredit {
  /** What the work is used for in the app. */
  use: TextKey;
  /** The work, by its own name. */
  title: string;
  /** Who made it. */
  by: string;
  licence: string;
  /** Where it was taken from. */
  source: string;
  /** What was changed (CC BY asks that changes are named). */
  changes: TextKey | null;
}

export const SPACE_CREDITS: readonly WorkCredit[] = [
  {
    use: 'credits.use.sponza',
    title: '“Crytek Sponza”',
    by: '© 2010 Frank Meinl, Crytek. After the Sponza model by Marko Dabrovic (2002); corrected by Morgan McGuire, Computer Graphics Archive, July 2017.',
    licence: 'CC BY 3.0 · creativecommons.org/licenses/by/3.0',
    source: 'casual-effects.com/data',
    changes: 'credits.sponza.changes',
  },
  {
    use: 'credits.use.sky',
    title: '“Kloofendal 48d Partly Cloudy (Pure Sky)”',
    by: 'Greg Zaal, sky edits by Jarod Guest',
    licence: 'CC0 1.0',
    source: 'polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky',
    changes: null,
  },
];

export const DOOR_CREDITS: readonly WorkCredit[] = [
  {
    use: 'credits.use.casing',
    title: '“European Walnut Veneer 04”',
    by: 'Jenelle van Heerden',
    licence: 'CC0 1.0',
    source: 'polyhaven.com/a/european_walnut_veneer_04',
    changes: null,
  },
  {
    use: 'credits.use.leaf',
    title: '“Oak Veneer 01”',
    by: 'Jenelle van Heerden',
    licence: 'CC0 1.0',
    source: 'polyhaven.com/a/oak_veneer_01',
    changes: null,
  },
];

export interface SoftwareNotice {
  name: string;
  version: string;
  /** The copyright lines of its licence file. */
  by: string;
  licence: string;
}

const versions: Record<string, string> = packageJson.dependencies;

/** The packages the app depends on directly (`package.json`), as their licence files name them. */
export const SOFTWARE_NOTICES: readonly SoftwareNotice[] = [
  {
    name: 'ViroReact',
    version: versions['@reactvision/react-viro'] ?? '',
    by: '© 2019 Viro Media, Inc · © 2021 Viro Community · © 2025 ReactVision, Inc',
    licence: 'MIT',
  },
  { name: 'React Native', version: versions['react-native'] ?? '', by: '© Meta Platforms, Inc. and affiliates', licence: 'MIT' },
  { name: 'React', version: versions.react ?? '', by: '© Meta Platforms, Inc. and affiliates', licence: 'MIT' },
  { name: 'Expo', version: versions.expo ?? '', by: '© 2015-present 650 Industries, Inc. (aka Expo)', licence: 'MIT' },
];
