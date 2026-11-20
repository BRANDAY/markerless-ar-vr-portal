import { DEFAULT_MAP_ID, localizeWithClip } from '../room/roomServer';
import { getRoomScanState, roomActions, subscribeRoomScan, type ServerPlan } from '../room/roomStore';
import { formatAddress } from '../server/core/address';
import type { ConnectionSnapshot } from '../server/core/connectionMachine';
import { serverConnection } from '../server/ServerConnection';
import { BaseProvider } from './BaseProvider';
import type { LocalizationContext, ProviderId, Unsubscribe } from './types';

/** Automatic attempts after the provider starts; after that the user asks with "Re-place door". */
const MAX_AUTOMATIC_ATTEMPTS = 2;

/**
 * Self-hosted localization server on the local network: the doorway is the REAL door
 * opening the server found in the scanned room.
 *
 * Two ways to a doorway pose in the current AR session:
 *  - the room was scanned and built in this very session: the server's plan is already in
 *    this session's frame (`roomStore.serverPlan`, set after a build);
 *  - any later session: a short clip with camera poses goes to `POST /localize`, and the
 *    answer carries the plan and the doorway transformed into this session's frame.
 *
 * If the server found no door opening, nothing is placed and the status says so. There
 * is no fallback position: placing the door by hand is the `manual` provider's job.
 */
export class SelfHostedServerProvider extends BaseProvider {
  readonly id: ProviderId = 'self-hosted';
  readonly displayName = 'Self-hosted server';

  private subscriptions: Unsubscribe[] = [];
  private connected = false;
  private appliedPlan: ServerPlan | null = null;
  private localizing = false;
  private automaticAttempts = 0;
  private stopped = true;

  /** `http://host:port` of the connected server, or null. */
  getBaseUrl(): string | null {
    return serverConnection.getBaseUrl();
  }

  protected onStart(context: LocalizationContext): void {
    this.stopped = false;
    this.connected = false;
    this.appliedPlan = null;
    this.automaticAttempts = 0;
    this.subscriptions = [
      serverConnection.subscribe((view) => this.follow(view.connection)),
      subscribeRoomScan(() => this.onPlan()),
      context.onTrackingState(() => this.maybeLocalize()),
    ];
    this.follow(serverConnection.getView().connection);
  }

  protected onStop(): void {
    this.stopped = true;
    this.subscriptions.forEach((off) => off());
    this.subscriptions = [];
  }

  /** "Re-place door": look for the room again. */
  relocalize(): void {
    void this.localizeNow();
  }

  private onPlan(): void {
    const plan = getRoomScanState().serverPlan;
    if (plan && plan !== this.appliedPlan && !this.stopped) {
      this.applyPlan(plan);
    }
  }

  private follow(connection: ConnectionSnapshot): void {
    const { state, address } = connection;
    const wasConnected = this.connected;
    this.connected = state === 'connected';
    if (this.connected) {
      // The connection reports every heartbeat; only the change to "connected" matters here,
      // otherwise a status such as "room not found" would be overwritten seconds later.
      const plan = getRoomScanState().serverPlan;
      if (plan) {
        if (plan !== this.appliedPlan) {
          this.applyPlan(plan);
        }
      } else if (!wasConnected && !this.localizing) {
        this.setStatus('connected', 'connected to the server');
        this.maybeLocalize();
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

  /** Tries by itself a couple of times once everything needed is there. */
  private maybeLocalize(): void {
    if (
      this.stopped ||
      !this.connected ||
      this.localizing ||
      getRoomScanState().serverPlan ||
      this.automaticAttempts >= MAX_AUTOMATIC_ATTEMPTS ||
      this.context?.getTrackingState() !== 'normal'
    ) {
      return;
    }
    this.automaticAttempts++;
    void this.localizeNow();
  }

  private async localizeNow(): Promise<void> {
    if (this.stopped || this.localizing) {
      return;
    }
    if (!this.connected) {
      this.setStatus('waiting-for-server', 'the server is not connected');
      return;
    }
    const maps = serverConnection.getView().connection.info?.maps ?? [];
    if (!maps.includes(DEFAULT_MAP_ID)) {
      this.setStatus(
        'error',
        `the server has no map "${DEFAULT_MAP_ID}" yet - scan the room first: Scan room, Record, Upload`,
      );
      return;
    }
    if (this.context?.getTrackingState() !== 'normal') {
      this.setStatus('waiting-for-tracking', 'waiting for tracking NORMAL before looking for the room');
      return;
    }
    this.localizing = true;
    this.setStatus('localizing', 'looking for the room: recording a short clip, hold the phone still');
    const result = await localizeWithClip(DEFAULT_MAP_ID);
    this.localizing = false;
    if (this.stopped) {
      return;
    }
    if (result.kind === 'plan') {
      roomActions.setServerPlan(result.plan); // applied through the store subscription
      return;
    }
    this.setStatus(
      'lost',
      `room not found (${result.reason}). Point the phone at a part of the room that was scanned and press "Re-place door"`,
    );
    this.maybeLocalize();
  }

  private applyPlan(plan: ServerPlan): void {
    this.appliedPlan = plan;
    const portal = plan.portal;
    if (!portal || portal.source === 'none' || !portal.position || !portal.rotation) {
      const why = portal?.reason ? ` (${portal.reason})` : '';
      this.setStatus(
        'error',
        `no door opening found in map "${plan.mapId}"${why}. Nothing was placed: switch the provider ` +
          'to "manual" to place the door by hand, or scan the room again with the whole door in view',
      );
      return;
    }
    const sized = portal.width !== null && portal.height !== null && portal.width > 0 && portal.height > 0;
    const confidence = portal.confidence === null ? '' : `, confidence ${portal.confidence.toFixed(2)}`;
    this.emitPose({
      pose: { position: portal.position, rotation: portal.rotation },
      opening: sized ? { width: portal.width as number, height: portal.height as number } : undefined,
      quality: {
        confidence: portal.confidence ?? undefined,
        note: `server ${portal.source}${confidence}`,
      },
    });
    this.setStatus(
      'localized',
      `doorway from the server (${portal.source}` +
        (sized ? `, ${(portal.width as number).toFixed(2)} x ${(portal.height as number).toFixed(2)} m` : '') +
        `, ${plan.origin === 'build' ? 'this scan' : 'recognised room'})`,
    );
  }
}
