// @ts-check
// Wiremap exports: pins.h, BOM / cart CSV, WireViz YAML, KiCad netlist,
// a static HTML build guide and a markdown shopping checklist.
// Pure ES module with no dependencies and no Node built-ins: runs in Node and
// in the browser. Every function takes the project JSON and the library map.

import { resolveProject } from './model.js';
import { buildNets, netRole } from './nets.js';

const POWER_KINDS = new Set(['power_in', 'power_out', 'power_rail', 'ground', 'nc']);
const I2C_KINDS = new Set(['i2c_sda', 'i2c_scl']);

// ---------------------------------------------------------------------------
// Small helpers

/** Turn any text into an upper-case C identifier fragment. */
export function cIdent(s) {
  let out = String(s ?? '')
    .replace(/\+/g, 'P')
    .replace(/-/g, '_')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!out) out = 'X';
  if (/^[0-9]/.test(out)) out = `_${out}`;
  return out;
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /').trim();
}

function modelOf(project, library) {
  const model = resolveProject(project, library || {});
  const nets = buildNets(model);
  return { model, nets };
}

/**
 * Numeric GPIO for a controller pin, from `gpio`, the pin name or its label.
 * GPIO21 / GP21 / IO21 / D21 / 21 -> 21. Arduino analog pins A0..A7 -> "A0"
 * (the Arduino core symbol) when no GPIO number is found.
 * @returns {number|string|null}
 */
export function pinNumber(pin) {
  if (!pin) return null;
  if (typeof pin.gpio === 'number') return pin.gpio;
  const tokens = [];
  for (const s of [pin.name, pin.label]) {
    if (typeof s === 'string') tokens.push(...s.split(/[\/\s,|()]+/).filter(Boolean));
  }
  const patterns = [
    /^(?:GPIO|GPIO_NUM_|GP|IO)_?(\d{1,3})$/i,
    /^(?:D|P|PIN)_?(\d{1,3})$/i,
    /^(\d{1,3})$/,
  ];
  for (const re of patterns) {
    for (const t of tokens) {
      const m = re.exec(t);
      if (m) return Number(m[1]);
    }
  }
  for (const t of tokens) {
    const m = /^A(\d{1,2})$/.exec(t);
    if (m) return `A${Number(m[1])}`;
  }
  return null;
}

/** Pick the controller part id: explicit option or first part with category "controller". */
export function findController(model, controller) {
  if (controller) {
    if (!model.parts.has(controller)) throw new Error(`Controller part "${controller}" is not in the project`);
    return controller;
  }
  const c = model.partList.find((p) => p.category === 'controller');
  if (!c) throw new Error('No part with category "controller" in the project; pass a controller id');
  return c.id;
}

/**
 * The pin table the map implies for the controller: one entry per controller
 * signal pin that is wired to something.
 * @returns {{controller:string, entries: {symbol:string, value:number|string|null, controllerPin:string,
 *   pinKey:string, group:'i2c'|'uart'|'spi'|'pwm'|'analog'|'digital', others:string[], otherPins:any[],
 *   wires:string[], role:string, comment:string}[]}}
 */
