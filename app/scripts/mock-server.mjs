// Minimal stand-in for the localization server: implements only `GET /health` of the
// contract the app expects. For checking the app's connection screen without the real
// (Python, GPU) server. No dependencies.
//
//   node scripts/mock-server.mjs                      # port 8077, all network interfaces
//   node scripts/mock-server.mjs --port 9000 --name "Test PC" --api-version 2
//
// Stop with Ctrl+C. Like the real server it must be reachable from the phone: same Wi-Fi,
// and the PC's firewall has to allow inbound TCP on the port (see README).
import { createServer } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const port = Number(option('port', '8077'));
const serverName = option('name', `${hostname()} (mock)`);
const apiVersion = Number(option('api-version', '1'));
const startedAt = Date.now();

const server = createServer((request, response) => {
  const path = (request.url ?? '').split('?')[0];
  const send = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && path === '/health') {
    send(200, {
      service: 'arportal-localization-server',
      api_version: apiVersion,
      server_version: '0.0.0-mock',
      server_name: serverName,
      status: 'ok',
      device: 'none',
      device_name: 'mock server, no localisation',
      maps: [],
      uptime_s: Math.round((Date.now() - startedAt) / 100) / 10,
    });
  } else {
    send(404, { detail: 'the mock server only implements GET /health' });
  }
  console.log(`${new Date().toISOString()} ${request.socket.remoteAddress} ${request.method} ${path}`);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mock localization server "${serverName}", API version ${apiVersion}, port ${port}`);
  console.log('addresses of this computer (type one into the app, or use "Find automatically"):');
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        console.log(`  ${entry.address}:${port}   (${name})`);
      }
    }
  }
});
