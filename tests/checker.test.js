// Unit tests of the electrical checker with small inline parts, so they do not
// depend on the library. The known-bad suite (tests/known-bad.test.js) runs
// the same rules against real library parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProject } from '../lib/check.js';

const LIB = {
  mcu33: {
    id: 'mcu33', name: '3.3V MCU', category: 'controller', confidence: 'verified', size: [50, 10, 25],
    pins: [
      { name: 'VIN', kind: 'power_in', vmin: 4.5, vmax: 12, current: 0.1, current_peak: 0.4 },
      { name: '3V3', kind: 'power_out', voltage: 3.3, current_max: 0.5 },
      { name: 'GND', kind: 'ground' },
      { name: 'GND_2', kind: 'ground' },
      { name: 'IO1', kind: 'digital', dir: 'io', voltage: 3.3, vmax: 3.6 },
      { name: 'IO2', kind: 'digital', dir: 'io', voltage: 3.3, vmax: 3.6 },
      { name: 'SDA', kind: 'i2c_sda', dir: 'io', voltage: 3.3, vmax: 3.6, open_drain: true },
      { name: 'SCL', kind: 'i2c_scl', dir: 'io', voltage: 3.3, vmax: 3.6, open_drain: true },
      { name: 'TX', kind: 'uart_tx', dir: 'out', voltage: 3.3, vmax: 3.6 },
      { name: 'RX', kind: 'uart_rx', dir: 'in', voltage: 3.3, vmax: 3.6 },
    ],
    internal: [['GND', 'GND_2']],
    regulators: [{ in: 'VIN', out: '3V3', gnd: 'GND', type: 'linear', vout: 3.3, dropout: 1.1, current_max: 0.5 }],
  },
  mcu5: {
    id: 'mcu5', name: '5V MCU', category: 'controller', confidence: 'verified', size: [50, 10, 25],
    pins: [
      { name: '5V', kind: 'power_out', voltage: 5, current_max: 0.4 },
      { name: 'GND', kind: 'ground' },
      { name: 'D2', kind: 'digital', dir: 'io', voltage: 5, vmax: 5.5 },
      { name: 'TX', kind: 'uart_tx', dir: 'out', voltage: 5, vmax: 5.5 },
      { name: 'SDA', kind: 'i2c_sda', dir: 'io', voltage: 5, vmax: 5.5, open_drain: true, pullup: 5, pullup_weak: true },
    ],
  },
  sonar: {
    id: 'sonar', name: 'Ultrasonic', category: 'sensor', confidence: 'verified', size: [45, 15, 20],
    pins: [
      { name: 'VCC', kind: 'power_in', vmin: 4.5, vmax: 5.5, current: 0.015 },
      { name: 'TRIG', kind: 'digital', dir: 'in', vmax: 5.5 },
      { name: 'ECHO', kind: 'digital', dir: 'out', voltage: 5 },
      { name: 'GND', kind: 'ground' },
    ],
  },
  i2cdev: {
    id: 'i2cdev', name: 'I2C sensor', category: 'sensor', confidence: 'verified', size: [20, 3, 15],
    pins: [
      { name: 'VCC', kind: 'power_in', vmin: 3.0, vmax: 3.6, current: 0.005 },
      { name: 'GND', kind: 'ground' },
      { name: 'SDA', kind: 'i2c_sda', dir: 'io', voltage_ref: 'VCC', vmax: 3.6, open_drain: true, pullup_ref: 'VCC' },
      { name: 'SCL', kind: 'i2c_scl', dir: 'io', voltage_ref: 'VCC', vmax: 3.6, open_drain: true, pullup_ref: 'VCC' },
    ],
  },
  psu6: {
    id: 'psu6', name: '6V 5A', category: 'power', confidence: 'checked', size: [60, 30, 40],
    pins: [{ name: 'V+', kind: 'power_out', voltage: 6, current_max: 5 }, { name: 'GND', kind: 'ground' }],
  },
  psu5: {
    id: 'psu5', name: '5V 3A', category: 'power', confidence: 'checked', size: [60, 30, 40],
    pins: [{ name: 'V+', kind: 'power_out', voltage: 5, current_max: 3 }, { name: 'GND', kind: 'ground' }],
  },
  usb: {
    id: 'usb', name: 'USB', category: 'power', confidence: 'checked', size: [20, 10, 10],
    pins: [{ name: '5V', kind: 'power_out', voltage: 5, current_max: 0.5 }, { name: 'GND', kind: 'ground' }],
  },
  lipo2s: {
    id: 'lipo2s', name: '2S LiPo', category: 'battery', confidence: 'verified', size: [70, 20, 35],
    battery: { chemistry: 'lipo', cells: 2, capacity_ah: 2.2, bms: false },
    pins: [{ name: 'BAT+', kind: 'power_out', voltage: 7.4, voltage_max: 8.4, voltage_min: 6.6, current_max: 55 }, { name: 'BAT-', kind: 'ground' }],
  },
  fuse: {
    id: 'fuse', name: 'Fuse', category: 'protection', protection: 'fuse', params: { rating_a: 5 }, rating_a: '$rating_a', size: [30, 10, 10],
    pins: [{ name: 'IN', kind: 'power_rail' }, { name: 'OUT', kind: 'power_rail' }], internal: [['IN', 'OUT']],
  },
  sw: {
    id: 'sw', name: 'Switch', category: 'protection', protection: 'switch', rating_a: 10, size: [20, 15, 12],
    pins: [{ name: 'IN', kind: 'power_rail' }, { name: 'OUT', kind: 'power_rail' }], internal: [['IN', 'OUT']],
  },
  buck: {
    id: 'buck', name: 'Buck', category: 'power', params: { vout: 5 }, size: [43, 14, 21], confidence: 'checked',
    pins: [
      { name: 'IN+', kind: 'power_in', vmin: 4.5, vmax: 40, current: 0.005 },
      { name: 'IN-', kind: 'ground' },
      { name: 'OUT+', kind: 'power_out', voltage: '$vout', current_max: 3 },
      { name: 'OUT-', kind: 'ground' },
    ],
    internal: [['IN-', 'OUT-']],
    regulators: [{ in: 'IN+', out: 'OUT+', gnd: 'IN-', type: 'buck', vout: '$vout', efficiency: 0.85, current_max: 3, vin_max: 40 }],
  },
  servo: {
    id: 'servo', name: 'Servo', category: 'actuator', confidence: 'checked', size: [40, 40, 20],
    pins: [
      { name: 'SIG', kind: 'pwm', dir: 'in', vmax: 6 },
      { name: 'V+', kind: 'power_in', vmin: 4.8, vmax: 7.2, current: 0.5, current_peak: 2.5 },
      { name: 'GND', kind: 'ground' },
    ],
  },
  pwmdrv: {
    id: 'pwmdrv', name: 'PWM driver', category: 'driver', confidence: 'verified', size: [62, 4, 25],
    pins: [
      { name: 'VCC', kind: 'power_in', vmin: 2.3, vmax: 5.5, current: 0.01 },
      { name: 'GND', kind: 'ground' },
      { name: 'SDA', kind: 'i2c_sda', dir: 'io', voltage_ref: 'VCC', vmax: 5.5, open_drain: true, pullup_ref: 'VCC' },
      { name: 'SCL', kind: 'i2c_scl', dir: 'in', vmax: 5.5, pullup_ref: 'VCC' },
      { name: 'V+', kind: 'power_rail', vmax: 6 },
      { name: 'PWM0', kind: 'pwm', dir: 'out', voltage_ref: 'VCC' },
      { name: 'V+0', kind: 'power_rail' },
      { name: 'GND0', kind: 'ground' },
      { name: 'PWM1', kind: 'pwm', dir: 'out', voltage_ref: 'VCC' },
      { name: 'V+1', kind: 'power_rail' },
      { name: 'GND1', kind: 'ground' },
    ],
    internal: [['V+', 'V+0', 'V+1'], ['GND', 'GND0', 'GND1']],
  },
  motor: {
    id: 'motor', name: 'DC motor', category: 'actuator', size: [60, 20, 20],
    pins: [{ name: 'M+', kind: 'motor', current: 0.2, current_peak: 1.5 }, { name: 'M-', kind: 'motor' }],
  },
  drv: {
    id: 'drv', name: 'Driver', category: 'driver', flyback: true, confidence: 'verified', size: [20, 3, 20],
    pins: [
      { name: 'VM', kind: 'power_in', vmax: 13.5, current: 0.4, current_peak: 2 },
      { name: 'VCC', kind: 'power_in', vmin: 2.7, vmax: 5.5, current: 0.002 },
      { name: 'GND', kind: 'ground' },
      { name: 'STBY', kind: 'digital', dir: 'in', vmax: 5.5, required: true },
      { name: 'AIN1', kind: 'digital', dir: 'in', vmax: 5.5 },
      { name: 'AO1', kind: 'motor', dir: 'out' },
      { name: 'AO2', kind: 'motor', dir: 'out' },
    ],
  },
  res: {
    id: 'res', name: 'Resistor', category: 'passive', params: { ohms: 1000 }, size: [10, 2, 3],
    pins: [{ name: '1', kind: 'passive' }, { name: '2', kind: 'passive' }],
  },
  mains: { id: 'mains', name: 'Mains relay', category: 'module', mains: true, size: [50, 20, 25], pins: [{ name: 'L', kind: 'passive' }] },
};

