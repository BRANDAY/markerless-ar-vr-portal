import { IDENTITY } from '../door/core/roomFrame';
import { DoorPlacer, type Placement } from '../door/DoorPlacer';
import { noteDoorRecord } from '../door/doorRecords';
import { localizeWithClip } from '../room/roomServer';
import { currentRoomId } from '../room/roomsStore';
import { getRoomScanState, subscribeRoomScan, type ServerPlan } from '../room/roomStore';
import { formatAddress } from '../server/core/address';
import type { ConnectionSnapshot } from '../server/core/connectionMachine';
import { SESSION_ID } from '../server/identity';
import { serverConnection } from '../server/ServerConnection';
import { getAppState, subscribeAppState } from '../state/appStore';
import { BaseProvider } from './BaseProvider';
import {
  checkAfterExit,
  decide,
  type Decision,
  describeExitCheck,
  type EpisodeReason,
  exitCheckGate,
  exitCheckGaveUp,
  INTERRUPTION_GRACE_MS,
  MAX_ATTEMPTS,
  retryDelayMs,
  TrackingWatch,
  wantsAnotherAttempt,
} from './core/relocalization';
import type { LocalizationContext, LocalizationReport, ProviderId, StatusMeta, TrackingState, Unsubscribe } from './types';

/** While a scan recording runs the recorder is busy; look again after this long. */
const RECORDER_BUSY_RETRY_MS = 2000;
/** Pause before a weak pose is checked again. */
const CONFIRM_DELAY_MS = 3000;
/**
 * While there is no door on screen the search does not stop and does not pause: a look
 * the server answered with "not recognised" is followed by the next one at once (the
 * user is told to look at the room, not at the floor; waiting 1.5-10 s and stopping
 * after five only added to the wait - first pass on a phone, 2026-11-21). A look that
 * did not get to the server (no clip, no connection) waits this long, so as not to spin.
 */
const FAILED_LOOK_PAUSE_MS = 1000;
/** The answer has been this long in coming: the screen says that the server is busy. */
const BUSY_AFTER_MS = 6000;
/** This many answered looks in a row that recognised nothing: the session counts against the room. */
const MISSED_AFTER = 5;
/**
 * Behind the door there is no map: the camera sees what the scan never saw. So the
 * place of the door is not checked from inside the space, nor for this long after the
 * way out (the user is still turning round to the room).
 */
const CHECK_AFTER_EXIT_MS = 6000;

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
  /** The latest answer could not be used because the scale of the map is not known yet. */
  scaleUnknown?: boolean;
  /** The server answered the look that has just ended. */
  answered?: boolean;
  /** Answered looks in a row in which the room was not recognised. */
  refused?: number;
}

/** See `worldEpoch`. */
let nextWorldFrame = 0;

const HOW_TO_LOOK = 'Look at a part of the room that was scanned (not a bare wall) and press "Re-localize"';

/**
 * Self-hosted localization server on the local network: one of the ways to recognise the
 * room. It answers one question - WHERE THE ROOM'S FRAME LIES IN THIS AR SESSION - and
 * hands that to the door layer (`door/DoorPlacer.ts`), which reads the room's door record
 * and puts the door there, the same for every way. This provider knows nothing about the
 * door; it only hears back what the answer meant for it, to decide whether to look again.
 *
 * Two ways to the room's frame:
 *  - the room was scanned and built in this very session: the map frame IS this session's
 *    frame (`roomStore.serverPlan` of origin `build`, set after a build);
 *  - otherwise a short clip with camera poses goes to `POST /localize`, and the answer
 *    says where the map lies in the session (`alignment.T_arworld_from_map`).
 *
 * Looking for the room happens in EPISODES (session start, tracking came back, the user
 * pressed "Re-localize", a weak answer is being confirmed). An episode makes a limited
 * number of attempts with growing pauses and then tells the user what to do.
 *
 * When tracking is interrupted the door layer is told so (the door stays, unbelieved),
 * the status says so, and the room is looked for again as soon as tracking is back. The
 * server-side session id changes then, because the AR world frame may have changed.
 */
export class SelfHostedServerProvider extends BaseProvider {
  readonly id: ProviderId = 'self-hosted';
  readonly displayName = 'Self-hosted server';

  private subscriptions: Unsubscribe[] = [];
  private stopped = true;
  private connected = false;

