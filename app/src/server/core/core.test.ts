// Unit tests of the pure server-connection code. Run with `npm test`
// (compiled with tsconfig.test.json, executed by Node's built-in test runner).
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import {
  DEFAULT_PORT,
  formatAddress,
  parseIPv4,
  parseServerAddress,
  sameAddress,
  toBaseUrl,
} from './address';
import { probeHealth, type ProbeResult } from './client';
import {
  describeConnection,
  INITIAL_CONNECTION,
  MISSED_HEARTBEATS_BEFORE_UNREACHABLE,
  reduceConnection,
  type ConnectionEvent,
  type ConnectionSnapshot,
} from './connectionMachine';
import { scanHosts } from './discovery';
import { SERVICE_ID, validateHealth, type ServerInfo } from './health';
import { enumerateSubnet24 } from './subnet';

// ---------------------------------------------------------------------------------------
describe('parseServerAddress', () => {
  const ok = (input: string) => {
    const result = parseServerAddress(input);
    assert.equal(result.ok, true, `${input}: ${result.ok ? '' : result.error}`);
    return result.ok ? result.address : (undefined as never);
  };
  const bad = (input: string) => assert.equal(parseServerAddress(input).ok, false, input);

  test('host only gets the default port and http', () => {
    assert.deepEqual(ok('192.0.2.10'), { scheme: 'http', host: '192.0.2.10', port: DEFAULT_PORT });
    assert.equal(DEFAULT_PORT, 8077);
  });
  test('host:port', () => {
    assert.deepEqual(ok('198.51.100.5:9000'), { scheme: 'http', host: '198.51.100.5', port: 9000 });
  });
  test('scheme, trailing slash, path and whitespace are tolerated', () => {
    assert.deepEqual(ok('  http://198.51.100.5:9000/  '), { scheme: 'http', host: '198.51.100.5', port: 9000 });
    assert.deepEqual(ok('HTTP://198.51.100.5/health?x=1'), { scheme: 'http', host: '198.51.100.5', port: DEFAULT_PORT });
    assert.equal(ok('https://example.org').scheme, 'https');
  });
  test('host names are lower-cased', () => {
    assert.equal(ok('My-Laptop.local:8077').host, 'my-laptop.local');
    assert.equal(ok('localhost').host, 'localhost');
  });
  test('rejects nonsense', () => {
    for (const input of [
      '',
      '   ',
      '192.0.2.300',
      '192.0.2',
      '1.2.3.4.5',
      '198.51.100.5:',
      '198.51.100.5:abc',
      '198.51.100.5:0',
      '198.51.100.5:70000',
      'ftp://198.51.100.5',
      'user@198.51.100.5',
      '[::1]:8077',
      'fe80::1',
      'bad host',
      '-bad-.example',
      ':8077',
    ]) {
      bad(input);
    }
  });
  test('formatting', () => {
    const address = ok('198.51.100.5');
    assert.equal(toBaseUrl(address), 'http://198.51.100.5:8077');
    assert.equal(formatAddress(address), '198.51.100.5:8077');
    assert.equal(formatAddress(ok('https://example.org:443')), 'https://example.org:443');
    // What is shown in the field parses back to the same address.
    assert.equal(sameAddress(ok(formatAddress(address)), address), true);
    assert.equal(sameAddress(address, ok('198.51.100.5:8078')), false);
    assert.equal(sameAddress(null, address), false);
  });
  test('parseIPv4', () => {
    assert.deepEqual(parseIPv4('0.255.10.1'), [0, 255, 10, 1]);
    assert.equal(parseIPv4('256.1.1.1'), null);
    assert.equal(parseIPv4('1.1.1'), null);
    assert.equal(parseIPv4('a.b.c.d'), null);
  });
});

// ---------------------------------------------------------------------------------------
describe('enumerateSubnet24', () => {
  test('all other hosts of the /24', () => {
    const result = enumerateSubnet24('192.0.2.23');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.prefix, '192.0.2');
    assert.equal(result.hosts.length, 253);
    assert.equal(result.hosts[0], '192.0.2.1');
    assert.equal(result.hosts[result.hosts.length - 1], '192.0.2.254');
    assert.equal(result.hosts.includes('192.0.2.23'), false);
    assert.equal(result.hosts.includes('192.0.2.0'), false);
    assert.equal(result.hosts.includes('192.0.2.255'), false);
    assert.equal(new Set(result.hosts).size, 253);
  });
  test('rejects addresses that are not on a local network', () => {
    for (const input of ['0.0.0.0', '127.0.0.1', '169.254.3.4', 'not-an-ip', '']) {
      assert.equal(enumerateSubnet24(input).ok, false, input);
    }
  });
});

