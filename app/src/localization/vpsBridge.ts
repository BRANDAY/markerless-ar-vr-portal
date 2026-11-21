/**
 * Between the ReactVision provider (a plain class) and the library's `<ViroVPS>` (a React
 * component that has to live inside the AR scene): the provider says which location it
 * wants tracked, `ar/VpsLayer.tsx` starts the tracking and passes on what the library
 * reports. Same listener pattern as the stores.
 *
 * Also the one place that asks whether this build has ReactVision keys at all.
 */
import { NativeModules } from 'react-native';

/** What the provider asks for; null = track nothing. */
export interface VpsRequest {
  locationId: string;
  /** Match on the phone, or on the vendor's servers (charged by the minute). */
  mode: 'device' | 'server';
  /** Changes with every new request, so that asking for the same place again starts anew. */
  nonce: number;
}

export type VpsEvent =
  /** `startTracking` came back. */
  | { kind: 'started'; nonce: number; success: boolean; code: string; message: string }
  /** The library's tracking state changed. */
  | { kind: 'state'; state: string; code: string; message: string }
  /** A converged pose: the camera in the frame of the service's map. */
  | { kind: 'localized'; renderPose: string; inliers: number | null };

let request: VpsRequest | null = null;
let nextNonce = 1;
const requestListeners = new Set<() => void>();
const eventListeners = new Set<(event: VpsEvent) => void>();

export const vpsBridge = {
  // ---- the provider's side ----
  track(locationId: string, mode: 'device' | 'server'): void {
    request = { locationId, mode, nonce: nextNonce++ };
    requestListeners.forEach((listener) => listener());
  },

  stop(): void {
    if (request !== null) {
      request = null;
      requestListeners.forEach((listener) => listener());
    }
  },

  onEvent(listener: (event: VpsEvent) => void): () => void {
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  },

  // ---- the layer's side ----
  getRequest(): VpsRequest | null {
    return request;
  },

  subscribeRequest(listener: () => void): () => void {
    requestListeners.add(listener);
    return () => {
      requestListeners.delete(listener);
    };
  },

  report(event: VpsEvent): void {
    eventListeners.forEach((listener) => listener(event));
  },
};

interface AuthContext {
  headers?: Record<string, string>;
  projectId?: string | null;
}

let configured: Promise<boolean> | null = null;

/**
 * Whether this build carries a ReactVision project id and client key (they are put into
 * the app when it is built, from a file outside the repository: `app.config.js`). Asked
 * from the library's native module, which reads them from the app's manifest; the key
 * itself is not kept or logged here. Asked once per app run.
 *
 * NOT VERIFIED on a device: that the native module answers like this in a build without keys.
 */
export function reactVisionConfigured(): Promise<boolean> {
  configured ??= (async () => {
    try {
      const native = (NativeModules as Record<string, { rvGetAuthHeaders?: () => Promise<AuthContext> } | undefined>).VRTStudio;
      if (typeof native?.rvGetAuthHeaders !== 'function') {
        return false;
      }
      const context = await native.rvGetAuthHeaders();
      const headers = context?.headers ?? {};
      const hasKey = Object.keys(headers).some((name) => name.toLowerCase() === 'x-api-key' && Boolean(headers[name]));
      return Boolean(context?.projectId) && hasKey;
    } catch {
      return false;
    }
  })();
  return configured;
}
