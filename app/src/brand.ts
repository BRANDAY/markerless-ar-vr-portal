/**
 * Name and colours of the product. PLACEHOLDERS: "Vrata" and the amber / teal palette are
 * working choices that the owner has not confirmed. Everything that shows the name or a
 * brand colour takes it from here, so a rename or a new palette is an edit of this file.
 * Pure data (no React Native import), so the text dictionary and the tests can use it.
 */
export const BRAND = {
  /** The app's name as shown to users; `{app}` in the text dictionary. */
  name: 'Vrata',
  /** The server program's name as shown to users; `{serverApp}` in the text dictionary. */
  serverName: 'Vrata Server',
} as const;

export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  ink: string;
  ink2: string;
  line: string;
  /** The door and the main action. */
  amber: string;
  amberInk: string;
  amberText: string;
  amberSoft: string;
  /** The real room as the app understands it. */
  teal: string;
  tealSoft: string;
  danger: string;
  dangerSoft: string;
  ok: string;
}

export const LIGHT: Palette = {
  bg: '#F4F6F9',
  surface: '#FFFFFF',
  surface2: '#E9EDF2',
  ink: '#131A26',
  ink2: '#566074',
  line: '#D7DCE5',
  amber: '#FFB23E',
  amberInk: '#2A1A00',
  amberText: '#8F5400',
  amberSoft: '#FFF0D6',
  teal: '#0B8580',
  tealSoft: '#D8F0EE',
  danger: '#C2352B',
  dangerSoft: '#FBE4E1',
  ok: '#1B7F45',
};

export const DARK: Palette = {
  bg: '#0C111A',
  surface: '#151C28',
  surface2: '#1E2736',
  ink: '#EEF2F8',
  ink2: '#9AA6BA',
  line: '#2A3445',
  amber: '#FFB84D',
  amberInk: '#2A1A00',
  amberText: '#FFC873',
  amberSoft: '#3A2A10',
  teal: '#3FD0C6',
  tealSoft: '#12363A',
  danger: '#FF7A6E',
  dangerSoft: '#3B1A18',
  ok: '#5AD08A',
};

/** Over the camera there is one look in both themes: the elements sit on live video. */
export const HUD = {
  bg: 'rgba(9,13,21,0.66)',
  fg: '#FFFFFF',
  dim: 'rgba(255,255,255,0.72)',
  line: 'rgba(255,255,255,0.16)',
  /** Scan paint and the wall warning grid. */
  scan: '#3FE0D4',
  /** Doorway outline and rings. */
  door: '#FFB84D',
  danger: 'rgba(120,30,22,0.82)',
} as const;