let wid = 0;
const W = (from, to, extra = {}) => ({ id: `w${++wid}`, from, to, ...extra });
const P = (id, library, extra = {}) => ({ id, library, ...extra });
const run = (parts, wires) => checkProject({ parts, wires }, LIB);
const rules = (res, level) => res.issues.filter((i) => !level || i.level === level).map((i) => i.rule);
const has = (res, rule, level) => res.issues.some((i) => i.rule === rule && (!level || i.level === level));

/** A correct base design: MCU on USB-less 5V buck, sonar via divider, servo on 6V. */
function good() {
  return {
    parts: [P('psu', 'psu6'), P('mcu', 'mcu33'), P('pwm', 'pwmdrv'), P('s1', 'servo'), P('dev', 'i2cdev')],
    wires: [
      W('psu.V+', 'pwm.V+', { gauge: 18 }), W('psu.GND', 'pwm.GND', { gauge: 18 }),
      W('s1.SIG', 'pwm.PWM0'), W('s1.V+', 'pwm.V+0'), W('s1.GND', 'pwm.GND0'),
      W('mcu.3V3', 'pwm.VCC'), W('mcu.GND', 'pwm.GND'),
      W('mcu.SDA', 'pwm.SDA'), W('mcu.SCL', 'pwm.SCL'),
      W('dev.VCC', 'mcu.3V3'), W('dev.GND', 'mcu.GND_2'), W('dev.SDA', 'pwm.SDA'), W('dev.SCL', 'pwm.SCL'),
    ],
  };
}

