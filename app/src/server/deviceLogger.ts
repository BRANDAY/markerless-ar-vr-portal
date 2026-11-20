/**
 * Sends the app's event log and its current state to the server's monitoring panel
 * (`api-v2.md`, section 9): in batches, in the background, only to a server that
 * announces the capability `device_log`.
 *
 * Nothing here runs per frame: events come from `appActions.log` (state changes, not
 * frames), and one timer per second decides whether a request is due. A request never
 * blocks anything; if it fails the events wait for the next one.
 */
import { AppState } from 'react-native';

import { DEFAULT_MAP_ID } from '../room/roomServer';
import { getRoomScanState } from '../room/roomStore';
import { addLogListener, getAppState } from '../state/appStore';
import { postDeviceLog, setClientIdentity } from './core/client';
import {
  buildLogBody,
  type ClientIdentity,
  DeviceLogQueue,
  type DeviceLogState,
  scenarioStep,
} from './core/deviceLog';
import { loadClientIdentity } from './identity';
import { serverConnection } from './ServerConnection';

const TICK_MS = 1000;

class DeviceLogger {
  private readonly queue = new DeviceLogQueue();
  private identity: ClientIdentity | null = null;
  private started = false;
  private inFlight = false;
  private lastSentMs = 0;
  /** A server that answered 404: it has no device log, whatever it announced. */
  private refusedBy: string | null = null;

  /**
   * Call once at app start, before the first request to the server, so that every request
   * carries the device's identity.
   */
  async start(log: (message: string) => void): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    addLogListener((text, timeMs) => {
      const event = this.queue.add(text, timeMs);
      if (event.level === 'error') {
        setTimeout(() => void this.flush(), 0);
      }
    });
    this.identity = await loadClientIdentity(log);
    setClientIdentity(this.identity);
    log(`app: ${this.identity.deviceName}, device id ${this.identity.deviceId}, run ${this.identity.sessionId}, version ${this.identity.appVersion}`);
    setInterval(() => void this.flush(), TICK_MS);
  }

  private currentState(): DeviceLogState {
    const app = getAppState();
    const scan = getRoomScanState();
    const connection = serverConnection.getView().connection;
    const { step, detail } = scenarioStep({
      serverConnected: connection.state === 'connected',
      recording: scan.recording === 'recording', // a clip for /localize never reaches this state
      uploadPhase: scan.upload.phase,
      uploadText: scan.upload.text,
      inside: app.mode === 'VR',
      doorPlaced: app.door !== null,
      providerId: app.providerId,
      providerStatus: app.providerStatus,
      providerDetail: app.providerDetail,
      mapAvailable: scan.serverPlan !== null || (connection.info?.maps ?? []).includes(DEFAULT_MAP_ID),
    });
    const reason = app.trackingReason ? ` (${app.trackingReason})` : '';
    return {
      step,
      tracking: `${app.trackingState.toUpperCase()}${reason}`,
      map_id: scan.serverPlan?.mapId ?? DEFAULT_MAP_ID,
      detail: scan.scanning && step !== 'scanning' ? `${detail}; scan mode on`.replace(/^; /, '') : detail,
    };
  }

  private async flush(): Promise<void> {
    const identity = this.identity;
    if (!identity || this.inFlight || AppState.currentState === 'background') {
      return;
    }
    const baseUrl = serverConnection.getBaseUrl();
    const connection = serverConnection.getView().connection;
    if (!baseUrl || baseUrl === this.refusedBy || !connection.info?.capabilities.includes('device_log')) {
      return;
    }
    const now = Date.now();
    if (!this.queue.isDue(now, this.lastSentMs)) {
      return;
    }
    this.inFlight = true;
    this.lastSentMs = now;
    const batch = this.queue.nextBatch();
    try {
      const body = buildLogBody(identity, batch, this.currentState(), now, connection.latencyMs);
      const answer = await postDeviceLog(baseUrl, identity.deviceId, body);
      if (answer.ok) {
        this.queue.acknowledge(answer.value.lastSeq);
      } else if (answer.status === 404) {
        this.refusedBy = baseUrl;
        console.log('[portal] device log: the server answered 404, not sending to it any more');
      } else if (answer.status === 413 || answer.status === 422) {
        // The server will never take this batch; keeping it would block everything after it.
        console.log(`[portal] device log: batch refused (${answer.reason}), ${batch.length} events dropped`);
        if (batch.length > 0) {
          this.queue.acknowledge(batch[batch.length - 1].seq);
        }
      } else {
        this.queue.deferUrgent(); // no answer: the events go with the next regular batch
      }
    } finally {
      this.inFlight = false;
    }
  }
}

export const deviceLogger = new DeviceLogger();
