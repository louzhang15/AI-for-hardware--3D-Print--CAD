import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { centeredBounds } from '../scripts/companion.mjs';

const script = fileURLToPath(new URL('../scripts/companion.mjs', import.meta.url));
const run = promisify(execFile);

test('desktop companion centers within the Windows working area', () => {
  assert.deepEqual(centeredBounds({ x: 0, y: 0, width: 1920, height: 1040 }),
    { x: 700, y: 180, width: 520, height: 680 });
  assert.deepEqual(centeredBounds({ x: -480, y: 24, width: 480, height: 640 }),
    { x: -480, y: 24, width: 480, height: 640 });
});

test('desktop companion exposes help and validates the port without launching anything', () => {
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /wiremap companion/);
  const badPort = spawnSync(process.execPath, [script, '--port', '99999'], { encoding: 'utf8' });
  assert.equal(badPort.status, 1);
  assert.match(badPort.stderr, /--port must be a number/);
});

test('desktop companion reuses a healthy server in no-open mode', async (t) => {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    if (request.url === '/api/companion') response.end('{"available":true}');
    else if (request.url === '/companion.html') response.end('<title>Wiremap Companion</title>');
    else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const { port } = server.address();
  const { stdout } = await run(process.execPath, [script, '--no-open', '--port', String(port)], { timeout: 5000 });
  assert.equal(stdout.trim(), `Wiremap Companion: http://127.0.0.1:${port}/companion.html`);
  assert.deepEqual(calls, ['/api/companion', '/companion.html']);
});
