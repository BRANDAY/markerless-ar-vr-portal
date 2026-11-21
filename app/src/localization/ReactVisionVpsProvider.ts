import { applyToPoint } from '../door/core/roomFrame';
import { DoorPlacer } from '../door/DoorPlacer';
import { keptDoorPosition } from '../door/doorRecords';
import { currentRoomId, vpsOfRoom } from '../room/roomsStore';
import { getPrefs } from '../state/prefs';
import { BaseProvider } from './BaseProvider';
import { INTERRUPTION_GRACE_MS, TrackingWatch } from './core/relocalization';
import { cameraMatrix, type FlatPose, mapInSession, type MapInSession, parseRenderPose, SteadyAlignment, toSession } from './core/vpsAlignment';
import { differs, VPS_REPUBLISH, VPS_SEARCH, vpsProblem, vpsSearchAttempt } from './core/vpsStatus';
import { roomThroughBridge } from './core/ways';
import type { LocalizationContext, LocalizationReport, ProviderId, TrackingState, Unsubscribe } from './types';
import { reactVisionConfigured, vpsBridge, type VpsEvent } from './vpsBridge';

/** The room as this way needs it: its place at the service and its bridge. Nothing about the door. */
interface CloudRoom {
  mapId: string;
  locationId: string;
  /** `T_service_from_map`: the room's frame in the service's map. */
  serviceFromRoom: number[];
  /** The frame of the room the bridge was measured for. */
  frameId: string;
  /** Where agreement between readings is judged, in the service's map: at the door, else at the room's origin. */
  judgedAt: FlatPose;
}

/** While one answer is with the door layer, the next ones wait; and they do not come more often than this. */
const MIN_ANSWER_GAP_MS = 2000;

/**
 * ReactVision Advanced VPS: the second way to recognise a room (`ui-spec.md`, 5.15;
 * `docs/cloud/cloud-connection.md`; `localization-server/docs/api-v2.md`, section 11).
 * Like every way it answers one question - WHERE THE ROOM'S FRAME LIES IN THIS AR SESSION
 * - and hands that to the door layer (`door/DoorPlacer.ts`), which puts the room's one
 * door there. It knows nothing about the door.
 *
 * The room was scanned once into the vendor's cloud and has a location id there. The
 * phone downloads that location's map, matches the camera against it and learns where
 * THE SERVICE'S MAP lies in the running AR session. The room's bridge - how the service's
 * map lies in the room's frame, measured once by staff and kept by the venue's server -
 * turns that into where the room lies:
 *
 *   room in the session = service's map in the session x room in the service's map
 *
 * What comes from where:
 *  - the keys: built into the app from a file outside the repository (`app.config.js`).
 *    A build without them reports "not set up" and does nothing else;
 *  - the room's place at the service and its bridge: from the venue's own server
 *    (`GET /maps`, field `vps`), or from the copy the phone kept of it;
 *  - the matching: the library's `<ViroVPS>` (`ar/VpsLayer.tsx`), asked through
 *    `vpsBridge`. The location is always named - never `"auto"`, which starts from GPS.
 *
 * The door is NOT put inside the library's `<ViroVPSAnchor>`: that moves its content
 * every frame, and the portal must not move while somebody walks through it. The
 * service's readings are steadied here (`core/vpsAlignment.ts`: the service's camera pose
 * against the AR engine's, several agreeing readings averaged), and an answer goes to the
 * door layer only when it differs from the one before; what a new answer does to a door
 * that stands is the door layer's rule, the same as for the venue's server.
 *
 * NOT RUN AT ALL: there is no ReactVision account yet. Neither a device nor the service
 * has seen this code; what it assumes about the service is listed in the README.
 */
export class ReactVisionVpsProvider extends BaseProvider {
  readonly id: ProviderId = 'reactvision-vps';
  readonly displayName = 'ReactVision Advanced VPS';

  private subscriptions: Unsubscribe[] = [];
  private stopped = true;
  /** Changes whenever running work becomes void (stop, a new start, tracking lost). */
  private run = 0;

