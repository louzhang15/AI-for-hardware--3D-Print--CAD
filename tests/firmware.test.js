import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanFirmware, comparePins, comparePinsDetailed, stripComments, parsePlatformio, resolvePinValue } from '../lib/firmware.js';
import { pinsHeader } from '../lib/export.js';
import { main as importMain, collectFiles } from '../scripts/import-repo.mjs';
import { main as exportMain } from '../scripts/export.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function load(name) {
  const root = join(FIX, name);
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(root, p).split('\\').join('/'), text: readFileSync(p, 'utf8') });
    }
  };
  walk(root);
  return out;
}

const LIB = {
  'esp32-test': {
    id: 'esp32-test', name: 'ESP32 (test)', category: 'controller',
    pins: [
      { name: '3V3', kind: 'power_out', voltage: 3.3 }, { name: 'GND', kind: 'ground' },
      { name: 'GPIO21', kind: 'digital' }, { name: 'GPIO22', kind: 'digital' },
      { name: 'GPIO5', kind: 'digital' }, { name: 'GPIO18', kind: 'digital' }, { name: 'GPIO27', kind: 'digital' },
    ],
  },
  'pca-test': { id: 'pca-test', name: 'PCA9685', category: 'driver',
    pins: [{ name: 'VCC', kind: 'power_in' }, { name: 'GND', kind: 'ground' }, { name: 'SDA', kind: 'i2c_sda' }, { name: 'SCL', kind: 'i2c_scl' }] },
  'sonar-test': { id: 'sonar-test', name: 'HC-SR04', category: 'sensor',
    pins: [{ name: 'VCC', kind: 'power_in' }, { name: 'TRIG', kind: 'digital' }, { name: 'ECHO', kind: 'digital' }, { name: 'GND', kind: 'ground' }] },
  'buzzer-test': { id: 'buzzer-test', name: 'Buzzer', category: 'actuator', pins: [{ name: 'SIG', kind: 'digital' }, { name: 'GND', kind: 'ground' }] },
};

const PROJECT = {
  meta: { name: 'sonar bot' },
  parts: [
    { id: 'esp', library: 'esp32-test' }, { id: 'pca', library: 'pca-test' },
    { id: 'sonar', library: 'sonar-test' }, { id: 'buzzer', library: 'buzzer-test' },
  ],
  wires: [
    { id: 'w1', from: 'esp.GPIO21', to: 'pca.SDA' }, { id: 'w2', from: 'esp.GPIO22', to: 'pca.SCL' },
    { id: 'w3', from: 'esp.GPIO5', to: 'sonar.TRIG' }, { id: 'w4', from: 'esp.GPIO18', to: 'sonar.ECHO' },
    { id: 'w5', from: 'esp.GPIO27', to: 'buzzer.SIG' }, { id: 'w6', from: 'esp.3V3', to: 'pca.VCC' },
  ],
};

test('stripComments keeps line numbers and ignores comments and strings', () => {
  const src = 'int a = 1; // x = 2\n/* b\n c */ int d = "e//f";\n';
  const out = stripComments(src, 'c', { strings: true });
  assert.equal(out.length, src.length);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(!out.includes('x = 2'));
  assert.ok(!out.includes('e//f'));
  assert.ok(out.includes('int d = "    "'));
  assert.ok(stripComments(src, 'c').includes('"e//f"'), 'strings kept unless asked');
  const py = 's = "Pin(9)"  # Pin(8)\nx = Pin(3)\n';
  const pyOut = stripComments(py, 'py', { strings: true });
  assert.ok(!pyOut.includes('Pin(9)') && !pyOut.includes('Pin(8)') && pyOut.includes('Pin(3)'));
});

test('resolvePinValue follows symbols, casts and ESP-IDF names', () => {
  const sym = new Map([['A', 'B'], ['B', '(gpio_num_t)GPIO_NUM_21'], ['LOOP', 'LOOP']]);
  assert.equal(resolvePinValue('A', sym), 21);
  assert.equal(resolvePinValue('((13))', sym), 13);
  assert.equal(resolvePinValue('A0', new Map()), 'A0');
  assert.equal(resolvePinValue('LOOP', sym), null);
  assert.equal(resolvePinValue('SDA', new Map(), 0, { family: 'esp32' }), 21);
  assert.equal(resolvePinValue('SDA', new Map(), 0, { family: 'avr' }), 'A4');
});

