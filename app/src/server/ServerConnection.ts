/**
 * The app's connection to the self-hosted localization server: one instance for the whole app.
 *
 * It owns everything impure around the pure pieces in `core/`: the heartbeat timer, the
 * foreground/background switch, the phone's network state, persistence of the last working
 * address and the automatic search. State lives in `core/connectionMachine.ts`.
 *
 * Nothing here knows an address in advance: it comes from the user, from the automatic
 * search or from the file written after an earlier successful connection.
 */
import { AppState } from 'react-native';

import { DEFAULT_PORT, formatAddress, sameAddress, toBaseUrl, type ServerAddress } from './core/address';
import { probeHealth, type ProbeResult } from './core/client';
import {
  describeConnection,
  INITIAL_CONNECTION,
  reduceConnection,
  type ConnectionEvent,
  type ConnectionSnapshot,
} from './core/connectionMachine';
import {
  DEFAULT_SCAN_START_INTERVAL_MS,
  DEFAULT_SCAN_TIMEOUT_MS,
  scanDurationSeconds,
  scanHosts,
  type DiscoveredServer,
} from './core/discovery';
import { describePhoneNetwork } from './core/phoneNetwork';
import { enumerateSubnet24 } from './core/subnet';
import { loadSavedAddress, saveAddress } from './storage';
import { getPhoneNetworkState, startWifiRoute } from './wifiRoute';

/** How often a configured server is checked while the app is in the foreground. */
export const HEARTBEAT_INTERVAL_MS = 3000;
export const HEARTBEAT_TIMEOUT_MS = 1500;
/** "Test connection" waits a little longer than the heartbeat. */
export const TEST_TIMEOUT_MS = 3000;

/** Result of the last automatic search, for the settings panel. */
export interface SearchReport {
  /** The /24 that was scanned, e.g. "192.168.x" - empty when the search could not start. */
  prefix: string;
  port: number;
  found: DiscoveredServer[];
  /** What to tell the user (also set on success). */
  message: string;
  /** True when the search could not run or found nothing usable. */
  failed: boolean;
}

export interface ServerConnectionView {
  connection: ConnectionSnapshot;
  lastSearch: SearchReport | null;
}

type Listener = (view: ServerConnectionView) => void;

const NOT_ON_WIFI =
  'The phone is not connected to Wi-Fi, so there is no local network to search. Connect it ' +
  'to the same Wi-Fi network as the computer that runs the server, or type the address in.';

function isForeground(state: string | null | undefined): boolean {
  return state !== 'background' && state !== 'inactive';
}

class ServerConnection {
  private view: ServerConnectionView = { connection: INITIAL_CONNECTION, lastSearch: null };
  private readonly listeners = new Set<Listener>();
  private log: (message: string) => void = () => {};

  private started = false;
  /**
   * Foreground unless React Native explicitly says otherwise: `AppState.currentState` can
   * be unknown right after launch, and no `change` event follows if nothing changes.
   */
  private foreground = isForeground(AppState.currentState);
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private probeInFlight = false;
  /** Bumped whenever the address changes: answers of older probes are dropped. */
  private generation = 0;
  private searchAbort: AbortController | null = null;
  private savedAddress: ServerAddress | null = null;

  // ---- observation ---------------------------------------------------------------------

