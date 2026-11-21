import { DEFAULT_MAP_ID, localizeWithClip } from '../room/roomServer';
import { getRoomScanState, roomActions, subscribeRoomScan, type ServerPlan } from '../room/roomStore';
import { formatAddress } from '../server/core/address';
import type { ConnectionSnapshot } from '../server/core/connectionMachine';
import type { ServerPortal } from '../server/core/roomPlan';
import { SESSION_ID } from '../server/identity';
import { serverConnection } from '../server/ServerConnection';
import { BaseProvider } from './BaseProvider';
import {
  decide,
  type Decision,
  type DoorCandidate,
  type EpisodeReason,
  INTERRUPTION_GRACE_MS,
  MAX_ATTEMPTS,
  retryDelayMs,
  TrackingWatch,
  wantsAnotherAttempt,
} from './core/relocalization';
import type { LocalizationContext, LocalizationReport, ProviderId, TrackingState, Unsubscribe } from './types';

/** While a scan recording runs the recorder is busy; look again after this long. */
const RECORDER_BUSY_RETRY_MS = 2000;
/** Pause before a weak pose is checked again. */
const CONFIRM_DELAY_MS = 3000;

/** One search for the room: a limited number of attempts for one reason. */
interface Episode {
  reason: EpisodeReason;
  /** Reason of the search this one continues (a `confirm` episode follows another one). */
  origin: EpisodeReason;
  attempt: number;
  /** Attempts of the episodes this one continues. */
  earlier: number;
  lastWhy: string;
  /** `Date.now()` when the search began. */
  startedAt: number;
  /** The server's description of its latest answer in this search. */
  server?: LocalizationReport['server'];
}

const HOW_TO_LOOK = 'Look at a part of the room that was scanned (not a bare wall) and press "Re-localize"';

/**
 * Self-hosted localization server on the local network: the doorway is the REAL door
 * opening the server found in the scanned room.
 *
 * Two ways to a doorway pose in the current AR session:
 *  - the room was scanned and built in this very session: the server's plan is already in
 *    this session's frame (`roomStore.serverPlan`, set after a build);
 *  - otherwise a short clip with camera poses goes to `POST /localize`, and the answer
 *    carries the plan and the doorway transformed into this session's frame.
 *
 * Looking for the room happens in EPISODES (session start, tracking came back, the user
 * pressed "Re-localize", a weak answer is being confirmed). An episode makes a limited
 * number of attempts with growing pauses and then tells the user what to do. What each
 * answer means for the door on screen is decided by `core/relocalization.ts`:
 * the door is placed, kept, moved (with a log line saying by how much) - never moved
 * silently and never removed.
 *
 * When tracking is interrupted the door stays where it is but is no longer trusted, the
 * status says so, and the room is looked for again as soon as tracking is back. The
 * server-side session id changes then, because the AR world frame may have changed.
 *
 * If the server found no door opening, nothing is placed and the status says so. There
 * is no fallback position: placing the door by hand is the `manual` provider's job.
 */
export class SelfHostedServerProvider extends BaseProvider {
  readonly id: ProviderId = 'self-hosted';
  readonly displayName = 'Self-hosted server';

  private subscriptions: Unsubscribe[] = [];
  private stopped = true;
  private connected = false;

  private watch = new TrackingWatch();
  private interrupted = false;
  /** Counts the AR world frames of this app run: +1 after every interruption of tracking. */
  private worldEpoch = 0;
  /** Changes whenever running work becomes void (stop, interruption, a new episode). */
  private generation = 0;

  /** The door on screen, and whether its pose is believed. */
  private shown: DoorCandidate | null = null;
  private trusted = false;
  /** The plan this provider has dealt with last (so that the store's echo is ignored). */
  private handledPlan: ServerPlan | null = null;

  private episode: Episode | null = null;
  private busy = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  /** `http://host:port` of the connected server, or null. */
  getBaseUrl(): string | null {
    return serverConnection.getBaseUrl();
  }

  protected onStart(context: LocalizationContext): void {
    this.stopped = false;
    this.connected = false;
    this.watch = new TrackingWatch();
    this.interrupted = false;
    this.shown = null;
    this.trusted = false;
    this.handledPlan = null;
    this.episode = null;
    this.busy = false;
    this.generation++;
    this.watch.onState(context.getTrackingState(), Date.now());
    this.subscriptions = [
      serverConnection.subscribe((view) => this.follow(view.connection)),
      subscribeRoomScan(() => this.onStorePlan()),
      context.onTrackingState((state) => this.onTracking(state)),
    ];
    this.follow(serverConnection.getView().connection);
    this.onStorePlan();
  }

