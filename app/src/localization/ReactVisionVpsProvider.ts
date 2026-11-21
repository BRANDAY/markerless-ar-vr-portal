import { currentRoomId, vpsOfRoom } from '../room/roomsStore';
import { roomActions, type ServerPlan } from '../room/roomStore';
import type { ServerPortal } from '../server/core/roomPlan';
import { getPrefs } from '../state/prefs';
import { BaseProvider } from './BaseProvider';
import { INTERRUPTION_GRACE_MS, TrackingWatch } from './core/relocalization';
import {
  cameraMatrix,
  type FlatPose,
  mapInSession,
  type MapInSession,
  parseRenderPose,
  SteadyAlignment,
  toSession,
  yawFromQuaternion,
} from './core/vpsAlignment';
import { differs, VPS_MOVE, VPS_REPUBLISH, VPS_SEARCH, vpsProblem, vpsSearchAttempt } from './core/vpsStatus';
import type { LocalizationContext, LocalizationReport, ProviderId, TrackingState, Unsubscribe } from './types';
import { reactVisionConfigured, vpsBridge, type VpsEvent } from './vpsBridge';

/** The room as the service knows it, with the door staff saved in the service's map. */
interface CloudRoom {
  mapId: string;
  locationId: string;
  door: FlatPose | null;
  width: number | null;
  height: number | null;
}

const ORIGIN: FlatPose = { position: [0, 0, 0], yawDeg: 0 };

/**
 * ReactVision Advanced VPS: the second way to find a room (`ui-spec.md`, 5.15;
 * `docs/cloud/cloud-connection.md`). The room was scanned once into the vendor's cloud and
 * has a location id there; the phone downloads that location's map, matches the camera
 * against it and learns where the map lies in the running AR session. The door is then
 * put at the place staff saved IN THAT MAP.
 *
 * What comes from where:
 *  - the keys: built into the app from a file outside the repository (`app.config.js`).
 *    A build without them reports "not set up" and does nothing else;
 *  - the room's location id and the door in the service's map: from the venue's own
 *    server (`GET /maps`, field `vps`), or from the copy the phone kept of it. The
 *    service itself has no call to store a placed object;
 *  - the matching: the library's `<ViroVPS>` (`ar/VpsLayer.tsx`), asked through
 *    `vpsBridge`. The location is always named - never `"auto"`, which starts from GPS.
 *
 * The door is NOT put inside the library's `<ViroVPSAnchor>`: that moves its content
 * every frame, and the portal must not move while somebody walks through it. Instead the
 * map's place in the session is worked out here (`core/vpsAlignment.ts`: the service's
 * camera pose against the AR engine's, several steady readings averaged) and the door
 * goes out through `emitPose` like every other door; later corrections are marked
 * `automatic`, so they wait while the user is inside the space.
 *
 * NOT RUN AT ALL: there is no ReactVision account yet. Neither a device nor the service
 * has seen this code; what it assumes about the service is listed in the README.
 */
export class ReactVisionVpsProvider extends BaseProvider {
  readonly id: ProviderId = 'reactvision-vps';
  readonly displayName = 'ReactVision Advanced VPS';

  private subscriptions: Unsubscribe[] = [];
  private stopped = true;
  /** Changes whenever running work becomes void (stop, a new start). */
  private run = 0;

