/**
 * Validation of the server's `GET /health` answer. Pure TypeScript, covered by `health.test.ts`.
 *
 * Contract (identity fields are required, everything else is optional and read defensively):
 *   {
 *     "service": "arportal-localization-server",
 *     "api_version": 1,
 *     "server_version": "0.1.0",
 *     "server_name": "DESKTOP-ABC",
 *     "status": "ok",
 *     "device": "cuda", "device_name": "...", "maps": ["room"], ...
 *   }
 */

export const SERVICE_ID = 'arportal-localization-server';
export const SUPPORTED_API_VERSIONS: readonly number[] = [1];

export interface ServerInfo {
  serverName: string;
  serverVersion: string;
  apiVersion: number;
  status: string;
  /** Compute device, e.g. "cuda" or "cpu"; empty when the server does not say. */
  device: string;
  deviceName: string;
  /** Ids of the maps the server has loaded. */
  maps: string[];
  /** v2 features the server announces (`recording_upload`, `jobs`, `room_plan`, `auto_portal`); empty on a v1 server. */
  capabilities: string[];
}

export type HealthVerdict =
  /** Our server, a supported API version, status "ok". */
  | { kind: 'ok'; info: ServerInfo }
  /** Our server, but it speaks an API version this app does not support. */
  | { kind: 'incompatible'; info: ServerInfo; reason: string }
  /** Our server, compatible, but it reports a status other than "ok". */
  | { kind: 'unhealthy'; info: ServerInfo; reason: string }
  /** Something answered, but it is not the AR-portal localization server. */
  | { kind: 'not-our-server'; reason: string };

function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function readMaps(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      ids.push(item);
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const id = asString(record.map_id) || asString(record.id) || asString(record.name);
      if (id) {
        ids.push(id);
      }
    }
  }
  return ids;
}

export function validateHealth(body: unknown): HealthVerdict {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'not-our-server', reason: 'the answer is not a JSON object' };
  }
  const json = body as Record<string, unknown>;
  if (json.service !== SERVICE_ID) {
    return {
      kind: 'not-our-server',
      reason:
        json.service === undefined
          ? 'the answer has no "service" field'
          : `service is "${asString(json.service)}"`,
    };
  }

  const apiVersion =
    typeof json.api_version === 'number' && Number.isInteger(json.api_version)
      ? json.api_version
      : NaN;
  const info: ServerInfo = {
    serverName: asString(json.server_name) || '(unnamed server)',
    serverVersion: asString(json.server_version),
    apiVersion,
    status: asString(json.status),
    device: asString(json.device),
    deviceName: asString(json.device_name),
    maps: readMaps(json.maps),
    capabilities: Array.isArray(json.capabilities)
      ? json.capabilities.filter((c): c is string => typeof c === 'string')
      : [],
  };

  if (!SUPPORTED_API_VERSIONS.includes(apiVersion)) {
    return {
      kind: 'incompatible',
      info,
      reason: Number.isNaN(apiVersion)
        ? 'the server does not report an integer api_version'
        : `server API version ${apiVersion}, this app supports ${SUPPORTED_API_VERSIONS.join(', ')}`,
    };
  }
  if (info.status !== 'ok') {
    return { kind: 'unhealthy', info, reason: `server status is "${info.status || 'missing'}"` };
  }
  return { kind: 'ok', info };
}