  protected onStop(): void {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    this.episode = null;
    this.subscriptions.forEach((off) => off());
    this.subscriptions = [];
  }

  /** "Re-localize": look for the room again now, whatever is shown. */
  relocalize(): void {
    if (this.stopped) {
      return;
    }
    if (this.busy) {
      this.context?.log('self-hosted: already looking for the room');
      return;
    }
    this.begin('manual');
  }

  // ---- inputs ---------------------------------------------------------------------------

  private follow(connection: ConnectionSnapshot): void {
    const { state, address } = connection;
    const wasConnected = this.connected;
    this.connected = state === 'connected';
    if (this.connected) {
      // The connection reports every heartbeat; only the change to "connected" matters
      // here, otherwise a status such as "room not recognised" would be overwritten.
      if (!wasConnected) {
        if (!this.shown && !this.episode) {
          this.setStatus('connected', 'connected to the server');
          this.begin('start');
        } else if (this.episode && !this.busy) {
          this.scheduleAttempt(0); // an episode that was waiting for the server
        }
      }
      return;
    }
    if (this.shown) {
      // A door that is placed needs no server; only say that looking again is not possible.
      if (wasConnected) {
        this.context?.log('self-hosted: server connection lost - the doorway stays where it is');
      }
      return;
    }
    const where = address ? ` ${formatAddress(address)}` : '';
    switch (state) {
      case 'not-configured':
        this.setStatus('waiting-for-server', 'no server address - tap the server chip to set it up');
        break;
      case 'searching':
        this.setStatus('waiting-for-server', 'searching for the server');
        break;
      case 'connecting':
        this.setStatus('waiting-for-server', `connecting to${where}`);
        break;
      case 'incompatible':
        this.setStatus('error', `incompatible server at${where}: ${connection.detail}`);
        break;
      default:
        this.setStatus('waiting-for-server', `server${where} unreachable: ${connection.detail}`);
    }
  }

  /** A plan that appeared in the store after a map build: it is in this session's frame. */
  private onStorePlan(): void {
    const plan = getRoomScanState().serverPlan;
    if (this.stopped || !plan || plan === this.handledPlan || plan.origin !== 'build') {
      return;
    }
    this.handledPlan = plan;
    this.cancelEpisode();
    const door = candidateFrom(plan.portal, true);
    const server = {
      quality: 'build',
      inliers: null,
      source: plan.portal?.source ?? null,
      confidence: plan.portal?.confidence ?? null,
    };
    if (!door) {
      this.reportNoDoorway(plan);
      this.report('no-doorway', null, server);
      return;
    }
    // Built from a recording of a frame that has been interrupted since: show, do not trust.
    this.place(door, plan, !this.interrupted, 'this scan');
    this.report('placed', null, server);
  }

