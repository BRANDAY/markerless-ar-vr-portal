import type { Decision, DoorCandidate } from '../localization/core/relocalization';
import type { LocalizationStatus, PoseUpdate, RoomFix, StatusMeta } from '../localization/types';
import { getRoomScanState, roomActions, type ServerPlan } from '../room/roomStore';
import type { ServerPortal } from '../server/core/roomPlan';
import { roomInSession, settle } from './core/placement';
import { readDoorRecord, readRoomPlan, RECORD_FRESH_MS } from './doorRecords';

/** What the door layer needs from the provider it works for: the app's door slot, the status line, the log. */
export interface DoorSink {
  emitPose(update: Omit<PoseUpdate, 'source' | 'timestampMs'>): void;
  setStatus(status: LocalizationStatus, detail: string, meta?: StatusMeta): void;
  log(text: string): void;
}

/** What became of a recognised room. Null: the answer was overtaken (stop, tracking lost) and dropped. */
export interface Placement {
  decision: Decision;
  /** The door record in this session's frame; null when the record could not be read. */
  portal: ServerPortal | null;
}

/**
 * THE ONE PLACE WHERE A DOOR IS PUT (`localization-server/docs/api-v2.md`, section 5;
 * the owner's decision of 2026-11-21: one approach to the door for every way of
 * recognising the room, so that switching between them is seamless).
 *
 * A way of recognising the room - the venue's own server, ReactVision Advanced VPS -
 * answers one question: where is the room's frame in this AR session (`RoomFix`). It
 * knows nothing about the door. This class takes that answer, reads the room's one door
 * record from the venue's server, does the sum
 *
 *   door in the session = room in the session x door in the room
 *
 * and applies the rules that are the same for every way (`core/relocalization.ts`):
 *  - a door is placed only where a staff member saved one;
 *  - a door that stands is moved only by a better answer that really differs - small
 *    disagreements are noise;
 *  - a move the user did not ask for is marked `automatic`, so it waits while the user is
 *    inside the space;
 *  - after tracking was lost the door stays, but is not believed until the room is
 *    recognised again;
 *  - nothing moves or disappears without a line in the log and a status on screen.
 *
 * It also tells the room store that the room is found (`found`): that is what the placing
 * screen saves a door through - the same sum backwards (`room/doorServer.ts`).
 */
export class DoorPlacer {
  private shownDoor: DoorCandidate | null = null;
  private isTrusted = false;
  private wasTrusted = false;
  /** Changes whenever an answer on its way becomes void. */
  private epoch = 0;
  private lastPlan: ServerPlan | null = null;

  constructor(private readonly out: DoorSink) {}

  /** The door on screen, in this session. */
  get shown(): DoorCandidate | null {
    return this.shownDoor;
  }

  /** Whether the place of that door is believed. */
  get trusted(): boolean {
    return this.isTrusted;
  }

  /** A door of this run has been believed at least once. */
  get everTrusted(): boolean {
    return this.wasTrusted;
  }

  /** A plan this layer wrote into the room store itself (so that its echo can be told apart). */
  wrote(plan: ServerPlan | null): boolean {
    return plan !== null && plan === this.lastPlan;
  }

  /** A provider starts or stops: nothing is shown, the room is not found. */
  reset(): void {
    this.epoch++;
    this.shownDoor = null;
    this.isTrusted = false;
    this.wasTrusted = false;
    this.lastPlan = null;
    roomActions.setFound(null);
  }

  /**
   * Tracking was interrupted: the session's frame may have changed. The door stays where
   * it is, unbelieved; nothing can be saved until the room is recognised again.
   */
  distrust(): void {
    this.epoch++;
    this.isTrusted = false;
    roomActions.setFound(null);
  }

