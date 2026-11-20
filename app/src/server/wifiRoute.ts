/**
 * JavaScript side of the local native module `modules/wifi-route` (Android).
 *
 * It keeps the app's connections on the Wi-Fi network even when the phone's default
 * network is mobile data, and reports the phone's Wi-Fi address. Without the native
 * module (another platform, or a build made before it existed) the functions report
 * "unknown" and requests simply use the phone's default network.
 */
import { requireOptionalNativeModule } from 'expo';

import type { PhoneNetworkState } from './core/phoneNetwork';

interface WifiRouteNativeModule {
  start(): boolean;
  getState(): PhoneNetworkState;
}

const native = requireOptionalNativeModule<WifiRouteNativeModule>('WifiRoute');

/** Ask Android for the Wi-Fi network and bind this app to it whenever it is available. */
export function startWifiRoute(): boolean {
  try {
    return native?.start() ?? false;
  } catch {
    return false;
  }
}

/** Current state, read fresh on every call. `null` when it cannot be read. */
export function getPhoneNetworkState(): PhoneNetworkState | null {
  try {
    return native?.getState() ?? null;
  } catch {
    return null;
  }
}