  private onTracking(state: TrackingState): void {
    const now = Date.now();
    const event = this.watch.onState(state, now);
    if (state === 'normal' && !event) {
      // First NORMAL of the session (or nothing had happened): start if there is nothing yet.
      if (this.connected && !this.shown && !this.episode) {
        this.begin('start');
      } else if (this.episode && !this.busy) {
        this.scheduleAttempt(0);
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
      if (this.episode && !this.busy) {
        this.scheduleAttempt(0);
      }
      return;
    }
    // Recovered after a real interruption.
    this.markInterrupted();
    this.interrupted = false;
    this.worldEpoch++;
    this.context?.log(
      `self-hosted: tracking is back after ${(event.gapMs / 1000).toFixed(1)} s - ` +
        (this.shown ? 'checking the doorway position' : 'looking for the room'),
    );
    this.begin('recovery');
  }

  private markInterrupted(): void {
    if (this.interrupted) {
      return;
    }
    this.interrupted = true;
    this.trusted = false;
    this.generation++; // a clip recorded across the interruption is worthless
    this.clearRetryTimer();
    this.context?.log('self-hosted: tracking lost');
    this.setStatus(
      'lost',
      this.shown
        ? 'tracking lost - the doorway stays where it was, but it may be off. Move the phone slowly over a part of the room with detail'
        : 'tracking lost - move the phone slowly over a part of the room with detail',
    );
  }

  // ---- episodes -------------------------------------------------------------------------

  private begin(reason: EpisodeReason): void {
    if (this.stopped) {
      return;
    }
    this.clearRetryTimer();
    this.generation++;
    this.episode = { reason, origin: reason, attempt: 0, earlier: 0, lastWhy: '', startedAt: Date.now() };
    this.scheduleAttempt(0);
  }

  private cancelEpisode(): void {
    this.clearRetryTimer();
    this.generation++;
    this.episode = null;
  }

  private scheduleAttempt(delayMs: number): void {
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attempt();
    }, delayMs);
  }

  private async attempt(): Promise<void> {
    const episode = this.episode;
    if (this.stopped || !episode || this.busy) {
      return;
    }
    // What has to be there before a clip can be sent. The episode waits; the input
    // handlers above start it again when the missing thing arrives.
    if (!this.connected) {
      if (!this.shown) {
        this.setStatus('waiting-for-server', 'the server is not connected');
      }
      return;
    }
    if (this.context?.getTrackingState() !== 'normal') {
      if (!this.interrupted) {
        this.setStatus('waiting-for-tracking', 'waiting for tracking NORMAL before looking for the room');
      }
      return;
    }
    const maps = serverConnection.getView().connection.info?.maps ?? [];
    if (!maps.includes(DEFAULT_MAP_ID)) {
      this.episode = null;
      this.setStatus(
        'error',
        `the server has no map "${DEFAULT_MAP_ID}" yet - scan the room first: Scan room, Record, Upload`,
      );
      return;
    }
    if (getRoomScanState().recording !== 'idle') {
      this.scheduleAttempt(RECORDER_BUSY_RETRY_MS); // a scan is being recorded
      return;
    }

    episode.attempt++;
    const of = `attempt ${episode.attempt} of ${MAX_ATTEMPTS[episode.reason]}`;
    this.setStatus(
      'localizing',
      this.shown
        ? `checking the doorway position (${of}): hold the phone still for 3 seconds`
        : `looking for the room (${of}): hold the phone still for 3 seconds, pointed at a part of the room with detail`,
    );
    const generation = this.generation;
    this.busy = true;
    const result = await localizeWithClip(DEFAULT_MAP_ID, `${SESSION_ID}-w${this.worldEpoch}`);
    this.busy = false;
    if (this.stopped || generation !== this.generation || this.episode !== episode) {
      // Stopped, interrupted or superseded while the clip was on its way: the answer is
      // dropped. An episode that started meanwhile could not run while this one was busy.
      if (!this.stopped && this.episode && this.retryTimer === null) {
        this.scheduleAttempt(0);
      }
      return;
    }

    if (result.kind === 'failed') {
      this.afterDecision(episode, { action: 'retry', why: result.reason }, null);
      return;
    }
    const { outcome, plan } = result;
    episode.server = {
      quality: outcome.quality,
      inliers: outcome.numInliers,
      source: outcome.portal?.source ?? null,
      confidence: outcome.portal?.confidence ?? null,
    };
    const door = outcome.alignmentStatus === 'ok' ? candidateFrom(outcome.portal, outcome.quality === 'good') : null;
    const decision = decide(this.shown, this.trusted, {
      quality: outcome.quality,
      alignmentStatus: outcome.alignmentStatus,
      door: door ? { position: door.position, rotation: door.rotation } : null,
    });
    this.afterDecision(episode, decision, plan);
  }

  private afterDecision(episode: Episode, decision: Decision, plan: ServerPlan | null): void {
    const log = (text: string) => this.context?.log(`self-hosted: ${text}`);
    switch (decision.action) {
      case 'retry':
        episode.lastWhy = decision.why;
        log(`attempt ${episode.attempt}: ${decision.why}`);
        break;
      case 'no-doorway':
        this.episode = null;
        if (plan) {
          this.reportNoDoorway(plan);
        }
        this.report('no-doorway', episode);
        return;
      case 'place':
        if (plan) {
          this.place(decision.door, plan, decision.door.strong, 'recognised room');
          this.report('placed', episode);
        }
        break;
      case 'move':
        log(
          `doorway moved by ${decision.distanceM.toFixed(2)} m and ${decision.angleDeg.toFixed(0)} deg ` +
            `after re-localisation (${decision.door.strong ? 'good' : 'weak'} match)`,
        );
        if (plan) {
          this.place(decision.door, plan, decision.door.strong, 'recognised room, corrected', episode.reason !== 'manual');
          this.report('moved', episode);
        }
        break;
      case 'keep':
        this.trusted = true;
        log(`doorway confirmed: the new answer is ${(decision.distanceM * 100).toFixed(0)} cm from the shown one`);
        this.setStatus('localized', 'doorway confirmed by a second look');
        this.report('confirmed', episode);
        break;
      case 'ignore':
        episode.lastWhy = 'only weak matches that disagree with the doorway shown';
        log(`weak answer ${decision.distanceM.toFixed(2)} m away from the trusted doorway ignored`);
        break;
    }

    if (!wantsAnotherAttempt(decision)) {
      this.episode = null;
      return;
    }
    // A weak pose is on screen: the remaining attempts only confirm it.
    let current = episode;
    if ((decision.action === 'place' || decision.action === 'move') && episode.reason !== 'confirm') {
      current = {
        reason: 'confirm',
        origin: episode.origin,
        attempt: 0,
        earlier: episode.earlier + episode.attempt,
        lastWhy: 'the match was weak',
        startedAt: episode.startedAt,
        server: episode.server,
      };
      this.episode = current;
    }
    if (current.attempt >= MAX_ATTEMPTS[current.reason]) {
      this.giveUp(current);
      return;
    }
    const pause = current.reason === 'confirm' ? CONFIRM_DELAY_MS : retryDelayMs(current.attempt + 1);
    this.scheduleAttempt(pause);
  }

  /** The attempts of an episode are used up. Nothing on screen changes; the status says what to do. */
  private giveUp(episode: Episode): void {
    this.episode = null;
    const why = episode.lastWhy ? ` (${episode.lastWhy})` : '';
    if (this.shown && this.trusted) {
      this.setStatus('localized', 'doorway kept: the new look did not give a better position');
      this.report('kept', episode);
      return;
    }
    if (this.shown) {
      this.setStatus(
        'lost',
        `the doorway is shown where it was, but its position could not be confirmed${why}. ${HOW_TO_LOOK}`,
      );
      this.report('kept', episode); // `trusted: false` says that it is not confirmed
      return;
    }
    this.setStatus('lost', `room not recognised after ${episode.attempt} attempts${why}. ${HOW_TO_LOOK}`);
    this.report('not-found', episode);
  }

  /** Tells the measurement log how a search ended. `episode` is null for a plan straight from a build. */
  private report(
    event: LocalizationReport['event'],
    episode: Episode | null,
    server: LocalizationReport['server'] = episode?.server,
  ): void {
    this.context?.reportLocalization({
      event,
      reason: episode ? episode.origin : 'build',
      attempts: episode ? episode.earlier + episode.attempt : 0,
      elapsedMs: episode ? Date.now() - episode.startedAt : null,
      trusted: this.trusted,
      server,
    });
  }

  // ---- outputs --------------------------------------------------------------------------

  private place(door: DoorCandidate, plan: ServerPlan, trusted: boolean, origin: string, automatic = false): void {
    this.shown = door;
    this.trusted = trusted;
    this.handledPlan = plan;
    if (getRoomScanState().serverPlan !== plan) {
      roomActions.setServerPlan(plan); // the room plan is drawn from the same answer as the door
    }
    const portal = plan.portal;
    const width = portal?.width ?? null;
    const height = portal?.height ?? null;
    const sized = width !== null && height !== null && width > 0 && height > 0;
    const confidence = portal?.confidence ?? null;
    this.emitPose({
      pose: { position: door.position, rotation: door.rotation },
      opening: sized ? { width, height } : undefined,
      automatic,
      quality: {
        confidence: confidence ?? undefined,
        note: `server ${portal?.source ?? '?'}${confidence === null ? '' : `, confidence ${confidence.toFixed(2)}`}${trusted ? '' : ', not confirmed'}`,
      },
    });
    this.setStatus(
      'localized',
      `doorway from the server (${portal?.source ?? '?'}` +
        (sized ? `, ${width.toFixed(2)} x ${height.toFixed(2)} m` : '') +
        `, ${origin})${trusted ? '' : ' - weak match, checking again'}`,
    );
  }

  private reportNoDoorway(plan: ServerPlan): void {
    this.handledPlan = plan;
    if (getRoomScanState().serverPlan !== plan) {
      roomActions.setServerPlan(plan); // the walls are still worth drawing
    }
    const why = plan.portal?.reason ? ` (${plan.portal.reason})` : '';
    this.setStatus(
      'error',
      `no door opening found in map "${plan.mapId}"${why}. ` +
        (this.shown ? 'The doorway shown is an earlier one. ' : 'Nothing was placed: ') +
        'switch the provider to "manual" to place the door by hand, or scan the room again with the whole door in view',
    );
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearRetryTimer();
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}

/** The doorway of a server answer as a candidate pose, or null when there is none. */
function candidateFrom(portal: ServerPortal | null, strong: boolean): DoorCandidate | null {
  if (!portal || portal.source === 'none' || !portal.position || !portal.rotation) {
    return null;
  }
  return { position: portal.position, rotation: portal.rotation, strong };
}
