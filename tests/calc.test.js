import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../lib/calc.js';

const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const shape = (r) => {
  for (const k of ['value', 'unit', 'inputs', 'formula', 'warnings', 'label']) assert.ok(k in r, `missing ${k}`);
  assert.equal(r.label, 'calculated');
};

test('E-series helpers', () => {
  assert.equal(c.nextUp(200), 220);
  assert.equal(c.nextUp(220), 220);
  assert.equal(c.nextUp(8300), 10000);
  assert.equal(c.nextUp(200, 'E24'), 200);
  assert.equal(c.nextDown(250, 'E24'), 240);
  assert.equal(c.nearest(3400), 3300);
  assert.equal(c.e12.nextUp(1.3), 1.5);
  assert.equal(c.e24.nearest(5.0), 5.1);
  assert.throws(() => c.nextUp(-1));
  assert.throws(() => c.nextUp(10, 'E96'));
});

test('ohm: any two of V, I, R, P', () => {
  const r = c.ohm({ v: 5, r: 220 });
  shape(r);
  near(r.value.i, 0.022727, 1e-5);
  near(c.ohm({ i: 0.5, p: 2 }).value.r, 8);
  near(c.ohm({ p: 1, r: 100 }).value.v, 10);
  assert.throws(() => c.ohm({ v: 5 }), /two/);
  assert.throws(() => c.ohm({ v: 5, i: 1, r: 5 }), /two/);
});

test('LED resistor rounds up so current stays below target', () => {
  const r = c.ledResistor({ vsupply: 5, vf: 2, i: 0.015 });
  shape(r);
  assert.equal(r.value, 220);
  assert.ok(r.current <= 0.015);
  assert.equal(r.watts, 0.125);
  assert.throws(() => c.ledResistor({ vsupply: 2, vf: 3, i: 0.01 }));
});

test('PRD: 1k + 2.2k divider from 5 V gives 3.44 V', () => {
  const r = c.divider({ vin: 5, r1: 1000, r2: 2200 });
  shape(r);
  near(r.value, 3.44, 0.005);
  const s = c.divider({ vin: 5, vmax: 3.6 });
  assert.equal(s.r1, 1000);
  assert.equal(s.r2, 2200);
  assert.ok(s.value <= 3.6);
  const t = c.divider({ vin: 12, vmax: 3.6 });
  assert.ok(t.value <= 3.6 && t.value > 3.0, String(t.value));
  assert.throws(() => c.divider({ vin: 5 }));
});

test('PRD: 4x MG996R (10 A peak) on a 5 A supply is flagged', () => {
  const r = c.powerBudget([{ name: 'MG996R', qty: 4, current: 0.5, peak: 2.5 }, { name: 'ESP32', current: 0.25, peak: 0.5 }], 5);
  shape(r);
  near(r.peak, 10.5);
  assert.equal(r.ok, false);
  assert.ok(r.flags.some((f) => /exceeds/.test(f.message)));
  const ok = c.powerBudget([{ current: 1 }], 5);
  assert.equal(ok.ok, true);
  const hot = c.powerBudget([{ current: 4.2 }], 5);
  assert.ok(hot.flags.some((f) => f.level === 'warning' && /80%/.test(f.message)));
});

test('regulator heat', () => {
  const r = c.regulatorHeat({ vin: 7.4, vout: 3.3, i: 0.3 });
  shape(r);
  near(r.value, 1.23);
  const t = c.regulatorHeat({ vin: 12, vout: 5, i: 1, package: 'TO-220' });
  assert.equal(t.needsHeatsink, true);
  assert.ok(t.theta_sa_required > 0 && t.theta_sa_required < 10);
  assert.throws(() => c.regulatorHeat({ vin: 3, vout: 5, i: 1 }));
});

test('wire resistance from the AWG formula', () => {
  near(c.awgDiameter(18), 1.024, 0.002);
  near(c.awgOhmPerM(18), 0.02095, 0.0002); // ~20.9 mΩ/m
  near(c.awgOhmPerM(22), 0.0530, 0.0005);
  const r = c.wireDrop({ current: 4, length_m: 0.5, awg: 18 });
  shape(r);
  near(r.value, 4 * 0.02095 * 2 * 0.5, 0.001);
  const pct = c.wireDrop({ current: 10, length_m: 3, awg: 22, vsupply: 5 });
  assert.ok(pct.warnings.length > 0);
});

