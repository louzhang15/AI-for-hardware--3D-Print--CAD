// Pin and wire editing: lib/edit.js operations and ranking, the server's
// wire route with its undo stack (on a temp copy of projects/), and the
// viewer's Change pin picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { applyWireEdit, pinOptions } from '../lib/edit.js';
import { checkProject } from '../lib/check.js';
import { loadLibrary } from '../lib/node/library.js';
import { startServer } from '../viewer/serve.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const lib = loadLibrary();
const arm = () => JSON.parse(readFileSync(join(root, 'projects', 'robot-arm.json'), 'utf8'));

test('move, add, colour and delete a wire', () => {
  const p = arm();
  const moved = applyWireEdit(p, lib, { op: 'move', id: 'usb-power', end: 'to', to: 'esp.GPIO3', color: 'orange' });
  assert.equal(moved.project.wires.find((w) => w.id === 'usb-power').to, 'esp.GPIO3');
  assert.equal(moved.project.wires.find((w) => w.id === 'usb-power').color, 'orange');
  assert.equal(p.wires.find((w) => w.id === 'usb-power').to, 'esp.VIN', 'input project is not mutated');
  const added = applyWireEdit(p, lib, { op: 'add', from: 'esp.GND', to: 'pwm.GND', color: 'black' });
  assert.equal(added.project.wires.length, p.wires.length + 1);
  assert.ok(added.wire.id && !p.wires.some((w) => w.id === added.wire.id));
  const colored = applyWireEdit(p, lib, { op: 'color', id: 'usb-power', color: 'red' });
  assert.equal(colored.project.wires.find((w) => w.id === 'usb-power').color, 'red');
  const stepWith = p.steps.find((s) => (s.wires || []).includes('usb-power'));
  const del = applyWireEdit(p, lib, { op: 'delete', id: 'usb-power' });
  assert.ok(!del.project.wires.some((w) => w.id === 'usb-power'));
  assert.ok(!del.project.steps.find((s) => s.id === stepWith.id).wires.includes('usb-power'), 'deleted wire leaves its steps');
});

test('bad edits are refused with a reason', () => {
  const p = arm();
  assert.throws(() => applyWireEdit(p, lib, { op: 'move', id: 'nope', end: 'to', to: 'esp.GND' }), /No wire/);
  assert.throws(() => applyWireEdit(p, lib, { op: 'move', id: 'usb-power', end: 'to', to: 'esp.NOPE' }), /no pin "NOPE"/);
  assert.throws(() => applyWireEdit(p, lib, { op: 'move', id: 'usb-power', end: 'to', to: 'ghost.GND' }), /No part "ghost"/);
  assert.throws(() => applyWireEdit(p, lib, { op: 'move', id: 'usb-power', end: 'side', to: 'esp.GND' }), /end must be/);
  assert.throws(() => applyWireEdit(p, lib, { op: 'move', id: 'usb-power', end: 'to', to: 'usb.5V' }), /same pin/);
  assert.throws(() => applyWireEdit(p, lib, { op: 'color', id: 'usb-power', color: 'pink' }), /colour/);
  assert.throws(() => applyWireEdit(p, lib, { op: 'explode' }), /op must be/);
  for (const bad of [{ op: 'add', from: 'esp.GND', to: 'esp.GND' }, { op: 'add', from: 'esp.GND', to: 'x' }]) {
    assert.throws(() => applyWireEdit(p, lib, bad), (e) => e.status === 400);
  }
});

test('pinOptions ranks safe pins first and a short to GND last', () => {
  const opts = pinOptions(arm(), lib, { id: 'usb-power', end: 'to', part: 'esp' });
  assert.ok(opts.length > 20);
  const gnd = opts.find((o) => o.endpoint === 'esp.GND');
  assert.ok(gnd.errors >= 1 && /Short circuit/.test(gnd.problems.map((x) => x.message).join(' ')));
  assert.ok(opts.indexOf(gnd) > opts.findIndex((o) => o.errors === 0), 'error-free pins come before the short');
  for (let i = 1; i < opts.length; i++) assert.ok(opts[i - 1].errors <= opts[i].errors, 'sorted by new errors');
  // 5 V into a 3.6 V GPIO is an error now
  const gpio = opts.find((o) => o.endpoint === 'esp.GPIO3');
  assert.ok(gpio.errors >= 1, 'supply into a signal pin is flagged');
  assert.ok(!opts.some((o) => o.endpoint === 'esp.VIN'), 'the current pin is not offered');
});

