import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pinsHeader, bomCsv, csvField, wirevizYaml, kicadNetlist, kicadNets, buildGuideHtml, shoppingChecklist,
  pinNumber, controllerPinTable,
} from '../lib/export.js';
import { resolveProject } from '../lib/model.js';
import { buildNets } from '../lib/nets.js';
import { appendInbox, readInbox, markInbox, inboxPath } from '../lib/node/inbox.js';
import { main as inboxMain } from '../scripts/inbox.mjs';

// Inline part definitions so the tests don't depend on library/*.json.
const LIB = {
  'esp32-test': {
    id: 'esp32-test', name: 'ESP32 DevKit (test)', category: 'controller', size: [52, 10, 28],
    pins: [
      { name: '3V3', kind: 'power_out', voltage: 3.3, current_max: 0.5 },
      { name: 'VIN', kind: 'power_in', vmin: 4.5, vmax: 12 },
      { name: 'GND', kind: 'ground' },
      { name: 'GND_2', kind: 'ground' },
      { name: 'GPIO21', kind: 'digital', dir: 'io', voltage: 3.3, label: 'D21' },
      { name: 'GPIO22', kind: 'digital', dir: 'io', voltage: 3.3, label: 'D22' },
      { name: 'GPIO5', kind: 'digital', dir: 'io', voltage: 3.3, label: 'D5' },
      { name: 'GPIO18', kind: 'digital', dir: 'io', voltage: 3.3, label: 'D18' },
      { name: 'EN', kind: 'digital', dir: 'in' },
    ],
    internal: [['GND', 'GND_2']],
  },
  'pca-test': {
    id: 'pca-test', name: 'PCA9685 "16-ch" PWM, driver', category: 'driver', size: [62, 4, 25],
    pins: [
      { name: 'VCC', kind: 'power_in' }, { name: 'GND', kind: 'ground' },
      { name: 'SDA', kind: 'i2c_sda' }, { name: 'SCL', kind: 'i2c_scl' }, { name: 'V+', kind: 'power_rail' },
    ],
  },
  'sonar-test': {
    id: 'sonar-test', name: 'HC-SR04', category: 'sensor', size: [45, 15, 20],
    pins: [{ name: 'VCC', kind: 'power_in' }, { name: 'TRIG', kind: 'digital' }, { name: 'ECHO', kind: 'digital' }, { name: 'GND', kind: 'ground' }],
  },
  'uno-test': {
    id: 'uno-test', name: 'Uno', category: 'controller',
    pins: [{ name: 'A0', kind: 'analog' }, { name: 'D7', kind: 'digital' }, { name: 'GND', kind: 'ground' }],
  },
};

function sampleProject() {
  return {
    meta: { name: 'Sonar <script>alert(1)</script> bot', description: 'Desk robot "v1", with sonar' },
    parts: [
      { id: 'esp', library: 'esp32-test', bom: { why: 'Brains, WiFi', price: 8.5, currency: 'USD', link: 'https://example.com/esp?a=1&b=2', checked: '2026-11-20',
        options: [{ tier: 'budget', name: 'ESP32 clone', why: 'cheaper, "same" chip' }, { tier: 'recommended', name: 'Espressif DevKitC' }] } },
      { id: 'pca', library: 'pca-test', have: true },
      { id: 'sonar', library: 'sonar-test', bom: { why: 'Measures distance,\nup to 4 m', price: 2 } },
    ],
    wires: [
      { id: 'w1', from: 'esp.GPIO21', to: 'pca.SDA', color: 'blue', gauge: 26, length_mm: 150, purpose: 'I2C data' },
      { id: 'w2', from: 'esp.GPIO22', to: 'pca.SCL', color: 'yellow', gauge: 26, length_mm: 150, purpose: 'I2C clock' },
      { id: 'w3', from: 'esp.GPIO5', to: 'sonar.TRIG', color: 'white', purpose: 'trigger <pulse>' },
      { id: 'w4', from: 'esp.GPIO18', to: 'sonar.ECHO', color: 'green' },
      { id: 'w5', from: 'esp.3V3', to: 'pca.VCC', color: 'red' },
      { id: 'w6', from: 'esp.GND', to: 'pca.GND', color: 'black' },
      { id: 'w7', from: 'esp.VIN', to: 'sonar.VCC', color: 'red' },
      { id: 'w8', from: 'esp.GND_2', to: 'sonar.GND', color: 'black' },
    ],
    fasteners: [{ id: 'm3x8', name: 'M3x8 screw, socket head', qty: 8 }],
    prints: [
      { id: 'base', name: 'Base', material: 'PLA', filament_g: 42 },
      { id: 'lid', name: 'Lid', material: 'PLA', size: [100, 5, 80], settings: { infill: 20 } },
      { id: 'clip', name: 'Clip', material: 'PETG', filament_g: 3, qty: 2 },
    ],
    steps: [
      { id: 's1', phase: 'wire', title: 'Connect the <b>I2C</b> bus', text: 'SDA & SCL', wires: ['w1', 'w2'],
        warnings: ['Unplug USB <script>x</script>'], tools: ['2 jumpers'] },
      { id: 's2', phase: 'wire', title: 'Sonar', wires: ['w3', 'w4'], warning: 'Echo is 5 V' },
    ],
  };
}

