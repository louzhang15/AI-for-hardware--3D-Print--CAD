import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  layoutBreadboard, applyLayoutToProject, holeName, parseHole, BOARD_MODELS, formatLayout,
} from '../lib/breadboard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- fixtures

function l293d(extra = {}) {
  const P = (name, label, kind, more = {}) => ({ name, label, kind, ...more });
  return {
    id: 'drv', name: 'L293D', category: 'driver', size: [20, 5, 7],
    pins: [
      P('1', 'EN1,2', 'digital', { dir: 'in', voltage: 5 }), P('2', '1A', 'digital', { dir: 'in' }),
      P('3', '1Y', 'motor'), P('4', 'GND', 'ground'), P('5', 'GND', 'ground'), P('6', '2Y', 'motor'),
      P('7', '2A', 'digital', { dir: 'in' }), P('8', 'VCC2', 'power_in', { current: 0.6 }),
      P('9', 'EN3,4', 'digital', { dir: 'in' }), P('10', '3A', 'digital'), P('11', '3Y', 'motor'),
      P('12', 'GND', 'ground'), P('13', 'GND', 'ground'), P('14', '4Y', 'motor'), P('15', '4A', 'digital'),
      P('16', 'VCC1', 'power_in', { current: 0.06 }),
    ],
    internal: [['4', '5', '12', '13']],
    breadboard: { fit: 'straddle', rows: [['1', '2', '3', '4', '5', '6', '7', '8'], ['16', '15', '14', '13', '12', '11', '10', '9']], row_spacing: 3, body_width_mm: 9.5 },
    ...extra,
  };
}
const psu12 = { id: 'psu', name: '12V supply', category: 'power', size: [50, 20, 30],
  pins: [{ name: 'V+', kind: 'power_out', voltage: 12, current_max: 2 }, { name: 'GND', kind: 'ground' }],
  breadboard: { fit: 'offboard' } };
const uno = { id: 'uno', name: 'Arduino Uno', category: 'controller', size: [68, 10, 53],
  pins: [{ name: '5V', kind: 'power_out', voltage: 5, current_max: 0.5 }, { name: 'GND', kind: 'ground' },
    { name: 'D7', label: 'D7', kind: 'pwm', dir: 'io', voltage: 5 }],
  breadboard: { fit: 'offboard' } };
const motor = { id: 'mot', name: 'DC motor', category: 'actuator', size: [25, 20, 20],
  pins: [{ name: 'A', kind: 'motor' }, { name: 'B', kind: 'motor' }], breadboard: { fit: 'offboard' } };

function prdProject() {
  return {
    meta: { name: 'L293D excerpt' },
    parts: [l293d({ bb: { pin1: 'e8', rot: 0 } }), psu12, uno, motor],
    wires: [
      { id: 'w1', from: 'psu.V+', to: 'drv.8' },
      { id: 'w2', from: 'uno.5V', to: 'drv.16' },
      { id: 'w3', from: 'drv.4', to: 'psu.GND' },
      { id: 'w4', from: 'drv.12', to: 'uno.GND' },
      { id: 'w5', from: 'uno.D7', to: 'drv.2' },
      { id: 'w6', from: 'drv.3', to: 'mot.A' },
      { id: 'w7', from: 'psu.GND', to: 'uno.GND' },
    ],
    breadboard: { model: 'full-830' },
  };
}

function devkit(id, perRow, spacing, body) {
  const pins = [];
  const rows = [[], []];
  for (let i = 0; i < perRow; i++) {
    for (const r of [0, 1]) {
      const name = `P${r}_${i}`;
      rows[r].push(name);
      pins.push({ name, kind: 'digital', dir: 'io', voltage: 3.3 });
    }
  }
  pins.find((p) => p.name === 'P0_0').kind = 'power_out';
  pins.find((p) => p.name === 'P0_0').voltage = 3.3;
  pins.find((p) => p.name === 'P1_0').kind = 'ground';
  return { id, name: `devkit-${perRow * 2}`, category: 'controller', size: [50, 10, 28], pins,
    breadboard: { fit: 'straddle', rows, row_spacing: spacing, body_width_mm: body } };
}

const byRule = (layout, rule) => layout.issues.filter((i) => i.rule === rule);

// ---------------------------------------------------------------- tests