test('Arduino .ino: defines, consts, comments and strings', () => {
  const scan = scanFirmware(load('repo-arduino'));
  assert.equal(scan.board, 'esp32dev');
  assert.equal(scan.framework, 'arduino');
  const byName = (n, kind) => scan.pins.find((p) => p.name === n && (!kind || p.kind === kind));
  assert.deepEqual([byName('TRIG_PIN', 'define').value, byName('TRIG_PIN', 'define').line], [5, 6]);
  assert.equal(byName('ECHO_PIN', 'define').value, 18);
  assert.equal(byName('SDA_PIN', 'const').value, 4);
  assert.equal(byName('SCL_PIN', 'const').value, 22, 'constexpr uint8_t');
  assert.equal(byName('BUZZER_PIN', 'const').value, 27, 'static const int');
  assert.equal(byName('SDA', 'wire-begin').value, 4, 'Wire.begin(SDA_PIN, SCL_PIN) resolved');
  assert.equal(byName('SCL', 'wire-begin').value, 22);
  assert.equal(byName('BUZZER_PIN', 'pinMode').value, 27);
  assert.equal(scan.pins.find((p) => p.kind === 'pinMode' && p.value === 13).name, '13');
  assert.equal(scan.pins.find((p) => p.kind === 'analogRead').value, 'A0');
  assert.ok(scan.pins.some((p) => p.kind === 'newping' && p.value === 5));
  // ignored: comments, block comments, strings, non-pin constants
  for (const ghost of ['OLD_PIN', 'GHOST_PIN', 'BAUD']) assert.ok(!byName(ghost), ghost);
  assert.ok(!scan.pins.some((p) => p.value === 12 || p.value === 34 || p.value === 99 || p.value === 33));
  const libs = scan.libraries.map((l) => l.name);
  assert.deepEqual(libs, ['Wire.h', 'Adafruit_PWMServoDriver.h', 'NewPing.h']);
  const parts = scan.inferredParts.map((p) => p.library);
  assert.deepEqual(parts, ['esp32-devkit-v1', 'pca9685-breakout', 'hc-sr04']);
  assert.ok(scan.inferredParts.every((p) => p.confidence === 'inferred' && p.reason));
});

test('PlatformIO esp32dev with lib_deps and a pins header', () => {
  const ini = parsePlatformio(load('repo-pio').find((f) => f.path === 'platformio.ini').text);
  assert.equal(ini.env, 'esp32dev');
  assert.equal(ini.board, 'esp32dev');
  assert.equal(ini.framework, 'arduino');
  assert.deepEqual(ini.lib_deps.map((d) => d.name), [
    'adafruit/Adafruit PWM Servo Driver Library@^3.0.2', 'madhephaestus/ESP32Servo@^3.0.5', 'adafruit/Adafruit SSD1306',
  ]);
  const scan = scanFirmware(load('repo-pio'));
  assert.equal(scan.board, 'esp32dev');
  assert.equal(scan.boardSource, 'platformio.ini');
  assert.equal(scan.pins.find((p) => p.name === 'PIN_I2C_SDA').value, 21, 'GPIO_NUM_21');
  assert.equal(scan.pins.find((p) => p.name === 'SERVO_ARM_PIN' && p.kind === 'define').value, 14, '(14)');
  const attaches = scan.pins.filter((p) => p.kind === 'servo-attach');
  assert.deepEqual(attaches.map((p) => p.value), [13, 14]);
  assert.deepEqual(scan.pins.filter((p) => p.kind === 'wire-begin').map((p) => p.value), [21, 22]);
  const parts = Object.fromEntries(scan.inferredParts.map((p) => [p.library, p]));
  assert.ok(parts['esp32-devkit-v1'] && parts['pca9685-breakout'] && parts['ssd1306-oled-i2c']);
  assert.equal(parts.servo.qty, 2);
  // With a library, the servo guess resolves to an existing id
  const scan2 = scanFirmware(load('repo-pio'), { library: { 'servo-sg90': {} } });
  assert.ok(scan2.inferredParts.some((p) => p.library === 'servo-sg90'));
});

test('MicroPython on a Pico', () => {
  const scan = scanFirmware(load('repo-micropython'));
  assert.equal(scan.framework, 'micropython');
  assert.equal(scan.board, 'pico');
  const get = (n) => scan.pins.find((p) => p.name === n && p.kind !== 'const');
  assert.equal(get('led').value, 15, 'Pin(LED_PIN) resolved');
  assert.equal(get('sda').value, 4);
  assert.equal(get('scl').value, 5);
  assert.equal(get('servo').value, 16, 'PWM(Pin(SERVO))');
  assert.equal(get('pot').value, 26);
  assert.equal(get('pot').kind, 'analogRead');
  assert.ok(!scan.pins.some((p) => p.value === 99 || p.value === 98));
  const parts = scan.inferredParts.map((p) => p.library);
  assert.deepEqual(parts, ['rpi-pico', 'ssd1306-oled-i2c']);
});

