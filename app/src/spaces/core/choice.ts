/**
 * Which space stands behind the door of a room, and which spaces are offered
 * (`docs/product/ui-spec.md`, 5.10). The choice is kept per room. Pure: the list of the
 * spaces and the kept choices come in from outside.
 */

/** What is needed of a space to list it and to choose it. */
export interface ListedSpace {
  id: string;
  /** `walk-in` has depth (one can step inside); `360` surrounds the viewer but stays flat. */
  kind: 'walk-in' | '360';
  /** A real place: what the "Heritage" chip shows. */
  heritage: boolean;
  /** Offered only with developer options on. */
  developerOnly: boolean;
}

export type SpaceFilter = 'all' | 'heritage' | '360';

/** The filter chips are shown only when more spaces than this are offered. */
export const FILTERS_ABOVE = 6;

/** The spaces a person is offered, in the order of the list. */
export function listedSpaces<T extends ListedSpace>(spaces: readonly T[], developer: boolean, filter: SpaceFilter = 'all'): T[] {
  return spaces.filter(
    (space) =>
      (developer || !space.developerOnly) &&
      (filter === 'all' || (filter === 'heritage' ? space.heritage : space.kind === '360')),
  );
}

export function filtersShown(spaces: readonly ListedSpace[], developer: boolean): boolean {
  return listedSpaces(spaces, developer).length > FILTERS_ABOVE;
}

function choices(byRoom: unknown): Record<string, string> {
  const kept: Record<string, string> = {};
  if (byRoom !== null && typeof byRoom === 'object' && !Array.isArray(byRoom)) {
    for (const [roomId, spaceId] of Object.entries(byRoom as Record<string, unknown>)) {
      if (typeof spaceId === 'string' && spaceId) {
        kept[roomId] = spaceId;
      }
    }
  }
  return kept;
}

/**
 * The space behind the door of a room: the one chosen for it, as long as it is still
 * offered (a developer-only space is not, once developer options are off); else the
 * first one offered. `byRoom` is what was read from the phone's file: anything.
 * Null only for an empty list.
 */
export function chosenSpaceId(spaces: readonly ListedSpace[], byRoom: unknown, roomId: string | null, developer: boolean): string | null {
  const offered = listedSpaces(spaces, developer);
  const kept = roomId === null ? undefined : choices(byRoom)[roomId];
  if (kept !== undefined && offered.some((space) => space.id === kept)) {
    return kept;
  }
  return offered[0]?.id ?? spaces[0]?.id ?? null;
}

/** The kept choices with the one for this room set; what is not a choice is dropped. */
export function withChoice(byRoom: unknown, roomId: string, spaceId: string): Record<string, string> {
  return { ...choices(byRoom), [roomId]: spaceId };
}