test('hole helpers', () => {
  assert.equal(holeName('e', 8), 'e8');
  assert.equal(holeName(7, 8), 'f8');
  assert.equal(holeName(5, 8), null);
  assert.equal(holeName('bottom+', 8), 'bottom+:8');
  assert.equal(holeName('j', 3, 2), 'B2/j3');
  assert.deepEqual(parseHole('j8'), { board: 'B1', boardIndex: 0, rail: null, row: 'j', y: 11, col: 8 });
  assert.equal(parseHole('bottom+:8').rail, 'bottom+');
  assert.equal(parseHole('bottom+:8').col, 8);
  assert.equal(parseHole('B2/a1').boardIndex, 1);
  assert.equal(parseHole('k3'), null);
  assert.equal(BOARD_MODELS['half-400'].columns, 30);
  assert.equal(BOARD_MODELS['full-830'].columns, 63);
});

test('PRD excerpt: L293D straddles e/f with pin 1 at e8', () => {
  const L = layoutBreadboard(prdProject(), {});
  const pl = L.placements.drv;
  assert.equal(pl.pin1, 'e8');
  for (let i = 1; i <= 8; i++) assert.equal(pl.holes[String(i)], `e${7 + i}`);
  for (let i = 16, c = 8; i >= 9; i--, c++) assert.equal(pl.holes[String(i)], `f${c}`);
  assert.equal(pl.free.top, 4);
  assert.equal(pl.free.bottom, 4);
  assert.deepEqual(L.offboard.sort(), ['mot', 'psu', 'uno']);

  // rails: 12V motor supply on top +, 5V logic on bottom +, GND on both -
  assert.equal(L.rails['top+'].voltage, 12);
  assert.equal(L.rails['bottom+'].voltage, 5);
  assert.equal(L.rails['top-'].name, 'GND');
  assert.equal(L.rails['bottom-'].name, 'GND');

  const j = (from, to) => L.jumpers.find((x) => x.from === from && x.to === to);
  assert.ok(j('a15', 'top+:15'), 'pin 8 VCC2 -> top + rail');
  assert.equal(j('a15', 'top+:15').color, 'red');
  assert.ok(j('j8', 'bottom+:8'), 'pin 16 VCC1 -> bottom + rail');
  assert.equal(j('j8', 'bottom+:8').len_mm, 5.08);
  assert.ok(j('a11', 'top-:11'), 'pin 4 GND -> top - rail');
  assert.equal(j('a11', 'top-:11').color, 'black');
  assert.ok(j('j12', 'bottom-:12'), 'pin 12 GND -> bottom - rail');
  const d7 = L.jumpers.find((x) => x.from === 'uno.D7');
  assert.equal(d7.to, 'a9');
  assert.equal(d7.color, 'orange');
  assert.equal(d7.kind, 'male-female');

  assert.equal(L.issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(L.issues));
  assert.ok(byRule(L, 'strips-ok').length);

  // steps: rails first, then the chip, then power before ground before signals
  const chipStep = L.steps.find((s) => s.part === 'drv');
  assert.match(chipStep.text, /Insert the L293D across the centre gap, notch left, pin 1 in hole e8/);
  const idx = (pred) => L.steps.findIndex(pred);
  assert.ok(idx((s) => s.rail) < idx((s) => s.part));
  assert.ok(idx((s) => s.part) < idx((s) => s.jumper));
  const roleOf = (s) => L.jumpers.find((x) => x.id === s.jumper)?.role;
  const roles = L.steps.filter((s) => s.jumper).map(roleOf);
  assert.ok(roles.lastIndexOf('power') < roles.indexOf('ground'));
  assert.ok(roles.lastIndexOf('ground') < roles.findIndex((r) => r !== 'power' && r !== 'ground'));
  for (const s of L.steps) assert.ok(Array.isArray(s.holes));
  assert.ok(L.table.some((r) => r.type === 'pin' && r.part === 'drv' && r.pin === '1' && r.hole === 'e8' && r.label === 'EN1,2'));

  const text = formatLayout(L);
  assert.match(text, /Rails: top \+ =/);
});

test('rails from project.breadboard.rails override the auto choice', () => {
  const p = prdProject();
  p.breadboard.rails = { 'top+': '5V', 'bottom+': 'psu.V+' };
  const L = layoutBreadboard(p, {});
  assert.equal(L.rails['top+'].voltage, 5);
  assert.equal(L.rails['bottom+'].voltage, 12);
  assert.equal(L.rails['top-'].name, 'GND');
  assert.ok(L.jumpers.some((j) => j.from === 'a15' && j.to === 'bottom+:15') || L.jumpers.some((j) => j.to.startsWith('bottom+:') && j.pins.includes('drv.8')));
});

test('rail carrying two nets is an error', () => {
  const p = prdProject();
  p.breadboard.rails = { 'top+': ['5V', '12V'] };
  const L = layoutBreadboard(p, {});
  assert.equal(byRule(L, 'rail-two-nets').length, 1);
  assert.equal(byRule(L, 'rail-two-nets')[0].level, 'error');
});