test('PRD: 26 AWG at 4 A is flagged for PVC; gauge depends on insulation', () => {
  assert.ok(c.ampacity(26, 'pvc') < 4);
  const g = c.minGauge(4, 'pvc');
  shape(g);
  assert.ok(g.value < 26 && g.value <= 20);
  const s = c.minGauge(4, 'silicone');
  assert.ok(s.value > g.value, 'silicone allows a thinner wire than PVC');
  assert.ok(c.ampacity(20, 'pvc', { bundled: true }) < c.ampacity(20, 'pvc'));
  assert.ok(c.AMPACITY.pvc[26] < 4);
  assert.throws(() => c.ampacity(26, 'paper'));
  // Monotonic per insulation.
  for (const ins of Object.keys(c.AMPACITY)) {
    const gs = [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10];
    for (let i = 1; i < gs.length; i++) assert.ok(c.ampacity(gs[i], ins) > c.ampacity(gs[i - 1], ins));
  }
});

test('battery runtime', () => {
  const r = c.batteryRuntime({ capacity_ah: 2.2, avg_a: 1.5 });
  shape(r);
  near(r.value, 2.2 * 0.8 / 1.5, 0.01);
});

test('fuse size: 125% up to standard, never above wire', () => {
  const r = c.fuseSize({ current: 4 });
  shape(r);
  assert.equal(r.value, 5);
  assert.equal(c.fuseSize({ current: 6 }).value, 7.5);
  const w = c.fuseSize({ current: 4, wireAwg: 26 });
  assert.equal(w.value, null);
  assert.ok(w.warnings.some((x) => /No fuse fits/.test(x)));
  const tight = c.fuseSize({ current: 4, wireAwg: 20 }); // pvc 20 AWG = 4.5 A ceiling
  assert.equal(tight.value, 4);
  assert.ok(c.fuseSize({ current: 2, voltage: 48 }).warnings.some((x) => /32 V/.test(x)));
});

test('print fits', () => {
  const prof = { id: 'p', clearance_mm: { press: 0.05, snug: 0.1, sliding: 0.2, free: 0.3 } };
  const h = c.printFit({ nominal: 3, fit: 'sliding', profile: prof, feature: 'hole' });
  shape(h);
  near(h.value, 3.4);
  near(c.printFit({ nominal: 3, fit: 'sliding', profile: prof, feature: 'shaft' }).value, 2.6);
  near(c.printFit({ nominal: 8, fit: 'free', clearance: 0.5, feature: 'slot' }).value, 9);
  near(c.printFit({ nominal: 3, fit: 'snug' }).value, 3.3);
  assert.throws(() => c.printFit({ nominal: 3, fit: 'loose' }));
});

test('PRD: Ruthex M3 insert hole 4.0 mm, wall 1.6 mm', () => {
  const r = c.insertHole({ size: 'M3' });
  shape(r);
  assert.equal(r.value, 4.0);
  assert.equal(r.min_wall, 1.6);
  assert.ok(r.depth > r.insert_length);
  near(r.boss_d, 7.2);
  for (const s of ['M2', 'M2.5', 'M4', 'M5']) assert.ok(c.insertHole({ size: s }).value > 0);
  assert.throws(() => c.insertHole({ size: 'M7' }));
});

test('screw length', () => {
  const r = c.screwLength({ stack: 6, size: 'M3', engagement: 'insert' });
  shape(r);
  assert.equal(r.value, 12);
  assert.ok(r.value >= r.min && r.value <= r.max);
  const n = c.screwLength({ stack: 10, size: 'M3', engagement: 'nut' });
  assert.equal(n.value, 14);
  const p = c.screwLength({ stack: 3, size: 'M3', engagement: 'thread-plastic', depth: 10 });
  assert.ok(p.value >= 3 + 7.5 && p.value <= 12.5);
  assert.throws(() => c.screwLength({ stack: 3, size: 'M3', engagement: 'glue' }));
});
