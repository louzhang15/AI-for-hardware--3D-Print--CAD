// Part library sanity tests: every library/<id>.json must be internally
// consistent so the checker, breadboard layout and viewer can trust it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLibrary, WIREMAP_ROOT } from '../lib/node/library.js';
import { PIN_KINDS, resolveProject } from '../lib/model.js';

const DIR = join(WIREMAP_ROOT, 'library');
const library = loadLibrary(DIR);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();

const CATEGORIES = ['controller', 'driver', 'actuator', 'sensor', 'power', 'battery', 'protection', 'passive', 'module'];
const CONFIDENCE = ['verified', 'checked', 'confirm'];
const DIRS = ['in', 'out', 'io'];
const FITS = ['straddle', 'single', 'offboard'];
const PROTECTION = ['fuse', 'switch', 'bms', 'diode'];
const REG_TYPES = ['linear', 'buck', 'boost', 'buck-boost'];
const NUMERIC_PIN_FIELDS = ['voltage', 'voltage_max', 'voltage_min', 'vmin', 'vmax', 'vih', 'current',
  'current_peak', 'current_max', 'pullup', 'vmax_offset', 'pullup_ohms'];
const PIN_REF_FIELDS = ['voltage_ref', 'vmax_ref', 'pullup_ref'];
const REG_NUMERIC = ['vout', 'dropout', 'current_max', 'iq', 'efficiency', 'vin_max'];

// The exact ids other parts of the system and the example projects depend on.
const REQUIRED_IDS = [
  'esp32-devkit-v1', 'esp32-devkitc-v4', 'arduino-uno-r3', 'arduino-nano', 'rpi-pico', 'pca9685-breakout',
  'l298n-module', 'tb6612fng-breakout', 'drv8825-module', 'a4988-module', 'l293d', 'servo-sg90', 'servo-mg996r',
  'nema17-stepper', 'dc-motor-tt', 'hc-sr04', 'mpu6050-gy521', 'bme280-breakout', 'ssd1306-oled-i2c',
  'dc-adapter-5v-3a', 'dc-adapter-6v-5a', 'dc-adapter-12v-2a', 'usb-5v', 'buck-lm2596', 'buck-mp1584',
  'ams1117-3v3-module', 'lipo-2s', 'lipo-3s', 'li-ion-18650-2s-bms', 'bms-2s', 'fuse-inline', 'switch-rocker',
  'level-shifter-bss138', 'led-5mm', 'resistor', 'diode-1n5819', 'capacitor-electrolytic',
];

// Pin names that projects and tests refer to.
const REQUIRED_PINS = {
  'esp32-devkit-v1': ['GPIO21', 'GPIO22', 'GPIO1', 'GPIO3', 'GPIO34', 'GPIO35', 'GPIO36', 'GPIO39', 'VIN', '3V3', 'GND', 'GND_2', 'EN'],
  'esp32-devkitc-v4': ['GPIO21', 'GPIO22', '5V', '3V3', 'GND'],
  'arduino-uno-r3': ['D0', 'D13', 'A0', 'A5', '5V', '3V3', 'VIN', 'GND', 'GND_2', 'GND_3', 'IOREF', 'RESET', 'AREF', 'SDA', 'SCL'],
  'arduino-nano': ['D0', 'D13', 'A0', 'A7', '5V', '3V3', 'VIN', 'GND'],
  'rpi-pico': ['GP0', 'GP28', 'VBUS', 'VSYS', '3V3', '3V3_EN', 'GND', 'RUN', 'ADC_VREF', 'AGND'],
  'pca9685-breakout': ['GND', 'OE', 'SCL', 'SDA', 'VCC', 'V+', 'GND_R', 'V+_R', 'V+_T', 'GND_T', 'PWM0', 'PWM15', 'V+0', 'V+15', 'GND0', 'GND15'],
  'servo-mg996r': ['SIG', 'V+', 'GND'],
  'servo-sg90': ['SIG', 'V+', 'GND'],
  'dc-adapter-6v-5a': ['V+', 'GND'],
  'usb-5v': ['5V', 'GND'],
  'buck-lm2596': ['IN+', 'IN-', 'OUT+', 'OUT-'],
  'buck-mp1584': ['IN+', 'IN-', 'OUT+', 'OUT-'],
  'ams1117-3v3-module': ['VIN', 'GND', '3V3'],
  'lipo-2s': ['BAT+', 'BAT-'],
  'bms-2s': ['B+', 'B-', 'P+', 'P-'],
  'fuse-inline': ['IN', 'OUT'],
  'switch-rocker': ['IN', 'OUT'],
  'l293d': Array.from({ length: 16 }, (_, i) => String(i + 1)),
  'tb6612fng-breakout': ['VM', 'VCC', 'GND', 'AO1', 'AO2', 'BO2', 'BO1', 'PWMA', 'AIN2', 'AIN1', 'STBY', 'BIN1', 'BIN2', 'PWMB'],
  'l298n-module': ['+12V', 'GND', '+5V', 'ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB', 'OUT1', 'OUT2', 'OUT3', 'OUT4'],
  'a4988-module': ['ENABLE', 'MS1', 'MS2', 'MS3', 'RESET', 'SLEEP', 'STEP', 'DIR', 'VMOT', 'GND', '2B', '2A', '1A', '1B', 'VDD', 'GND_2'],
  'nema17-stepper': ['A+', 'A-', 'B+', 'B-'],
  'dc-motor-tt': ['M+', 'M-'],
  'hc-sr04': ['VCC', 'TRIG', 'ECHO', 'GND'],
  'mpu6050-gy521': ['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'],
  'level-shifter-bss138': ['HV', 'LV', 'GND', 'GND_2', 'HV1', 'HV4', 'LV1', 'LV4'],
  'led-5mm': ['A', 'K'],
  'resistor': ['1', '2'],
  'diode-1n5819': ['A', 'K'],
  'capacitor-electrolytic': ['+', '-'],
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isParamRef = (v, params) => {
  if (typeof v !== 'string') return false;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\s*[*+\-/]\s*-?[0-9.]+)?$/.exec(v);
  return Boolean(m && params && isNum(params[m[1]]));
};
const numOrParam = (v, params) => isNum(v) || isParamRef(v, params);