  /**
   * The room was recognised. `requested`: the user asked for this look, so a move may
   * happen at once. `always`: put the door there whatever stands (see `settle`).
   */
  async roomRecognised(fix: RoomFix, how: { requested: boolean; always?: boolean }): Promise<Placement | null> {
    const epoch = this.epoch;
    const [read, ownPlan] = await Promise.all([
      readDoorRecord(fix.mapId, fix.continuous ? RECORD_FRESH_MS : 0),
      fix.room === undefined ? readRoomPlan(fix.mapId, fix.frameId) : Promise.resolve(null),
    ]);
    if (epoch !== this.epoch) {
      return null;
    }
    if (!read) {
      return { decision: { action: 'retry', why: 'the door of this room could not be read from the server' }, portal: null };
    }
    if (fix.frameId && read.record.frameId && fix.frameId !== read.record.frameId) {
      // The room was scanned again between the two answers: door and transform belong to different scans.
      return { decision: { action: 'retry', why: 'the room has been scanned again' }, portal: null };
    }
    if (read.from === 'kept') {
      this.out.log('the server did not answer - using the door record kept on this phone');
    }
    const { portal, decision } = settle(this.shownDoor, this.isTrusted, fix.transform, read.record, fix.strong, how.always);
    const plan: ServerPlan = {
      mapId: fix.mapId,
      origin: fix.fromRecording ? 'build' : 'localize',
      room: fix.room !== undefined ? fix.room : ownPlan ? roomInSession(fix.transform, ownPlan) : null,
      portal,
    };
    if (!fix.fromRecording) {
      roomActions.setFound({ mapId: fix.mapId, frameId: fix.frameId, transform: fix.transform, strong: fix.strong, plan });
    }

    switch (decision.action) {
      case 'no-doorway':
        this.noDoor(plan);
        break;
      case 'place':
        this.place(decision.door, plan, fix.how, false);
        break;
      case 'move':
        this.out.log(
          `doorway moved by ${decision.distanceM.toFixed(2)} m and ${decision.angleDeg.toFixed(0)} deg ` +
            `after re-localisation (${decision.door.strong ? 'good' : 'weak'} match)`,
        );
        this.place(decision.door, plan, `${fix.how}, corrected`, !how.requested);
        break;
      case 'keep':
        // A way that answers all the time confirms all the time: one line when it matters.
        if (!this.isTrusted || !fix.continuous) {
          this.out.log(`doorway confirmed: the new answer is ${(decision.distanceM * 100).toFixed(0)} cm from the shown one`);
        }
        this.isTrusted = true;
        this.wasTrusted = true;
        this.out.setStatus('localized', 'doorway confirmed by a second look');
        break;
      case 'ignore':
        this.out.log(`weak answer ${decision.distanceM.toFixed(2)} m away from the trusted doorway ignored`);
        break;
      case 'retry':
        break;
    }
    return { decision, portal };
  }

  private writePlan(plan: ServerPlan): void {
    this.lastPlan = plan;
    if (getRoomScanState().serverPlan !== plan) {
      roomActions.setServerPlan(plan); // the room plan is drawn from the same answer as the door
    }
  }

  private place(door: DoorCandidate, plan: ServerPlan, how: string, automatic: boolean): void {
    this.shownDoor = door;
    this.isTrusted = door.strong;
    if (door.strong) {
      this.wasTrusted = true;
    }
    this.writePlan(plan);
    const portal = plan.portal;
    const width = portal?.width ?? null;
    const height = portal?.height ?? null;
    const sized = width !== null && height !== null && width > 0 && height > 0;
    const confidence = portal?.confidence ?? null;
    this.out.emitPose({
      pose: { position: door.position, rotation: door.rotation },
      opening: sized ? { width, height } : undefined,
      automatic,
      quality: {
        confidence: confidence ?? undefined,
        note: `server ${portal?.source ?? '?'}${confidence === null ? '' : `, confidence ${confidence.toFixed(2)}`}${door.strong ? '' : ', not confirmed'}`,
      },
    });
    this.out.setStatus(
      'localized',
      `doorway from the server (${portal?.source ?? '?'}` +
        (sized ? `, ${width.toFixed(2)} x ${height.toFixed(2)} m` : '') +
        `, ${how})${door.strong ? '' : ' - weak match, checking again'}`,
      { pending: !door.strong && !this.wasTrusted },
    );
  }

  private noDoor(plan: ServerPlan): void {
    this.writePlan(plan); // the walls are still worth drawing
    const found = plan.portal?.suggested ? 'the server found a doorway, which is only a suggestion' : 'the server found no doorway either';
    this.out.setStatus(
      'error',
      `no door has been saved in map "${plan.mapId}" (${found}). ` +
        (this.shownDoor ? 'The door shown is an earlier one. ' : 'Nothing was placed: ') +
        'place the door and save it ("Place the door" on Home)',
      { code: 'no-doorway' },
    );
  }
}