  private watch = new TrackingWatch();
  private interrupted = false;
  /**
   * Number of the AR world frame the provider works in: a new one at every start of the
   * provider (the AR view may have been mounted anew) and after every interruption of
   * tracking. It is part of the server session id, so the counter is shared by all
   * provider instances of an app run.
   */
  private worldEpoch = 0;
  /** Changes whenever running work becomes void (stop, interruption, a new episode). */
  private generation = 0;

  /** Where the answers go: the one place that puts the door (and knows whether one stands). */
  private readonly door = new DoorPlacer({
    emitPose: (update) => this.emitPose(update),
    setStatus: (status, detail, meta) => this.setStatus(status, detail, meta),
    log: (text) => this.context?.log(`self-hosted: ${text}`),
  });
  /** The build's plan this provider has dealt with last. */
  private handledPlan: ServerPlan | null = null;

  private episode: Episode | null = null;
  private busy = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  /** The place of the door is to be checked once the user is back in the room. */
  private checkAfterExit = false;
  private lastMode: 'AR' | 'VR' = 'AR';
  private exitedAt = 0;

  /** `http://host:port` of the connected server, or null. */
  getBaseUrl(): string | null {
    return serverConnection.getBaseUrl();
  }

  protected onStart(context: LocalizationContext): void {
    this.stopped = false;
    this.connected = false;
    this.watch = new TrackingWatch();
    this.interrupted = false;
    this.door.reset();
    this.worldEpoch = nextWorldFrame++;
    this.handledPlan = null;
    this.episode = null;
    this.busy = false;
    this.checkAfterExit = false;
    this.lastMode = getAppState().mode;
    this.exitedAt = 0;
    this.generation++;
    this.watch.onState(context.getTrackingState(), Date.now());
    this.subscriptions = [
      subscribeAppState(() => this.onMode()),
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
    this.door.reset();
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
        if (!this.door.shown && !this.episode) {
          this.setStatus('connected', 'connected to the server');
          this.begin('start');
        } else if (this.episode && !this.busy) {
          this.scheduleAttempt(0); // an episode that was waiting for the server
        }
      }
      return;
    }
    if (this.busy) {
      // A look is on its way. Its own end says what became of it; a server that is busy
      // with the clip may miss a health check, and that must not end the search.
      return;
    }
    if (this.door.shown) {
      // A door that is placed needs no server; only say that looking again is not possible.
      if (wasConnected) {
        this.context?.log('self-hosted: server connection lost - the doorway stays where it is');
      }
      return;
    }
    const where = address ? ` ${formatAddress(address)}` : '';
    switch (state) {
      case 'not-configured':
        this.setStatus('waiting-for-server', 'no server address - tap the server chip to set it up', { code: 'no-server' });
        break;
      case 'searching':
        this.setStatus('waiting-for-server', 'searching for the server', { code: 'connecting' });
        break;
      case 'connecting':
        this.setStatus('waiting-for-server', `connecting to${where}`, { code: 'connecting' });
        break;
      case 'incompatible':
        this.setStatus('error', `incompatible server at${where}: ${connection.detail}`, { code: 'incompatible' });
        break;
      default:
        this.setStatus('waiting-for-server', `server${where} unreachable: ${connection.detail}`, { code: 'server-offline' });
    }
  }

  /**
   * A plan that appeared in the store after a map build. The recording was made in this
   * session, so the room's frame is this session's frame: the room transform is the identity.
   */
  private onStorePlan(): void {
    const plan = getRoomScanState().serverPlan;
    if (this.stopped || !plan || plan === this.handledPlan || this.door.wrote(plan) || plan.origin !== 'build') {
      return;
    }
    this.handledPlan = plan;
    this.cancelEpisode();
    if (plan.portal) {
      noteDoorRecord(plan.mapId, plan.portal); // read from the server a moment ago, with the plan
    }
    const generation = this.generation;
    void this.door
      .roomRecognised(
        {
          mapId: plan.mapId,
          frameId: plan.portal?.frameId ?? '',
          transform: IDENTITY,
          // Built from a recording of a frame that has been interrupted since: show, do not trust.
          strong: !this.interrupted,
          room: plan.room,
          how: 'this scan',
          fromRecording: true,
        },
        { requested: true, always: true },
      )
      .then((placed) => {
        if (!placed || this.stopped || generation !== this.generation) {
          return;
        }
        const server = {
          quality: 'build',
          inliers: null,
          source: placed.portal?.source ?? null,
          confidence: placed.portal?.confidence ?? null,
        };
        if (placed.decision.action === 'place') {
          this.report('placed', null, server);
        } else if (placed.decision.action === 'no-doorway') {
          this.report('no-doorway', null, server);
        } else if (placed.decision.action === 'retry') {
          this.context?.log(`self-hosted: the door of this scan was not placed - ${placed.decision.why}`);
        }
      });
  }

  private onTracking(state: TrackingState): void {
    const now = Date.now();
    const event = this.watch.onState(state, now);
    if (state === 'normal' && !event) {
      // First NORMAL of the session (or nothing had happened): start if there is nothing yet.
      if (this.connected && !this.door.shown && !this.episode) {
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
    this.worldEpoch = nextWorldFrame++;
    const inside = getAppState().mode === 'VR';
    const sinceExit = Date.now() - this.exitedAt;
    if (this.door.shown && (inside || sinceExit < CHECK_AFTER_EXIT_MS)) {
      // No look from inside the space or on the way out of it (`CHECK_AFTER_EXIT_MS`):
      // it could only fail, and the door would be called doubtful for no reason.
      this.checkAfterExit = true;
      this.context?.log(
        `self-hosted: tracking is back after ${(event.gapMs / 1000).toFixed(1)} s ${inside ? 'inside the space' : 'on the way out of the space'} - ` +
          'the doorway is kept, its place is checked once the user is back in the room',
      );
      this.setStatus('localized', 'doorway kept while the user is in the space');
      if (!inside) {
        this.scheduleExitCheck(CHECK_AFTER_EXIT_MS - sinceExit);
      }
      return;
    }
    this.context?.log(
      `self-hosted: tracking is back after ${(event.gapMs / 1000).toFixed(1)} s - ` +
        (this.door.shown ? 'checking the doorway position' : 'looking for the room'),
    );
    this.begin('recovery');
  }

  /** The user walked into the space or out of it. */
  private onMode(): void {
    const mode = getAppState().mode;
    if (mode === this.lastMode) {
      return; // the store reports every change of anything
    }
    this.lastMode = mode;
    if (this.stopped) {
      return;
    }
    if (mode === 'VR') {
      this.clearExitTimer();
      return;
    }
    this.exitedAt = Date.now();
    // Every way out: ARCore may have corrected its map while the user was inside without
    // announcing a loss of tracking (second pass on a phone, 2026-11-22), and the door is a
    // point in ARCore's frame. After an announced loss it is looked for as before.
    const check = checkAfterExit({ doorShown: this.door.shown !== null, afterLoss: this.checkAfterExit });
    if (check) {
      this.scheduleExitCheck(CHECK_AFTER_EXIT_MS, check);
    }
  }

  private scheduleExitCheck(delayMs: number, reason: 'recovery' | 'exit' = 'recovery'): void {
    this.clearExitTimer();
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null;
      if (this.stopped || getAppState().mode === 'VR') {
        return;
      }
      // A loss announced in the meantime makes it a recovery.
      const what = this.checkAfterExit ? 'recovery' : reason;
      this.checkAfterExit = false;
      if (this.door.shown && !this.episode && !this.interrupted) {
        this.context?.log(
          `self-hosted: back in the room - checking the doorway position (${what === 'exit' ? 'after every way out of the space' : 'after a loss of tracking'})`,
        );
        this.begin(what);
      }
    }, Math.max(0, delayMs));
  }

  private clearExitTimer(): void {
    if (this.exitTimer !== null) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
  }

  private markInterrupted(): void {
    if (this.interrupted) {
      return;
    }
    this.interrupted = true;
    this.door.distrust(); // the room transform belonged to the frame that was interrupted
    this.generation++; // a clip recorded across the interruption is worthless
    this.clearRetryTimer();
    this.context?.log('self-hosted: tracking lost');
    this.setStatus(
      'lost',
      this.door.shown
        ? 'tracking lost - the doorway stays where it was, but it may be off. Move the phone slowly over a part of the room with detail'
        : 'tracking lost - move the phone slowly over a part of the room with detail',
      { code: 'tracking-lost' },
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
      if (!this.door.shown) {
        this.setStatus('waiting-for-server', 'the server is not connected', { code: 'server-offline' });
      }
      return;
    }
    if (this.context?.getTrackingState() !== 'normal') {
      if (!this.interrupted) {
        this.setStatus('waiting-for-tracking', 'waiting for tracking NORMAL before looking for the room');
      }
      return;
    }
    const roomId = currentRoomId();
    const sessionId = `${SESSION_ID}-w${this.worldEpoch}`;
    if (!roomId) {
      this.episode = null;
      this.setStatus('error', 'the server has no room yet - scan the room first', { code: 'no-room' });
      return;
    }
    if (getRoomScanState().recording !== 'idle') {
      this.scheduleAttempt(RECORDER_BUSY_RETRY_MS); // a scan is being recorded
      return;
    }
    if (this.door.shown && episode.reason !== 'manual' && getAppState().mode === 'VR') {
      // Nobody asked for this check, and from inside the space it can only fail.
      this.episode = null;
      // Every way out brings a check of its own; a dropped check after a loss is kept for it.
      if (episode.origin !== 'exit') {
        this.checkAfterExit = true;
      }
      this.setStatus('localized', 'doorway kept while the user is in the space');
      return;
    }

    episode.attempt++;
    episode.answered = false;
    this.showLook(episode, 'recording');
    const generation = this.generation;
    this.busy = true;
    const placed = await this.look(episode, roomId, sessionId, generation);
    this.busy = false;
    this.clearBusyTimer();
    if (this.stopped || generation !== this.generation || this.episode !== episode || !placed) {
      // Stopped, interrupted or superseded while the clip was on its way: the answer is
      // dropped. An episode that started meanwhile could not run while this one was busy.
      if (!this.stopped && this.episode && this.retryTimer === null) {
        this.scheduleAttempt(0);
      }
      return;
    }
    this.afterDecision(episode, placed.decision);
  }

  /**
   * One look: a clip to the server, its answer to "where is the room" to the door layer.
   * Null when the answer was overtaken on its way.
   */
  private async look(episode: Episode, roomId: string, sessionId: string, generation: number): Promise<Placement | null> {
    const result = await localizeWithClip(roomId, sessionId, (stage) => {
      if (this.stopped || generation !== this.generation || this.episode !== episode) {
        return;
      }
      this.clearBusyTimer();
      this.showLook(episode, stage);
      if (stage === 'thinking') {
        this.busyTimer = setTimeout(() => {
          this.busyTimer = null;
          if (!this.stopped && generation === this.generation && this.episode === episode && this.busy) {
            this.showLook(episode, 'busy');
          }
        }, BUSY_AFTER_MS);
      }
    });
    if (this.stopped || generation !== this.generation) {
      return null;
    }
    if (result.kind === 'failed') {
      return { decision: { action: 'retry', why: result.reason }, portal: null };
    }
    const { outcome } = result;
    episode.answered = true;
    episode.scaleUnknown = outcome.alignmentStatus === 'scale_unknown';
    episode.server = { quality: outcome.quality, inliers: outcome.numInliers, source: null, confidence: null };
    if (outcome.alignmentStatus !== 'ok' || outcome.quality === 'failed') {
      // No room transform in this answer; `decide` words the reason.
      const decision = decide(null, false, { quality: outcome.quality, alignmentStatus: outcome.alignmentStatus, door: null });
      return { decision, portal: null };
    }
    if (episode.reason === 'exit') {
      const gate = exitCheckGate(outcome.quality);
      if (gate) {
        return { decision: gate, portal: null };
      }
    }
    if (!outcome.transform) {
      return { decision: { action: 'retry', why: 'the server did not say where the room is (no T_arworld_from_map)' }, portal: null };
    }
    const placed = await this.door.roomRecognised(
      {
        mapId: roomId,
        frameId: outcome.frameId,
        transform: outcome.transform,
        strong: outcome.quality === 'good',
        room: outcome.room,
        how: 'recognised room',
        serverSession: sessionId,
      },
      // A move nobody asked for waits while the user is inside the space.
      { requested: episode.reason === 'manual' },
    );
    if (placed) {
      episode.server = {
        ...episode.server,
        source: placed.portal?.source ?? null,
        confidence: placed.portal?.confidence ?? null,
      };
    }
    return placed;
  }

  /** What the door layer made of an answer decides whether the search goes on. */
  private afterDecision(episode: Episode, decision: Decision): void {
    if (episode.reason === 'exit') {
      this.context?.log(`self-hosted: back in the room, look ${episode.attempt}: ${describeExitCheck(decision)}`);
    }
    switch (decision.action) {
      case 'retry':
        episode.lastWhy = decision.why;
        if (episode.answered) {
          episode.refused = (episode.refused ?? 0) + 1;
        }
        this.context?.log(`self-hosted: attempt ${episode.attempt}: ${decision.why}`);
        break;
      case 'no-doorway':
        this.episode = null;
        this.report('no-doorway', episode);
        return;
      case 'place':
        this.report('placed', episode);
        break;
      case 'move':
        this.report('moved', episode);
        break;
      case 'keep':
        this.report('confirmed', episode);
        break;
      case 'ignore':
        episode.lastWhy = 'only weak matches that disagree with the doorway shown';
        break;
      case 'suspect':
        this.report('kept', episode); // the door layer has said what to do
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
    const bounded = this.bounded(current);
    if (bounded && current.attempt >= MAX_ATTEMPTS[current.reason]) {
      this.giveUp(current);
      return;
    }
    let pause: number;
    if (current.reason === 'confirm') {
      pause = CONFIRM_DELAY_MS;
    } else if (bounded) {
      pause = retryDelayMs(current.attempt + 1);
    } else {
      pause = current.answered ? 0 : FAILED_LOOK_PAUSE_MS; // see `FAILED_LOOK_PAUSE_MS`
    }
    if (decision.action === 'retry' || decision.action === 'ignore') {
      // Tell the interface at once that another look follows, and why this one failed:
      // the user should move before the next clip is recorded, not after.
      this.setStatus(
        'localizing',
        `attempt ${current.attempt} gave nothing (${current.lastWhy}); looking again` + (pause > 0 ? ` in ${(pause / 1000).toFixed(1)} s` : ''),
        this.searchMeta(current, current.attempt + 1),
      );
    }
    this.scheduleAttempt(pause);
  }

  /** The attempts of an episode are used up. Nothing on screen changes; the status says what to do. */
  private giveUp(episode: Episode): void {
    this.episode = null;
    if (episode.origin === 'exit') {
      // No alarm after the way out: the door stays where it was.
      this.context?.log(`self-hosted: ${exitCheckGaveUp(episode.earlier + episode.attempt)}`);
      this.setStatus('localized', 'doorway kept: no good answer after the way out');
      this.report('kept', episode);
      return;
    }
    const why = episode.lastWhy ? ` (${episode.lastWhy})` : '';
    if (this.door.shown && this.door.trusted) {
      this.setStatus('localized', 'doorway kept: the new look did not give a better position');
      this.report('kept', episode);
      return;
    }
    if (this.door.shown) {
      this.setStatus(
        'lost',
        `the doorway is shown where it was, but its position could not be confirmed${why}. ${HOW_TO_LOOK}`,
        { code: 'unconfirmed' },
      );
      this.report('kept', episode); // `trusted: false` says that it is not confirmed
      return;
    }
    this.setStatus('lost', `room not recognised after ${episode.attempt} attempts${why}. ${HOW_TO_LOOK}`, {
      code: 'not-recognised',
      // Not one answer of the server in this search: nothing was compared with the room.
      ...(episode.server ? {} : { unanswered: true }),
    });
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
      trusted: this.door.trusted,
      server,
    });
  }

  // ---- outputs --------------------------------------------------------------------------

  /**
   * A search with a door on screen (a check of its place) has a limited number of
   * attempts; a search for a room that is not found yet goes on while the screen is open.
   */
  private bounded(episode: Episode): boolean {
    return this.door.shown !== null || episode.reason === 'confirm';
  }

  /** What the interface needs to know about a search: which attempt, and why the last one failed. */
  private searchMeta(episode: Episode, attempt: number): StatusMeta {
    const bounded = this.bounded(episode);
    return {
      attempt: episode.earlier + attempt,
      attempts: bounded ? episode.earlier + MAX_ATTEMPTS[episode.reason] : undefined,
      code: episode.scaleUnknown ? 'scale-unknown' : undefined,
      pending: this.door.shown !== null && !this.door.trusted && !this.door.everTrusted,
      missed: !bounded && (episode.refused ?? 0) >= MISSED_AFTER ? true : undefined,
    };
  }

  /** Says what the look that is running is doing: the screen shows it, the log keeps it. */
  private showLook(episode: Episode, stage: NonNullable<StatusMeta['stage']>): void {
    const what = {
      recording: 'recording a clip',
      sending: 'sending the clip',
      thinking: 'the server is comparing it with the room',
      busy: 'the server is busy - waiting for its answer',
    }[stage];
    const n = episode.earlier + episode.attempt;
    this.setStatus(
      'localizing',
      `${this.door.shown ? 'checking the doorway position' : 'looking for the room'} (attempt ${n}): ${what}`,
      { ...this.searchMeta(episode, episode.attempt), stage },
    );
  }

  private clearBusyTimer(): void {
    if (this.busyTimer !== null) {
      clearTimeout(this.busyTimer);
      this.busyTimer = null;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearRetryTimer();
    this.clearBusyTimer();
    this.clearExitTimer();
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}
