/**
 * Sizes, type and the colour theme of the interface (`docs/product/ui-spec.md`, section 3).
 * The colours themselves and the product name are in `src/brand.ts`.
 */
import { StatusBar, type TextStyle, useColorScheme } from 'react-native';

import { DARK, LIGHT, type Palette } from '../brand';

export { BRAND, HUD } from '../brand';
export type { Palette } from '../brand';

/** The app follows the phone's light or dark setting. */
export function useTheme(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

export const SPACE = { screen: 20, gap: 12, small: 8 } as const;
export const RADIUS = { button: 16, card: 20, sheet: 26, pill: 999 } as const;
export const SIZE = { button: 54, touch: 44, shutter: 68, icon: 22 } as const;

/**
 * The spec names Bricolage Grotesque for titles and Inter for the rest; bundling fonts is
 * postponed, and the system font stands in with the same sizes (allowed by the spec).
 */
export const TYPE = {
  title: { fontSize: 28, lineHeight: 31, fontWeight: '700' },
  cardTitle: { fontSize: 21, lineHeight: 24, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  button: { fontSize: 16, fontWeight: '600' },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  eyebrow: { fontSize: 11.5, fontWeight: '600', letterSpacing: 0.9, textTransform: 'uppercase' },
  numbers: { fontVariant: ['tabular-nums'] },
  mono: { fontFamily: 'monospace', fontSize: 11, fontWeight: '500' },
} as const satisfies Record<string, TextStyle>;

/**
 * Space taken by the system bars. The top comes from the status bar; the bottom is a
 * fixed allowance, because the real inset needs a native safe-area module that is not
 * part of the build yet. Everything asks here, so adding the module is one edit.
 */
export function useInsets(): { top: number; bottom: number } {
  return { top: (StatusBar.currentHeight ?? 24) + 8, bottom: 28 };
}
