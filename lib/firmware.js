// @ts-check
// Firmware link: scan a firmware repo (Arduino / PlatformIO / ESP-IDF /
// MicroPython) for pin numbers, board and libraries, infer library parts, and
// compare the code's pins with the wiring map.
// Pure ES module, no Node built-ins: callers pass file contents in.

import { controllerPinTable, cIdent } from './export.js';

// ---------------------------------------------------------------------------
// Comment / string stripping (keeps line numbers and columns)

/**
 * Blank out comments (and optionally string contents) with spaces, keeping
 * newlines so offsets still map to the same line.
 * @param {string} text
 * @param {'c'|'py'|'ini'} lang
 * @param {{strings?: boolean}} [opts] strings: true also blanks string contents
 */
export function stripComments(text, lang, opts = {}) {
  const blankStrings = Boolean(opts.strings);
  const out = [];
  const n = text.length;
  let i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  if (lang === 'ini') {
    // ";" or "#" at line start or after whitespace starts a comment
    return text.split('\n').map((l) => l.replace(/(^|\s)[;#].*$/, (m, pre) => pre + ' '.repeat(m.length - pre.length))).join('\n');
  }
  while (i < n) {
    const c = text[i];
    const c2 = text.slice(i, i + 2);
    if (lang === 'c' && c2 === '//') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      out.push(blank(text.slice(i, j)));
      i = j;
    } else if (lang === 'c' && c2 === '/*') {
      let j = text.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      out.push(blank(text.slice(i, j)));
      i = j;
    } else if (lang === 'py' && c === '#') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      out.push(blank(text.slice(i, j)));
      i = j;
    } else if (lang === 'py' && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const q = text.slice(i, i + 3);
      let j = text.indexOf(q, i + 3);
      j = j < 0 ? n : j + 3;
      const closed = text.startsWith(q, j - 3) && j - 3 >= i + 3;
      out.push(blankStrings ? q + blank(text.slice(i + 3, closed ? j - 3 : j)) + (closed ? q : '') : text.slice(i, j));
      i = j;
    } else if (c === '"' || (c === "'" && (lang === 'py' || lang === 'c'))) {
      // C: '\'' is a char literal; treat the same way.
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      const end = Math.min(j + 1, n);
      const body = text.slice(i + 1, Math.min(j, n));
      out.push(blankStrings ? c + blank(body) + (text[j] === c ? c : '') : text.slice(i, end));
      i = end;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

function langOf(path) {
  const p = path.toLowerCase();
  if (p.endsWith('.py')) return 'py';
  if (p.endsWith('.ini')) return 'ini';
  return 'c';
}

function lineAt(text, idx) {
  let line = 1;
  for (let k = 0; k < idx && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

// ---------------------------------------------------------------------------
// Boards and library -> part mapping

/** board id -> { part, family } */
export const BOARD_PARTS = {
  esp32dev: { part: 'esp32-devkit-v1', family: 'esp32' },
  'esp32doit-devkit-v1': { part: 'esp32-devkit-v1', family: 'esp32' },
  nodemcu_32s: { part: 'esp32-devkit-v1', family: 'esp32' },
  uno: { part: 'arduino-uno-r3', family: 'avr' },
  nanoatmega328: { part: 'arduino-nano', family: 'avr' },
  nanoatmega328new: { part: 'arduino-nano', family: 'avr' },
  nano: { part: 'arduino-nano', family: 'avr' },
  pico: { part: 'rpi-pico', family: 'rp2040' },
  rpipico: { part: 'rpi-pico', family: 'rp2040' },
};

const FQBN_BOARDS = [
  [/^esp32:esp32:(esp32|esp32doit-devkit-v1|nodemcu-32s)\b/, 'esp32dev'],
  [/^arduino:avr:uno\b/, 'uno'],
  [/^arduino:avr:nano\b/, 'nanoatmega328'],
  [/^(rp2040:rp2040:rpipico|arduino:mbed_rp2040:pico)\b/, 'pico'],
];

/** Default I2C pins when code calls Wire.begin() without arguments. */
const DEFAULT_I2C = {
  esp32: { SDA: 21, SCL: 22 },
  avr: { SDA: 'A4', SCL: 'A5' },
  rp2040: { SDA: 4, SCL: 5 },
};

/** Normalised library name -> part guess. Keys are lower-case, alphanumerics only. */
const LIB_RULES = [
  [/adafruitpwmservodriver|pca9685/, { library: 'pca9685-breakout', why: 'PCA9685 PWM driver library' }],
  [/mpu6050/, { library: 'mpu6050-gy521', why: 'MPU6050 IMU library' }],
  [/newping|hcsr04|ultrasonic/, { library: 'hc-sr04', why: 'ultrasonic distance sensor library' }],
  [/^(esp32servo|servo|servoesp32|esp32servo\w*)$/, { library: 'servo', why: 'servo library', candidates: ['servo-sg90', 'servo-mg996r'] }],
  [/ssd1306/, { library: 'ssd1306-oled-i2c', why: 'SSD1306 OLED display library' }],
  [/bme280/, { library: 'bme280-breakout', why: 'BME280 sensor library' }],
  [/accelstepper/, { library: 'a4988-module', why: 'AccelStepper usually drives a STEP/DIR driver such as an A4988 (could also be a DRV8825)', candidates: ['a4988-module', 'drv8825-module'] }],
];

function normLib(name) {
  return String(name).toLowerCase().replace(/@.*$/, '').replace(/^.*\//, '').replace(/\.(h|hpp)$/, '').replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Value resolution

const MAX_DEPTH = 8;

/**
 * Resolve a C / Python expression to a pin value: number, "A0"-style string,
 * or null. `symbols` maps identifier -> raw expression.
 */
export function resolvePinValue(expr, symbols, depth = 0, ctx = {}) {
  if (expr === undefined || expr === null) return null;
  let e = String(expr).trim();
  // strip casts and wrapping parentheses: (gpio_num_t)21, ((21)), static_cast<uint8_t>(21)
  for (let k = 0; k < 5; k++) {
    const before = e;
    e = e.replace(/^static_cast\s*<[^>]+>\s*\((.*)\)$/, '$1').trim();
    e = e.replace(/^\(\s*(?:const\s+)?(?:unsigned\s+)?[A-Za-z_]\w*\s*\)\s*/, '').trim();
    if (/^\(.*\)$/.test(e)) e = e.slice(1, -1).trim();
    e = e.replace(/[uUlL]+$/, (m) => (/^\d/.test(e) ? '' : m));
    if (e === before) break;
  }
  let m;
  if ((m = /^(\d+)[uUlL]*$/.exec(e))) return Number(m[1]);
  if ((m = /^0x([0-9a-f]+)$/i.exec(e))) return parseInt(m[1], 16);
  if ((m = /^GPIO_NUM_(\d+)$/.exec(e))) return Number(m[1]);
  if ((m = /^(?:GPIO|GP)(\d+)$/.exec(e)) && !(symbols && symbols.has(e))) return Number(m[1]);
  if ((m = /^A(\d{1,2})$/.exec(e)) && !(symbols && symbols.has(e))) return `A${Number(m[1])}`;
  if ((m = /^D(\d{1,2})$/.exec(e)) && !(symbols && symbols.has(e))) return `D${Number(m[1])}`;
  if ((m = /^(?:machine\.)?Pin\(\s*([^,)]+)/.exec(e))) return resolvePinValue(m[1], symbols, depth + 1, ctx);
  if (/^[A-Za-z_]\w*$/.test(e)) {
    if (symbols && symbols.has(e) && depth < MAX_DEPTH) return resolvePinValue(symbols.get(e), symbols, depth + 1, ctx);
    if ((e === 'SDA' || e === 'SCL') && ctx.family && DEFAULT_I2C[ctx.family]) return DEFAULT_I2C[ctx.family][e];
    if (e === 'LED_BUILTIN' && ctx.family) return { esp32: 2, avr: 13, rp2040: 25 }[ctx.family] ?? null;
  }
  return null;
}

/** Split call arguments at top-level commas. */
function splitArgs(s) {
  const args = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** Text inside the parentheses that open at `open` (index of "("). */
function callArgs(text, open) {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, j);
    }
  }
  return text.slice(open + 1);
}

const PINISH = /(PIN|SDA|SCL|LED|TRIG|ECHO|SERVO|GPIO|BUTTON|BTN|BUZZER|RELAY|MOTOR|PWM|ADC|STEP|DIR|^EN_|_EN$|ENABLE|CS$|^CS_|MOSI|MISO|SCK|RX|TX|IRQ|INT\d?$|SENSOR|POT|NEOPIXEL|STRIP)/i;
const INT_TYPES = '(?:unsigned\\s+)?(?:int|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|byte|short|long|size_t|pin_size_t|gpio_num_t|uint)';

// ---------------------------------------------------------------------------
// Scan

/**
 * Scan firmware sources.
 * @param {{path:string, text:string}[]} files
 * @param {{library?: Record<string, any>}} [opts] library: resolve part guesses to existing ids
 */
export function scanFirmware(files, opts = {}) {
  const result = {
    board: null, boardSource: null, family: null, framework: null,
    pins: /** @type {any[]} */ ([]),
    libraries: /** @type {any[]} */ ([]),
    inferredParts: /** @type {any[]} */ ([]),
    files: files.map((f) => f.path),
  };

  // 1. Board and framework: platformio.ini first, then FQBN hints, then code hints.
  for (const f of files) {
    if (!/(^|\/)platformio\.ini$/i.test(f.path)) continue;
    const ini = parsePlatformio(f.text);
    if (ini.board && !result.board) { result.board = ini.board; result.boardSource = f.path; }
    if (ini.framework && !result.framework) result.framework = ini.framework;
    for (const d of ini.lib_deps) result.libraries.push({ name: d.name, source: 'lib_deps', file: f.path, line: d.line });
  }
  if (!result.board) {
    for (const f of files) {
      const re = /\b((?:esp32|arduino|rp2040):[\w-]+:[\w-]+)/g;
      let m;
      while ((m = re.exec(f.text))) {
        const hit = FQBN_BOARDS.find(([r]) => r.test(m[1]));
        if (hit) { result.board = hit[1]; result.boardSource = `${f.path}:${lineAt(f.text, m.index)} (FQBN ${m[1]})`; break; }
      }
      if (result.board) break;
    }
  }
  const allText = files.map((f) => f.text).join('\n');
  const hasPy = files.some((f) => langOf(f.path) === 'py');
  if (!result.framework) {
    if (hasPy && /\bfrom\s+machine\s+import|\bimport\s+machine\b/.test(allText)) result.framework = 'micropython';
    else if (/\bapp_main\s*\(|#include\s*[<"](driver\/gpio\.h|freertos\/)/.test(allText)) result.framework = 'espidf';
    else if (/\bvoid\s+setup\s*\(|#include\s*[<"]Arduino\.h/.test(allText)) result.framework = 'arduino';
  }
  if (!result.board) {
    if (result.framework === 'micropython' && /\b(rp2|pico|rp2040)\b/i.test(allText)) { result.board = 'pico'; result.boardSource = 'MicroPython code mentions rp2/Pico'; }
    else if (result.framework === 'espidf' || /\b(esp_\w+|ledcAttach\w*|WiFi\.h|ESP32Servo)\b/.test(allText)) { result.board = 'esp32dev'; result.boardSource = 'ESP32-only APIs in code (guess)'; }
  }
  if (result.board && BOARD_PARTS[result.board]) result.family = BOARD_PARTS[result.board].family;
  else if (result.board && /esp32/i.test(result.board)) result.family = 'esp32';
  const ctx = { family: result.family };

  // 2. Symbols (global across files, first definition wins)
  /** @type {Map<string, string>} */
  const symbols = new Map();
  /** @type {any[]} */
  const decls = [];
  const servoVars = new Set();
  const cleaned = files.map((f) => {
    const lang = langOf(f.path);
    return { ...f, lang, noComments: stripComments(f.text, lang), code: stripComments(f.text, lang, { strings: true }) };
  });
  for (const f of cleaned) {
    if (f.lang === 'ini') continue;
    if (f.lang === 'c') {
      const defRe = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+([^\n]+?)[ \t]*$/gm;
      let m;
      while ((m = defRe.exec(f.code))) addDecl(m[1], m[2], 'define', f, m.index);
      const constRe = new RegExp(`\\b((?:(?:static|const|constexpr|volatile|inline)\\s+)*)${INT_TYPES}\\s+([A-Za-z_]\\w*)\\s*=\\s*([^;,{}\\n]+)\\s*[;,]`, 'g');
      while ((m = constRe.exec(f.code))) {
        const isConst = /\b(const|constexpr)\b/.test(m[1]);
        addDecl(m[2], m[3], isConst ? 'const' : 'var', f, m.index);
      }
      const servoRe = /\b(?:Servo|ESP32Servo|ServoESP32)\s+([A-Za-z_]\w*)/g;
      while ((m = servoRe.exec(f.code))) servoVars.add(m[1]);
    } else {
      const pyRe = /^([A-Za-z_]\w*)\s*=\s*(\d+|0x[0-9a-fA-F]+)\s*$/gm;
      let m;
      while ((m = pyRe.exec(f.code))) addDecl(m[1], m[2], 'const', f, m.index);
    }
  }
  function addDecl(name, raw, kind, f, idx) {
    if (!symbols.has(name)) symbols.set(name, raw.trim());
    decls.push({ name, raw: raw.trim(), kind, file: f.path, line: lineAt(f.code, idx) });
  }

  // 3. Pin usages
  /** @type {any[]} */
  const uses = [];
  const usedNames = new Set();
  const addUse = (name, raw, kind, f, idx, extra = {}) => {
    const r = String(raw).trim();
    const value = resolvePinValue(r, symbols, 0, ctx);
    if (/^[A-Za-z_]\w*$/.test(r)) usedNames.add(r);
    uses.push({ name, value, raw: r, kind, file: f.path, line: lineAt(f.code, idx), ...extra });
  };
  const identName = (raw) => (/^[A-Za-z_]\w*$/.test(String(raw).trim()) ? String(raw).trim() : null);

  for (const f of cleaned) {
    if (f.lang === 'ini') continue;
    const code = f.code;
    let m;
    if (f.lang === 'c') {
      const callRe = /\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|ledcAttachPin|ledcAttach|gpio_set_direction|gpio_set_level|gpio_get_level|gpio_reset_pin|gpio_pullup_en|tone|attachInterrupt)\s*\(/g;
      while ((m = callRe.exec(code))) {
        const args = splitArgs(callArgs(code, m.index + m[0].length - 1));
        if (!args.length) continue;
        let a0 = args[0];
        const im = /^digitalPinToInterrupt\s*\((.*)\)$/.exec(a0);
        if (im) a0 = im[1];
        const kind = m[1].startsWith('gpio_') ? 'idf-gpio' : m[1].startsWith('ledc') ? 'ledc' : m[1];
        addUse(identName(a0) || a0, a0, kind, f, m.index);
      }
      const wireRe = /\b(Wire\d?)\s*\.\s*(begin|setPins)\s*\(/g;
      while ((m = wireRe.exec(code))) {
        const args = splitArgs(callArgs(code, m.index + m[0].length - 1));
        const bus = m[1];
        if (args.length >= 2) {
          addUse('SDA', args[0], 'wire-begin', f, m.index, { bus, symbol: identName(args[0]) });
          addUse('SCL', args[1], 'wire-begin', f, m.index, { bus, symbol: identName(args[1]) });
        } else if (args.length === 0 && ctx.family && DEFAULT_I2C[ctx.family]) {
          const d = DEFAULT_I2C[ctx.family];
          addUse('SDA', String(d.SDA), 'wire-begin', f, m.index, { bus, default: true });
          addUse('SCL', String(d.SCL), 'wire-begin', f, m.index, { bus, default: true });
        }
      }
      const setRe = /\b(Wire\d?)\s*\.\s*set(SDA|SCL)\s*\(/g;
      while ((m = setRe.exec(code))) {
        const args = splitArgs(callArgs(code, m.index + m[0].length - 1));
        if (args.length) addUse(m[2], args[0], 'wire-begin', f, m.index, { bus: m[1], symbol: identName(args[0]) });
      }
      const attachRe = /\b([A-Za-z_]\w*)(\s*\[[^\]]*\])?\s*\.\s*attach\s*\(/g;
      while ((m = attachRe.exec(code))) {
        if (!servoVars.has(m[1]) && !/servo/i.test(m[1])) continue;
        const args = splitArgs(callArgs(code, m.index + m[0].length - 1));
        if (args.length) addUse(identName(args[0]) || `${m[1]}.attach`, args[0], 'servo-attach', f, m.index, { object: m[1] });
      }
      const npRe = /\bNewPing\s+([A-Za-z_]\w*)\s*\(/g;
      while ((m = npRe.exec(code))) {
        const args = splitArgs(callArgs(code, m.index + m[0].length - 1));
        if (args[0]) addUse(identName(args[0]) || 'TRIGGER', args[0], 'newping', f, m.index, { role: 'trig' });
        if (args[1]) addUse(identName(args[1]) || 'ECHO', args[1], 'newping', f, m.index, { role: 'echo' });
      }
      // ESP-IDF config structs: .sda_io_num = GPIO_NUM_21, .gpio_num = 5, .pin_bit_mask = (1ULL << 4)
      const cfgRe = /\.\s*([A-Za-z_]*(?:io_num|gpio_num|_pin|pin_\w+|gpio)\w*)\s*=\s*([^,;}\n]+)/g;
      while ((m = cfgRe.exec(code))) {
        const raw = m[2].trim();
        const bm = /^\(?\s*1U?L{0,2}\s*<<\s*([^)]+)\)?$/.exec(raw);
        addUse(m[1], bm ? bm[1] : raw, 'idf-config', f, m.index);
      }
      // Bare GPIO_NUM_x anywhere that wasn't caught above
      const numRe = /\bGPIO_NUM_(\d+)\b/g;
      while ((m = numRe.exec(code))) {
        const line = lineAt(code, m.index);
        if (uses.some((u) => u.file === f.path && u.line === line && u.value === Number(m[1]))) continue;
        if (decls.some((d) => d.file === f.path && d.line === line)) continue;
        addUse(`GPIO_NUM_${m[1]}`, m[0], 'idf-gpio', f, m.index);
      }
    } else {
      // MicroPython: Pin(15), machine.Pin(15, Pin.OUT), sda=Pin(4), PWM(Pin(15)), ADC(26)
      const pinRe = /\b(?:machine\s*\.\s*)?(Pin|ADC)\s*\(/g;
      while ((m = pinRe.exec(code))) {
        const args = splitArgs(callArgs(code, m.index + m[0].length - 1));
        if (!args.length) continue;
        const prefix = code.slice(Math.max(0, code.lastIndexOf('\n', m.index) + 1), m.index);
        const nm = /([A-Za-z_]\w*)\s*=\s*(?:[A-Za-z_][\w.]*\s*\(\s*)?$/.exec(prefix);
        let name = nm ? nm[1] : identName(args[0]) || `${m[1]}(${args[0]})`;
        if (m[1] === 'ADC' && /^(?:machine\s*\.\s*)?Pin\s*\(/.test(args[0])) continue; // inner Pin() is scanned on its own
        // A string literal like Pin("LED") is blanked; read it from the comment-free text.
        let raw = args[0];
        if (/^["']\s*["']$/.test(raw.replace(/\s+/g, ' '))) {
          const orig = f.noComments.slice(m.index, m.index + m[0].length + 20);
          const sm = /\(\s*["']([^"']*)["']/.exec(orig);
          raw = sm ? sm[1] : raw;
          if (sm && sm[1] === 'LED' && !nm) name = 'LED';
        }
        addUse(name, raw, m[1] === 'ADC' ? 'analogRead' : 'micropython-pin', f, m.index);
      }
    }
  }

  // 4. Declarations become pins when pin-like by name or used as a pin
  for (const d of decls) {
    const value = resolvePinValue(d.raw, symbols, 0, ctx);
    if (value === null) continue;
    if (typeof value === 'number' && value > 64) continue;
    if (!PINISH.test(d.name) && !usedNames.has(d.name)) continue;
    if (d.kind === 'define' && /^(SDA|SCL)$/.test(d.name) === false && /^__|_H_?$/.test(d.name)) continue;
    result.pins.push({ name: d.name, value, raw: d.raw, kind: d.kind, file: d.file, line: d.line });
  }
  for (const u of uses) result.pins.push(u);
  result.pins.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  // 5. Libraries from includes / imports
  const localNames = new Set(files.map((f) => f.path.split('/').pop()));
  for (const f of cleaned) {
    if (f.lang === 'c') {
      const incRe = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"]+)[>"]/gm;
      let m;
      while ((m = incRe.exec(f.noComments))) {
        const base = m[1].split('/').pop();
        if (localNames.has(base)) continue; // the repo's own header, not a library
        result.libraries.push({ name: m[1], source: 'include', file: f.path, line: lineAt(f.noComments, m.index) });
      }
    } else if (f.lang === 'py') {
      const impRe = /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w.]+))/gm;
      let m;
      while ((m = impRe.exec(f.code))) result.libraries.push({ name: m[1] || m[2], source: 'import', file: f.path, line: lineAt(f.code, m.index) });
    }
  }

  // 6. Inferred parts
  const lib = opts.library || null;
  const pickId = (guess) => {
    if (!lib) return guess.library;
    for (const c of [guess.library, ...(guess.candidates || [])]) if (lib[c]) return c;
    return guess.library;
  };
  const inferred = new Map();
  const addPart = (id, reason, extra = {}) => {
    if (inferred.has(id)) { inferred.get(id).reasons.push(reason); return; }
    inferred.set(id, { library: id, reason, reasons: [reason], confidence: 'inferred', ...extra });
  };
  if (result.board && BOARD_PARTS[result.board]) {
    addPart(pickId({ library: BOARD_PARTS[result.board].part }), `board "${result.board}" from ${result.boardSource}`, { role: 'controller' });
  }
  for (const l of result.libraries) {
    const key = normLib(l.name);
    const rule = LIB_RULES.find(([re]) => re.test(key));
    if (!rule) continue;
    const g = rule[1];
    addPart(pickId(g), `${g.why}: ${l.name} (${l.file}${l.line ? ':' + l.line : ''})`, g.candidates ? { candidates: g.candidates } : {});
  }
  // Quantities that the code makes obvious
  const servoPart = [...inferred.values()].find((p) => p.candidates && p.candidates.includes('servo-sg90'));
  if (servoPart) {
    const attached = new Set(result.pins.filter((p) => p.kind === 'servo-attach').map((p) => `${p.object}:${p.raw}`));
    if (attached.size) servoPart.qty = attached.size;
  }
  result.inferredParts = [...inferred.values()];
  return result;
}

/** Minimal platformio.ini reader: first (or default) env's board, framework, lib_deps. */
export function parsePlatformio(text) {
  const clean = stripComments(text.replace(/\r\n/g, '\n'), 'ini');
  const lines = clean.split('\n');
  /** @type {Record<string, Record<string, {value:string, line:number, extra:{v:string,line:number}[]}>>} */
  const sections = {};
  let sec = '';
  let lastKey = null;
  lines.forEach((l, i) => {
    const sm = /^\s*\[([^\]]+)\]\s*$/.exec(l);
    if (sm) { sec = sm[1].trim(); sections[sec] = sections[sec] || {}; lastKey = null; return; }
    const km = /^([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(l);
    if (km) {
      sections[sec] = sections[sec] || {};
      sections[sec][km[1]] = { value: km[2].trim(), line: i + 1, extra: [] };
      lastKey = km[1];
      return;
    }
    if (lastKey && /^\s+\S/.test(l)) sections[sec][lastKey].extra.push({ v: l.trim(), line: i + 1 });
  });
  const envs = Object.keys(sections).filter((s) => s.startsWith('env:'));
  const def = sections.platformio?.default_envs?.value?.split(/[,\s]+/)[0];
  const envName = def && sections[`env:${def}`] ? `env:${def}` : envs[0];
  const get = (k) => sections[envName]?.[k] || sections.env?.[k];
  const board = get('board')?.value || null;
  const fw = get('framework')?.value || null;
  const lib_deps = [];
  const deps = get('lib_deps');
  if (deps) {
    const items = [{ v: deps.value, line: deps.line }, ...deps.extra];
    for (const it of items) {
      for (const part of it.v.split(',')) {
        const name = part.trim();
        if (name) lib_deps.push({ name, line: it.line });
      }
    }
  }
  return { env: envName ? envName.slice(4) : null, board, framework: fw ? fw.split(/[,\s]+/)[0] : null, lib_deps };
}

// ---------------------------------------------------------------------------
// Compare code pins with the wiring map

function canon(v, family) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return String(v);
  const s = String(v);
  const a = /^A(\d+)$/.exec(s);
  if (a && family === 'avr') return String(14 + Number(a[1]));
  return s;
}

const NOISE = new Set(['PIN', 'PINS', 'GPIO', 'IO', 'NUM', 'THE', 'P']);

function tokens(name) {
  return cIdent(String(name).replace(/([a-z])([A-Z])/g, '$1_$2')).split('_').filter((t) => t && !NOISE.has(t));
}

/**
 * Detailed comparison. Returns
 *  { mismatches, unwired, matched }
 * mismatches: code pins whose name points at a mapped connection but whose
 * number differs; unwired: code pins on numbers the map does not wire.
 */
export function comparePinsDetailed(project, library, scan, opts = {}) {
  const { entries } = controllerPinTable(project, library, opts);
  const family = scan.family || null;
  const mapByValue = new Map();
  for (const e of entries) if (e.value !== null) mapByValue.set(canon(e.value, family), e);

  // Index map entries by tokens of the other end.
  const roleCount = new Map();
  for (const e of entries) for (const p of e.otherPins) {
    const t = cIdent(p.name);
    roleCount.set(t, (roleCount.get(t) || 0) + 1);
  }
  const findEntry = (codeName, codeKind) => {
    const toks = new Set(tokens(codeName));
    if (!toks.size) return null;
    const exact = entries.find((e) => e.symbol === cIdent(codeName) || e.symbol === `PIN_${cIdent(codeName)}`);
    if (exact) return exact;
    // I2C: SDA/SCL names (Wire.begin, sda=Pin(...), I2C_SDA, SDA_PIN)
    for (const bus of ['SDA', 'SCL']) {
      if (toks.has(bus) || (codeKind === 'wire-begin' && cIdent(codeName) === bus)) {
        const e = entries.find((x) => x.group === 'i2c' && x.otherPins.some((p) => p.kind === `i2c_${bus.toLowerCase()}` || cIdent(p.name) === bus))
          || entries.find((x) => x.group === 'i2c' && x.symbol.endsWith(bus));
        if (e) return e;
      }
    }
    let best = null;
    let bestScore = 0;
    for (const e of entries) {
      for (const p of e.otherPins) {
        const role = cIdent(p.name);
        const partToks = tokens(p.part);
        const roleToks = tokens(p.name);
        const roleHit = roleToks.length && roleToks.every((t) => toks.has(t));
        const partHit = partToks.length && partToks.every((t) => toks.has(t));
        let score = 0;
        if (roleHit && partHit) score = 3;
        else if (roleHit && roleCount.get(role) === 1 && !['VCC', 'GND', 'SIG', 'IN', 'OUT'].includes(role)) score = 2;
        else if (partHit && e.otherPins.length === 1 && entries.filter((x) => x.otherPins.some((q) => q.part === p.part)).length === 1) score = 1;
        if (score > bestScore) { best = e; bestScore = score; }
      }
    }
    return best;
  };

  const mismatches = [];
  const unwired = [];
  const matched = [];
  const seen = new Set();
  for (const cp of scan.pins || []) {
    if (cp.value === null || cp.value === undefined) continue;
    const key = `${cp.name}|${canon(cp.value, family)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const codeVal = canon(cp.value, family);
    const named = cp.name && !/^(GPIO_NUM_\d+|\d+|[AD]\d+)$/.test(cp.name) ? findEntry(cp.name, cp.kind) : null;
    if (named) {
      const mapVal = canon(named.value, family);
      if (mapVal !== null && mapVal !== codeVal) {
        mismatches.push({
          symbol: cp.name, codeValue: cp.value, mapValue: named.value, mapSymbol: named.symbol,
          mapPin: named.pinKey, others: named.others, file: cp.file, line: cp.line, kind: cp.kind,
          message: `${cp.file}:${cp.line}: code puts ${cp.name} on ${fmtPin(cp.value)}, but the map wires ${named.others.join(', ')} to ${named.pinKey} (${fmtPin(named.value)})`,
        });
      } else {
        matched.push({ symbol: cp.name, value: cp.value, mapSymbol: named.symbol, mapPin: named.pinKey, file: cp.file, line: cp.line });
      }
      continue;
    }
    if (!mapByValue.has(codeVal)) {
      if (/LED_BUILTIN|^LED$/.test(cp.raw) || cp.name === 'LED') continue;
      unwired.push({ symbol: cp.name, codeValue: cp.value, file: cp.file, line: cp.line, kind: cp.kind,
        message: `${cp.file}:${cp.line}: code uses ${fmtPin(cp.value)} (${cp.name}) but nothing in the map is wired to it` });
    } else {
      const e = mapByValue.get(codeVal);
      matched.push({ symbol: cp.name, value: cp.value, mapSymbol: e.symbol, mapPin: e.pinKey, file: cp.file, line: cp.line });
    }
  }
  return { mismatches, unwired, matched };
}

function fmtPin(v) {
  return typeof v === 'number' ? `GPIO ${v}` : String(v);
}

/** Mismatches between code pins and the wiring map (see comparePinsDetailed). */
export function comparePins(project, library, scan, opts = {}) {
  return comparePinsDetailed(project, library, scan, opts).mismatches;
}