test('a correct design has no errors', () => {
  const g = good();
  const res = run(g.parts, g.wires);
  assert.equal(res.errors, 0, JSON.stringify(res.issues.filter((i) => i.level === 'error'), null, 1));
  assert.ok(res.summary.startsWith('No rule violations found'));
  assert.ok(res.notChecked.length > 0);
});

test('short: supply + straight to GND', () => {
  const res = run([P('psu', 'psu6')], [W('psu.V+', 'psu.GND')]);
  assert.ok(has(res, 'short', 'error'));
});

test('over-voltage: 2S LiPo (8.4V full) on a 7.2V servo', () => {
  const res = run([P('b', 'lipo2s'), P('f', 'fuse'), P('s', 'servo')], [W('b.BAT+', 'f.IN'), W('f.OUT', 's.V+'), W('b.BAT-', 's.GND')]);
  const iss = res.issues.find((i) => i.rule === 'over-voltage');
  assert.ok(iss && iss.level === 'error');
  assert.match(iss.message, /8\.4V/);
});

test('logic level: 5V echo into a 3.3V GPIO', () => {
  const res = run(
    [P('mcu', 'mcu33'), P('son', 'sonar'), P('psu', 'psu5')],
    [W('son.ECHO', 'mcu.IO1'), W('son.TRIG', 'mcu.IO2'), W('psu.V+', 'son.VCC'), W('psu.GND', 'son.GND'), W('psu.GND', 'mcu.GND'), W('psu.V+', 'mcu.VIN')],
  );
  const iss = res.issues.find((i) => i.rule === 'logic-level' && i.level === 'error');
  assert.ok(iss, rules(res).join());
  assert.deepEqual(iss.pins.sort(), ['mcu.IO1', 'son.ECHO']);
});

