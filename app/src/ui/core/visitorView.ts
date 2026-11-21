/**
 * What the visitor screen shows (`docs/product/ui-spec.md`, 5.13). The same states as the
 * staff AR screen (`arView.ts`), in a visitor's words: there is nothing a visitor can set
 * up, so every dead end is a sheet with "Try again" and a line a staff member can read.
 * Pure.
 */
import type { TextKey } from '../../i18n';
import { type ArInput, arView, type CoachLines } from './arView';

export type VisitorSheet =
  /** No server found, or it stopped answering. */
  | 'noServer'
  /** The phone is not on Wi-Fi. */
  | 'wifi'
  /** App and server are different versions. */
  | 'version'
  /** No room on the server, or no room with a saved door. */
  | 'noDoor'
  /** The room was not recognised after the tries. */
  | 'notRecognised'
  /** ReactVision as the connection method: the service is not reachable, or the room is not set up there. */
  | 'cloud'
  /** Before the camera: the connection to the server is too slow or loses requests. */
  | 'slow'
  /** The camera was refused. */
  | 'camera'
  /** The phone cannot run AR. */
  | 'device';

export interface VisitorInput extends ArInput {
  /** The phone is on Wi-Fi (true when unknown). */
  wifi: boolean;
  /** Camera permission: refused, or blocked in the phone's settings. */
  cameraRefused: boolean;
  /** The AR engine said this phone cannot run AR. */
  arUnsupported: boolean;
  /** No server is known yet and the search for one has not ended: not a problem so far. */
  searchPending: boolean;
}

export interface VisitorView {
  situation: 'finding' | 'door' | 'inside';
  coach: CoachLines | null;
  /** The amber dashed outline of a door whose place is still being checked. */
  outline: boolean;
  lostBanner: boolean;
  sheet: VisitorSheet | null;
}

const MOMENT: CoachLines = { line1: 'visitor.coach.moment.1', line2: 'visitor.coach.moment.2' };

/** The staff lines that read differently for a visitor. */
const VISITOR_WORDS: Partial<Record<TextKey, TextKey>> = {
  'ar.coach.find.2': 'visitor.coach.find.2',
  'ar.coach.still.2': 'visitor.coach.still.2',
};

function inVisitorWords(coach: CoachLines | null): CoachLines | null {
  if (!coach) {
    return null;
  }
  if (coach.line1 === 'ar.coach.server.1') {
    return MOMENT;
  }
  return { line1: coach.line1, line2: coach.line2 ? (VISITOR_WORDS[coach.line2] ?? coach.line2) : null };
}

export function visitorView(input: VisitorInput): VisitorView {
  const staff = arView({ ...input, source: 'room' });
  const view: VisitorView = {
    situation: staff.situation,
    coach: inVisitorWords(staff.coach),
    outline: staff.outline,
    lostBanner: staff.lostBanner,
    sheet: null,
  };
  if (input.cameraRefused) {
    view.sheet = 'camera';
    view.coach = null;
    return view;
  }
  if (input.arUnsupported) {
    view.sheet = 'device';
    return view;
  }
  if (staff.leave === 'version') {
    view.sheet = 'version';
  } else if (staff.leave === 'server') {
    if (input.searchPending) {
      view.coach = MOMENT;
    } else {
      view.sheet = input.wifi ? 'noServer' : 'wifi';
    }
  } else if (staff.leave === 'cloud' || staff.leave === 'cloud-setup') {
    view.sheet = 'cloud';
  } else if (staff.leave === 'no-room' || staff.sheet === 'noDoor') {
    view.sheet = 'noDoor';
  } else if (staff.sheet === 'unknown') {
    view.sheet = 'notRecognised';
  }
  if (view.sheet !== null && view.situation === 'finding') {
    view.coach = null; // the sheet says it all
  }
  return view;
}

export interface VisitorSheetText {
  title: TextKey;
  body: TextKey;
  /** The small grey line for staff; null where the title says it. */
  reason: TextKey | null;
  /** `retry`: "Try again"; `settings`: "Open phone settings"; null: no button. */
  button: 'retry' | 'settings' | null;
}

export function visitorSheetText(sheet: VisitorSheet): VisitorSheetText {
  switch (sheet) {
    case 'noServer':
      return { title: 'visitor.notReady.title', body: 'visitor.askStaff', reason: 'visitor.reason.noServer', button: 'retry' };
    case 'wifi':
      return { title: 'visitor.wifi.title', body: 'visitor.wifi.body', reason: 'visitor.reason.wifi', button: 'retry' };
    case 'version':
      return { title: 'visitor.notReady.title', body: 'visitor.askStaff', reason: 'visitor.reason.version', button: 'retry' };
    case 'noDoor':
      return { title: 'visitor.notReady.title', body: 'visitor.askStaff', reason: 'visitor.reason.noDoor', button: 'retry' };
    case 'cloud':
      return { title: 'visitor.notReady.title', body: 'visitor.askStaff', reason: 'visitor.reason.cloud', button: 'retry' };
    case 'notRecognised':
      return { title: 'visitor.cantFind.title', body: 'visitor.cantFind.body', reason: 'visitor.reason.notRecognised', button: 'retry' };
    case 'slow':
      // The line for staff carries the numbers; the screen adds it itself.
      return { title: 'visitor.slow.title', body: 'visitor.slow.body', reason: null, button: 'retry' };
    case 'camera':
      return { title: 'problem.camera.title', body: 'visitor.camera.body', reason: null, button: 'settings' };
    case 'device':
      return { title: 'visitor.device.title', body: 'visitor.device.body', reason: null, button: null };
  }
}