test('pinNumber parses GPIO, GP, D and analog names', () => {
  assert.equal(pinNumber({ name: 'GPIO21' }), 21);
  assert.equal(pinNumber({ name: 'GP15' }), 15);
  assert.equal(pinNumber({ name: 'D7' }), 7);
  assert.equal(pinNumber({ name: 'A0' }), 'A0');
  assert.equal(pinNumber({ name: 'X', label: 'IO4' }), 4);
  assert.equal(pinNumber({ name: 'EN' }), null);
  assert.equal(pinNumber({ name: 'X', gpio: 9 }), 9);
});

test('pins.h for ESP32 -> PCA9685 + HC-SR04', () => {
  const h = pinsHeader(sampleProject(), LIB);
  assert.match(h, /#ifndef WIREMAP_PINS_H\n#define WIREMAP_PINS_H/);
  assert.match(h, /#endif/);
  assert.match(h, /DO NOT EDIT BY HAND/);
  assert.match(h, /wiremap export pins-h/);
  assert.match(h, /#define PIN_PCA_SDA\s+21\n/);
  assert.match(h, /#define PIN_PCA_SCL\s+22\n/);
  assert.match(h, /#define PIN_SONAR_TRIG\s+5\n/);
  assert.match(h, /#define PIN_SONAR_ECHO\s+18\n/);
  // I2C grouped first
  assert.ok(h.indexOf('// I2C bus') < h.indexOf('PIN_SONAR_TRIG'));
  assert.ok(h.indexOf('PIN_PCA_SDA') < h.indexOf('// Digital I/O'));
  // power pins never become defines
  assert.doesNotMatch(h, /#define \w*(VCC|GND|3V3)/);
  // no duplicate symbols
  const syms = [...h.matchAll(/#define (PIN_\w+)/g)].map((m) => m[1]);
  assert.equal(new Set(syms).size, syms.length);
  // project-name text can't break out of the comment
  assert.ok(!/\n[^/\n#].*script/.test(h));

  const c = pinsHeader(sampleProject(), LIB, { style: 'constexpr' });
  assert.match(c, /constexpr uint8_t PIN_PCA_SDA = 21;/);
});

test('pins.h: two devices on I2C give a shared bus name; analog emits A0; duplicates are suffixed', () => {
  const p = sampleProject();
  p.parts.push({ id: 'pca2', library: 'pca-test' });
  p.wires.push({ id: 'w9', from: 'pca.SDA', to: 'pca2.SDA' });
  const h = pinsHeader(p, LIB);
  assert.match(h, /#define PIN_I2C_SDA\s+21/);
  assert.match(h, /#define PIN_PCA_SCL\s+22/);

  const uno = {
    parts: [{ id: 'uno', library: 'uno-test' }, { id: 'pot', pins: [{ name: 'W', kind: 'analog' }, { name: 'W2', kind: 'analog' }] },
      { id: 'led', name: 'LED', pins: [{ name: 'A', kind: 'passive' }] }],
    wires: [{ id: 'a', from: 'uno.A0', to: 'pot.W' }, { id: 'b', from: 'uno.D7', to: 'led.A' }],
  };
  const hu = pinsHeader(uno, LIB);
  assert.match(hu, /#define PIN_POT_W\s+A0/);
  assert.match(hu, /#define PIN_LED_A\s+7/);
  assert.throws(() => pinsHeader({ parts: [{ id: 'pca', library: 'pca-test' }] }, LIB), /controller/);
  // two controller pins wired to the same part pin: second symbol gets a suffix
  const d = sampleProject();
  d.wires = d.wires.filter((w) => w.id !== 'w4').concat([{ id: 'w4b', from: 'esp.GPIO18', to: 'sonar.TRIG' }]);
  const hd = pinsHeader(d, LIB);
  assert.match(hd, /#define PIN_SONAR_TRIG\s+\d+/);
  assert.match(hd, /#define PIN_SONAR_TRIG_2\s+\d+/);
  const t = controllerPinTable(sampleProject(), LIB, { controller: 'esp' });
  assert.equal(t.entries.length, 4);
});

/** Minimal RFC 4180 parser for the test. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

test('BOM CSV escapes quotes, commas and newlines', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('two\nlines'), '"two\nlines"');
  assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvField(-3), '-3');
  assert.equal(csvField(undefined), '');

  const csv = bomCsv(sampleProject(), LIB);
  assert.ok(csv.endsWith('\r\n'));
  const rows = parseCsv(csv);
  const header = rows[0];
  assert.deepEqual(header, ['type', 'id', 'name', 'qty', 'have', 'why', 'price', 'currency', 'link', 'checked', 'options']);
  for (const r of rows) assert.equal(r.length, header.length, JSON.stringify(r));
  const col = (r, k) => r[header.indexOf(k)];
  const pca = rows.find((r) => col(r, 'id') === 'pca');
  assert.equal(col(pca, 'name'), 'PCA9685 "16-ch" PWM, driver');
  assert.equal(col(pca, 'have'), 'yes');
  const sonar = rows.find((r) => col(r, 'id') === 'sonar');
  assert.equal(col(sonar, 'why'), 'Measures distance,\nup to 4 m');
  const esp = rows.find((r) => col(r, 'id') === 'esp');
  assert.equal(col(esp, 'price'), '8.5');
  assert.equal(col(esp, 'link'), 'https://example.com/esp?a=1&b=2');
  assert.match(col(esp, 'options'), /^budget: ESP32 clone \(cheaper, "same" chip\); recommended: Espressif DevKitC$/);
  assert.equal(col(rows.find((r) => col(r, 'id') === 'm3x8'), 'qty'), '8');
  const pla = rows.find((r) => col(r, 'id') === 'filament-pla');
  assert.ok(Number(col(pla, 'qty')) > 42, 'explicit 42 g + estimate for the lid');
  assert.match(col(pla, 'why'), /estimate/i);
  assert.equal(col(rows.find((r) => col(r, 'id') === 'filament-petg'), 'qty'), '6');
});

test('WireViz YAML structure', () => {
  const yml = wirevizYaml(sampleProject(), LIB);
  const lines = yml.split('\n');
  const top = lines.filter((l) => /^\S/.test(l) && !l.startsWith('#'));
  assert.deepEqual(top, ['connectors:', 'cables:', 'connections:']);
  assert.match(yml, /\n {2}"esp":\n {4}type: "ESP32 DevKit \(test\)"\n/);
  assert.match(yml, /pinlabels: \["D21"|pinlabels: \["3V3"/);
  assert.match(yml, /\n {2}"w1":\n {4}wirecount: 1\n {4}colors: \[BU\]\n {4}gauge: "26 AWG"\n {4}length: 0\.15\n/);
  // connection w1: esp pin 5 (GPIO21 is the 5th pin) -> w1 -> pca pin 3 (SDA)
  assert.match(yml, /- "esp": \[5\]\n {4}- "w1": \[1\]\n {4}- "pca": \[3\]/);
  const conns = yml.split('connections:')[1].match(/^ {2}-$/gm);
  assert.equal(conns.length, 8);
  // no tabs, quotes in names stay inside JSON-style strings
  assert.ok(!yml.includes('\t'));
  assert.match(yml, /type: "PCA9685 \\"16-ch\\" PWM, driver"/);
});

test('KiCad netlist: balanced parens and one net per joined pin group', () => {
  const p = sampleProject();
  const net = kicadNetlist(p, LIB, { date: '2026-11-20' });
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < net.length; i++) {
    const c = net[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '(') depth++;
    else if (c === ')') { depth--; assert.ok(depth >= 0, 'closing paren without opener'); }
  }
  assert.equal(depth, 0);
  assert.ok(!inStr);
  assert.ok(net.startsWith('(export (version "E")'));
  const nets = buildNets(resolveProject(p, LIB));
  const expected = kicadNets(nets).length;
  // GND (with internal GND_2), 3V3, VIN, SDA, SCL, TRIG, ECHO
  assert.equal(expected, 7);
  assert.equal((net.match(/\(net \(code /g) || []).length, expected);
  assert.equal((net.match(/\(comp \(ref /g) || []).length, 3);
  assert.match(net, /\(node \(ref "U1"\) \(pin "GPIO21"\)/);
  assert.match(net, /\(value "PCA9685 \\"16-ch\\" PWM, driver"\)/);
  const names = [...net.matchAll(/\(net \(code "\d+"\) \(name ("(?:[^"\\]|\\.)*")/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length);
});

test('HTML build guide escapes user text', () => {
  const html = buildGuideHtml(sampleProject(), LIB, { issues: [{ level: 'error', message: 'Bad <img src=x onerror=alert(1)>' }] });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('<script>'), 'no raw script tag');
  assert.ok(!html.includes('<img'), 'no raw img tag');
  assert.match(html, /Sonar &lt;script&gt;alert\(1\)&lt;\/script&gt; bot/);
  assert.match(html, /Connect the &lt;b&gt;I2C&lt;\/b&gt; bus/);
  assert.match(html, /Warning: Unplug USB &lt;script&gt;/);
  assert.match(html, /Warning: Echo is 5 V/);
  assert.match(html, /href="https:\/\/example.com\/esp\?a=1&amp;b=2"/);
  assert.match(html, /trigger &lt;pulse&gt;/);
  assert.match(html, /1 error\(s\)/);
  // self-contained: no external resources
  assert.ok(!/<(script|link)\b/i.test(html));
  // javascript: links are dropped
  const p = sampleProject();
  p.parts[0].bom.link = 'javascript:alert(1)';
  assert.ok(!buildGuideHtml(p, LIB).includes('javascript:'));
});

test('shopping checklist is markdown with ticks for parts on hand', () => {
  const md = shoppingChecklist(sampleProject(), LIB);
  assert.match(md, /^# Shopping list: /);
  assert.match(md, /- \[x\] 1x PCA9685/);
  assert.match(md, /- \[ \] 1x ESP32 DevKit \(test\) - 8\.5 USD - \[store\]\(<https:\/\/example\.com\/esp\?a=1&b=2>\)/);
  assert.match(md, /- \[ \] 8x M3x8 screw, socket head/);
  assert.match(md, /## Filament/);
  assert.match(md, /Estimated total for items still to buy: 8\.5 USD \+ 2/);
  // works without a library too
  assert.match(shoppingChecklist(sampleProject()), /1x esp32-test/);
});

test('inbox round trip in a temp dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-inbox-'));
  try {
    assert.deepEqual(readInbox(dir), []);
    const r = appendInbox(dir, { kind: 'explain', project: 'projects/x.json', target: 'wire:w5', text: 'Why blue?' });
    assert.equal(r.status, 'pending');
    assert.deepEqual(r.target, { type: 'wire', id: 'w5' });
    appendInbox(dir, { kind: 'fix', target: { type: 'issue', id: 'i3' }, text: '' });
    assert.throws(() => appendInbox(dir, { kind: 'hack', text: 'x' }), /kind/);
    assert.throws(() => appendInbox(dir, { kind: 'ask', target: 'disk:/' }), /target type/);
    assert.equal(readInbox(dir, { pendingOnly: true }).length, 2);
    markInbox(dir, r.id, 'done', 'explained in chat');
    const all = readInbox(dir);
    assert.equal(all.find((x) => x.id === r.id).status, 'done');
    assert.equal(all.find((x) => x.id === r.id).note, 'explained in chat');
    assert.equal(readInbox(dir, { pendingOnly: true }).length, 1);
    assert.throws(() => markInbox(dir, 'nope'), /No inbox request/);
    // history is append-only: 3 lines (2 requests + 1 status)
    const raw = readFileSync(inboxPath(dir), 'utf8').trim().split('\n');
    assert.equal(raw.length, 3);
    assert.equal(JSON.parse(raw[0]).status, 'pending');

    // CLI
    const log = console.log;
    const out = [];
    console.log = (...a) => out.push(a.join(' '));
    try {
      assert.equal(await inboxMain(['add', '--kind', 'stuck', '--target', 'step:s9', '--text', 'help', '--dir', dir]), 0);
      assert.equal(await inboxMain(['list', '--dir', dir]), 0);
      assert.ok(out.some((l) => l.includes('stuck') && l.includes('step:s9')));
      const id = readInbox(dir, { pendingOnly: true }).find((x) => x.kind === 'stuck').id;
      assert.equal(await inboxMain(['done', id, '--note', 'ok', '--dir', dir]), 0);
      assert.equal(await inboxMain(['--help']), 0);
    } finally {
      console.log = log;
    }
    assert.equal(readInbox(dir, { pendingOnly: true }).length, 1);
    assert.ok(existsSync(join(dir, '.wiremap', 'inbox.jsonl')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
