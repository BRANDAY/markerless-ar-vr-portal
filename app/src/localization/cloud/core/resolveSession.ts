/**
 * Finding the saved doorway again in a new AR session ("resolving"), and keeping it in
 * place over the session. The same rules as the self-hosted provider, from
 * `localization/core/relocalization.ts`: a limited number of attempts per search, the
 * door is never moved or removed silently, a pose from before a tracking loss is kept on
 * screen but no longer trusted until the place is found again.
 *
 * The class has no timers, no clock and no ViroReact of its own: all of that comes in
 * through `ResolveSessionDeps`, so the rules are unit-tested with fakes. The provider
 * (`CloudAnchorDoorProvider.ts`) only connects it to the app.
 */
import { decide, type DoorCandidate, INTERRUPTION_GRACE_MS, retryDelayMs, TrackingWatch } from '../../core/relocalization';
import type { LocalizationReport, LocalizationStatus, Pose, StatusMeta, TrackingState } from '../../types';
import { doorFromAnchor } from './anchorMath';
import { classifyFailure, type CloudAnchorApi, type Failure, type ResolveOutcome } from './cloudAnchorApi';
import { type CloudDoorRecord, daysLeft, expiryState } from './doorRecord';
import type { Schedule } from './saveDoor';

export type SearchReason = 'start' | 'recovery' | 'manual';

export interface ResolveOptions {
  /**
   * One attempt may take this long. ViroReact's ReactVision provider ends a resolve by
   * itself after a 30 s window (`ViroARSceneNavigator.tsx:1075-1076`); ARCore keeps
   * looking until it is cancelled.
   */
  attemptTimeoutMs: number;
  maxAttempts: Record<SearchReason, number>;
}

export const DEFAULT_RESOLVE_OPTIONS: ResolveOptions = {
  attemptTimeoutMs: 35_000,
  maxAttempts: { start: 4, recovery: 4, manual: 2 },
};

export interface DoorUpdate {
  pose: Pose;
  opening?: { width: number; height: number };
  /** The door on screen is moved without the user asking. */
  automatic: boolean;
  note: string;
}

export interface ResolveSessionDeps {
  /** The cloud anchor calls, or null while the AR view is not there. */
  getApi(): CloudAnchorApi | null;
  now(): number;
  schedule: Schedule;
  log(message: string): void;
  getTracking(): TrackingState;
  onStatus(status: LocalizationStatus, detail: string, meta?: StatusMeta): void;
  onDoor(update: DoorUpdate): void;
  onReport(report: LocalizationReport): void;
}

const HOW_TO_LOOK = 'Stand where the doorway was saved, look at the wall and floor around it, and press "Re-localize"';

interface Search {
  reason: SearchReason;
  attempt: number;
  startedAt: number;
}

export class ResolveSession {
  private readonly options: ResolveOptions;
  private record: CloudDoorRecord | null = null;
  private running = false;

  private watch = new TrackingWatch();
  private interrupted = false;
  private waitingForTracking = false;

  private shown: DoorCandidate | null = null;
  private trusted = false;

  private search: Search | null = null;
  /** Changes whenever a running attempt becomes void. */
  private token = 0;
  private cancelTimer: (() => void) | null = null;
  private cancelGrace: (() => void) | null = null;

  constructor(
    private readonly deps: ResolveSessionDeps,
    options: Partial<ResolveOptions> = {},
  ) {
    this.options = { ...DEFAULT_RESOLVE_OPTIONS, ...options };
  }

  /** Begins looking for the doorway of `record` (null: nothing was saved on this phone). */
  start(record: CloudDoorRecord | null): void {
    this.stop();
    this.running = true;
    this.record = record;
    this.watch = new TrackingWatch();
    this.interrupted = false;
    this.shown = null;
    this.trusted = false;
    this.watch.onState(this.deps.getTracking(), this.deps.now());
    if (!record) {
      this.deps.onStatus('error', 'no doorway has been saved in the cloud on this phone yet', { code: 'no-room' });
      return;
    }
    const state = expiryState(record, this.deps.now());
    const left = daysLeft(record, this.deps.now());
    if (state === 'expired') {
      // The service decides: the lifetime may have been extended since the save.
      this.deps.log(`cloud: by this phone's record the anchor expired ${-left} day(s) ago - trying anyway`);
    } else if (state === 'expiring') {
      this.deps.log(`cloud: the anchor expires in ${left} day(s) - save the doorway again soon`);
    }
    this.begin('start');
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.voidAttempt(true);
    this.cancelGrace?.();
    this.cancelGrace = null;
    this.search = null;
    this.waitingForTracking = false;
  }