  private readonly door = new DoorPlacer({
    emitPose: (update) => this.emitPose(update),
    setStatus: (status, detail, meta) => this.setStatus(status, detail, meta),
    log: (text) => this.context?.log(`reactvision: ${text}`),
  });

  private room: CloudRoom | null = null;
  private watch = new TrackingWatch();
  private interrupted = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  /** The library has been asked to track the room's location. */
  private requested = false;
  private searchStartedAt = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private steady = new SteadyAlignment();
  /** The answer the door layer was given last. */
  private answered: MapInSession | null = null;
  private answeredAt = 0;
  /** An answer is with the door layer. */
  private busy = false;
  /** The user asked for this look: a correction may then be applied at once. */
  private asked = false;
  private lastState = '';
  private badReadings = 0;

  protected onStart(context: LocalizationContext): void {
    this.stopped = false;
    this.run++;
    this.room = null;
    this.watch = new TrackingWatch();
    this.interrupted = false;
    this.requested = false;
    this.steady.reset();
    this.answered = null;
    this.busy = false;
    this.asked = false;
    this.lastState = '';
    this.badReadings = 0;
    this.door.reset();
    this.watch.onState(context.getTrackingState(), Date.now());
    this.subscriptions = [
      vpsBridge.onEvent((event) => this.onVps(event)),
      context.onTrackingState((state) => this.onTracking(state)),
    ];
    this.setStatus('connected', 'checking the ReactVision set-up');
    void this.prepare();
  }

  protected onStop(): void {
    this.stopped = true;
    this.run++;
    this.clearTimers();
    vpsBridge.stop();
    this.requested = false;
    this.door.reset();
    this.subscriptions.forEach((off) => off());
    this.subscriptions = [];
  }

  /** "Find the door again": the place is looked for anew. */
  relocalize(): void {
    if (this.stopped) {
      return;
    }
    if (!this.room) {
      void this.prepare(); // e.g. the bridge has been measured meanwhile
      return;
    }
    this.context?.log('reactvision: looking for the place again');
    this.asked = true;
    this.search();
  }

  // ---- set-up -----------------------------------------------------------------------------

  /** Keys, room, place, bridge: everything that has to be there before the service is asked. */
  private async prepare(): Promise<void> {
    const run = this.run;
    const configured = await reactVisionConfigured();
    if (this.stopped || run !== this.run) {
      return;
    }
    if (!configured) {
      this.setStatus(
        'error',
        'not set up: this build has no ReactVision keys (reactvision-app.json was not in the secrets folder when the app was built)',
        { code: 'cloud-not-set-up' },
      );
      return;
    }
    const mapId = currentRoomId();
    if (!mapId) {
      this.setStatus('error', 'no room yet - scan the room first', { code: 'no-room' });
      return;
    }
    const entry = vpsOfRoom(mapId);
    if (!entry) {
      this.setStatus(
        'error',
        `room "${mapId}" has no location id at ReactVision - enter it under Settings > Connection`,
        { code: 'cloud-not-set-up' },
      );
      return;
    }
    if (!entry.bridge) {
      this.setStatus(
        'error',
        `room "${mapId}" is not linked to its ReactVision location yet (no bridge, or the room was scanned again) - ` +
          'link it under Settings > Connection',
        { code: 'cloud-not-set-up' },
      );
      return;
    }
    // Agreement between readings matters where the door is: a small error in the turn is
    // a large one far from the map's origin. The door layer says where that is.
    const interest = keptDoorPosition(mapId) ?? [0, 0, 0];
    this.room = {
      mapId,
      locationId: entry.locationId,
      serviceFromRoom: entry.bridge.serviceFromRoom,
      frameId: entry.bridge.frameId,
      judgedAt: { position: applyToPoint(entry.bridge.serviceFromRoom, interest), yawDeg: 0 },
    };
    this.search();
  }