export function controllerPinTable(project, library, opts = {}) {
  const { model, nets } = modelOf(project, library);
  const controller = findController(model, opts.controller);
  const cpart = model.parts.get(controller);
  const entries = [];
  const used = new Set();
  for (const pin of cpart.pins) {
    if (POWER_KINDS.has(pin.kind)) continue;
    const net = nets.netOfPin.get(pin.key);
    if (!net || !net.wires.length) continue;
    const otherPins = net.pins.filter((k) => !k.startsWith(`${controller}.`)).map(nets.pinOf).filter(Boolean);
    const signalOthers = otherPins.filter((p) => !POWER_KINDS.has(p.kind));
    if (!signalOthers.length) continue;
    const role = netRole(net, nets.pinOf);
    const kinds = new Set([pin.kind, ...signalOthers.map((p) => p.kind)]);
    let group = 'digital';
    if (kinds.has('i2c_sda') || kinds.has('i2c_scl')) group = 'i2c';
    else if (kinds.has('uart_tx') || kinds.has('uart_rx')) group = 'uart';
    else if (kinds.has('spi')) group = 'spi';
    else if (kinds.has('pwm')) group = 'pwm';
    else if (kinds.has('analog')) group = 'analog';

    // Prefer the pin at the other end of a direct wire for the name.
    const direct = model.wires.filter((w) => w.valid && (w.fromKey === pin.key || w.toKey === pin.key))
      .map((w) => (w.fromKey === pin.key ? w.toKey : w.fromKey))
      .map(nets.pinOf).filter((p) => p && !POWER_KINDS.has(p.kind) && p.part !== controller);
    const named = direct[0] || signalOthers[0];
    const distinctParts = [...new Set(signalOthers.map((p) => p.part))];
    let base;
    if (group === 'i2c' && distinctParts.length > 1) {
      base = `PIN_I2C_${kinds.has('i2c_sda') ? 'SDA' : 'SCL'}`;
    } else {
      base = `PIN_${cIdent(named.part)}_${cIdent(named.name)}`;
    }
    let symbol = base;
    for (let i = 2; used.has(symbol); i++) symbol = `${base}_${i}`;
    used.add(symbol);
    const value = pinNumber(pin);
    const wireObjs = model.wires.filter((w) => net.wires.includes(w.id));
    const purpose = wireObjs.map((w) => w.purpose || w.label).filter(Boolean)[0] || '';
    entries.push({
      symbol, value, controllerPin: pin.name, pinKey: pin.key, group, role,
      others: signalOthers.map((p) => p.key), otherPins: signalOthers, wires: net.wires.slice(),
      comment: `${pin.key} -> ${signalOthers.map((p) => p.key).join(', ')}${net.wires.length ? ` (wire ${net.wires.join(', ')})` : ''}${purpose ? `: ${purpose}` : ''}`,
    });
  }
  return { controller, entries };
}

const GROUP_ORDER = ['i2c', 'uart', 'spi', 'pwm', 'analog', 'digital'];
const GROUP_TITLES = { i2c: 'I2C bus', uart: 'UART', spi: 'SPI', pwm: 'PWM outputs', analog: 'Analog inputs', digital: 'Digital I/O' };

/**
 * pins.h generated from the wiring map.
 * @param {{controller?:string, style?:'define'|'constexpr'}} [opts]
 */
