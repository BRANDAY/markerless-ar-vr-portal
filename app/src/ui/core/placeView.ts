/**
 * Room result and "Place the door" (`docs/product/ui-spec.md`, 5.8 and 5.14): what the
 * room result says about the server's findings, where the door first appears on the
 * placing screen, which doorways "Use the found doorway" walks through, and what the
 * screen shows when. Pure.
 */
import type { TextKey } from '../../i18n';
import { type ArInput, type ArView, arView, type CoachLines } from './arView';

type V3 = readonly number[];

/** The parts of the server's room plan this depends on. */
export interface FoundDoorway {
  width: number;
  height: number;
  /** False when only the width could be measured. */
  heightMeasured: boolean;
}

/** The line under "The room is ready". `room` is null or `unavailable` when there is no plan. */
export function roomResultBody(
  room: { status: string; openings: readonly FoundDoorway[] } | null,
): { key: TextKey; params: Record<string, string | number> } {
  if (!room || room.status === 'unavailable') {
    return { key: 'roomResult.noPlan', params: {} };
  }
  const doorways = room.openings;
  if (doorways.length === 0) {
    return { key: 'roomResult.noDoorway', params: {} };
  }
  if (doorways.length > 1) {
    return { key: 'roomResult.several', params: { n: doorways.length } };
  }
  const [doorway] = doorways;
  return doorway.heightMeasured
    ? { key: 'roomResult.one', params: { w: doorway.width.toFixed(2), h: doorway.height.toFixed(2) } }
    : { key: 'roomResult.one.width', params: { w: doorway.width.toFixed(2) } };
}

/**
 * Where the door first stands on the placing screen: at the place that was saved, else in
 * the doorway the server suggests, else on the floor two metres in front of the camera.
 */
export type PlaceStart = 'saved' | 'suggested' | 'free';

export function placeStart(door: { source: string; hasPose: boolean } | null, hasSuggestion: boolean): PlaceStart {
  if (door && door.hasPose && (door.source === 'manual' || door.source === 'selected')) {
    return 'saved';
  }
  return hasSuggestion ? 'suggested' : 'free';
}

/** The coach lines once the room is found. */
export function placeCoach(start: PlaceStart): CoachLines {
  switch (start) {
    case 'saved':
      return { line1: 'place.coach.saved.1', line2: 'place.coach.saved.2' };
    case 'suggested':
      return { line1: 'place.coach.suggested.1', line2: 'place.coach.suggested.2' };
    case 'free':
      return { line1: 'place.coach.free.1', line2: 'place.coach.free.2' };
  }
}

/** A doorway the server found, as a place the door can be put into. */
export interface DoorwayOption {
  id: string;
  position: V3;
  rotation: V3;
  /** Null: not measured, the door keeps the default. */
  width: number | null;
  height: number | null;
}

/**
 * The doorways "Use the found doorway" walks through, the suggested one first. They come
 * from the room plan of the same answer as the suggestion, so both are in the frame of
 * the running AR session.
 */
export function foundDoorways(
  openings:
    | readonly { id: string; portalPosition: V3; portalRotation: V3; width: number; height: number; heightMeasured: boolean }[]
    | null,
  suggested: { openingId: string | null; position: V3; rotation: V3; width: number | null; height: number | null } | null,
): DoorwayOption[] {
  const options: DoorwayOption[] = (openings ?? []).map((opening) => ({
    id: opening.id,
    position: opening.portalPosition,
    rotation: opening.portalRotation,
    width: opening.width,
    height: opening.heightMeasured ? opening.height : null,
  }));
  if (!suggested) {
    return options;
  }
  const index = options.findIndex((option) => option.id === suggested.openingId);
  if (index < 0) {
    // The suggestion is not among the plan's doorways (or there is no plan): it leads.
    return [
      { id: suggested.openingId ?? 'suggested', position: suggested.position, rotation: suggested.rotation, width: suggested.width, height: suggested.height },
      ...options,
    ];
  }
  return [options[index], ...options.slice(0, index), ...options.slice(index + 1)];
}

export interface PlaceInput extends Omit<ArInput, 'mode' | 'source' | 'wallClose'> {
  /** The server has placed its map in the running AR session: a door can be saved. */
  found: boolean;
  start: PlaceStart;
  /** The staff member has used a control: the first instruction has done its work. */
  touched: boolean;
}

export interface PlaceScreen {
  /** The door can be edited and saved. */
  ready: boolean;
  coach: CoachLines | null;
  lostBanner: boolean;
  /** "This doesn't look like {room}". */
  sheet: 'unknown' | null;
  leave: ArView['leave'];
}

/**
 * What the placing screen shows. Until the room is found it is the AR screen's search
 * (5.9); a first answer that is still being checked does not count as found, because a
 * door saved through it would be saved a little off.
 */
export function placeScreen(input: PlaceInput): PlaceScreen {
  if (input.found && !input.meta.pending) {
    return { ready: true, coach: input.touched ? null : placeCoach(input.start), lostBanner: false, sheet: null, leave: null };
  }
  const search = arView({ ...input, mode: 'AR', source: 'room' });
  const stopped = search.sheet === 'unknown' || search.leave !== null;
  return {
    ready: false,
    // A door that is shown has no coach line on the AR screen; here the search still has to be explained.
    coach: search.lostBanner || stopped ? null : (search.coach ?? { line1: 'ar.coach.find.1', line2: 'ar.coach.find.2' }),
    lostBanner: search.lostBanner,
    sheet: search.sheet === 'unknown' ? 'unknown' : null,
    leave: search.leave,
  };
}