test('ESP-IDF: GPIO_NUM and config structs', () => {
  const scan = scanFirmware([{ path: 'main/main.c', text: [
    '#include "driver/gpio.h"',
    '#include "driver/i2c.h"',
    '#define BLINK_GPIO GPIO_NUM_2',
    'void app_main(void) {',
    '  i2c_config_t conf = { .mode = I2C_MODE_MASTER, .sda_io_num = GPIO_NUM_21, .scl_io_num = 22 };',
    '  gpio_set_direction(BLINK_GPIO, GPIO_MODE_OUTPUT);',
    '  gpio_set_level(GPIO_NUM_4, 1);',
    '}',
  ].join('\n') }]);
  assert.equal(scan.framework, 'espidf');
  assert.equal(scan.board, 'esp32dev');
  assert.equal(scan.pins.find((p) => p.name === 'BLINK_GPIO' && p.kind === 'define').value, 2);
  assert.equal(scan.pins.find((p) => p.name === 'sda_io_num').value, 21);
  assert.equal(scan.pins.find((p) => p.name === 'scl_io_num').value, 22);
  assert.ok(scan.pins.some((p) => p.kind === 'idf-gpio' && p.value === 4));
});

test('mismatch detection: code SDA on 4, map on GPIO21', () => {
  const scan = scanFirmware(load('repo-arduino'));
  const mm = comparePins(PROJECT, LIB, scan);
  assert.ok(mm.length >= 1);
  const sda = mm.find((m) => m.symbol === 'SDA_PIN');
  assert.ok(sda, JSON.stringify(mm, null, 1));
  assert.equal(sda.codeValue, 4);
  assert.equal(sda.mapValue, 21);
  assert.equal(sda.file, 'robot.ino');
  assert.equal(sda.line, 8);
  assert.match(sda.message, /SDA_PIN on GPIO 4.*esp\.GPIO21/);
  // Wire.begin(SDA_PIN, ...) is also flagged; TRIG / ECHO / SCL / BUZZER agree
  assert.ok(mm.some((m) => m.kind === 'wire-begin' && m.codeValue === 4));
  for (const ok of ['TRIG_PIN', 'ECHO_PIN', 'SCL_PIN', 'BUZZER_PIN']) assert.ok(!mm.some((m) => m.symbol === ok), ok);
  const detail = comparePinsDetailed(PROJECT, LIB, scan);
  assert.ok(detail.unwired.some((u) => u.codeValue === 13), 'pin 13 is used but not wired');
  assert.ok(detail.matched.some((m) => m.symbol === 'BUZZER_PIN' && m.mapSymbol === 'PIN_BUZZER_SIG'));

  // A header generated from the map, scanned back, has no mismatches.
  const h = pinsHeader(PROJECT, LIB);
  const back = scanFirmware([{ path: 'include/pins.h', text: h }, { path: 'platformio.ini', text: '[env:x]\nboard = esp32dev\n' }]);
  assert.deepEqual(comparePins(PROJECT, LIB, back), []);
  assert.equal(comparePinsDetailed(PROJECT, LIB, back).matched.length, 5);
});

test('import-repo script: skips .git, compares, exit codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-repo-'));
  const log = console.log;
  const err = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    cpSync(join(FIX, 'repo-arduino'), dir, { recursive: true });
    for (const skip of ['.git', 'node_modules', '.pio', 'build']) {
      mkdirSync(join(dir, skip), { recursive: true });
      writeFileSync(join(dir, skip, 'x.h'), '#define SKIPPED_PIN 33\n');
    }
    assert.deepEqual(collectFiles(dir).map((f) => f.path), ['robot.ino']);
    const proj = join(dir, 'project.json');
    // The built-in library may not have the test parts, so pass them via the project inline.
    const inline = { ...PROJECT, parts: PROJECT.parts.map((p) => ({ ...LIB[p.library], id: p.id })) };
    writeFileSync(proj, JSON.stringify(inline));
    assert.equal(await importMain([dir]), 0);
    assert.ok(out.some((l) => l.includes('TRIG_PIN')));
    assert.equal(await importMain([dir, '--project', proj]), 1);
    assert.ok(out.some((l) => l.includes('MISMATCH') && l.includes('SDA_PIN')));
    out.length = 0;
    assert.equal(await importMain([dir, '--json']), 0);
    assert.equal(JSON.parse(out.join('\n')).board, 'esp32dev');
    assert.equal(await importMain(['--help']), 0);
    assert.equal(await importMain([join(dir, 'missing')]), 2);

    // export script on the same inline project
    const target = join(dir, 'pins.h');
    assert.equal(await exportMain(['pins-h', proj, '--out', target]), 0);
    assert.match(readFileSync(target, 'utf8'), /#define PIN_PCA_SDA\s+21/);
    for (const fmt of ['bom-csv', 'wireviz', 'kicad', 'html', 'shopping']) {
      assert.equal(await exportMain([fmt, proj, '--out', join(dir, `out.${fmt}`)]), 0, fmt);
    }
    assert.equal(await exportMain(['nope', proj]), 2);
    assert.equal(await exportMain(['--help']), 0);
  } finally {
    console.log = log;
    console.error = err;
    rmSync(dir, { recursive: true, force: true });
  }
});