export function pinsHeader(project, library, opts = {}) {
  const { controller, entries } = controllerPinTable(project, library, opts);
  const { model } = modelOf(project, library);
  const cpart = model.parts.get(controller);
  const style = opts.style === 'constexpr' ? 'constexpr' : 'define';
  const guard = 'WIREMAP_PINS_H';
  const lines = [
    '// pins.h - generated from the Wiremap wiring map. DO NOT EDIT BY HAND.',
    '// Change the wiring in the project file, then regenerate with `wiremap export pins-h`.',
    `// Project: ${oneLine(project?.meta?.name || 'unnamed')}`,
    `// Controller: ${oneLine(controller)} (${oneLine(cpart.name || cpart.libraryId || '')})`,
    '',
    `#ifndef ${guard}`,
    `#define ${guard}`,
    '',
  ];
  if (style === 'constexpr') lines.push('#include <stdint.h>', '');
  const width = Math.max(0, ...entries.map((e) => e.symbol.length));
  for (const g of GROUP_ORDER) {
    const list = entries.filter((e) => e.group === g).sort((a, b) => a.symbol.localeCompare(b.symbol));
    if (!list.length) continue;
    lines.push(`// ${GROUP_TITLES[g]}`);
    for (const e of list) {
      lines.push(`// ${oneLine(e.comment)}`);
      if (e.value === null) {
        lines.push(`// ${e.symbol}: controller pin "${oneLine(e.controllerPin)}" has no GPIO number; set it by hand`);
      } else if (style === 'constexpr') {
        lines.push(`constexpr uint8_t ${e.symbol} = ${e.value};`);
      } else {
        lines.push(`#define ${e.symbol.padEnd(width)} ${e.value}`);
      }
    }
    lines.push('');
  }
  if (!entries.length) lines.push('// No signal wires on the controller yet.', '');
  lines.push(`#endif  // ${guard}`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CSV

/** One RFC 4180 field. Strings that a spreadsheet would run as a formula get a leading quote. */
export function csvField(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(fields) {
  return fields.map(csvField).join(',');
}

const DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, PC: 1.2, PA: 1.14, NYLON: 1.14 };

/**
 * Filament grams for a print: explicit `filament_g`/`grams`, else a rough
 * estimate from the bounding box (shell + infill share), marked as estimate.
 */
export function printFilament(print) {
  const qty = Number(print.qty) > 0 ? Number(print.qty) : 1;
  const explicit = print.filament_g ?? print.grams ?? print.estimate?.filament_g;
  if (typeof explicit === 'number') return { grams: explicit * qty, estimate: false };
  if (!Array.isArray(print.size) || print.size.length !== 3) return { grams: null, estimate: true };
  const vol = print.size.reduce((a, b) => a * Number(b || 0), 1) / 1000; // cm^3
  const infill = Number(print.settings?.infill ?? 20) / 100;
  const density = DENSITY[String(print.material || 'PLA').toUpperCase()] || 1.24;
  // Typical printed parts fill ~40% of their bounding box; walls ~30% of that volume.
  const solid = vol * 0.4 * (0.3 + 0.7 * infill);
  return { grams: Math.round(solid * density * qty), estimate: true };
}

function partName(part, def) {
  return part?.bom?.name || def?.name || part?.name || part?.library || part?.id;
}

function optionsText(options) {
  if (!Array.isArray(options)) return '';
  return options.map((o) => `${o.tier || 'option'}: ${o.name || ''}${o.why ? ` (${o.why})` : ''}${o.price !== undefined ? ` [${o.price}${o.currency ? ' ' + o.currency : ''}]` : ''}`).join('; ');
}

export const BOM_COLUMNS = ['type', 'id', 'name', 'qty', 'have', 'why', 'price', 'currency', 'link', 'checked', 'options'];

/** Rows of the BOM (objects), shared by CSV, HTML and the shopping list. */
export function bomRows(project, library) {
  const lib = library || {};
  const rows = [];
  for (const p of project.parts || []) {
    if (!p || !p.id) continue;
    const def = p.library ? lib[p.library] : p;
    const b = p.bom || {};
    rows.push({
      type: 'part', id: p.id, name: partName(p, def), qty: p.qty ?? 1, have: Boolean(p.have),
      why: b.why || def?.description || '', price: b.price, currency: b.currency, link: b.link,
      checked: b.checked, options: optionsText(b.options), optionsList: b.options || [],
      inferred: Boolean(p.inferred), verify: Boolean(p.verify),
    });
  }
  for (const f of project.fasteners || []) {
    if (!f) continue;
    rows.push({ type: 'fastener', id: f.id, name: f.name || f.id, qty: f.qty ?? 1, have: Boolean(f.have),
      why: f.why || f.note || '', price: f.price, currency: f.currency, link: f.link, checked: f.checked, options: '', optionsList: [] });
  }
  const byMat = new Map();
  for (const pr of project.prints || []) {
    if (!pr) continue;
    const mat = String(pr.material || project.printer?.material || 'PLA');
    const f = printFilament(pr);
    const cur = byMat.get(mat) || { grams: 0, estimate: false, prints: [], unknown: 0 };
    if (f.grams === null) cur.unknown++;
    else cur.grams += f.grams;
    cur.estimate = cur.estimate || f.estimate;
    cur.prints.push(pr.id || pr.name);
    byMat.set(mat, cur);
  }
  for (const [mat, f] of byMat) {
    const why = `${f.estimate ? 'Rough estimate' : 'From slicer weights'} for ${f.prints.length} print(s): ${f.prints.join(', ')}`
      + (f.unknown ? `; ${f.unknown} print(s) without size or weight not counted` : '');
    rows.push({ type: 'filament', id: `filament-${mat.toLowerCase()}`, name: `${mat} filament (g)`, qty: f.grams,
      have: false, why, price: undefined, currency: undefined, link: undefined, checked: undefined, options: '', optionsList: [] });
  }
  return rows;
}

/** BOM / cart CSV (RFC 4180, CRLF line ends). */
export function bomCsv(project, library) {
  const rows = bomRows(project, library);
  const out = [csvRow(BOM_COLUMNS)];
  for (const r of rows) out.push(csvRow(BOM_COLUMNS.map((c) => r[c])));
  return out.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// WireViz

const WIREVIZ_COLORS = {
  black: 'BK', white: 'WH', gray: 'GY', grey: 'GY', pink: 'PK', red: 'RD', orange: 'OG', yellow: 'YE',
  olive: 'OL', green: 'GN', turquoise: 'TQ', 'light blue': 'LB', lightblue: 'LB', blue: 'BU', violet: 'VT',
  purple: 'VT', brown: 'BN', beige: 'BG', ivory: 'IV', silver: 'SL', copper: 'CU', tin: 'SN', gold: 'GD',
};

/** YAML scalar: always double-quoted JSON string (valid YAML 1.2). */
function y(s) {
  return JSON.stringify(String(s ?? ''));
}

/** WireViz harness YAML (connectors, cables, connections). */
export function wirevizYaml(project, library) {
  const { model } = modelOf(project, library);
  const usedParts = new Set();
  const wires = model.wires.filter((w) => w.valid);
  for (const w of wires) {
    usedParts.add(w.fromKey.split('.')[0]);
    usedParts.add(w.toKey.split('.')[0]);
  }
  const lines = [
    `# WireViz harness generated by Wiremap from ${oneLine(project?.meta?.name || 'project')}.`,
    '# Render with: wireviz wiring.yml',
    'connectors:',
  ];
  const pinIndex = new Map();
  for (const part of model.partList) {
    if (!usedParts.has(part.id)) continue;
    lines.push(`  ${y(part.id)}:`);
    lines.push(`    type: ${y(part.name || part.libraryId || part.id)}`);
    if (part.libraryId) lines.push(`    subtype: ${y(part.libraryId)}`);
    lines.push(`    pinlabels: [${part.pins.map((p) => y(p.label || p.name)).join(', ')}]`);
    part.pins.forEach((p, i) => pinIndex.set(p.key, i + 1));
  }
  if (!usedParts.size) lines[lines.length - 1] = 'connectors: {}';
  lines.push(wires.length ? 'cables:' : 'cables: {}');
  for (const w of wires) {
    lines.push(`  ${y(w.id)}:`);
    lines.push('    wirecount: 1');
    const code = w.color ? WIREVIZ_COLORS[String(w.color).toLowerCase()] : null;
    if (code) lines.push(`    colors: [${code}]`);
    if (typeof w.gauge === 'number') lines.push(`    gauge: ${y(`${w.gauge} AWG`)}`);
    if (typeof w.length_mm === 'number') lines.push(`    length: ${Number((w.length_mm / 1000).toFixed(4))}`);
    const note = [w.label, w.purpose].filter(Boolean).join(': ');
    if (note) lines.push(`    notes: ${y(oneLine(note))}`);
  }
  lines.push(wires.length ? 'connections:' : 'connections: []');
  for (const w of wires) {
    const a = w.fromKey.split('.')[0];
    const b = w.toKey.split('.')[0];
    lines.push('  -');
    lines.push(`    - ${y(a)}: [${pinIndex.get(w.fromKey)}]`);
    lines.push(`    - ${y(w.id)}: [1]`);
    lines.push(`    - ${y(b)}: [${pinIndex.get(w.toKey)}]`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// KiCad netlist

function sx(s) {
  return `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

function refPrefix(def) {
  switch (def.category) {
    case 'actuator': return 'M';
    case 'battery': return 'BT';
    case 'power': return 'PS';
    case 'protection':
      return def.protection === 'fuse' ? 'F' : def.protection === 'switch' ? 'SW' : def.protection === 'diode' ? 'D' : 'U';
    case 'passive': return 'X';
    default: return 'U';
  }
}

/**
 * KiCad S-expression netlist (format version "E", KiCad 6+). A hand-off for
 * someone who wants to draw a PCB in KiCad: footprints are left empty and
 * pin numbers are the Wiremap pin names. Wiremap does no PCB layout.
 * @param {{date?:string, source?:string}} [opts]
 */
export function kicadNetlist(project, library, opts = {}) {
  const { model, nets } = modelOf(project, library);
  const counters = {};
  const refs = new Map();
  for (const part of model.partList) {
    const pre = refPrefix(part);
    counters[pre] = (counters[pre] || 0) + 1;
    refs.set(part.id, `${pre}${counters[pre]}`);
  }
  const out = [];
  out.push('(export (version "E")');
  out.push(`  (design (source ${sx(opts.source || (project?.meta?.name || 'wiremap project'))}) (date ${sx(opts.date || '')}) (tool "Wiremap")`);
  out.push(`    (comment (number "1") (value "Generated from the Wiremap wiring map; pin numbers are Wiremap pin names. No footprints: assign them in KiCad.")))`);
  out.push('  (components');
  for (const part of model.partList) {
    out.push(`    (comp (ref ${sx(refs.get(part.id))})`);
    out.push(`      (value ${sx(part.name || part.libraryId || part.id)})`);
    out.push('      (footprint "")');
    out.push(`      (libsource (lib "wiremap") (part ${sx(part.libraryId || part.id)}) (description ${sx(part.description || '')}))`);
    out.push(`      (property (name "wiremap_id") (value ${sx(part.id)})))`);
  }
  out.push('  )');
  out.push('  (nets');
  const usedNames = new Set();
  let code = 0;
  for (const net of kicadNets(nets)) {
    code++;
    let name = net.name || net.id;
    if (usedNames.has(name)) name = `${name}_${code}`;
    usedNames.add(name);
    out.push(`    (net (code ${sx(code)}) (name ${sx(name)})`);
    for (const key of net.pins) {
      const pin = nets.pinOf(key);
      const i = key.indexOf('.');
      const ref = refs.get(key.slice(0, i));
      out.push(`      (node (ref ${sx(ref)}) (pin ${sx(pin.name)}) (pinfunction ${sx(pin.label || pin.name)}) (pintype ${sx(kicadPinType(pin.kind))}))`);
    }
    out[out.length - 1] += ')';
  }
  out.push('  )');
  out.push(')');
  return out.join('\n') + '\n';
}

/** Nets that make it into the KiCad netlist: those joining at least two pins. */
export function kicadNets(nets) {
  return nets.nets.filter((n) => n.pins.length >= 2);
}

function kicadPinType(kind) {
  switch (kind) {
    case 'power_in': return 'power_in';
    case 'power_out': return 'power_out';
    case 'ground': return 'power_in';
    case 'power_rail': case 'passive': case 'motor': return 'passive';
    case 'nc': return 'no_connect';
    default: return 'bidirectional';
  }
}

// ---------------------------------------------------------------------------
// HTML build guide

/** Escape text for HTML element content and attribute values. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]);
}

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
}

const GUIDE_CSS = `
:root{--bg:#fff;--fg:#1c2024;--muted:#60646c;--line:#e0e1e6;--err:#ce2c31;--warn:#ab6400;--card:#f9f9fb}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#edeef0;--muted:#b0b4ba;--line:#2e3135;--err:#ff9592;--warn:#ffca16;--card:#18191b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:28px;margin:0 0 4px}h2{margin-top:32px;border-bottom:1px solid var(--line);padding-bottom:4px}
.muted{color:var(--muted)}table{border-collapse:collapse;width:100%;margin:8px 0;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--card)}
.step{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
.warn{color:var(--warn)}.err{color:var(--err)}.sw{display:inline-block;width:10px;height:10px;border-radius:50%;border:1px solid var(--line);margin-right:4px}
.phase{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
@media print{.step{break-inside:avoid}}
`;

function wireTable(model, wireIds) {
  const wires = model.wires.filter((w) => wireIds.includes(w.id));
  if (!wires.length) return '';
  const rows = wires.map((w) => `<tr><td>${escapeHtml(w.id)}</td><td>${escapeHtml(w.from)}</td><td>${escapeHtml(w.to)}</td>`
    + `<td>${w.color ? `<span class="sw" style="background:${escapeHtml(cssColor(w.color))}"></span>` : ''}${escapeHtml(w.color || '')}</td>`
    + `<td>${escapeHtml(w.gauge ?? '')}</td><td>${escapeHtml(w.length_mm ?? '')}</td><td>${escapeHtml(w.purpose || w.label || '')}</td></tr>`).join('\n');
  return `<table><thead><tr><th>Wire</th><th>From</th><th>To</th><th>Color</th><th>AWG</th><th>Length (mm)</th><th>Purpose</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
}

function cssColor(c) {
  return /^[a-z]{3,12}$/i.test(String(c)) || /^#[0-9a-f]{3,8}$/i.test(String(c)) ? String(c) : 'transparent';
}

/**
 * Single self-contained static HTML build guide. All user text is escaped.
 * @param {any} [checkResult] optional result of checkProject()
 */
export function buildGuideHtml(project, library, checkResult) {
  const { model } = modelOf(project, library);
  const meta = project.meta || {};
  const title = meta.name || 'Wiremap build guide';
  const parts = [];
  parts.push('<!doctype html><html lang="en"><head><meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`);
  parts.push(`<title>${escapeHtml(title)}</title><style>${GUIDE_CSS}</style></head><body><main>`);
  parts.push(`<h1>${escapeHtml(title)}</h1>`);
  if (meta.description) parts.push(`<p>${escapeHtml(meta.description)}</p>`);
  parts.push('<p class="muted">Build guide generated by Wiremap from the project file. The project file is the source of truth.</p>');

  if (checkResult) {
    const issues = checkResult.issues || [];
    const errs = issues.filter((i) => i.level === 'error');
    const warns = issues.filter((i) => i.level === 'warning');
    parts.push('<h2>Electrical check</h2>');
    parts.push(`<p class="${errs.length ? 'err' : ''}">${errs.length} error(s), ${warns.length} warning(s).</p>`);
    if (errs.length || warns.length) {
      parts.push('<ul>' + [...errs, ...warns].map((i) => `<li class="${i.level === 'error' ? 'err' : 'warn'}">${escapeHtml(i.message)}${i.fix ? ` <span class="muted">Fix: ${escapeHtml(i.fix)}</span>` : ''}</li>`).join('') + '</ul>');
    }
    if (Array.isArray(checkResult.notChecked) && checkResult.notChecked.length) {
      parts.push('<p class="muted">Not checked: ' + checkResult.notChecked.map((x) => escapeHtml(typeof x === 'string' ? x : x.message || JSON.stringify(x))).join('; ') + '</p>');
    }
  }

  const rows = bomRows(project, library);
  parts.push('<h2>Bill of materials</h2>');
  parts.push('<table><thead><tr><th>Item</th><th>Qty</th><th>Have</th><th>Why</th><th>Price</th><th>Link</th></tr></thead><tbody>');
  for (const r of rows) {
    const url = safeUrl(r.link);
    const flag = r.inferred ? ' <span class="warn">(inferred, confirm)</span>' : r.verify ? ' <span class="warn">(verify)</span>' : '';
    parts.push(`<tr><td>${escapeHtml(r.name)}${flag}</td><td>${escapeHtml(r.qty ?? '')}</td><td>${r.have ? 'yes' : ''}</td><td>${escapeHtml(r.why)}</td>`
      + `<td>${r.price !== undefined ? escapeHtml(`${r.price} ${r.currency || ''}`.trim()) : ''}${r.checked ? `<br><span class="muted">checked ${escapeHtml(r.checked)}</span>` : ''}</td>`
      + `<td>${url ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">store</a>` : ''}</td></tr>`);
  }
  parts.push('</tbody></table>');

  const steps = project.steps || [];
  if (steps.length) {
    parts.push('<h2>Steps</h2>');
    steps.forEach((s, i) => {
      parts.push('<section class="step">');
      parts.push(`<div class="phase">${escapeHtml(s.phase || '')}</div>`);
      parts.push(`<h3>${i + 1}. ${escapeHtml(s.title || s.id || 'Step')}${s.done ? ' <span class="muted">(done)</span>' : ''}</h3>`);
      if (s.text) parts.push(`<p>${escapeHtml(s.text)}</p>`);
      if (s.why) parts.push(`<p class="muted">Why: ${escapeHtml(s.why)}</p>`);
      const warnings = [...(Array.isArray(s.warnings) ? s.warnings : []), ...(s.warning ? [s.warning] : [])];
      if (warnings.length) parts.push('<ul>' + warnings.map((w) => `<li class="warn">Warning: ${escapeHtml(w)}</li>`).join('') + '</ul>');
      if (Array.isArray(s.tools) && s.tools.length) parts.push(`<p>Tools: ${s.tools.map(escapeHtml).join(', ')}</p>`);
      if (Array.isArray(s.wires) && s.wires.length) parts.push(wireTable(model, s.wires));
      parts.push('</section>');
    });
  }
  const allWires = model.wires.map((w) => w.id);
  if (allWires.length) {
    parts.push('<h2>All wires</h2>');
    parts.push(wireTable(model, allWires));
  }
  parts.push('</main></body></html>\n');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Shopping checklist

function mdText(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>|])/g, '\\$1');
}

/** Markdown shopping checklist; parts you already have are ticked. Library is optional (for names). */
export function shoppingChecklist(project, library) {
  const rows = bomRows(project, library || {});
  const out = [`# Shopping list: ${mdText(project?.meta?.name || 'project')}`, ''];
  const toBuy = rows.filter((r) => !r.have);
  const total = {};
  for (const r of toBuy) {
    if (typeof r.price === 'number') {
      const c = r.currency || '';
      total[c] = (total[c] || 0) + r.price * (typeof r.qty === 'number' ? r.qty : 1);
    }
  }
  const sections = [['part', 'Parts'], ['fastener', 'Fasteners'], ['filament', 'Filament']];
  for (const [type, heading] of sections) {
    const list = rows.filter((r) => r.type === type);
    if (!list.length) continue;
    out.push(`## ${heading}`, '');
    for (const r of list) {
      const qty = type === 'filament' ? `${r.qty ?? '?'} g` : `${r.qty ?? 1}x`;
      let line = `- [${r.have ? 'x' : ' '}] ${qty} ${mdText(r.name)}`;
      if (typeof r.price === 'number') line += ` - ${r.price}${r.currency ? ' ' + mdText(r.currency) : ''}`;
      const url = safeUrl(r.link);
      if (url) line += ` - [store](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)`;
      if (r.checked) line += ` (price checked ${mdText(r.checked)})`;
      if (r.inferred) line += ' (inferred, confirm)';
      out.push(line);
      for (const o of r.optionsList || []) out.push(`  - ${mdText(o.tier || 'option')}: ${mdText(o.name || '')}${o.why ? ` - ${mdText(o.why)}` : ''}`);
    }
    out.push('');
  }
  const totals = Object.entries(total).map(([c, v]) => `${Number(v.toFixed(2))}${c ? ' ' + c : ''}`);
  if (totals.length) out.push(`Estimated total for items still to buy: ${totals.join(' + ')}`, '');
  return out.join('\n');
}