  /** Asks the library to track the room's location (again), once tracking is usable. */
  private search(): void {
    const room = this.room;
    if (this.stopped || !room) {
      return;
    }
    if (this.context?.getTrackingState() !== 'normal') {
      if (!this.interrupted && !this.door.shown) {
        this.setStatus('waiting-for-tracking', 'waiting for tracking NORMAL before looking for the place');
      }
      return; // `onTracking` comes back here
    }
    this.steady.reset();
    this.answered = null;
    this.searchStartedAt = Date.now();
    this.requested = true;
    vpsBridge.track(room.locationId, getPrefs().vpsServerMode ? 'server' : 'device');
    if (this.door.shown) {
      this.setStatus('localizing', 'checking the door position through ReactVision', { attempt: 1, attempts: 5 });
    }
    this.tickSearch();
  }

  /** The search has no attempts of its own: the coach lines follow the time it takes. */
  private tickSearch(): void {
    this.clearSearchTimer();
    if (this.stopped || !this.requested || this.answered) {
      return;
    }
    const elapsedS = (Date.now() - this.searchStartedAt) / 1000;
    const attempt = vpsSearchAttempt(elapsedS);
    if (attempt === null) {
      if (this.door.shown) {
        // The door stays; only its place could not be checked.
        this.setStatus('lost', 'the door is shown where it was, but ReactVision did not recognise the place again', {
          code: 'unconfirmed',
        });
        this.report('kept');
      } else {
        vpsBridge.stop();
        this.requested = false;
        this.setStatus('lost', `the place was not recognised within ${VPS_SEARCH.giveUpS} s`, { code: 'not-recognised' });
        this.report('not-found');
      }
      return;
    }
    if (!this.door.shown && !this.interrupted) {
      this.setStatus('localizing', `looking for the place through ReactVision (${this.lastState || 'starting'})`, {
        attempt,
        attempts: 5,
      });
    }
    this.searchTimer = setTimeout(() => this.tickSearch(), 1000);
  }

  // ---- what the library reports -------------------------------------------------------------

  private onVps(event: VpsEvent): void {
    if (this.stopped || !this.room) {
      return;
    }
    switch (event.kind) {
      case 'started':
        if (!event.success) {
          this.fail(event.code, event.message || 'the place could not be loaded');
        }
        return;
      case 'state':
        if (event.state !== this.lastState) {
          this.lastState = event.state;
          this.context?.log(`reactvision: ${event.state}${event.message ? ` - ${event.message}` : ''}`);
        }
        if (event.state === 'error' || event.state === 'unsupported') {
          this.fail(event.state === 'unsupported' ? 'UNSUPPORTED' : event.code, event.message || event.state);
        }
        return;
      case 'localized':
        this.onReading(event.renderPose, event.inliers);
        return;
    }
  }

  /** The service cannot go on. A door that stands stays; without one the status says why. */
  private fail(code: string, message: string): void {
    const problem = vpsProblem(code);
    if (problem === null) {
      return;
    }
    this.context?.log(`reactvision: ${problem} (${code || 'no code'}) - ${message}`);
    if (this.door.shown) {
      return;
    }
    this.clearSearchTimer();
    this.requested = false;
    vpsBridge.stop();
    this.setStatus('error', `ReactVision: ${message}`, { code: problem === 'not-set-up' ? 'cloud-not-set-up' : 'cloud-offline' });
  }

  /** One converged pose of the service: the camera in the frame of the service's map. */
  private onReading(renderPose: string, inliers: number | null): void {
    const room = this.room;
    const camera = this.context?.getCameraPose();
    if (!room || !camera || this.interrupted || this.context?.getTrackingState() !== 'normal') {
      return;
    }
    const reading = mapInSession(cameraMatrix(camera.position, camera.forward, camera.up), parseRenderPose(renderPose));
    if (!reading) {
      // Not a pose, or the two cameras did not belong together (the phone was moving).
      if (++this.badReadings === 10) {
        this.context?.log('reactvision: ten readings in a row could not be used (tilted map frame or unreadable pose)');
      }
      return;
    }
    this.badReadings = 0;
    const map = this.steady.add(reading, Date.now(), room.judgedAt);
    if (!map || this.busy) {
      return;
    }
    const now = Date.now();
    const news =
      this.answered === null ||
      (now - this.answeredAt >= MIN_ANSWER_GAP_MS && differs(toSession(map, room.judgedAt), toSession(this.answered, room.judgedAt), VPS_REPUBLISH));
    if (news) {
      void this.answer(room, map, inliers);
    }
  }

