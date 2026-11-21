/**
 * What the AR screen shows for a given state (`docs/product/ui-spec.md`, 5.9 and 7.3):
 * which of its three situations it is in, the coach lines, the pill, the banner, the
 * sheet. Pure, so that every row of the spec's tables is covered by a test.
 */
import type { TextKey } from '../../i18n';

/** The parts of `localization/types.ts` and of the stores this depends on, as plain strings. */
/** What a look for the room is doing (`StatusMeta.stage`). */
export type LookStage = 'recording' | 'sending' | 'thinking' | 'busy';

export interface ArInput {
  status: string;
  meta: { attempt?: number; attempts?: number; code?: string; pending?: boolean; stage?: LookStage };
  hasDoor: boolean;
  /** 'VR' while the user is inside the space. */
  mode: 'AR' | 'VR';
  tracking: 'unavailable' | 'limited' | 'normal';
  /** "excessive motion", "insufficient light", "insufficient features" or empty. */
  trackingReason: string;
  /** The door stands in a scanned room's doorway (`room`) or in front of the user (`free`). */
  source: 'room' | 'free';
  /** State of the server connection. */
  connection: string;
  /** Inside the space: the phone is close to a real wall of the room. */
  wallClose?: boolean;
}

export interface CoachLines {
  line1: TextKey;
  line2: TextKey | null;
}

export interface ArView {
  /** `finding`: no door yet. `door`: the door stands in the room. `inside`: the user is in the space. */
  situation: 'finding' | 'door' | 'inside';
  /** The instruction of the moment; null when there is nothing to say. */
  coach: CoachLines | null;
  /** The ghost button "This is a different room" belongs under the coach lines. */
  offerOtherRoom: boolean;
  /** Draw the amber dashed outline of the doorway instead of the door. */
  outline: boolean;
  /** The small state under the top row. */
  pill: 'off' | 'offline' | null;
  /** The red "Lost track of the room" banner. */
  lostBanner: boolean;
  /**
   * A problem that is shown as a sheet over the camera: the room was not recognised, or
   * it was and no door has been saved in it.
   */
  sheet: 'unknown' | 'noDoor' | null;
  /** The AR screen cannot go on: the app leaves it for Home or for a problem screen. */
  leave: 'no-room' | 'server' | 'version' | 'cloud' | 'cloud-setup' | null;
}

const READY: CoachLines = { line1: 'ar.coach.ready.1', line2: 'ar.coach.ready.2' };

/** The tracking warnings of section 5.6: they replace the coach line while they apply. */
export function trackingWarning(tracking: ArInput['tracking'], reason: string): CoachLines | null {
  if (tracking === 'normal') {
    return null;
  }
  if (reason.includes('motion')) {
    return { line1: 'ar.coach.motion.1', line2: 'ar.coach.motion.2' };
  }
  if (reason.includes('light')) {
    return { line1: 'ar.coach.dark.1', line2: 'ar.coach.dark.2' };
  }
  if (reason.includes('features')) {
    return { line1: 'ar.coach.plain.1', line2: 'ar.coach.plain.2' };
  }
  return READY;
}

/**
 * The coach lines of a search. The first line says the one thing that decides whether
 * the room is recognised - look at the room, not at the floor (every refusal of the
 * first pass on a phone was a look at the floor, a table top or another room) - and
 * the second what the look is doing: recording, sending, waiting for the server.
 */
function searchLines(stage: LookStage | undefined, scaleUnknown: boolean): CoachLines {
  if (scaleUnknown) {
    return { line1: 'ar.coach.sideways.1', line2: 'ar.coach.sideways.2' };
  }
  const line2: TextKey =
    stage === 'sending'
      ? 'ar.coach.look.sending'
      : stage === 'thinking'
        ? 'ar.coach.look.thinking'
        : stage === 'busy'
          ? 'ar.coach.look.busy'
          : 'ar.coach.look.recording';
  return { line1: 'ar.coach.look.1', line2 };
}

export function arView(input: ArInput): ArView {
  const { status, meta, hasDoor } = input;
  const view: ArView = {
    situation: 'finding',
    coach: null,
    offerOtherRoom: false,
    outline: false,
    pill: null,
    lostBanner: status === 'lost' && meta.code === 'tracking-lost',
    sheet: null,
    leave: null,
  };
  const attempt = meta.attempt ?? 1;
  const searching = status === 'localizing';
  const warning = trackingWarning(input.tracking, input.trackingReason);

  if (input.mode === 'VR') {
    view.situation = 'inside';
    if (input.wallClose) {
      view.coach = { line1: 'ar.inside.wall.1', line2: 'ar.inside.wall.2' };
    }
    return view;
  }

  // A first pose that is still being checked: the outline, and one line saying so.
  if (hasDoor && meta.pending) {
    view.outline = true;
    const lines = searching ? searchLines(meta.stage, meta.code === 'scale-unknown') : searchLines(undefined, false);
    view.coach = warning ?? { line1: lines.line1, line2: 'ar.coach.checking.2' };
    return view;
  }

  if (hasDoor) {
    view.situation = 'door';
    if (status === 'lost' && meta.code === 'unconfirmed') {
      view.pill = 'off';
    } else if (input.source === 'room' && (input.connection === 'unreachable' || input.connection === 'not-configured')) {
      view.pill = 'offline';
    }
    if (status === 'error' && meta.code === 'no-doorway') {
      view.sheet = 'noDoor'; // the door on screen is an earlier one
    }
    return view;
  }

  // ---- no door yet ----
  switch (status) {
    case 'waiting-for-server':
      if (meta.code === 'connecting') {
        view.coach = { line1: 'ar.coach.server.1', line2: 'ar.coach.server.2' };
      } else {
        view.leave = 'server';
      }
      return view;
    case 'error':
      if (meta.code === 'no-room') {
        view.leave = 'no-room';
      } else if (meta.code === 'incompatible') {
        view.leave = 'version';
      } else if (meta.code === 'cloud-offline') {
        view.leave = 'cloud'; // ReactVision cannot be reached, or it refused
      } else if (meta.code === 'cloud-not-set-up') {
        view.leave = 'cloud-setup'; // no keys in this build, or no location id for the room
      } else if (meta.code === 'no-doorway') {
        view.sheet = 'noDoor';
      } else {
        view.sheet = 'unknown';
      }
      return view;
    case 'lost':
      if (meta.code === 'not-recognised') {
        view.sheet = 'unknown';
        view.coach = warning ?? searchLines(undefined, false);
      } else {
        view.coach = warning ?? READY; // tracking lost before any door: the banner says the rest
      }
      return view;
    case 'localizing':
      // A provider without attempts (placing by hand) only waits for a usable camera pose.
      if (meta.attempt === undefined) {
        view.coach = warning ?? READY;
        return view;
      }
      view.coach = warning ?? searchLines(meta.stage, meta.code === 'scale-unknown');
      view.offerOtherRoom = attempt >= 4;
      return view;
    default:
      // idle, waiting-for-tracking, connected, and localized just before the pose arrives
      view.coach = warning ?? READY;
      return view;
  }
}