test('DIP not across the gap: bridges the strip', () => {
  const p = prdProject();
  p.parts[0].bb = { pin1: 'f8', rot: 0 }; // rows f and i, both in the bottom half
  const L = layoutBreadboard(p, {});
  const iss = byRule(L, 'not-across-gap');
  assert.equal(iss.length, 1);
  assert.equal(iss[0].level, 'error');
  assert.match(iss[0].message, /bridges the strip: every pin pair shorted/);
  // the per-strip conflicts of the same chip are folded into that one error
  assert.equal(byRule(L, 'strip-conflict').length, 0);
});

test('pins off the board', () => {
  const p = prdProject();
  p.parts[0].bb = { pin1: 'e60', rot: 0 };
  const L = layoutBreadboard(p, {});
  assert.equal(byRule(L, 'off-board').length, 1);
  assert.ok(L.unplaced.includes('drv'));
});

test('strip conflict: two nets in one 5-hole strip', () => {
  const sensor = (id, pin1) => ({ id, name: id.toUpperCase(), category: 'sensor', size: [10, 5, 10],
    pins: [{ name: 'VCC', kind: 'power_in' }, { name: 'OUT', kind: 'digital', dir: 'out' }, { name: 'GND', kind: 'ground' }],
    breadboard: { fit: 'single', rows: [['VCC', 'OUT', 'GND']] }, bb: { pin1, rot: 0 } });
  const p = {
    parts: [sensor('s1', 'e5'), sensor('s2', 'a6'), uno],
    wires: [{ id: 'w1', from: 's1.OUT', to: 'uno.D7' }, { id: 'w2', from: 's2.VCC', to: 'uno.5V' }],
  };
  const L = layoutBreadboard(p, {});
  const iss = byRule(L, 'strip-conflict');
  assert.ok(iss.length >= 1);
  assert.equal(iss[0].level, 'error');
  assert.ok(iss[0].holes.includes('e6') && iss[0].holes.includes('a6'));
  assert.equal(byRule(L, 'overlap').length, 0);
});

test('overlapping parts', () => {
  const p = prdProject();
  const second = l293d({ id: 'drv2', bb: { pin1: 'e12', rot: 0 } });
  p.parts.push(second);
  const L = layoutBreadboard(p, {});
  assert.equal(byRule(L, 'overlap').length, 1);
});

test('38-pin DevKitC leaves no free hole, 30-pin board leaves one row', () => {
  const wide = layoutBreadboard({ parts: [devkit('esp', 19, 10, 28)], wires: [] }, {});
  const w = byRule(wide, 'too-wide');
  assert.ok(w.length >= 1, JSON.stringify(wide.issues));
  assert.equal(w[0].level, 'warning');
  assert.match(w[0].message, /too wide: leaves no free hole beside row [a-j]; use two breadboards side by side/);

  const narrow = layoutBreadboard({ parts: [devkit('esp', 15, 9, 25.5)], wires: [] }, {});
  assert.equal(byRule(narrow, 'too-wide').length, 0, JSON.stringify(narrow.issues));
  const pl = narrow.placements.esp;
  assert.deepEqual(pl.rows.sort(), ['b', 'i']);
  assert.equal(pl.free.top, 1);
  assert.equal(pl.free.bottom, 1);
});

test('off-board servo gets male-female jumpers; servo power goes through the rail', () => {
  const servo = { id: 'servo1', name: 'SG90 servo', category: 'actuator', size: [23, 22, 12],
    pins: [{ name: 'SIG', kind: 'pwm', dir: 'in' }, { name: 'V+', kind: 'power_in', current: 0.2, current_peak: 0.7 }, { name: 'GND', kind: 'ground' }],
    breadboard: { fit: 'offboard' } };
  const p = {
    parts: [devkit('esp', 15, 9, 25.5), servo, { ...psu12, pins: [{ name: 'V+', kind: 'power_out', voltage: 5, current_max: 3 }, { name: 'GND', kind: 'ground' }] }],
    wires: [
      { id: 'w1', from: 'esp.P0_3', to: 'servo1.SIG' },
      { id: 'w2', from: 'psu.V+', to: 'servo1.V+' },
      { id: 'w3', from: 'psu.GND', to: 'servo1.GND' },
      { id: 'w4', from: 'psu.GND', to: 'esp.P1_0' },
    ],
  };
  const L = layoutBreadboard(p, {});
  const sig = L.jumpers.find((j) => j.from === 'servo1.SIG');
  assert.ok(sig);
  assert.equal(sig.kind, 'male-female');
  assert.equal(sig.color, 'orange');
  const espHole = L.placements.esp.holes.P0_3;
  assert.equal(parseHole(sig.to).col, parseHole(espHole).col);
  assert.equal(sig.to, `a${parseHole(espHole).col}`);
  // ground is on the - rails (esp GND is on board); servo GND and psu GND jumper to the rail
  assert.ok(L.jumpers.some((j) => j.from === 'servo1.GND' && /-:\d+$/.test(j.to)));
  // 5V net has no on-board pin: direct wire, not through the board
  const v = L.jumpers.find((j) => j.wire === 'w2');
  assert.equal(v.kind, 'direct');
  assert.equal(v.holes.length, 0);

  const out = applyLayoutToProject(p, L);
  assert.deepEqual(out.wires.find((w) => w.id === 'w1').bb.holes, ['servo1.SIG', sig.to]);
  assert.deepEqual(out.parts.find((x) => x.id === 'esp').bb, { pin1: L.placements.esp.pin1, rot: 0 });
  assert.equal(out.breadboard.layout.model, 'full-830');
  assert.ok(!p.breadboard, 'original project untouched');
  JSON.parse(JSON.stringify(out));

  // re-running on the written project keeps the placement
  const L2 = layoutBreadboard(out, {});
  assert.deepEqual(L2.placements.esp.holes, L.placements.esp.holes);
});