// ---------------------------------------------------------------------------------------
const GOOD_HEALTH = {
  service: SERVICE_ID,
  api_version: 1,
  server_version: '0.2.0',
  server_name: 'TEST-PC',
  status: 'ok',
  device: 'cuda',
  device_name: 'Some GPU',
  maps: ['room_a', 'room_b'],
  uptime_s: 12.3,
};

describe('validateHealth', () => {
  test('accepts the contract', () => {
    const verdict = validateHealth(GOOD_HEALTH);
    assert.equal(verdict.kind, 'ok');
    if (verdict.kind !== 'ok') return;
    assert.deepEqual(verdict.info, {
      serverName: 'TEST-PC',
      serverVersion: '0.2.0',
      apiVersion: 1,
      status: 'ok',
      device: 'cuda',
      deviceName: 'Some GPU',
      maps: ['room_a', 'room_b'],
    });
  });
  test('optional fields may be missing or oddly shaped', () => {
    const verdict = validateHealth({ service: SERVICE_ID, api_version: 1, status: 'ok', maps: [{ map_id: 'x' }, 7, null, { id: 'y' }] });
    assert.equal(verdict.kind, 'ok');
    if (verdict.kind !== 'ok') return;
    assert.equal(verdict.info.serverName, '(unnamed server)');
    assert.equal(verdict.info.device, '');
    assert.deepEqual(verdict.info.maps, ['x', 'y']);
    const noMaps = validateHealth({ ...GOOD_HEALTH, maps: 'none' });
    assert.equal(noMaps.kind === 'ok' && noMaps.info.maps.length, 0);
  });
  test('other services are not our server', () => {
    for (const body of [null, 'ok', 42, [], {}, { status: 'ok' }, { ...GOOD_HEALTH, service: 'something-else' }]) {
      assert.equal(validateHealth(body).kind, 'not-our-server', JSON.stringify(body));
    }
  });
  test('the health answer of the server before the identity fields is not accepted', () => {
    const legacy = { status: 'ok', version: '0.1.0', device: 'cuda', maps: ['tum_room'], sessions: 0 };
    assert.equal(validateHealth(legacy).kind, 'not-our-server');
  });
  test('unsupported or missing api_version is incompatible', () => {
    for (const api_version of [2, 0, '1', 1.5, undefined]) {
      const verdict = validateHealth({ ...GOOD_HEALTH, api_version });
      assert.equal(verdict.kind, 'incompatible', String(api_version));
    }
  });
  test('status other than ok is unhealthy', () => {
    assert.equal(validateHealth({ ...GOOD_HEALTH, status: 'loading' }).kind, 'unhealthy');
    assert.equal(validateHealth({ ...GOOD_HEALTH, status: undefined }).kind, 'unhealthy');
  });
});

// ---------------------------------------------------------------------------------------
const INFO: ServerInfo = {
  serverName: 'TEST-PC',
  serverVersion: '0.2.0',
  apiVersion: 1,
  status: 'ok',
  device: 'cpu',
  deviceName: '',
  maps: [],
};
const ADDRESS = { scheme: 'http' as const, host: '198.51.100.5', port: 8077 };
const OK: ProbeResult = { kind: 'ok', info: INFO, latencyMs: 12 };
const DOWN: ProbeResult = { kind: 'unreachable', reason: 'no answer within 1500 ms' };

function run(events: ConnectionEvent[], from: ConnectionSnapshot = INITIAL_CONNECTION): ConnectionSnapshot {
  return events.reduce(reduceConnection, from);
}