test('library has every required part id', () => {
  for (const id of REQUIRED_IDS) assert.ok(library[id], `missing library/${id}.json`);
});

test('required pin names exist', () => {
  for (const [id, names] of Object.entries(REQUIRED_PINS)) {
    const have = new Set(library[id].pins.map((p) => p.name));
    for (const n of names) assert.ok(have.has(n), `${id} has no pin "${n}"`);
  }
});

for (const file of files) {
  const id = file.replace(/\.json$/, '');
  test(`library part ${id}`, () => {
    const raw = readFileSync(join(DIR, file), 'utf8');
    const def = JSON.parse(raw);
    const where = (s) => `${id}: ${s}`;

    // identity and required fields
    assert.equal(def.id, id, where('id must equal the file name'));
    for (const f of ['name', 'category', 'description', 'confidence', 'size', 'pins', 'breadboard']) {
      assert.ok(def[f] !== undefined, where(`missing field "${f}"`));
    }
    assert.ok(CATEGORIES.includes(def.category), where(`bad category ${def.category}`));
    assert.ok(CONFIDENCE.includes(def.confidence), where(`bad confidence ${def.confidence}`));
    assert.ok(Array.isArray(def.sources) && def.sources.length > 0, where('needs at least one source'));
    for (const s of def.sources) assert.match(s, /^https?:\/\//, where(`source is not a URL: ${s}`));
    if (def.confidence === 'confirm') assert.ok(Array.isArray(def.notes) && def.notes.length > 0, where('"confirm" parts must say what to check in notes'));
    assert.ok(Array.isArray(def.size) && def.size.length === 3 && def.size.every((x) => isNum(x) && x > 0), where('size must be [sx, sy, sz] > 0'));
    const params = def.params || {};
    for (const [k, v] of Object.entries(params)) assert.ok(isNum(v), where(`param ${k} must be a number`));

    // pins
    assert.ok(Array.isArray(def.pins) && def.pins.length > 0, where('no pins'));
    const names = new Set();
    for (const p of def.pins) {
      const pw = (s) => where(`pin ${p.name}: ${s}`);
      assert.equal(typeof p.name, 'string', where('pin without a name'));
      assert.ok(!names.has(p.name), pw('duplicate pin name'));
      names.add(p.name);
      assert.equal(typeof p.label, 'string', pw('missing label'));
      assert.ok(PIN_KINDS.includes(p.kind), pw(`unknown kind ${p.kind}`));
      if (p.dir !== undefined) assert.ok(DIRS.includes(p.dir), pw(`bad dir ${p.dir}`));
      for (const f of NUMERIC_PIN_FIELDS) {
        if (p[f] !== undefined) assert.ok(numOrParam(p[f], params), pw(`${f} must be a number or "$param" (got ${JSON.stringify(p[f])})`));
      }
      if (isNum(p.vmin) && isNum(p.vmax)) assert.ok(p.vmin <= p.vmax, pw('vmin > vmax'));
      if (isNum(p.voltage_min) && isNum(p.voltage_max)) assert.ok(p.voltage_min <= p.voltage_max, pw('voltage_min > voltage_max'));
      if (p.kind === 'power_out') assert.ok(p.voltage !== undefined, pw('power_out needs voltage'));
      if (p.kind === 'power_in') assert.ok(isNum(p.vmin) || isNum(p.vmax), pw('power_in needs vmin/vmax'));
      // footprint position inside the part outline
      assert.ok(Array.isArray(p.pos) && p.pos.length === 2 && p.pos.every(isNum), pw('pos must be [u, v]'));
      const [u, v] = p.pos;
      assert.ok(u >= 0 && u <= def.size[0] + 1e-9 && v >= 0 && v <= def.size[2] + 1e-9,
        pw(`pos [${u}, ${v}] outside footprint ${def.size[0]} x ${def.size[2]}`));
    }
    for (const p of def.pins) {
      for (const f of PIN_REF_FIELDS) {
        if (p[f] !== undefined) assert.ok(names.has(p[f]), where(`pin ${p.name}.${f} refers to unknown pin "${p[f]}"`));
      }
    }

    // internal groups
    for (const group of def.internal || []) {
      assert.ok(Array.isArray(group) && group.length >= 2, where(`internal group too small: ${JSON.stringify(group)}`));
      for (const n of group) assert.ok(names.has(n), where(`internal group refers to unknown pin "${n}"`));
    }

    // regulators
    for (const reg of def.regulators || []) {
      for (const f of ['in', 'out', 'gnd']) assert.ok(names.has(reg[f]), where(`regulator.${f} refers to unknown pin "${reg[f]}"`));
      assert.ok(REG_TYPES.includes(reg.type), where(`regulator type ${reg.type}`));
      for (const f of REG_NUMERIC) if (reg[f] !== undefined) assert.ok(numOrParam(reg[f], params), where(`regulator.${f} must be numeric or "$param"`));
      assert.ok(reg.vout !== undefined && reg.current_max !== undefined, where('regulator needs vout and current_max'));
      const out = def.pins.find((p) => p.name === reg.out);
      assert.equal(out.kind, 'power_out', where('regulator output pin must be power_out'));
    }

    // battery / protection
    if (def.battery) {
      assert.equal(def.category, 'battery', where('battery block on a non-battery part'));
      for (const f of ['cells', 'capacity_ah']) assert.ok(numOrParam(def.battery[f], params), where(`battery.${f}`));
      assert.equal(typeof def.battery.bms, 'boolean', where('battery.bms must be boolean'));
      assert.ok(def.pins.some((p) => p.kind === 'power_out') && def.pins.some((p) => p.kind === 'ground'), where('battery needs + and - pins'));
    }
    if (def.protection !== undefined) {
      assert.ok(PROTECTION.includes(def.protection), where(`protection ${def.protection}`));
      assert.ok(numOrParam(def.rating_a, params), where('protection parts need rating_a'));
      assert.ok((def.internal || []).length > 0, where('protection parts need an internal series path'));
    }
    if (def.mains !== undefined) assert.equal(def.mains, false, where('mains parts are out of scope'));

    // breadboard
    const bb = def.breadboard;
    assert.ok(FITS.includes(bb.fit), where(`breadboard.fit ${bb.fit}`));
    if (bb.fit !== 'offboard') {
      assert.ok(Array.isArray(bb.rows) && bb.rows.length === (bb.fit === 'straddle' ? 2 : 1), where('breadboard.rows count'));
      const seen = new Set();
      for (const row of bb.rows) {
        for (const n of row) {
          if (n === null) continue;
          assert.ok(names.has(n), where(`breadboard row refers to unknown pin "${n}"`));
          assert.ok(!seen.has(n), where(`breadboard row repeats pin "${n}"`));
          seen.add(n);
        }
      }
      if (bb.fit === 'straddle') {
        assert.ok(Number.isInteger(bb.row_spacing) && bb.row_spacing >= 3, where('straddle needs integer row_spacing >= 3'));
        assert.ok(isNum(bb.body_width_mm), where('straddle needs body_width_mm'));
        assert.equal(bb.rows[0].length, bb.rows[1].length, where('straddle rows must be the same length'));
      }
    }

    // geometry
    if (def.geometry) assert.ok(CONFIDENCE.includes(def.geometry.confidence), where('geometry.confidence'));

    // resolves cleanly as a one-part project
    const model = resolveProject({ parts: [{ id: 'p', library: id, position: [0, 0, 0] }], wires: [] }, library);
    assert.deepEqual(model.problems, [], where(`resolveProject problems: ${JSON.stringify(model.problems)}`));
    const part = model.parts.get('p');
    for (const p of part.pins) {
      for (const f of NUMERIC_PIN_FIELDS) if (p[f] !== undefined) assert.ok(isNum(p[f]), where(`pin ${p.name}.${f} did not resolve to a number`));
    }
  });
}