  getView(): ServerConnectionView {
    return this.view;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Base URL for requests (`http://host:port`), or null unless the server is connected. */
  getBaseUrl(): string | null {
    const { state, address } = this.view.connection;
    return state === 'connected' && address ? toBaseUrl(address) : null;
  }

  // ---- life cycle ----------------------------------------------------------------------

  private markReady: () => void = () => undefined;
  /**
   * Resolved once the saved address has been read and is being tried. A screen that
   * would search the network when no server is known waits for this first: a search
   * started earlier pushed the saved address aside, and every launch then spent 17 s
   * walking the network for a server whose address it had (first pass, 2026-11-21).
   */
  readonly ready: Promise<void> = new Promise((resolve) => {
    this.markReady = resolve;
  });

  private held = 0;
  /**
   * While a long request to the server is on its way (a clip being recognised), the
   * server may be too busy to answer the health checks; it is not gone. Between `hold()`
   * and the call of the function it returns no check is made, so none can be missed.
   * The request has its own time limit.
   */
  hold(): () => void {
    this.held++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.held = Math.max(0, this.held - 1);
      }
    };
  }

  /** Call once at app start. Tries the address saved after the last successful connection. */
  async start(log: (message: string) => void): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.log = log;
    AppState.addEventListener('change', (next) => this.onAppState(next));
    // The server is on the Wi-Fi network; the phone's default network may be mobile data.
    if (!startWifiRoute()) {
      log('server: could not ask Android for the Wi-Fi network - requests use the default network');
    }

    const saved = await loadSavedAddress(log);
    this.savedAddress = saved;
    if (saved && this.view.connection.state === 'not-configured') {
      log(`server: trying the saved address ${formatAddress(saved)}`);
      this.applyAddress(saved);
      void this.probeNow(HEARTBEAT_TIMEOUT_MS);
    } else if (!saved) {
      log('server: no address saved yet - open the server settings to connect');
    }
    this.updateHeartbeat();
    this.markReady();
  }

  private onAppState(next: string | null | undefined): void {
    const wasForeground = this.foreground;
    this.foreground = isForeground(next);
    this.updateHeartbeat();
    if (this.foreground && !wasForeground) {
      void this.probeNow(HEARTBEAT_TIMEOUT_MS); // do not wait a full interval after coming back
    }
  }

  /** The heartbeat runs only in the foreground, with an address, outside a search. */
  private updateHeartbeat(): void {
    const { state, address } = this.view.connection;
    const wanted = this.foreground && address !== null && state !== 'searching';
    if (wanted && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => void this.probeNow(HEARTBEAT_TIMEOUT_MS), HEARTBEAT_INTERVAL_MS);
    } else if (!wanted && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---- state ---------------------------------------------------------------------------

  private dispatch(event: ConnectionEvent): void {
    const before = this.view.connection;
    const after = reduceConnection(before, event);
    if (after === before) {
      return;
    }
    this.view = { ...this.view, connection: after };
    if (after.state !== before.state) {
      const where = after.address ? ` [${formatAddress(after.address)}]` : '';
      const why = after.detail ? ` - ${after.detail}` : '';
      this.log(`${describeConnection(after).replace('Server:', 'server:')}${where}${why}`);
      if (after.state === 'connected' && after.address && !sameAddress(after.address, this.savedAddress)) {
        this.savedAddress = after.address;
        void saveAddress(after.address, this.log);
      }
    }
    this.updateHeartbeat();
    this.emit();
  }

  private setSearchReport(lastSearch: SearchReport | null): void {
    this.view = { ...this.view, lastSearch };
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.view));
  }

  private applyAddress(address: ServerAddress): void {
    this.generation++;
    this.dispatch({ type: 'address-set', address });
  }

  /** One `GET /health` to the configured address; the result goes into the state machine. */
  private async probeNow(timeoutMs: number): Promise<ProbeResult | null> {
    const { address, state } = this.view.connection;
    if (!address || state === 'searching' || this.probeInFlight || this.held > 0) {
      return null;
    }
    const generation = this.generation;
    this.probeInFlight = true;
    try {
      const result = await probeHealth(toBaseUrl(address), { timeoutMs });
      if (generation !== this.generation) {
        return null; // the address changed while waiting
      }
      this.dispatch({ type: 'probe', result });
      return result;
    } finally {
      this.probeInFlight = false;
    }
  }

  /**
   * How fast the connected server answers: `probes` health requests one after another,
   * `gapMs` apart. One entry per request, null for one without an answer in `timeoutMs`.
   * Judged by `core/linkQuality.ts`. These requests do not go into the connection state.
   */
  async measureLink(probes: number, gapMs: number, timeoutMs: number): Promise<(number | null)[]> {
    const address = this.view.connection.address;
    if (!address) {
      return [];
    }
    const latencies: (number | null)[] = [];
    for (let i = 0; i < probes; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
      }
      const result = await probeHealth(toBaseUrl(address), { timeoutMs });
      latencies.push(result.kind === 'ok' ? result.latencyMs : null);
    }
    return latencies;
  }

  /**
   * The phone's own network, for the settings panel: knowing the phone's address lets the
   * user compare networks and, if needed, reach the phone from the computer.
   */
  describePhoneNetwork(): string {
    return describePhoneNetwork(getPhoneNetworkState());
  }

  // ---- user actions --------------------------------------------------------------------

  /**
   * "Test connection": makes `address` the configured server and checks it once.
   * The address stays configured even when the check fails (the heartbeat keeps trying,
   * e.g. while the server is still starting); it is saved only once it has connected.
   */
  async connectTo(address: ServerAddress): Promise<ProbeResult> {
    this.cancelSearch();
    this.applyAddress(address);
    const generation = this.generation;
    // A heartbeat for the previous address may still be in flight: its answer is dropped
    // by the generation check, and this probe is made independently of it.
    const result = await probeHealth(toBaseUrl(address), { timeoutMs: TEST_TIMEOUT_MS });
    if (generation === this.generation) {
      this.dispatch({ type: 'probe', result });
    }
    return result;
  }

  /**
   * One check right now instead of at the next heartbeat: after the server's rooms were
   * changed from this phone, so that the list it reports is the new one.
   */
  async checkNow(): Promise<void> {
    await this.probeNow(HEARTBEAT_TIMEOUT_MS);
  }

  /** Forget the configured and the saved address. */
  forget(): void {
    this.cancelSearch();
    this.generation++;
    this.savedAddress = null;
    void saveAddress(null, this.log);
    this.dispatch({ type: 'address-cleared' });
    this.setSearchReport(null);
  }

  cancelSearch(): void {
    this.searchAbort?.abort();
  }

  /**
   * "Find automatically": probes every host of the phone's /24 network on `port`.
   * Exactly one compatible server -> connect to it. Several -> the caller lets the user
   * choose from `SearchReport.found`. Never throws.
   */
  async findAutomatically(port: number = DEFAULT_PORT): Promise<SearchReport> {
    if (this.searchAbort) {
      return this.view.lastSearch ?? { prefix: '', port, found: [], message: 'A search is already running', failed: true };
    }
    const fail = (message: string, prefix = ''): SearchReport => {
      const report: SearchReport = { prefix, port, found: [], message, failed: true };
      this.log(`server search: ${message}`);
      this.setSearchReport(report);
      return report;
    };

    // Read fresh every time: the phone changes Wi-Fi networks and addresses on its own.
    const phone = getPhoneNetworkState();
    if (!phone) {
      return fail("Could not read the phone's network state. Type the address in instead.");
    }
    if (!phone.wifiConnected || !phone.address) {
      return fail(NOT_ON_WIFI);
    }
    const ownAddress = phone.address;
    const subnet = enumerateSubnet24(ownAddress);
    if (!subnet.ok) {
      return fail(`${subnet.error}. Type the address in instead.`);
    }

    const abort = new AbortController();
    this.searchAbort = abort;
    this.setSearchReport(null);
    const worstCase = scanDurationSeconds(
      subnet.hosts.length,
      DEFAULT_SCAN_START_INTERVAL_MS,
      DEFAULT_SCAN_TIMEOUT_MS,
    );
    this.log(
      `server search: probing ${subnet.prefix}.1-254 on port ${port}, ${subnet.prefix}.1 and then nearest to the phone ` +
        `(${ownAddress}) first, up to ${worstCase} s` +
        (phone.defaultNetwork === 'wifi' ? '' : ` (default network: ${phone.defaultNetwork}, bound to Wi-Fi: ${phone.boundToWifi})`),
    );
    this.dispatch({ type: 'search-started', total: subnet.hosts.length });

    let outcome;
    try {
      outcome = await scanHosts({
        hosts: subnet.hosts,
        port,
        startIntervalMs: DEFAULT_SCAN_START_INTERVAL_MS,
        timeoutMs: DEFAULT_SCAN_TIMEOUT_MS,
        stopAtFirstCompatible: true,
        probe: (baseUrl, options) => probeHealth(baseUrl, options),
        signal: abort.signal,
        onProgress: (scanned) => this.dispatch({ type: 'search-progress', scanned }),
      });
    } finally {
      this.searchAbort = null;
    }

    const compatible = outcome.found.filter((server) => server.compatible);
    let message: string;
    let failed = false;
    if (outcome.cancelled) {
      message = `Search cancelled after ${outcome.scanned} of ${outcome.total} addresses.`;
      failed = compatible.length === 0;
    } else if (compatible.length === 1) {
      message =
        `Found ${compatible[0].info.serverName} at ${formatAddress(compatible[0].address)} ` +
        `after ${outcome.scanned} of ${outcome.total} addresses.`;
    } else if (compatible.length > 1) {
      message = `Found ${compatible.length} servers - choose one.`;
    } else if (outcome.found.length > 0) {
      message = 'Only an incompatible server was found (different API version). Update the app or the server.';
      failed = true;
    } else {
      message =
        `No server answered on ${subnet.prefix}.x port ${port}. Check that the server is running, ` +
        'that the computer is on the same network and that its firewall allows the port. ' +
        "If all that is fine, type the computer's address in: on some networks devices cannot " +
        'be searched for, only addressed directly.';
      failed = true;
    }
    const report: SearchReport = { prefix: subnet.prefix, port, found: outcome.found, message, failed };
    this.log(`server search: ${message}`);
    this.view = { ...this.view, lastSearch: report };

    if (!outcome.cancelled && compatible.length === 1) {
      // Leaves `searching` through `address-set`; the scan answer doubles as the first check.
      this.applyAddress(compatible[0].address);
      this.dispatch({
        type: 'probe',
        result: { kind: 'ok', info: compatible[0].info, latencyMs: compatible[0].latencyMs },
      });
    } else {
      this.dispatch({ type: 'search-ended', detail: failed ? message : '' });
      void this.probeNow(HEARTBEAT_TIMEOUT_MS);
    }
    this.emit();
    return report;
  }
}

export const serverConnection = new ServerConnection();