  /** "Re-localize": look for the doorway again now. */
  relocalize(): void {
    if (!this.running) {
      return;
    }
    if (!this.record) {
      this.deps.log('cloud: nothing to look for - no doorway has been saved');
      return;
    }
    this.begin('manual');
  }

  /** Call on every change of the AR tracking state. */
  onTracking(state: TrackingState): void {
    if (!this.running) {
      return;
    }
    const event = this.watch.onState(state, this.deps.now());
    if (event?.kind === 'left-normal') {
      this.cancelGrace?.();
      this.cancelGrace = this.deps.schedule(() => {
        this.cancelGrace = null;
        if (this.running && this.watch.isInterrupted(this.deps.now())) {
          this.markInterrupted();
        }
      }, INTERRUPTION_GRACE_MS + 50);
    } else if (event?.kind === 'hiccup') {
      this.cancelGrace?.();
      this.cancelGrace = null;
    } else if (event?.kind === 'recovered') {
      this.cancelGrace?.();
      this.cancelGrace = null;
      if (!this.interrupted) {
        this.markInterrupted();
      }
      this.interrupted = false;
      this.deps.log(`cloud: tracking is back after ${(event.gapMs / 1000).toFixed(1)} s - looking for the doorway again`);
      if (this.record) {
        this.begin(this.shown ? 'recovery' : 'start');
      }
      return;
    }
    if (state === 'normal' && this.waitingForTracking) {
      this.waitingForTracking = false;
      this.attempt();
    }
  }

  // ---- search -----------------------------------------------------------------------------

  private markInterrupted(): void {
    this.interrupted = true;
    this.voidAttempt(true);
    this.search = null;
    this.waitingForTracking = false;
    if (this.shown) {
      this.trusted = false;
      this.deps.onStatus(
        'lost',
        'tracking lost - the door stays where it was, but it may be off. Move the phone slowly over a part of the room with detail',
        { code: 'tracking-lost' },
      );
    } else {
      this.deps.onStatus('waiting-for-tracking', 'tracking lost - move the phone slowly over a part of the room with detail', {
        code: 'tracking-lost',
      });
    }
  }

  private begin(reason: SearchReason): void {
    this.voidAttempt(true);
    this.search = { reason, attempt: 0, startedAt: this.deps.now() };
    this.attempt();
  }

  /** Makes the result of a running attempt void; `cancelNative` also stops the service call. */
  private voidAttempt(cancelNative: boolean): void {
    this.token++;
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (cancelNative && this.search && this.search.attempt > 0) {
      this.deps.getApi()?.cancel();
    }
  }

  private attempt(): void {
    const search = this.search;
    const record = this.record;
    if (!this.running || !search || !record) {
      return;
    }
    if (this.deps.getTracking() !== 'normal') {
      this.waitingForTracking = true;
      if (!this.shown) {
        this.deps.onStatus('waiting-for-tracking', 'waiting for tracking NORMAL before looking for the doorway');
      }
      return;
    }
    const api = this.deps.getApi();
    if (!api) {
      this.search = null;
      this.deps.onStatus('error', 'cloud anchors are not available: the AR view has no cloud anchor calls', { code: 'incompatible' });
      return;
    }
    search.attempt++;
    const max = this.options.maxAttempts[search.reason];
    this.deps.onStatus(
      'localizing',
      `looking for the saved doorway (attempt ${search.attempt} of ${max}) - look at the wall and floor around it`,
      { attempt: search.attempt, attempts: max },
    );
    const token = ++this.token;
    this.cancelTimer = this.deps.schedule(() => {
      if (token !== this.token) {
        return;
      }
      this.cancelTimer = null;
      this.token++;
      api.cancel();
      this.onOutcome(search, { ok: false, state: 'Timeout', error: '' });
    }, this.options.attemptTimeoutMs);
    void api.resolve(record.cloudAnchorId).then((outcome) => {
      if (token !== this.token) {
        return; // stopped, interrupted, timed out or superseded meanwhile
      }
      this.cancelTimer?.();
      this.cancelTimer = null;
      this.token++;
      this.onOutcome(search, outcome);
    });
  }

