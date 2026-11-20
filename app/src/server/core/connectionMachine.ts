/**
 * State machine of the connection to the localization server.
 * Pure TypeScript (a reducer), covered by `connectionMachine.test.ts`. Timers, HTTP and
 * storage live in `ServerConnection.ts`, which feeds events into `reduceConnection`.
 *
 *   not-configured  no address known yet
 *   searching       the automatic search is running
 *   connecting      an address is set, the first check has not answered yet
 *   connected       the last check answered and identified a compatible server
 *   unreachable     no (usable) answer from the address
 *   incompatible    our server answers, but with an API version this app does not support
 */
import type { ServerAddress } from './address';
import type { ProbeResult } from './client';
import type { ServerInfo } from './health';

export type ConnectionState =
  | 'not-configured'
  | 'searching'
  | 'connecting'
  | 'connected'
  | 'unreachable'
  | 'incompatible';

export interface ConnectionSnapshot {
  state: ConnectionState;
  address: ServerAddress | null;
  /** Identity of the server from its last valid answer. */
  info: ServerInfo | null;
  /** Round-trip time of the last successful check. */
  latencyMs: number | null;
  /** Human-readable reason for the current state (error text, hint). */
  detail: string;
  /** Consecutive heartbeats without an answer while `connected`. */
  missedHeartbeats: number;
  /** Progress of the automatic search, only while `searching`. */
  scan: { scanned: number; total: number } | null;
}

export type ConnectionEvent =
  | { type: 'address-set'; address: ServerAddress }
  | { type: 'address-cleared' }
  | { type: 'search-started'; total: number }
  | { type: 'search-progress'; scanned: number }
  /** The search ended (finished, cancelled or failed) without choosing a new address. */
  | { type: 'search-ended'; detail?: string }
  | { type: 'probe'; result: ProbeResult };

/**
 * A single lost heartbeat on Wi-Fi is common; the state only drops to `unreachable`
 * after this many misses in a row.
 */
export const MISSED_HEARTBEATS_BEFORE_UNREACHABLE = 2;

export const INITIAL_CONNECTION: ConnectionSnapshot = {
  state: 'not-configured',
  address: null,
  info: null,
  latencyMs: null,
  detail: '',
  missedHeartbeats: 0,
  scan: null,
};

export function reduceConnection(
  snapshot: ConnectionSnapshot,
  event: ConnectionEvent,
): ConnectionSnapshot {
  switch (event.type) {
    case 'address-set':
      return {
        ...INITIAL_CONNECTION,
        state: 'connecting',
        address: event.address,
      };

    case 'address-cleared':
      return INITIAL_CONNECTION;

    case 'search-started':
      return {
        ...snapshot,
        state: 'searching',
        detail: '',
        scan: { scanned: 0, total: event.total },
      };

    case 'search-progress':
      if (snapshot.state !== 'searching' || !snapshot.scan) {
        return snapshot;
      }
      return { ...snapshot, scan: { ...snapshot.scan, scanned: event.scanned } };

    case 'search-ended':
      if (snapshot.state !== 'searching') {
        return snapshot;
      }
      // Fall back to the address that was configured before the search, if any; the
      // next check decides whether it is reachable.
      return {
        ...snapshot,
        state: snapshot.address ? 'connecting' : 'not-configured',
        missedHeartbeats: 0,
        scan: null,
        detail: event.detail ?? '',
      };

    case 'probe':
      return applyProbe(snapshot, event.result);
  }
}

function applyProbe(snapshot: ConnectionSnapshot, result: ProbeResult): ConnectionSnapshot {
  // Answers that arrive while no address is active (cleared, or a search is running)
  // belong to an earlier state and are ignored.
  if (!snapshot.address || snapshot.state === 'searching' || snapshot.state === 'not-configured') {
    return snapshot;
  }
  switch (result.kind) {
    case 'ok':
      return {
        ...snapshot,
        state: 'connected',
        info: result.info,
        latencyMs: result.latencyMs,
        detail: '',
        missedHeartbeats: 0,
      };
    case 'incompatible':
      return {
        ...snapshot,
        state: 'incompatible',
        info: result.info,
        latencyMs: result.latencyMs,
        detail: result.reason,
        missedHeartbeats: 0,
      };
    case 'unhealthy':
      return {
        ...snapshot,
        state: 'unreachable',
        info: result.info,
        latencyMs: null,
        detail: result.reason,
        missedHeartbeats: 0,
      };
    case 'not-our-server':
      return {
        ...snapshot,
        state: 'unreachable',
        info: null,
        latencyMs: null,
        detail: `something answers at this address, but it is not the localization server (${result.reason})`,
        missedHeartbeats: 0,
      };
    case 'unreachable': {
      const missed = snapshot.missedHeartbeats + 1;
      if (snapshot.state === 'connected' && missed < MISSED_HEARTBEATS_BEFORE_UNREACHABLE) {
        return { ...snapshot, missedHeartbeats: missed, detail: `missed a check (${result.reason})` };
      }
      return {
        ...snapshot,
        state: 'unreachable',
        latencyMs: null,
        detail: result.reason,
        missedHeartbeats: missed,
      };
    }
  }
}

/** One-line text of the always-visible status chip. */
export function describeConnection(snapshot: ConnectionSnapshot): string {
  switch (snapshot.state) {
    case 'not-configured':
      return 'Server: not set up';
    case 'searching':
      return snapshot.scan
        ? `Server: searching ${snapshot.scan.scanned}/${snapshot.scan.total}`
        : 'Server: searching';
    case 'connecting':
      return 'Server: connecting...';
    case 'connected':
      return (
        `Server: connected · ${snapshot.info?.serverName ?? '?'}` +
        (snapshot.latencyMs !== null ? ` · ${snapshot.latencyMs} ms` : '')
      );
    case 'unreachable':
      return 'Server: unreachable';
    case 'incompatible':
      return 'Server: incompatible';
  }
}