test('half-400 overflow is an error suggesting a bigger board', () => {
  const p = { parts: [devkit('a', 15, 9, 25.5), devkit('b', 15, 9, 25.5)], wires: [], breadboard: { model: 'half-400' } };
  const L = layoutBreadboard(p, {});
  const iss = byRule(L, 'out-of-columns');
  assert.equal(iss.length, 1);
  assert.equal(iss[0].level, 'error');
  assert.match(iss[0].message, /full-830/);
  assert.ok(L.unplaced.includes('b'));
  // two boards side by side fit them
  const L2 = layoutBreadboard(p, {}, { model: ['half-400', 'half-400'] });
  assert.equal(byRule(L2, 'out-of-columns').length, 0);
  assert.equal(L2.placements.b.board, 'B2');
  assert.match(L2.placements.b.pin1, /^B2\//);
});

test('split full-830 rails used on both halves get a joining jumper', () => {
  const p = prdProject();
  p.parts.push(l293d({ id: 'drv2', bb: { pin1: 'e50', rot: 0 } }));
  p.wires.push({ id: 'w8', from: 'drv2.8', to: 'psu.V+' });
  const L = layoutBreadboard(p, {}, { split: true });
  const iss = byRule(L, 'split-rail');
  assert.ok(iss.length >= 1);
  assert.equal(iss[0].level, 'warning');
  const join = L.jumpers.find((j) => j.special === 'split-join' && j.from.startsWith('top+'));
  assert.ok(join);
  assert.equal(join.from, 'top+:31');
  assert.equal(join.to, 'top+:32');
});

test('CLI main prints and writes', async () => {
  const { main } = await import('../scripts/layout-breadboard.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-bb-'));
  try {
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify(prdProject(), null, 2));
    const log = console.log; const out = [];
    console.log = (...a) => out.push(a.join(' '));
    let code;
    try { code = await main([f, '--write']); } finally { console.log = log; }
    assert.equal(code, 0);
    assert.match(out.join('\n'), /Insert the L293D across the centre gap/);
    const saved = JSON.parse(readFileSync(f, 'utf8'));
    assert.deepEqual(saved.parts[0].bb, { pin1: 'e8', rot: 0 });
    assert.ok(saved.breadboard.layout.jumpers.length > 0);
    assert.ok(readFileSync(f, 'utf8').endsWith('}\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('library parts (optional, skipped when missing)', async (t) => {
  const need = ['l293d', 'esp32-devkit-v1', 'esp32-devkitc-v4', 'hc-sr04'];
  const missing = need.filter((id) => !existsSync(join(ROOT, 'library', `${id}.json`)));
  if (missing.length) { t.skip(`library parts missing: ${missing.join(', ')}`); return; }
  const { loadLibrary } = await import('../lib/node/library.js');
  const lib = loadLibrary();
  const c = layoutBreadboard({ parts: [{ id: 'esp', library: 'esp32-devkitc-v4' }], wires: [] }, lib);
  assert.ok(byRule(c, 'too-wide').length >= 1, 'DevKitC should be too wide');
  const v1 = layoutBreadboard({ parts: [{ id: 'esp', library: 'esp32-devkit-v1' }], wires: [] }, lib);
  assert.equal(byRule(v1, 'too-wide').length, 0, 'DOIT 30-pin board should leave a free row');
  const mix = layoutBreadboard({ parts: [{ id: 'drv', library: 'l293d' }, { id: 'us', library: 'hc-sr04' }], wires: [] }, lib);
  assert.equal(mix.issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(mix.issues));
});