test('logic level: a correct 1k/2.2k divider passes, a series resistor alone fails', () => {
  const base = [P('mcu', 'mcu33'), P('son', 'sonar'), P('psu', 'psu5')];
  const common = [W('psu.V+', 'son.VCC'), W('psu.GND', 'son.GND'), W('psu.GND', 'mcu.GND'), W('psu.V+', 'mcu.VIN')];
  const ok = run([...base, P('r1', 'res', { params: { ohms: 1000 } }), P('r2', 'res', { params: { ohms: 2200 } })],
    [...common, W('son.ECHO', 'r1.1'), W('r1.2', 'mcu.IO1'), W('r2.1', 'mcu.IO1'), W('r2.2', 'mcu.GND_2')]);
  assert.ok(!has(ok, 'logic-level', 'error'), JSON.stringify(ok.issues, null, 1));
  const bad = run([...base, P('r1', 'res', { params: { ohms: 1000 } })], [...common, W('son.ECHO', 'r1.1'), W('r1.2', 'mcu.IO1')]);
  assert.ok(has(bad, 'logic-level', 'error'));
  const weak = run([...base, P('r1', 'res', { params: { ohms: 2200 } }), P('r2', 'res', { params: { ohms: 1000 } })],
    [...common, W('son.ECHO', 'r1.1'), W('r1.2', 'mcu.IO1'), W('r2.1', 'mcu.IO1'), W('r2.2', 'mcu.GND_2')]);
  assert.ok(!has(weak, 'logic-level', 'error'), 'divider 2.2k/1k gives 1.56V: safe');
  const reversed = run([...base, P('r1', 'res', { params: { ohms: 1000 } }), P('r2', 'res', { params: { ohms: 10000 } })],
    [...common, W('son.ECHO', 'r1.1'), W('r1.2', 'mcu.IO1'), W('r2.1', 'mcu.IO1'), W('r2.2', 'mcu.GND_2')]);
  assert.ok(has(reversed, 'logic-level', 'error'), '1k/10k gives 4.5V: unsafe');
});

test('supplies fighting: USB 5V and a 5.2V buck on one rail', () => {
  const res = run(
    [P('usb', 'usb'), P('psu', 'psu6'), P('buck', 'buck', { params: { vout: 5.2 } }), P('son', 'sonar')],
    [W('psu.V+', 'buck.IN+'), W('psu.GND', 'buck.IN-'), W('buck.OUT+', 'son.VCC'), W('usb.5V', 'son.VCC'), W('usb.GND', 'son.GND'), W('buck.OUT-', 'son.GND')],
  );
  const iss = res.issues.find((i) => i.rule === 'supplies-fighting');
  assert.ok(iss && iss.level === 'error');
  assert.match(iss.message, /5\.2V/);
});

test('no common ground: servo supply GND not joined to MCU GND', () => {
  const g = good();
  const wires = g.wires.filter((w) => !(w.from === 'mcu.GND' && w.to === 'pwm.GND') && !(w.from === 'psu.GND'));
  // servo powered from psu, its GND to psu only; PWM driver GND to MCU
  const res = run(g.parts, [...wires.filter((w) => w.from !== 's1.GND'), W('s1.GND', 'psu.GND')]);
  assert.ok(has(res, 'common-ground', 'error'), rules(res).join());
});

test('overloaded supply: 4 servos stalling (10A) on a 5A supply is a peak warning; typical overload is an error', () => {
  const parts = [P('psu', 'psu6'), P('pwm', 'pwmdrv')];
  const wires = [W('psu.V+', 'pwm.V+', { gauge: 16 }), W('psu.GND', 'pwm.GND', { gauge: 16 })];
  for (let i = 0; i < 4; i++) {
    parts.push(P(`s${i}`, 'servo'));
    wires.push(W(`s${i}.V+`, 'psu.V+', { gauge: 18 }), W(`s${i}.GND`, 'psu.GND', { gauge: 18 }));
  }
  const res = run(parts, wires);
  const ov = res.issues.find((i) => i.rule === 'overload');
  assert.ok(ov && ov.level === 'warning', rules(res).join());
  assert.match(ov.message, /10 A/);
  const rail = res.power.rails.find((r) => r.source === 'psu.V+');
  assert.equal(rail.loadPeak, 10);
  assert.equal(rail.load, 2);
  const heavy = run(parts.map((p) => (p.library === 'servo' ? { ...p, pins: { 'V+': { current: 1.5 } } } : p)), wires);
  assert.ok(has(heavy, 'overload', 'error'));
});

