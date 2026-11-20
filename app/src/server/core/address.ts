/**
 * Parsing and formatting of the localization server address typed by the user.
 * Pure TypeScript (no React Native imports): covered by `address.test.ts`.
 *
 * No address is built into the app. The only default is the port.
 */

export const DEFAULT_PORT = 8077;

export interface ServerAddress {
  scheme: 'http' | 'https';
  /** IPv4 address or host name, lower case. */
  host: string;
  port: number;
}

export type ParseAddressResult =
  | { ok: true; address: ServerAddress }
  | { ok: false; error: string };

const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Returns the four octets of a dotted IPv4 address, or null. */
export function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) {
    return false;
  }
  return host.split('.').every((label) => HOSTNAME_LABEL.test(label));
}

/**
 * Accepts `host`, `host:port`, `http://host`, `http://host:port/anything`.
 * `https://` is accepted too; without a scheme plain HTTP is assumed (a LAN server).
 */
export function parseServerAddress(input: string, defaultPort = DEFAULT_PORT): ParseAddressResult {
  let text = input.trim();
  if (text.length === 0) {
    return { ok: false, error: 'Enter the address of the server, for example 192.168.x.y' };
  }
  if (/\s/.test(text)) {
    return { ok: false, error: 'The address must not contain spaces' };
  }

  let scheme: ServerAddress['scheme'] = 'http';
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (schemeMatch) {
    const given = schemeMatch[1].toLowerCase();
    if (given !== 'http' && given !== 'https') {
      return { ok: false, error: `Unsupported scheme "${given}://" (use http://)` };
    }
    scheme = given;
    text = text.slice(schemeMatch[0].length);
  }

  // Drop a path, query or fragment: only host[:port] matters.
  text = text.split(/[/?#]/)[0];
  if (text.includes('@')) {
    return { ok: false, error: 'User names in the address are not supported' };
  }
  if (text.includes('[') || text.split(':').length > 2) {
    return { ok: false, error: 'IPv6 addresses are not supported, use an IPv4 address or a host name' };
  }

  let host = text;
  let port = defaultPort;
  const colon = text.lastIndexOf(':');
  if (colon >= 0) {
    host = text.slice(0, colon);
    const portText = text.slice(colon + 1);
    if (!/^\d{1,5}$/.test(portText)) {
      return { ok: false, error: 'The port must be a number, for example 8077' };
    }
    port = Number(portText);
    if (port < 1 || port > 65535) {
      return { ok: false, error: 'The port must be between 1 and 65535' };
    }
  }

  host = host.toLowerCase();
  if (host.length === 0) {
    return { ok: false, error: 'The host part of the address is missing' };
  }
  const looksNumeric = /^[\d.]+$/.test(host);
  if (looksNumeric ? parseIPv4(host) === null : !isValidHostname(host)) {
    return { ok: false, error: `"${host}" is not a valid IPv4 address or host name` };
  }
  return { ok: true, address: { scheme, host, port } };
}

/** `http://host:port` - no trailing slash. */
export function toBaseUrl(address: ServerAddress): string {
  return `${address.scheme}://${address.host}:${address.port}`;
}

/** What is shown in the address field: `host:port`, with the scheme only when it is https. */
export function formatAddress(address: ServerAddress): string {
  const core = `${address.host}:${address.port}`;
  return address.scheme === 'https' ? `https://${core}` : core;
}

export function sameAddress(a: ServerAddress | null, b: ServerAddress | null): boolean {
  return (
    a !== null && b !== null && a.scheme === b.scheme && a.host === b.host && a.port === b.port
  );
}
