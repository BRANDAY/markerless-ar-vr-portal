/**
 * What the app knows about the phone's own network, and how to say it. Pure TypeScript.
 *
 * "On Wi-Fi" means that a Wi-Fi network is connected - not that Wi-Fi is the phone's
 * default network. A phone keeps mobile data as the default while Wi-Fi is connected
 * when the Wi-Fi has no internet access or the phone judges it to be poor; the server is
 * still reachable over that Wi-Fi, and the app routes its requests there (`wifiRoute.ts`).
 */

export interface PhoneNetworkState {
  /** A Wi-Fi network is connected. */
  wifiConnected: boolean;
  /** The phone's IPv4 address on that Wi-Fi network. */
  address: string | null;
  /** The app's connections are routed over that Wi-Fi network. */
  boundToWifi: boolean;
  /** What the phone itself uses by default. */
  defaultNetwork: 'wifi' | 'cellular' | 'other' | 'none';
}

/** One line for the server settings. `null`: the state could not be read. */
export function describePhoneNetwork(state: PhoneNetworkState | null): string {
  if (!state) {
    return 'This phone: network state unknown';
  }
  if (!state.wifiConnected || !state.address) {
    return 'This phone: not connected to Wi-Fi';
  }
  const line = `This phone: ${state.address} (Wi-Fi)`;
  if (state.defaultNetwork === 'wifi') {
    return line;
  }
  const main = state.defaultNetwork === 'cellular' ? 'mobile data' : 'another network';
  return state.boundToWifi
    ? `${line}. The phone currently prefers ${main}; the app talks to the server over Wi-Fi anyway.`
    : `${line}. The phone currently prefers ${main}, and the app could not switch its own ` +
        'connections to Wi-Fi: turn mobile data off to reach the server.';
}