describe('reduceConnection', () => {
  test('starts not configured; probes without an address are ignored', () => {
    assert.equal(INITIAL_CONNECTION.state, 'not-configured');
    assert.deepEqual(run([{ type: 'probe', result: OK }]), INITIAL_CONNECTION);
  });
  test('address -> connecting -> connected', () => {
    const connecting = run([{ type: 'address-set', address: ADDRESS }]);
    assert.equal(connecting.state, 'connecting');
    const connected = reduceConnection(connecting, { type: 'probe', result: OK });
    assert.equal(connected.state, 'connected');
    assert.equal(connected.latencyMs, 12);
    assert.equal(connected.info?.serverName, 'TEST-PC');
    assert.equal(describeConnection(connected), 'Server: connected · TEST-PC · 12 ms');
  });
  test('first check without an answer -> unreachable at once', () => {
    const state = run([{ type: 'address-set', address: ADDRESS }, { type: 'probe', result: DOWN }]);
    assert.equal(state.state, 'unreachable');
    assert.equal(state.detail, 'no answer within 1500 ms');
  });
  test('a connected server survives one missed heartbeat, not two; and recovers', () => {
    assert.equal(MISSED_HEARTBEATS_BEFORE_UNREACHABLE, 2);
    const connected = run([{ type: 'address-set', address: ADDRESS }, { type: 'probe', result: OK }]);
    const oneMiss = reduceConnection(connected, { type: 'probe', result: DOWN });
    assert.equal(oneMiss.state, 'connected');
    assert.equal(oneMiss.missedHeartbeats, 1);
    const recovered = reduceConnection(oneMiss, { type: 'probe', result: OK });
    assert.equal(recovered.state, 'connected');
    assert.equal(recovered.missedHeartbeats, 0);
    const twoMisses = reduceConnection(oneMiss, { type: 'probe', result: DOWN });
    assert.equal(twoMisses.state, 'unreachable');
    assert.equal(twoMisses.latencyMs, null);
    assert.equal(reduceConnection(twoMisses, { type: 'probe', result: OK }).state, 'connected');
  });
  test('incompatible, unhealthy and foreign servers', () => {
    const base = run([{ type: 'address-set', address: ADDRESS }]);
    const incompatible = reduceConnection(base, {
      type: 'probe',
      result: { kind: 'incompatible', info: { ...INFO, apiVersion: 2 }, reason: 'server API version 2', latencyMs: 9 },
    });
    assert.equal(incompatible.state, 'incompatible');
    assert.equal(describeConnection(incompatible), 'Server: incompatible');
    const unhealthy = reduceConnection(base, {
      type: 'probe',
      result: { kind: 'unhealthy', info: INFO, reason: 'server status is "loading"', latencyMs: 9 },
    });
    assert.equal(unhealthy.state, 'unreachable');
    const foreign = reduceConnection(base, { type: 'probe', result: { kind: 'not-our-server', reason: 'no service field' } });
    assert.equal(foreign.state, 'unreachable');
    assert.match(foreign.detail, /not the localization server/);
  });
  test('search: progress, late probes ignored, ends back at the old address or not-configured', () => {
    const searching = run([{ type: 'search-started', total: 253 }, { type: 'search-progress', scanned: 40 }]);
    assert.equal(searching.state, 'searching');
    assert.equal(describeConnection(searching), 'Server: searching 40/253');
    assert.equal(reduceConnection(searching, { type: 'probe', result: OK }).state, 'searching');
    const nothing = reduceConnection(searching, { type: 'search-ended', detail: 'no server found' });
    assert.equal(nothing.state, 'not-configured');
    assert.equal(nothing.detail, 'no server found');
    assert.equal(nothing.scan, null);

    const hadAddress = run([
      { type: 'address-set', address: ADDRESS },
      { type: 'probe', result: OK },
      { type: 'search-started', total: 253 },
      { type: 'search-ended' },
    ]);
    assert.equal(hadAddress.state, 'connecting');
    assert.deepEqual(hadAddress.address, ADDRESS);
  });
  test('choosing a found server and clearing the address', () => {
    const chosen = run([{ type: 'search-started', total: 253 }, { type: 'address-set', address: ADDRESS }]);
    assert.equal(chosen.state, 'connecting');
    assert.equal(chosen.scan, null);
    assert.deepEqual(run([{ type: 'address-set', address: ADDRESS }, { type: 'probe', result: OK }, { type: 'address-cleared' }]), INITIAL_CONNECTION);
  });
  test('chip texts', () => {
    assert.equal(describeConnection(INITIAL_CONNECTION), 'Server: not set up');
    assert.equal(describeConnection(run([{ type: 'address-set', address: ADDRESS }])), 'Server: connecting...');
    assert.equal(describeConnection(run([{ type: 'address-set', address: ADDRESS }, { type: 'probe', result: DOWN }])), 'Server: unreachable');
  });
});