test('wire too thin: 26 AWG carrying 4A of servo current', () => {
  const parts = [P('psu', 'psu6')];
  const wires = [];
  for (let i = 0; i < 2; i++) {
    parts.push(P(`s${i}`, 'servo', { pins: { 'V+': { current: 2, current_peak: 2 } } }));
    wires.push(W(`s${i}.V+`, i === 0 ? 'psu.V+' : 's0.V+', { gauge: i === 0 ? 26 : 18 }), W(`s${i}.GND`, 'psu.GND', { gauge: 18 }));
  }
  const res = run(parts, wires);
  const iss = res.issues.find((i) => i.rule === 'wire-gauge');
  assert.ok(iss && iss.level === 'warning', rules(res).join());
  assert.deepEqual(iss.wires, ['w' + (wid - 3)]);
  assert.equal(res.wireInfo[iss.wires[0]].current, 4, 'first wire carries both servos');
  const second = res.wireInfo['w' + (wid - 1)];
  assert.equal(second.current, 2, 'daisy-chained wire carries one servo');
});

test('under-voltage: 3.0V into a part that needs 3.3V', () => {
  const lib = { ...LIB, src3: { id: 'src3', category: 'power', size: [10, 10, 10], pins: [{ name: 'V', kind: 'power_out', voltage: 3.0, current_max: 1 }, { name: 'G', kind: 'ground' }] } };
  const res = checkProject({ parts: [P('s', 'src3'), P('d', 'sonar')], wires: [W('s.V', 'd.VCC'), W('s.G', 'd.GND')] }, lib);
  assert.ok(has(res, 'under-voltage', 'warning'));
});

test('required pin left floating: driver STBY', () => {
  const res = run([P('d', 'drv'), P('psu', 'psu6'), P('m', 'motor')], [W('psu.V+', 'd.VM'), W('psu.GND', 'd.GND'), W('d.AO1', 'm.M+'), W('d.AO2', 'm.M-')]);
  assert.ok(res.issues.some((i) => i.rule === 'required-pin' && i.pins.includes('d.STBY')));
  assert.ok(!has(res, 'flyback'), 'driver with built-in diodes protects the motor');
});

test('two DC motors add to the motor rail once per motor', () => {
  const driverOutputs = Object.fromEntries(['AO1', 'AO2', 'BO1', 'BO2'].map((pin) => [
    pin, { kind: 'motor', dir: 'out', voltage_ref: 'VM' },
  ]));
  const motors = ['left', 'right'].map((id) => P(id, 'motor', {
    pins: { 'M-': { current: 0.2, current_peak: 1.5 } },
  }));
  const motorFeed = W('supply.V+', 'drv.VM', { gauge: 18 });
  const parts = [P('supply', 'psu5'), P('drv', 'drv', { pins: driverOutputs }), ...motors];
  const wires = [motorFeed, W('supply.GND', 'drv.GND'), W('drv.AO1', 'left.M+'), W('drv.AO2', 'left.M-'),
    W('drv.BO1', 'right.M+'), W('drv.BO2', 'right.M-')];
  const result = run(parts, wires);
  const motorRail = result.power.rails.find((rail) => rail.source === 'supply.V+');
  assert.equal(motorRail.load, 0.8);
  assert.equal(motorRail.loadPeak, 5);
  assert.equal(result.wireInfo[motorFeed.id].currentPeak, 5);

  const incomplete = run(parts, wires.slice(0, -1));
  assert.equal(incomplete.power.rails[0].loadPeak, 3.5);
});