  private onOutcome(search: Search, outcome: ResolveOutcome): void {
    const record = this.record;
    if (!this.running || !record || this.search !== search) {
      return;
    }
    if (outcome.ok) {
      const door = doorFromAnchor(outcome.pose, record.doorInAnchor);
      if (door) {
        this.onDoorFound(search, record, door);
        return;
      }
      this.onFailure(search, { reason: 'unknown', retry: true, text: 'the anchor came back with an unusable pose' }, 'BadAnchorPose');
      return;
    }
    this.onFailure(search, classifyFailure(outcome.state, outcome.error), outcome.state);
  }

  private onDoorFound(search: Search, record: CloudDoorRecord, door: Pose): void {
    const decision = decide(this.shown, this.trusted, { quality: 'good', alignmentStatus: 'ok', door });
    const elapsedMs = this.deps.now() - search.startedAt;
    const base = { reason: search.reason, attempts: search.attempt, elapsedMs, trusted: true };
    const left = daysLeft(record, this.deps.now());
    const expiring = expiryState(record, this.deps.now()) !== 'valid' ? ` - the cloud anchor expires in ${Math.max(left, 0)} day(s)` : '';
    this.search = null;
    this.trusted = true;
    if (decision.action === 'keep') {
      this.deps.log(`cloud: the doorway was found again ${(decision.distanceM * 100).toFixed(0)} cm from where it is shown - kept`);
      this.deps.onStatus('localized', `doorway confirmed by the cloud anchor${expiring}`);
      this.deps.onReport({ ...base, event: 'confirmed' });
      return;
    }
    const moved = decision.action === 'move';
    if (moved) {
      this.deps.log(`cloud: the doorway moves by ${(decision.distanceM * 100).toFixed(0)} cm / ${decision.angleDeg.toFixed(0)} deg`);
    }
    this.shown = { position: door.position, rotation: door.rotation, strong: true };
    this.deps.onDoor({
      pose: door,
      opening: record.opening ?? undefined,
      automatic: moved && search.reason !== 'manual',
      note: `cloud anchor (${record.service}), doorway ${record.doorSource === 'server' ? 'found by the server' : 'placed by hand'}`,
    });
    this.deps.onStatus('localized', `doorway from the cloud anchor${expiring}`);
    this.deps.onReport({ ...base, event: moved ? 'moved' : 'placed' });
  }

  private onFailure(search: Search, failure: Failure, state: string): void {
    this.deps.log(`cloud: attempt ${search.attempt} failed: ${state} - ${failure.text}`);
    const max = this.options.maxAttempts[search.reason];
    if (failure.retry && search.attempt < max) {
      this.deps.onStatus('localizing', `${failure.text} - trying again`, {
        attempt: search.attempt + 1,
        attempts: max,
        code: failure.reason === 'network' ? 'server-offline' : undefined,
      });
      this.token++;
      this.cancelTimer = this.deps.schedule(() => {
        this.cancelTimer = null;
        this.attempt();
      }, retryDelayMs(search.attempt + 1));
      return;
    }
    this.search = null;
    const elapsedMs = this.deps.now() - search.startedAt;
    const report = { reason: search.reason, attempts: search.attempt, elapsedMs };
    if (!failure.retry) {
      this.deps.onStatus('error', `${failure.text}. ${adviceFor(failure)}`, { code: failure.reason === 'gone' ? 'no-room' : 'incompatible' });
      this.deps.onReport({ ...report, event: this.shown ? 'kept' : 'not-found', trusted: false });
      return;
    }
    if (this.shown && this.trusted) {
      this.deps.onStatus('localized', 'doorway kept: the new look did not find it again');
      this.deps.onReport({ ...report, event: 'kept', trusted: true });
      return;
    }
    if (this.shown) {
      this.deps.onStatus('lost', `the doorway could not be confirmed after tracking was lost - it may be off. ${HOW_TO_LOOK}`, {
        code: 'unconfirmed',
      });
      this.deps.onReport({ ...report, event: 'kept', trusted: false });
      return;
    }
    this.deps.onStatus('lost', `${failure.text} after ${search.attempt} attempts. ${failure.reason === 'network' ? 'Check the internet connection' : HOW_TO_LOOK}`, {
      code: failure.reason === 'network' ? 'server-offline' : 'not-recognised',
    });
    this.deps.onReport({ ...report, event: 'not-found', trusted: false });
  }
}

function adviceFor(failure: Failure): string {
  switch (failure.reason) {
    case 'gone':
      return 'Save the doorway to the cloud again';
    case 'not-authorised':
      return 'The app build must be registered in the cloud project (see docs/cloud/cloud-connection.md)';
    case 'not-supported':
      return 'This build was made without a cloud provider';
    default:
      return 'Update the app';
  }
}