  private room: CloudRoom | null = null;
  private watch = new TrackingWatch();
  private interrupted = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  /** The library has been asked to track the room's location. */
  private requested = false;
  private searchStartedAt = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private steady = new SteadyAlignment();
  /** The alignment the placing screen was told about last. */
  private published: MapInSession | null = null;
  /** The door on screen, in this session. */
  private shown: FlatPose | null = null;
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
    this.published = null;
    this.shown = null;
    this.lastState = '';
    this.badReadings = 0;
    roomActions.setFound(null);
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
    roomActions.setFound(null);
    this.subscriptions.forEach((off) => off());
    this.subscriptions = [];
  }

  /** "Find the door again": the place is looked for anew. */
  relocalize(): void {
    if (this.stopped) {
      return;
    }
    if (!this.room) {
      void this.prepare(); // e.g. the location id has been entered meanwhile
      return;
    }
    this.context?.log('reactvision: looking for the place again');
    this.search();
  }

  // ---- set-up -----------------------------------------------------------------------------

  /** Keys, room, location id: everything that has to be there before the service is asked. */
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
    const yaw = entry.door ? yawFromQuaternion(entry.door.quaternion) : null;
    this.room = {
      mapId,
      locationId: entry.locationId,
      door: entry.door && yaw !== null ? { position: entry.door.position, yawDeg: yaw } : null,
      width: entry.door?.width ?? null,
      height: entry.door?.height ?? null,
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
      if (!this.interrupted && !this.shown) {
        this.setStatus('waiting-for-tracking', 'waiting for tracking NORMAL before looking for the place');
      }
      return; // `onTracking` comes back here
    }
    this.steady.reset();
    this.published = null;
    roomActions.setFound(null);
    this.searchStartedAt = Date.now();
    this.requested = true;
    vpsBridge.track(room.locationId, getPrefs().vpsServerMode ? 'server' : 'device');
    if (this.shown) {
      this.setStatus('localizing', 'checking the door position through ReactVision', { attempt: 1, attempts: 5 });
    }
    this.tickSearch();
  }

  /** The search has no attempts of its own: the coach lines follow the time it takes. */
  private tickSearch(): void {
    this.clearSearchTimer();
    if (this.stopped || !this.requested || this.published) {
      return;
    }
    const elapsedS = (Date.now() - this.searchStartedAt) / 1000;
    const attempt = vpsSearchAttempt(elapsedS);
    if (attempt === null) {
      if (this.shown) {
        // The door stays; only its place could not be checked.
        this.setStatus('lost', 'the door is shown where it was, but ReactVision did not recognise the place again', {
          code: 'unconfirmed',
        });
        this.report('kept', false);
      } else {
        vpsBridge.stop();
        this.requested = false;
        this.setStatus('lost', `the place was not recognised within ${VPS_SEARCH.giveUpS} s`, { code: 'not-recognised' });
        this.report('not-found', false);
      }
      return;
    }
    if (!this.shown && !this.interrupted) {
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
    if (this.shown) {
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
    const map = this.steady.add(reading, Date.now(), room.door ?? ORIGIN);
    if (map) {
      this.apply(room, map, inliers);
    }
  }

  /** The map's place in the session is known (again): the door follows from it. */
  private apply(room: CloudRoom, map: MapInSession, inliers: number | null): void {
    const at = room.door ?? ORIGIN;
    const first = this.published === null;
    const doorHere = room.door ? toSession(map, room.door) : null;
    if (!this.published || differs(toSession(map, at), toSession(this.published, at), VPS_REPUBLISH)) {
      this.published = map;
      roomActions.setFound({
        mapId: room.mapId,
        sessionId: '',
        strong: true,
        plan: planOf(room, doorHere),
        vps: { locationId: room.locationId, map },
      });
    }
    this.clearSearchTimer();
    const note = `ReactVision${inliers === null ? '' : `, ${inliers} inliers`}`;
    if (!doorHere) {
      if (first) {
        this.setStatus('error', `no door has been saved for ReactVision in room "${room.mapId}" - place the door and save it`, {
          code: 'no-doorway',
        });
        this.report('no-doorway', true, inliers);
      }
      return;
    }
    const opening = room.width && room.height ? { width: room.width, height: room.height } : undefined;
    const pose = { position: doorHere.position, rotation: [0, doorHere.yawDeg, 0] as [number, number, number] };
    if (!this.shown) {
      this.shown = doorHere;
      this.emitPose({ pose, opening, quality: { note } });
      this.setStatus('localized', `door from the place's map (${note})`);
      this.report('placed', true, inliers);
    } else if (differs(doorHere, this.shown, VPS_MOVE)) {
      this.context?.log('reactvision: the door moved after the place was recognised again');
      this.shown = doorHere;
      this.emitPose({ pose, opening, automatic: true, quality: { note } });
      this.setStatus('localized', `door corrected (${note})`);
      this.report('moved', true, inliers);
    } else if (this.getStatus() !== 'localized') {
      this.setStatus('localized', 'door confirmed by a new look');
      this.report('confirmed', true, inliers);
    }
  }

  // ---- AR tracking ------------------------------------------------------------------------

  private onTracking(state: TrackingState): void {
    const event = this.watch.onState(state, Date.now());
    if (state === 'normal' && !event) {
      if (this.room && !this.requested && !this.published) {
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
    this.steady.reset();
    this.published = null;
    roomActions.setFound(null); // nothing can be saved through a frame that was interrupted
    this.clearSearchTimer();
    this.setStatus(
      'lost',
      this.shown ? 'tracking lost - the door stays where it was, but it may be off' : 'tracking lost - move the phone slowly',
      { code: 'tracking-lost' },
    );
  }

  // ---- helpers ----------------------------------------------------------------------------

  private report(event: LocalizationReport['event'], trusted: boolean, inliers: number | null = null): void {
    this.context?.reportLocalization({
      event,
      reason: 'start',
      attempts: 0,
      elapsedMs: this.searchStartedAt ? Date.now() - this.searchStartedAt : null,
      trusted,
      server: { quality: 'reactvision', inliers, source: 'manual', confidence: null },
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

/**
 * What the placing screen reads: the door staff saved for this way, in the session's
 * frame, in the form the venue's own server gives its door. There is no room plan and no
 * suggested doorway on this way.
 */
function planOf(room: CloudRoom, doorHere: FlatPose | null): ServerPlan {
  const portal: ServerPortal = {
    source: doorHere ? 'manual' : 'none',
    confirmed: doorHere !== null,
    openingId: null,
    position: doorHere ? doorHere.position : null,
    rotation: doorHere ? [0, doorHere.yawDeg, 0] : null,
    width: doorHere ? room.width : null,
    height: doorHere ? room.height : null,
    confidence: null,
    updatedUtc: '',
    suggested: null,
    reason: doorHere ? '' : 'no door has been saved for ReactVision',
  };
  return { mapId: room.mapId, origin: 'localize', room: null, portal };
}
