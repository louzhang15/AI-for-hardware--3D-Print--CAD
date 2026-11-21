import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/serial-log.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('serial capture requires explicit bounded parameters and rejects ambiguous inputs', () => {
  assert.equal(run('--help').status, 0);
  for (const args of [
    [], ['--list', '--file', 'firmware.log'], ['--file', 'firmware.log', '--baud', '115200'],
    ['--port', 'COM3 & echo unsafe'], ['--port', 'COM3', '--baud', '0'],
    ['--port', 'COM3', '--seconds', '31'], ['--port', 'COM3', '--seconds', '1.5'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
  }
});

test('serial-log reads a saved UTF-16 log and removes terminal escapes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-serial-'));
  const log = join(dir, 'power boot.log');
  t.after(() => { rmSync(log, { force: true }); rmdirSync(dir); });
  writeFileSync(log, Buffer.from('\uFEFF\x1b[31mBrownout\x1b[0m\r\nVérifiez le câble\r\n', 'utf16le'));
  const result = run('--file', log);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'Brownout\nVérifiez le câble\n');
});

test('serial-log limits a large log to its newest bytes and explains truncation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-serial-'));
  const log = join(dir, 'boot.log');
  t.after(() => { rmSync(log, { force: true }); rmdirSync(dir); });
  writeFileSync(log, `old header\n${'x'.repeat(256 * 1024)}\nlast observed event\n`, 'utf8');
  const result = run('--file', log);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.length, 256 * 1024);
  assert.ok(result.stdout.endsWith('\nlast observed event\n'));
  assert.match(result.stderr, /last 256 KiB/i);
});