test('missing protection: LiPo with no fuse is an error, no switch a warning; motor without flyback warns', () => {
  const res = run([P('b', 'lipo2s'), P('buck', 'buck'), P('m', 'motor'), P('mcu', 'mcu33')],
    [W('b.BAT+', 'buck.IN+'), W('b.BAT-', 'buck.IN-'), W('m.M+', 'mcu.IO1'), W('m.M-', 'mcu.GND')]);
  assert.ok(has(res, 'missing-fuse', 'error'));
  assert.ok(has(res, 'missing-switch', 'warning'));
  assert.ok(has(res, 'motor-on-gpio', 'error'));
  assert.ok(has(res, 'flyback', 'warning'));
  const fixed = run([P('b', 'lipo2s'), P('f', 'fuse'), P('sw', 'sw'), P('buck', 'buck')],
    [W('b.BAT+', 'f.IN'), W('f.OUT', 'sw.IN'), W('sw.OUT', 'buck.IN+'), W('b.BAT-', 'buck.IN-')]);
  assert.ok(!has(fixed, 'missing-fuse'));
  assert.ok(!has(fixed, 'missing-switch'));
  assert.ok(has(fixed, 'missing-bms', 'error'), 'a fuse and switch do not prevent over-discharge');
  const protectedLib = {
    ...LIB,
    cutoff: { ...LIB.sw, id: 'cutoff', protection: 'low-voltage-cutoff' },
  };
  const protectedProject = {
    parts: [P('b', 'lipo2s'), P('f', 'fuse'), P('sw', 'sw'), P('cutoff', 'cutoff'), P('buck', 'buck')],
    wires: [W('b.BAT+', 'f.IN'), W('f.OUT', 'sw.IN'), W('sw.OUT', 'cutoff.IN'), W('cutoff.OUT', 'buck.IN+'), W('b.BAT-', 'buck.IN-')],
  };
  assert.ok(!has(checkProject(protectedProject, protectedLib), 'missing-bms'));
  protectedProject.wires.push(W('sw.OUT', 'buck.IN+'));
  assert.ok(has(checkProject(protectedProject, protectedLib), 'missing-bms', 'error'), 'a parallel connection bypasses the cutoff');
  assert.ok(res.power.runtime.length >= 0);
});

test('fuse rating smaller than the load', () => {
  const parts = [P('psu', 'psu6'), P('f', 'fuse', { params: { rating_a: 1 } }), P('s', 'servo')];
  const res = run(parts, [W('psu.V+', 'f.IN'), W('f.OUT', 's.V+'), W('psu.GND', 's.GND')]);
  assert.equal(res.errors, 0, JSON.stringify(res.issues));
  assert.ok(has(res, 'fuse-rating', 'warning'), 'peak 2.5A over a 1A fuse');
  const res2 = run([P('psu', 'psu6'), P('f', 'fuse', { params: { rating_a: 0.25 } }), P('s', 'servo')], [W('psu.V+', 'f.IN'), W('f.OUT', 's.V+'), W('psu.GND', 's.GND')]);
  assert.ok(has(res2, 'fuse-rating', 'error'));
});

test('I2C: SDA to SCL mixup, missing pull-ups, 5V weak pull-up into 3.3V device', () => {
  const mix = run([P('mcu', 'mcu33'), P('dev', 'i2cdev')], [W('mcu.SDA', 'dev.SCL'), W('mcu.SCL', 'dev.SDA'), W('mcu.3V3', 'dev.VCC'), W('mcu.GND', 'dev.GND')]);
  assert.ok(has(mix, 'bus-mixup', 'error'), 'swapped pins put SDA and SCL on one net');
  const lib = { ...LIB, nopull: { ...LIB.i2cdev, id: 'nopull', pins: LIB.i2cdev.pins.map((p) => ({ ...p, pullup_ref: undefined })) } };
  const nopull = checkProject({ parts: [P('mcu', 'mcu33'), P('dev', 'nopull')], wires: [W('mcu.SDA', 'dev.SDA'), W('mcu.3V3', 'dev.VCC'), W('mcu.GND', 'dev.GND')] }, lib);
  assert.ok(has(nopull, 'i2c-pullup', 'warning'));
  const five = run([P('uno', 'mcu5'), P('dev', 'i2cdev'), P('mcu', 'mcu33')], [W('uno.SDA', 'dev.SDA'), W('mcu.3V3', 'dev.VCC'), W('uno.GND', 'dev.GND'), W('mcu.GND', 'uno.GND')]);
  const lv = five.issues.find((i) => i.rule === 'logic-level' && i.pins.includes('dev.SDA'));
  assert.ok(lv && lv.level === 'warning', 'weak internal pull-up is a warning');
});

test('UART TX to TX and output into ground', () => {
  const res = run([P('a', 'mcu33'), P('b', 'mcu5')], [W('a.TX', 'b.TX'), W('a.GND', 'b.GND')]);
  assert.ok(has(res, 'bus-mixup'));
  assert.ok(has(res, 'outputs-fight', 'error'));
  const g = run([P('a', 'mcu33')], [W('a.TX', 'a.GND')]);
  assert.ok(has(g, 'output-shorted', 'error'));
});