  /** The service's map is placed in the session (again): through the bridge, that is where the room is. */
  private async answer(room: CloudRoom, map: MapInSession, inliers: number | null): Promise<void> {
    const run = this.run;
    const first = this.answered === null;
    const requested = this.asked;
    this.answered = map;
    this.answeredAt = Date.now();
    this.asked = false;
    this.busy = true;
    this.clearSearchTimer();
    const placed = await this.door.roomRecognised(
      {
        mapId: room.mapId,
        frameId: room.frameId,
        transform: roomThroughBridge(map, room.serviceFromRoom),
        strong: true,
        how: `recognised through ReactVision${inliers === null ? '' : `, ${inliers} inliers`}`,
        continuous: !requested,
      },
      { requested },
    );
    this.busy = false;
    if (!placed || this.stopped || run !== this.run) {
      return;
    }
    switch (placed.decision.action) {
      case 'place':
        this.report('placed', inliers, placed.portal?.source ?? null);
        break;
      case 'move':
        this.report('moved', inliers, placed.portal?.source ?? null);
        break;
      case 'keep':
        if (first) {
          this.report('confirmed', inliers, placed.portal?.source ?? null);
        }
        break;
      case 'no-doorway':
        if (first) {
          this.report('no-doorway', inliers);
        }
        break;
      case 'retry':
        // The place is recognised, but the door layer has no door record: neither the
        // venue's server nor a copy on this phone.
        this.context?.log(`reactvision: ${placed.decision.why}`);
        this.answered = null; // the next steady reading asks again
        if (!this.door.shown) {
          this.setStatus('waiting-for-server', `the place is recognised, but ${placed.decision.why}`, { code: 'server-offline' });
        }
        break;
      case 'ignore':
        break;
    }
  }

  // ---- AR tracking ------------------------------------------------------------------------

  private onTracking(state: TrackingState): void {
    const event = this.watch.onState(state, Date.now());
    if (state === 'normal' && !event) {
      if (this.room && !this.requested && !this.answered) {
        this.search(); // the first NORMAL of the session
      }
      return;
    }
    if (!event) {
      return;
    }
    if (event.kind === 'left-normal') {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        if (!this.stopped && this.watch.isInterrupted(Date.now())) {
          this.markInterrupted();
        }
      }, INTERRUPTION_GRACE_MS + 50);
      return;
    }
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (event.kind === 'hiccup') {
      return;
    }
    // Back after a real interruption: the session's frame may have changed.
    this.markInterrupted();
    this.interrupted = false;
    this.context?.log(`reactvision: tracking is back after ${(event.gapMs / 1000).toFixed(1)} s - looking for the place again`);
    this.search();
  }

  private markInterrupted(): void {
    if (this.interrupted) {
      return;
    }
    this.interrupted = true;
    this.run++; // an answer on its way belonged to the frame that was interrupted
    this.busy = false;
    this.steady.reset();
    this.answered = null;
    this.door.distrust();
    this.clearSearchTimer();
    this.setStatus(
      'lost',
      this.door.shown ? 'tracking lost - the door stays where it was, but it may be off' : 'tracking lost - move the phone slowly',
      { code: 'tracking-lost' },
    );
  }

  // ---- helpers ----------------------------------------------------------------------------

  private report(event: LocalizationReport['event'], inliers: number | null = null, source: string | null = null): void {
    this.context?.reportLocalization({
      event,
      reason: 'start',
      attempts: 0,
      elapsedMs: this.searchStartedAt ? Date.now() - this.searchStartedAt : null,
      trusted: this.door.trusted,
      server: { quality: 'reactvision', inliers, source, confidence: null },
    });
  }

  private clearSearchTimer(): void {
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearSearchTimer();
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}