// ---------------------------------------------------------------------------------------
// A tiny mock of the server contract: several "hosts" are emulated by ports of 127.0.0.1.
describe('probeHealth and scanHosts against a local mock', () => {
  const servers: Server[] = [];
  const ports: Record<string, number> = {};

  const start = (name: string, handler: (path: string) => { status?: number; body: string; delayMs?: number }) =>
    new Promise<void>((resolve) => {
      const server = createServer((request, response) => {
        const answer = handler(request.url ?? '');
        setTimeout(() => {
          response.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json' });
          response.end(answer.body);
        }, answer.delayMs ?? 0);
      });
      server.listen(0, '127.0.0.1', () => {
        ports[name] = (server.address() as AddressInfo).port;
        servers.push(server);
        resolve();
      });
    });

  before(async () => {
    await start('good', (path) =>
      path === '/health' ? { body: JSON.stringify(GOOD_HEALTH) } : { status: 404, body: '{}' },
    );
    await start('v2', () => ({ body: JSON.stringify({ ...GOOD_HEALTH, api_version: 2, server_name: 'FUTURE' }) }));
    await start('other', () => ({ body: JSON.stringify({ hello: 'I am a router page' }) }));
    await start('html', () => ({ body: '<html>not json</html>' }));
    await start('slow', () => ({ body: JSON.stringify(GOOD_HEALTH), delayMs: 600 }));
    await start('error', () => ({ status: 500, body: '{}' }));
  });
  after(() => {
    servers.forEach((server) => {
      server.closeAllConnections();
      server.close();
    });
  });

  const url = (name: string) => `http://127.0.0.1:${ports[name]}`;

  test('good server', async () => {
    const result = await probeHealth(url('good'), { timeoutMs: 1000 });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') return;
    assert.equal(result.info.serverName, 'TEST-PC');
    assert.ok(result.latencyMs >= 0 && result.latencyMs < 1000);
  });
  test('incompatible, foreign, non-JSON, HTTP error', async () => {
    assert.equal((await probeHealth(url('v2'), { timeoutMs: 1000 })).kind, 'incompatible');
    assert.equal((await probeHealth(url('other'), { timeoutMs: 1000 })).kind, 'not-our-server');
    assert.equal((await probeHealth(url('html'), { timeoutMs: 1000 })).kind, 'not-our-server');
    const error = await probeHealth(url('error'), { timeoutMs: 1000 });
    assert.deepEqual(error, { kind: 'unreachable', reason: 'HTTP 500' });
  });
  test('timeout and connection refused never throw', async () => {
    const slow = await probeHealth(url('slow'), { timeoutMs: 100 });
    assert.deepEqual(slow, { kind: 'unreachable', reason: 'no answer within 100 ms' });
    const refused = await probeHealth('http://127.0.0.1:1', { timeoutMs: 1000 });
    assert.equal(refused.kind, 'unreachable');
  });
  test('an outer abort cancels the request', async () => {
    const controller = new AbortController();
    const pending = probeHealth(url('slow'), { timeoutMs: 5000, signal: controller.signal });
    controller.abort();
    assert.deepEqual(await pending, { kind: 'unreachable', reason: 'cancelled' });
  });

  // scanHosts builds "http://<host>:<port>"; the fake probe maps host names to mock ports.
  const probeByName = (baseUrl: string, options: { timeoutMs: number; signal?: AbortSignal }) => {
    const host = /^http:\/\/([^:]+):/.exec(baseUrl)?.[1] ?? '';
    return ports[host] !== undefined
      ? probeHealth(url(host), options)
      : Promise.resolve<ProbeResult>({ kind: 'unreachable', reason: 'no such host' });
  };

  test('scan finds only our servers, compatible first, and reports progress', async () => {
    const hosts = ['nobody1', 'other', 'v2', 'html', 'good', 'error', 'nobody2'];
    const progress: number[] = [];
    const result = await scanHosts({
      hosts,
      port: 8077,
      concurrency: 3,
      timeoutMs: 1000,
      probe: probeByName,
      onProgress: (scanned) => progress.push(scanned),
    });
    assert.equal(result.cancelled, false);
    assert.equal(result.scanned, hosts.length);
    assert.equal(result.total, hosts.length);
    assert.deepEqual(result.found.map((s) => [s.address.host, s.compatible]), [['good', true], ['v2', false]]);
    assert.equal(result.found[0].address.port, 8077);
    assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7]);
  });
  test('scan respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await scanHosts({
      hosts: Array.from({ length: 20 }, (_, i) => `h${i}`),
      port: 8077,
      concurrency: 4,
      timeoutMs: 100,
      probe: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { kind: 'unreachable', reason: 'x' };
      },
    });
    assert.equal(result.scanned, 20);
    assert.equal(peak, 4);
  });
  test('scan can be cancelled', async () => {
    const controller = new AbortController();
    const result = await scanHosts({
      hosts: Array.from({ length: 50 }, (_, i) => `h${i}`),
      port: 8077,
      concurrency: 2,
      timeoutMs: 100,
      signal: controller.signal,
      probe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: 'unreachable', reason: 'x' };
      },
      onProgress: (scanned) => {
        if (scanned === 6) controller.abort();
      },
    });
    assert.equal(result.cancelled, true);
    assert.ok(result.scanned >= 6 && result.scanned < 50, String(result.scanned));
  });
});