test('signal pin used to power a part', () => {
  const res = run([P('mcu', 'mcu33'), P('s', 'servo')], [W('mcu.IO1', 's.V+'), W('mcu.GND', 's.GND')]);
  assert.ok(has(res, 'signal-as-power', 'error'));
});

test('unknown parts, pins and duplicates are errors', () => {
  const res = checkProject({ parts: [P('a', 'nope'), P('m', 'mcu33'), P('m', 'mcu33')], wires: [W('m.FOO', 'x.Y'), { from: 'bad', to: 'm.GND' }] }, LIB);
  assert.ok(has(res, 'unknown-library-part', 'error'));
  assert.ok(has(res, 'unknown-endpoint', 'error'));
  assert.ok(res.issues.some((i) => i.rule === 'schema' && /Duplicate part/.test(i.message)));
  assert.ok(res.issues.some((i) => i.rule === 'schema' && /part\.pin/.test(i.message)));
});

test('mains parts are refused', () => {
  const res = run([P('r', 'mains')], []);
  assert.ok(has(res, 'mains', 'error'));
});

test('buck: input load follows the output, dropout warned, params resolved', () => {
  const res = run([P('psu', 'psu6'), P('buck', 'buck', { params: { vout: 5 } }), P('s0', 'servo'), P('s1', 'servo')],
    [W('psu.V+', 'buck.IN+'), W('psu.GND', 'buck.IN-'), W('buck.OUT+', 's0.V+'), W('buck.OUT+', 's1.V+'), W('s0.GND', 'buck.OUT-'), W('s1.GND', 'buck.OUT-')]);
  const out = res.power.rails.find((r) => r.source === 'buck.OUT+');
  assert.equal(out.voltage, 5);
  assert.equal(out.load, 1);
  const inp = res.power.rails.find((r) => r.source === 'psu.V+');
  // 5V × 1A / (0.85 × 6V) + 5 mA quiescent
  assert.ok(Math.abs(inp.load - (5 / (0.85 * 6) + 0.005)) < 0.002, String(inp.load));
  assert.equal(out.parent, inp.net);
  const drop = run([P('psu', 'psu5'), P('buck', 'buck', { params: { vout: 5 } })], [W('psu.V+', 'buck.IN+'), W('psu.GND', 'buck.IN-')]);
  assert.ok(has(drop, 'regulator-dropout', 'warning'));
});

test('linear regulator heat', () => {
  const lib = { ...LIB, big: { id: 'big', category: 'sensor', size: [10, 10, 10], pins: [{ name: 'VCC', kind: 'power_in', vmax: 3.6, current: 0.4 }, { name: 'GND', kind: 'ground' }] } };
  const res = checkProject({ parts: [P('psu', 'psu6'), P('mcu', 'mcu33', { pins: { VIN: { vmax: 12 } } }), P('d', 'big')], wires: [W('psu.V+', 'mcu.VIN'), W('psu.GND', 'mcu.GND'), W('mcu.3V3', 'd.VCC'), W('mcu.GND_2', 'd.GND')] }, lib);
  // (6 - 3.3) × (0.4 + 0.1) = 1.35 W
  assert.ok(has(res, 'regulator-heat', 'warning'), JSON.stringify(res.issues));
});

test('ground wire current follows the return path', () => {
  const g = good();
  const res = run(g.parts, g.wires);
  const gw = g.wires.find((w) => w.from === 'psu.GND');
  assert.equal(res.wireInfo[gw.id].role, 'ground');
  assert.equal(res.wireInfo[gw.id].current, 0.5, 'servo current returns through the supply ground wire');
  const pw = g.wires.find((w) => w.from === 'psu.V+');
  assert.equal(res.wireInfo[pw.id].currentPeak, 2.5);
});

test('wire color that hides its role', () => {
  const res = run([P('psu', 'psu6'), P('s', 'servo')], [W('psu.V+', 's.V+', { color: 'black', gauge: 20 }), W('psu.GND', 's.GND', { color: 'red', gauge: 20 })]);
  assert.equal(res.issues.filter((i) => i.rule === 'wire-color').length, 2);
});