test('server wire route edits a temp copy and undo restores the exact text', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'wiremap-pinedit-'));
  cpSync(join(root, 'projects'), join(tmp, 'projects'), { recursive: true });
  const file = join(tmp, 'projects', 'robot-arm.json');
  const original = readFileSync(file, 'utf8');
  const server = await startServer({ port: 0, projectsDir: join(tmp, 'projects') });
  t.after(() => server.close());
  const post = (path, body) => fetch(new URL(path, server.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

  let r = await post('/api/project/robot-arm/wire', { op: 'move', id: 'sda', end: 'from', to: 'esp.GPIO4' });
  assert.equal(r.status, 200, await r.clone().text());
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.wires.find((w) => w.id === 'sda').from, 'esp.GPIO4');
  assert.equal(checkProject(after, lib).issues.filter((i) => i.rule === 'schema').length, 0);

  r = await post('/api/project/robot-arm/wire', { op: 'move', id: 'sda', end: 'from', to: 'esp.NOPE' });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).wires.find((w) => w.id === 'sda').from, 'esp.GPIO4', 'a refused edit writes nothing');

  r = await post('/api/project/robot-arm/wire/undo');
  assert.equal(r.status, 200);
  assert.equal(readFileSync(file, 'utf8'), original, 'undo restores the original bytes');
  r = await post('/api/project/robot-arm/wire/undo');
  assert.equal(r.status, 409, 'nothing left to undo');
  r = await post('/api/project/..%2Fx/wire', { op: 'delete', id: 'usb-power' });
  assert.ok(r.status >= 400);
});

test('viewer: Change pin lists checked pins, safest first', { timeout: 90000 }, async (t) => {
  let chromium = null;
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
  if (!chromium) { t.skip('playwright not installed'); return; }
  const tmp = mkdtempSync(join(tmpdir(), 'wiremap-pinedit-ui-'));
  cpSync(join(root, 'projects'), join(tmp, 'projects'), { recursive: true });
  const server = await startServer({ port: 0, projectsDir: join(tmp, 'projects') });
  let browser;
  try { browser = await chromium.launch(); } catch (e) { await server.close(); t.skip(`chromium unavailable: ${e.message}`); return; }
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('wiremap:wiremap.askSeen', 'true'); });
  await page.goto(new URL('/#/p/robot-arm', server.url).href);
  await page.waitForSelector('.view-tab');
  await page.getByRole('tab', { name: 'Sketch' }).click();
  await page.waitForFunction(() => window.wiremap?.data?.name === 'robot-arm');
  await page.evaluate(() => window.wiremap.select({ type: 'wire', id: 'sda' }));
  await page.getByRole('button', { name: 'Change start pin' }).click();
  await page.waitForSelector('.pe-row');
  const rows = page.locator('.pe-row');
  assert.ok(await rows.count() > 20, `rows: ${await rows.count()}`);
  assert.equal(await rows.first().evaluate((el) => el.classList.contains('has-error')), false, 'safest pin first');
  assert.match(await rows.last().innerText(), /SDA and SCL are joined/);
  // an error pin needs a second click
  await rows.last().click();
  assert.match(await page.locator('.pe-status').innerText(), /Click it again/);
  await page.keyboard.press('Escape');
  // pin card offers a new wire
  await page.evaluate(() => window.wiremap.select({ type: 'pin', id: 'esp.GPIO4' }));
  assert.ok(await page.getByRole('button', { name: 'Connect to…' }).isVisible());
  assert.deepEqual(errors, []);
});
