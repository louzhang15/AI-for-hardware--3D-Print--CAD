// @ts-check
// Breadboard layout: places parts in exact holes of a solderless breadboard,
// assigns the power rails, generates every jumper (two named holes, role
// color, length) and checks breadboard-specific rules (strip conflicts,
// chips not across the gap, modules too wide, split rails, overlaps, room).
// Pure ES module with no dependencies: runs in Node and in the browser.
//
// Board geometry (0.1" = 2.54 mm units):
//   rows a..e are y = 0..4 (top half), the centre gap is 0.3", rows f..j are
//   y = 7..11 (bottom half). Each column's a-e is one 5-hole strip, f-j another.
//   Rails: top- y=-3, top+ y=-2, bottom+ y=13, bottom- y=14, one hole per column.
//   Holes are named "e8"; rail holes "top+:8"; on a second board "B2/e8".

import { resolveProject } from './model.js';
import { buildNets, netRole, ROLE_COLORS, fmtV } from './nets.js';

export const PITCH_MM = 2.54;

export const BOARD_MODELS = {
  'half-400': { id: 'half-400', name: 'half-size 400-point breadboard', columns: 30, splittable: false, points: 400 },
  'full-830': { id: 'full-830', name: 'full-size 830-point breadboard', columns: 63, splittable: true, points: 830 },
};

export const ROW_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
/** Row letter -> y position in 0.1" units. */
export const ROW_Y = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 7, g: 8, h: 9, i: 10, j: 11 };
const Y_ROW = Object.fromEntries(Object.entries(ROW_Y).map(([k, v]) => [v, k]));
export const RAIL_NAMES = ['top+', 'top-', 'bottom+', 'bottom-'];
export const RAIL_Y = { 'top-': -3, 'top+': -2, 'bottom+': 13, 'bottom-': 14 };
const TOP_YS = [0, 1, 2, 3, 4];
const BOTTOM_YS = [7, 8, 9, 10, 11];

/** Pre-cut jumper kit lengths (mm): 0.1" .. 1.0", then 2" .. 5". */
export const PRECUT_MM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50].map((n) => round2(n * PITCH_MM));

function round2(x) { return Math.round(x * 100) / 100; }

/**
 * Name a hole. `row` is a row letter ('a'..'j'), a y position in 0.1" units
 * (a=0..e=4, f=7..j=11) or a rail name ('top+', ...). `board` is optional:
 * 'B2' or a 1-based number; board 1 gets no prefix.
 * @param {string|number} row @param {number} col @param {string|number} [board]
 */
export function holeName(row, col, board) {
  let r = row;
  if (typeof r === 'number') r = Y_ROW[r];
  const bi = typeof board === 'string' ? Number(board.replace(/^B/i, '')) : (board || 1);
  const prefix = bi > 1 ? `B${bi}/` : '';
  if (typeof r !== 'string') return null;
  if (RAIL_NAMES.includes(r)) return `${prefix}${r}:${col}`;
  if (!(r in ROW_Y)) return null;
  return `${prefix}${r}${col}`;
}

/**
 * Parse "j8", "bottom+:8", "B2/e8". Returns
 * { board: 'B1', boardIndex: 0, rail: string|null, row: string|null, y, col } or null.
 * @param {string} s
 */
export function parseHole(s) {
  if (typeof s !== 'string') return null;
  const m = /^(?:B(\d+)\/)?(?:(top|bottom)([+-]):(\d+)|([a-j])(\d+))$/i.exec(s.trim());
  if (!m) return null;
  const bi = m[1] ? Number(m[1]) - 1 : 0;
  if (bi < 0) return null;
  if (m[2]) {
    const rail = `${m[2].toLowerCase()}${m[3]}`;
    return { board: `B${bi + 1}`, boardIndex: bi, rail, row: null, y: RAIL_Y[rail], col: Number(m[4]) };
  }
  const row = m[5].toLowerCase();
  return { board: `B${bi + 1}`, boardIndex: bi, rail: null, row, y: ROW_Y[row], col: Number(m[6]) };
}

// ---------------------------------------------------------------------------
// internal hole helpers: {b, y, col, rail?}

function hName(h) { return holeName(h.rail || h.y, h.col, h.b + 1); }
function halfOf(y) { return y <= 4 ? 'top' : 'bottom'; }
function stripKey(h) {
  if (h.rail) return `${h.b}:rail:${h.rail}`; // refined for split rails by caller
  return `${h.b}:${h.col}:${halfOf(h.y)}`;
}
function rot(dx, dy, r) {
  switch (((r % 360) + 360) % 360) {
    case 90: return [-dy, dx];
    case 180: return [-dx, -dy];
    case 270: return [dy, -dx];
    default: return [dx, dy];
  }
}
function lengthMm(a, b, boards) {
  const xa = boards[a.b].x0 + a.col;
  const xb = boards[b.b].x0 + b.col;
  const units = Math.abs(xa - xb) + Math.abs(a.y - b.y);
  return round2(Math.ceil(units - 1e-9) * PITCH_MM);
}
function precut(len) {
  if (len == null) return null;
  return PRECUT_MM.find((p) => p >= len - 1e-9) ?? null;
}
function shortName(def) {
  let n = (def.label || def.name || def.id || '').toString();
  n = n.split(/\s+\(|\s+-\s+|,/)[0].trim();
  if (n.length > 28) n = def.id;
  return n || def.id;
}
function railLabel(r) {
  const [side, pol] = [r.startsWith('top') ? 'top' : 'bottom', r.endsWith('+') ? '+' : '-'];
  return `${side} ${pol} rail`;
}

/**
 * Lay out a project on one or more breadboards.
 * @param {any} project
 * @param {Record<string, any>} [library]
 * @param {{model?: string|string[], rails?: Record<string, any>, split?: boolean, startCol?: number, gap?: number}} [options]
 */
export function layoutBreadboard(project, library = {}, options = {}) {
  /** @type {{rule:string, level:'error'|'warning'|'info', message:string, parts:string[], wires:string[], holes:string[]}[]} */
  const issues = [];
  const add = (level, rule, message, extra = {}) => {
    issues.push({ rule, level, message, parts: extra.parts || [], wires: extra.wires || [], holes: extra.holes || [] });
  };

  const model = resolveProject(project, library);
  for (const p of model.problems) {
    if (p.level === 'error') add('error', p.rule || 'schema', p.message, { parts: p.parts, wires: p.wires });
  }
  const { netOfPin, pinOf } = buildNets(model);
  const bbCfg = (project && project.breadboard) || {};

  // ---- boards
  const modelSpec = options.model ?? bbCfg.model ?? 'full-830';
  const modelList = Array.isArray(modelSpec) ? modelSpec : [modelSpec];
  const railsCfgRaw = options.rails ?? bbCfg.rails ?? {};
  const splitOpt = Boolean(options.split ?? bbCfg.split ?? (railsCfgRaw && railsCfgRaw.split) ?? false);
  let x0 = 0;
  const boards = modelList.map((m, i) => {
    let spec = BOARD_MODELS[m];
    if (!spec) {
      add('error', 'unknown-board', `Unknown breadboard model "${m}" (use half-400 or full-830); using full-830`);
      spec = BOARD_MODELS['full-830'];
    }
    const b = { id: `B${i + 1}`, model: spec.id, columns: spec.columns, rows: ROW_LETTERS.slice(), split: Boolean(spec.splittable && splitOpt), x0 };
    x0 += spec.columns + 4;
    return b;
  });
  const multi = boards.length > 1;
  const startCol = options.startCol ?? 3;
  const gap = options.gap ?? 2;

  // ---- part classification
  /** @type {Map<string, any>} */
  const infos = new Map();
  const offboard = [];
  for (const def of model.partList) {
    const bb = def.breadboard || null;
    let fit = bb && bb.fit;
    if (def.bb && (def.bb === 'offboard' || def.bb.offboard)) fit = 'offboard';
    if (!fit) {
      fit = 'offboard';
      if (!['actuator', 'power', 'battery', 'protection'].includes(def.category)) {
        add('info', 'no-breadboard-data', `${shortName(def)} (${def.id}) has no breadboard data; kept off the board and wired with jumpers`, { parts: [def.id] });
      }
    }
    if (fit === 'offboard') { offboard.push(def.id); continue; }
    let rows;
    if (fit === 'straddle') {
      rows = bb.rows;
      if (!Array.isArray(rows) || rows.length !== 2) {
        const names = def.pins.filter((p) => p.kind !== 'nc' || true).map((p) => p.name);
        const half = Math.ceil(names.length / 2);
        rows = [names.slice(0, half), names.slice(half).reverse()];
      }
    } else if (fit === 'single') {
      const r = (Array.isArray(bb.rows) && bb.rows[0]) || bb.pins || def.pins.map((p) => p.name);
      rows = [r];
    } else {
      add('error', 'schema', `${def.id}: unknown breadboard fit "${fit}" (straddle | single | offboard)`, { parts: [def.id] });
      offboard.push(def.id);
      continue;
    }
    let bad = false;
    for (const row of rows) {
      for (const n of row) {
        if (n == null || n === '') continue;
        if (!def.pinMap.has(n)) { add('error', 'schema', `${def.id}: breadboard row names pin "${n}", which the part does not have`, { parts: [def.id] }); bad = true; }
      }
    }
    if (bad) { offboard.push(def.id); continue; }
    const spacing = fit === 'straddle' ? Number(bb.row_spacing ?? 3) : 0;
    const bodyUnits = fit === 'straddle' && typeof bb.body_width_mm === 'number' ? bb.body_width_mm / PITCH_MM : (fit === 'straddle' ? spacing + 0.6 : 0);
    infos.set(def.id, { id: def.id, def, fit, rows, spacing, bodyUnits, width: Math.max(...rows.map((r) => r.length)), name: shortName(def) });
  }

  // ---- placement machinery
  /** hole key -> part id (pins and module bodies) */
  const claims = new Map();
  /** hole key -> true for anything that occupies a hole (pins, bodies, jumper ends) */
  const used = new Set();
  /** pinKey -> hole */
  const pinHole = new Map();
  const placements = {};
  /** per board extents [{min, max, part}] */
  const extents = boards.map(() => []);
  const unplaced = [];
  const bridging = new Set();

  /** Compute pin holes and body holes for a placement. */
  function geometry(info, b, y0, c0, r) {
    const pins = [];
    info.rows.forEach((row, ri) => {
      row.forEach((name, i) => {
        if (name == null || name === '') return;
        const [dx, dy] = rot(i, ri * info.spacing, r);
        pins.push({ name, ri, hole: { b, y: y0 + dy, col: c0 + dx } });
      });
    });
    const body = [];
    const nr = ((r % 360) + 360) % 360;
    if (info.fit === 'straddle' && (nr === 0 || nr === 180)) {
      const ys = pins.map((p) => p.hole.y);
      const centre = (Math.min(...ys) + Math.max(...ys)) / 2;
      const half = info.bodyUnits / 2;
      const cols = pins.map((p) => p.hole.col);
      const pinYs = new Set(ys);
      for (const y of [...TOP_YS, ...BOTTOM_YS]) {
        if (pinYs.has(y)) continue;
        if (Math.abs(y - centre) < half - 1e-9) {
          for (let c = Math.min(...cols); c <= Math.max(...cols); c++) body.push({ b, y, col: c });
        }
      }
    }
    return { pins, body };
  }

  function validHole(h) {
    const bd = boards[h.b];
    return bd && h.col >= 1 && h.col <= bd.columns && Y_ROW[h.y] !== undefined;
  }

  /** free holes per side for a straddle placement (per column, uniform) */
  function freeCount(info, geom) {
    const bodyKeys = new Set(geom.body.map((h) => `${h.y}`));
    const pinYs = new Set(geom.pins.map((p) => p.hole.y));
    const res = {};
    for (const [side, ys] of [['top', TOP_YS], ['bottom', BOTTOM_YS]]) {
      const pinY = ys.find((y) => pinYs.has(y));
      if (pinY === undefined) { res[side] = null; continue; }
      res[side] = ys.filter((y) => !pinYs.has(y) && !bodyKeys.has(`${y}`)).length;
    }
    return res;
  }

  function commit(info, b, y0, c0, r, auto) {
    const geom = geometry(info, b, y0, c0, r);
    const holes = {};
    const holeList = [];
    for (const p of geom.pins) {
      const key = hName(p.hole);
      holes[p.name] = key;
      holeList.push(key);
      pinHole.set(`${info.id}.${p.name}`, p.hole);
    }
    const overlapWith = new Set();
    const overlapHoles = [];
    for (const h of [...geom.pins.map((p) => p.hole), ...geom.body]) {
      const key = hName(h);
      const other = claims.get(key);
      if (other && other !== info.id) { overlapWith.add(other); overlapHoles.push(key); }
      else claims.set(key, info.id);
      used.add(key);
    }
    if (overlapWith.size) {
      add('error', 'overlap', `${info.name} (${info.id}) overlaps ${[...overlapWith].join(', ')} at ${overlapHoles.slice(0, 6).join(', ')}${overlapHoles.length > 6 ? '…' : ''}`, { parts: [info.id, ...overlapWith], holes: overlapHoles });
    }
    const cols = geom.pins.map((p) => p.hole.col);
    extents[b].push({ min: Math.min(...cols), max: Math.max(...cols), part: info.id });
    const nr = ((r % 360) + 360) % 360;
    const rowsUsed = [...new Set(geom.pins.map((p) => Y_ROW[p.hole.y]).filter(Boolean))];
    const pl = {
      pin1: holeName(y0, c0, b + 1), rot: nr, holes, board: boards[b].id, fit: info.fit,
      rows: rowsUsed, auto, notch: nr === 180 ? 'right' : nr === 0 ? 'left' : nr === 90 ? 'up' : 'down',
    };
    if (info.fit === 'straddle') {
      const fc = freeCount(info, geom);
      pl.free = fc;
      const ys = geom.pins.map((p) => p.hole.y);
      const halves = new Set(ys.map(halfOf));
      if (halves.size < 2 || !(nr === 0 || nr === 180)) {
        const msg = halves.size < 2
          ? `${info.name} (${info.id}) does not straddle the centre gap: both pin rows are in the ${[...halves][0]} half, so it bridges the strip: every pin pair shorted. Put one row in a-e and the other in f-j.`
          : `${info.name} (${info.id}) is rotated ${nr}°: its pins run along a strip, so it bridges the strip: every pin pair shorted. Use rot 0 or 180 across the centre gap.`;
        add('error', 'not-across-gap', msg, { parts: [info.id], holes: holeList });
        bridging.add(info.id);
      } else {
        for (const side of ['top', 'bottom']) {
          const pinY = ys.find((y) => halfOf(y) === side);
          if (fc[side] === 0) {
            add('warning', 'too-wide', `${info.name} (${info.id}) is too wide: leaves no free hole beside row ${Y_ROW[pinY]}; use two breadboards side by side (or wire that side with male-female jumpers)`, { parts: [info.id], holes: holeList });
          } else if (fc[side] === 1) {
            add('info', 'tight-fit', `${info.name} (${info.id}) leaves only one free hole beside row ${Y_ROW[pinY]}: one jumper per pin on that side`, { parts: [info.id] });
          }
        }
      }
    }
    placements[info.id] = pl;
    return pl;
  }

  // 1. user placements
  const autoQueue = [];
  for (const info of infos.values()) {
    const ub = info.def.bb;
    if (!ub || typeof ub !== 'object' || !ub.pin1) { autoQueue.push(info); continue; }
    const ph = parseHole(String(ub.pin1));
    let b = ph ? ph.boardIndex : 0;
    if (ub.board != null) b = typeof ub.board === 'number' ? ub.board - 1 : Number(String(ub.board).replace(/^B/i, '')) - 1;
    const r = Number(ub.rot || 0);
    if (!ph || ph.rail || !boards[b]) {
      add('error', 'off-board', `${info.name} (${info.id}): bb.pin1 "${ub.pin1}" is not a hole on the board`, { parts: [info.id] });
      unplaced.push(info.id);
      continue;
    }
    if (![0, 90, 180, 270].includes(((r % 360) + 360) % 360)) {
      add('error', 'schema', `${info.name} (${info.id}): bb.rot must be 0, 90, 180 or 270`, { parts: [info.id] });
      unplaced.push(info.id);
      continue;
    }
    const geom = geometry(info, b, ph.y, ph.col, r);
    const off = geom.pins.filter((p) => !validHole(p.hole));
    if (off.length) {
      const where = off.slice(0, 4).map((p) => `${p.name} at column ${p.hole.col}${Y_ROW[p.hole.y] ? ` row ${Y_ROW[p.hole.y]}` : ' (in the centre gap or off the edge)'}`).join(', ');
      add('error', 'off-board', `${info.name} (${info.id}) with pin 1 at ${ub.pin1} puts pins off the board: ${where}${off.length > 4 ? '…' : ''}`, { parts: [info.id] });
      unplaced.push(info.id);
      continue;
    }
    commit(info, b, ph.y, ph.col, r, false);
  }

  // 2. automatic placements, left to right
  const cursor = boards.map(() => startCol);
  for (const info of autoQueue) {
    let y0 = ROW_Y.e;
    if (info.fit === 'straddle') {
      const s = info.spacing;
      let best = null;
      for (const yt of TOP_YS) {
        const yb = yt + s;
        if (!BOTTOM_YS.includes(yb)) continue;
        const fc = freeCount(info, geometry(info, 0, yt, 1, 0));
        const mn = Math.min(fc.top ?? 0, fc.bottom ?? 0);
        const sum = (fc.top ?? 0) + (fc.bottom ?? 0);
        const centred = -Math.abs(yt + s / 2 - 5.5);
        const score = [mn, sum, centred];
        if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && (score[1] > best.score[1] || (score[1] === best.score[1] && score[2] > best.score[2])))) best = { yt, score };
      }
      if (!best) {
        add('error', 'cannot-straddle', `${info.name} (${info.id}) has a row spacing of ${s} (×2.54 mm), which cannot straddle the centre gap (needs 3 to 11)`, { parts: [info.id] });
        unplaced.push(info.id);
        continue;
      }
      y0 = best.yt;
    } else {
      const want = info.def.breadboard && info.def.breadboard.row;
      if (want && ROW_Y[want] !== undefined) y0 = ROW_Y[want];
    }
    let placed = false;
    for (let b = 0; b < boards.length && !placed; b++) {
      for (let c = Math.max(cursor[b], 1); c + info.width - 1 <= boards[b].columns; c++) {
        const lo = c - gap; const hi = c + info.width - 1 + gap;
        if (extents[b].some((e) => e.max >= lo && e.min <= hi)) continue;
        commit(info, b, y0, c, 0, true);
        cursor[b] = c + info.width + gap;
        placed = true;
        break;
      }
    }
    if (!placed) {
      const m = boards[boards.length - 1].model;
      const hint = m === 'half-400' && !multi ? 'use a full-830 board (--model full-830) or two boards side by side' : 'use two boards side by side (--model full-830,full-830) or move a module off the board';
      add('error', 'out-of-columns', `No room for ${info.name} (${info.id}, ${info.width} columns): ran out of columns on the ${boards.map((x) => x.model).join(' + ')}; ${hint}`, { parts: [info.id] });
      unplaced.push(info.id);
    }
  }

  const onBoard = new Set(Object.keys(placements));

  // ---- nets in use
  const allNets = new Map();
  for (const net of netOfPin.values()) allNets.set(net.id, net);
  const netOnBoardPins = (net) => net.pins.filter((k) => pinHole.has(k));

  // ---- rails
  /** rail -> {net, label, auto} */
  const railNet = { 'top+': null, 'top-': null, 'bottom+': null, 'bottom-': null };
  const groundNets = [...allNets.values()].filter((n) => (n.isGround || (n.grounds.length && !n.sources.length)) && n.connected);
  const bestGround = groundNets.sort((a, b) => netOnBoardPins(b).length - netOnBoardPins(a).length)[0] || null;
  const powerNets = [...allNets.values()].filter((n) => !n.isGround && !n.grounds.length && (n.isPower || n.sources.length) && n.connected);
  const netVoltage = (n) => n.voltage ?? Math.max(0, ...n.pins.map((k) => pinOf(k)?.voltage).filter((v) => typeof v === 'number'));
  const netCurrent = (n) => n.loads.reduce((s, k) => { const p = pinOf(k); return s + (p?.current_peak ?? p?.current ?? 0); }, 0);

  function resolveRailName(val, rail) {
    if (val == null || val === '') return null;
    if (typeof val === 'object' && !Array.isArray(val)) val = val.net || val.pin || val.name;
    const s = String(val).trim();
    if (netOfPin.has(s)) return netOfPin.get(s);
    const low = s.toLowerCase();
    if (/^(gnd|ground|0v|0|com|-)$/.test(low)) return bestGround;
    for (const n of allNets.values()) if (n.id === s || n.name === s) return n;
    const pinMatch = [...allNets.values()].filter((n) => n.pins.some((k) => { const p = pinOf(k); return p && (p.name.toLowerCase() === low || String(p.label).toLowerCase() === low); }));
    const pref = pinMatch.filter((n) => (rail.endsWith('-') ? groundNets.includes(n) : powerNets.includes(n)));
    if (pref.length) return pref.sort((a, b) => netOnBoardPins(b).length - netOnBoardPins(a).length)[0];
    const vm = /^(\d+(?:\.\d+)?)\s*v(?:\b|[^a-z]|$)/i.exec(s) || /^(\d+)v(\d+)$/i.exec(s);
    if (vm) {
      const v = vm[2] ? Number(`${vm[1]}.${vm[2]}`) : Number(vm[1]);
      const c = powerNets.filter((n) => Math.abs(netVoltage(n) - v) < 0.05);
      if (c.length) return c.sort((a, b) => netOnBoardPins(b).length - netOnBoardPins(a).length)[0];
    }
    const ranked = powerNets.slice().sort((a, b) => netVoltage(b) - netVoltage(a) || netCurrent(b) - netCurrent(a));
    if (/mot|servo|vm|batt|high/.test(low) && ranked.length) return ranked[0];
    if (/logic|vcc|vdd|low/.test(low) && ranked.length) return ranked[ranked.length - 1];
    if (pinMatch.length) return pinMatch[0];
    return null;
  }

  const userRails = railsCfgRaw && typeof railsCfgRaw === 'object' ? railsCfgRaw : {};
  for (const r of RAIL_NAMES) {
    const val = userRails[r];
    if (val == null || val === '') continue;
    const vals = Array.isArray(val) ? val : [val];
    const resolved = [];
    for (const v of vals) {
      const n = resolveRailName(v, r);
      if (!n) add('warning', 'rail-unresolved', `breadboard.rails["${r}"] = ${JSON.stringify(v)} does not match any net, pin or voltage in the project; the ${railLabel(r)} is left empty`);
      else if (!resolved.includes(n)) resolved.push(n);
    }
    if (resolved.length > 1) {
      add('error', 'rail-two-nets', `The ${railLabel(r)} would carry two different nets (${resolved.map((n) => n.name).join(' and ')}): they would be shorted together. Give each its own rail.`);
    }
    if (resolved.length) {
      const label = typeof vals[0] === 'object' ? (vals[0].label || vals[0].name || resolved[0].name) : String(vals[0]);
      railNet[r] = { net: resolved[0], label, auto: false };
    } else {
      railNet[r] = { net: null, label: String(vals[0]), auto: false };
    }
  }
  // auto-assign the rest
  const groundUsable = bestGround && netOnBoardPins(bestGround).length ? bestGround : null;
  for (const r of ['top-', 'bottom-']) if (!railNet[r] && groundUsable) railNet[r] = { net: groundUsable, label: 'GND', auto: true };
  const onRail = new Set(Object.values(railNet).filter((x) => x && x.net).map((x) => x.net));
  const cand = powerNets.filter((n) => netOnBoardPins(n).length && !onRail.has(n));
  const byVolt = cand.slice().sort((a, b) => netVoltage(b) - netVoltage(a) || netCurrent(b) - netCurrent(a));
  const supplyLabel = (n) => `${fmtV(netVoltage(n) || null)}`;
  if (!railNet['top+'] && byVolt.length) {
    const n = byVolt.shift();
    const motorish = n.pins.some((k) => { const p = pinOf(k); const d = model.parts.get(k.slice(0, k.indexOf('.'))); return p && p.kind === 'power_in' && d && (d.category === 'actuator' || d.pins.some((x) => x.kind === 'motor')); });
    railNet['top+'] = { net: n, label: byVolt.length ? `${supplyLabel(n)} ${motorish ? 'motor' : 'high-current'} supply` : `${supplyLabel(n)} supply`, auto: true };
  }
  if (!railNet['bottom+']) {
    const rest = byVolt.filter((n) => n !== railNet['top+']?.net);
    const powerInCount = (n) => netOnBoardPins(n).filter((k) => pinOf(k)?.kind === 'power_in').length;
    rest.sort((a, b) => powerInCount(b) - powerInCount(a) || netVoltage(a) - netVoltage(b));
    if (rest.length) railNet['bottom+'] = { net: rest[0], label: `${supplyLabel(rest[0])} logic supply`, auto: true };
    else if (railNet['top+'] && railNet['top+'].auto && railNet['top+'].net) railNet['bottom+'] = { ...railNet['top+'] };
  }
  for (const r of RAIL_NAMES) {
    const rn = railNet[r];
    if (!rn || !rn.net) continue;
    const isGnd = groundNets.includes(rn.net);
    if (r.endsWith('+') && isGnd) add('warning', 'rail-polarity', `The ${railLabel(r)} carries ground (${rn.net.name}); boards mark + rails red, so this is easy to misread`);
    if (r.endsWith('-') && !isGnd) add('warning', 'rail-polarity', `The ${railLabel(r)} carries ${rn.net.name}, not ground; - rails are usually marked blue for GND`);
  }
  const railsOfNet = (net) => RAIL_NAMES.filter((r) => railNet[r] && railNet[r].net === net);

  // ---- jumpers
  const jumpers = [];
  /** wire id -> jumper ids */
  const wireJumpers = new Map();
  /** pinKey -> jumper (pin-to-rail, once per pin) */
  const railJumperOf = new Map();
  /** strip key -> [{net, what, hole, part?}] */
  const stripUse = new Map();
  const noteStrip = (h, net, what, part) => {
    const k = stripKeyFull(h);
    if (!stripUse.has(k)) stripUse.set(k, []);
    stripUse.get(k).push({ net, what, hole: hName(h), part });
  };
  function stripKeyFull(h) {
    if (h.rail) {
      const bd = boards[h.b];
      const side = bd.split ? (h.col <= Math.floor(bd.columns / 2) ? ':L' : ':R') : '';
      return `${h.b}:rail:${h.rail}${side}`;
    }
    return stripKey(h);
  }
  for (const [k, h] of pinHole) noteStrip(h, netOfPin.get(k), k, k.split('.')[0]);

  function allocStripHole(pinH, targetY) {
    const ys = (halfOf(pinH.y) === 'top' ? TOP_YS : BOTTOM_YS).slice().sort((a, b) => Math.abs(a - targetY) - Math.abs(b - targetY));
    for (const y of ys) {
      const h = { b: pinH.b, y, col: pinH.col };
      if (!used.has(hName(h))) { used.add(hName(h)); return h; }
    }
    return null;
  }
  function allocRailHole(b, rail, col, lo = 1, hi = boards[b].columns) {
    for (let d = 0; d <= boards[b].columns; d++) {
      for (const c of d === 0 ? [col] : [col + d, col - d]) {
        if (c < lo || c > hi) continue;
        const h = { b, y: RAIL_Y[rail], col: c, rail };
        if (!used.has(hName(h))) { used.add(hName(h)); return h; }
      }
    }
    return null;
  }
  const outerY = (h) => (halfOf(h.y) === 'top' ? -10 : 20);
  function chooseRail(net, b, half) {
    const rs = railsOfNet(net);
    return rs.find((r) => r.startsWith(half)) || rs[0];
  }
  const pinDesc = (k) => {
    const [pid, pn] = [k.slice(0, k.indexOf('.')), k.slice(k.indexOf('.') + 1)];
    const p = pinOf(k);
    const info = infos.get(pid);
    const def = model.parts.get(pid);
    const nm = info ? info.name : def ? shortName(def) : pid;
    const lbl = p && p.label && p.label !== pn ? ` ${p.label}` : '';
    return `${nm} ${/^\d+$/.test(pn) ? `pin ${pn}` : pn}${lbl}`;
  };

  let jn = 0;
  function makeJumper({ a, b, net, wire, kind, pins, note, special }) {
    const role = net ? netRole(net, pinOf) : 'digital';
    const col = ROLE_COLORS[role] || ROLE_COLORS.digital;
    const isHoleA = a && typeof a === 'object';
    const isHoleB = b && typeof b === 'object';
    const from = isHoleA ? hName(a) : a;
    const to = isHoleB ? hName(b) : b;
    const len = isHoleA && isHoleB ? lengthMm(a, b, boards) : null;
    const j = {
      id: `jp${++jn}`, wire: wire || null, wires: wire ? [wire] : [], net: net ? net.id : null, net_name: net ? net.name : null,
      role, color: col.name, hex: col.hex, from, to, holes: [isHoleA ? from : null, isHoleB ? to : null].filter(Boolean),
      len_mm: len, precut_mm: precut(len), kind, pins: pins || [], note: note || '', special: special || null,
    };
    if (len != null && j.precut_mm == null) j.note = (j.note ? `${j.note}; ` : '') + 'longer than a pre-cut kit jumper: use a flexible jumper';
    if (isHoleA) noteStrip(a, net, j.id);
    if (isHoleB) noteStrip(b, net, j.id);
    jumpers.push(j);
    if (wire) { if (!wireJumpers.has(wire)) wireJumpers.set(wire, []); wireJumpers.get(wire).push(j.id); }
    return j;
  }
  const linkWire = (j, wire) => {
    if (!j.wires.includes(wire)) j.wires.push(wire);
    if (!wireJumpers.has(wire)) wireJumpers.set(wire, []);
    if (!wireJumpers.get(wire).includes(j.id)) wireJumpers.get(wire).push(j.id);
  };
  const offKind = (k) => {
    const def = model.parts.get(k.slice(0, k.indexOf('.')));
    const want = def && def.breadboard && def.breadboard.jumper;
    return want === 'male-male' || want === 'male-female' ? want : 'male-female';
  };

  const noHole = (k, w) => add('error', 'no-free-hole', `No free hole left in the strip of ${pinDesc(k)} (${hName(pinHole.get(k))}) for wire ${w.id}: the part covers the strip; use two boards side by side or move it`, { parts: [k.split('.')[0]], wires: [w.id], holes: [hName(pinHole.get(k))] });

  for (const w of model.wires) {
    if (!w.valid || w.fromKey === w.toKey) continue;
    const net = netOfPin.get(w.fromKey);
    const ends = [w.fromKey, w.toKey];
    if (railsOfNet(net).length) {
      // every endpoint connects to a rail once
      for (let i = 0; i < 2; i++) {
        const k = ends[i];
        const other = ends[1 - i];
        if (railJumperOf.has(k)) { linkWire(railJumperOf.get(k), w.id); continue; }
        const ph = pinHole.get(k);
        if (ph) {
          const rail = chooseRail(net, ph.b, halfOf(ph.y));
          const sh = allocStripHole(ph, RAIL_Y[rail]);
          if (!sh) { noHole(k, w); continue; }
          const rh = allocRailHole(ph.b, rail, ph.col);
          if (!rh) { add('error', 'out-of-columns', `No free hole left on the ${railLabel(rail)}`, { wires: [w.id] }); continue; }
          railJumperOf.set(k, makeJumper({ a: sh, b: rh, net, wire: w.id, kind: 'male-male', pins: [k] }));
        } else {
          const oh = pinHole.get(other) || (railJumperOf.get(other) && parseInternal(railJumperOf.get(other).to));
          const b = oh ? oh.b : 0;
          const half = oh && !oh.rail ? halfOf(oh.y) : oh && oh.rail ? (oh.rail.startsWith('top') ? 'top' : 'bottom') : 'top';
          const rail = chooseRail(net, b, half);
          const rh = allocRailHole(b, rail, oh ? oh.col + 1 : 1);
          if (!rh) { add('error', 'out-of-columns', `No free hole left on the ${railLabel(rail)}`, { wires: [w.id] }); continue; }
          railJumperOf.set(k, makeJumper({ a: k, b: rh, net, wire: w.id, kind: offKind(k), pins: [k] }));
        }
      }
      continue;
    }
    const [ka, kb] = ends;
    const ha = pinHole.get(ka); const hb = pinHole.get(kb);
    if (ha && hb) {
      if (stripKey(ha) === stripKey(hb)) {
        add('info', 'same-strip', `Wire ${w.id} joins ${pinDesc(ka)} and ${pinDesc(kb)}, which already share a strip: no jumper needed`, { wires: [w.id] });
        wireJumpers.set(w.id, []);
        continue;
      }
      const sa = allocStripHole(ha, hb.y); if (!sa) { noHole(ka, w); continue; }
      const sb = allocStripHole(hb, ha.y); if (!sb) { noHole(kb, w); continue; }
      makeJumper({ a: sa, b: sb, net, wire: w.id, kind: 'male-male', pins: [ka, kb] });
    } else if (ha || hb) {
      const [kOn, kOff, hOn] = ha ? [ka, kb, ha] : [kb, ka, hb];
      const s = allocStripHole(hOn, outerY(hOn)); if (!s) { noHole(kOn, w); continue; }
      makeJumper({ a: kOff, b: s, net, wire: w.id, kind: offKind(kOff), pins: [kOff, kOn] });
    } else {
      makeJumper({ a: ka, b: kb, net, wire: w.id, kind: 'direct', pins: [ka, kb], note: 'both ends are off the board: connect them directly, not through the breadboard' });
    }
  }
  function parseInternal(name) {
    const p = parseHole(name);
    return p ? { b: p.boardIndex, y: p.y, col: p.col, rail: p.rail || undefined } : null;
  }

  // ---- rail links between boards and across split rails
  for (const r of RAIL_NAMES) {
    const rn = railNet[r];
    if (!rn || !rn.net) continue;
    const usedOn = (b, lo, hi) => jumpers.some((j) => [j.from, j.to].some((n) => { const p = parseHole(n); return p && p.rail === r && p.boardIndex === b && p.col >= lo && p.col <= hi; }));
    const boardsUsing = boards.map((bd, b) => (usedOn(b, 1, bd.columns) ? b : -1)).filter((b) => b >= 0);
    for (let i = 1; i < boardsUsing.length; i++) {
      const b1 = boardsUsing[i - 1]; const b2 = boardsUsing[i];
      const h1 = allocRailHole(b1, r, boards[b1].columns); const h2 = allocRailHole(b2, r, 1);
      if (h1 && h2) {
        const j = makeJumper({ a: h1, b: h2, net: rn.net, kind: 'male-male', special: 'board-link', note: `joins the ${railLabel(r)} of ${boards[b1].id} and ${boards[b2].id}` });
        j.len_mm = null; j.precut_mm = null;
      }
    }
    boards.forEach((bd, b) => {
      if (!bd.split) return;
      const mid = Math.floor(bd.columns / 2);
      if (usedOn(b, 1, mid) && usedOn(b, mid + 1, bd.columns)) {
        const h1 = allocRailHole(b, r, mid, 1, mid); const h2 = allocRailHole(b, r, mid + 1, mid + 1, bd.columns);
        if (h1 && h2) {
          makeJumper({ a: h1, b: h2, net: rn.net, kind: 'male-male', special: 'split-join', note: `joins the two halves of the split ${railLabel(r)}` });
          add('warning', 'split-rail', `The ${railLabel(r)}${multi ? ` of ${bd.id}` : ''} is split in the middle and used on both halves; the layout adds a jumper ${hName(h1)} → ${hName(h2)} to join them`, { holes: [hName(h1), hName(h2)] });
        }
      }
    });
  }

  // ---- strip and rail checks
  let stripConflicts = 0;
  for (const [k, occ] of stripUse) {
    const nets = [...new Set(occ.map((o) => o.net).filter(Boolean))];
    if (nets.length < 2) continue;
    const isRail = k.includes(':rail:');
    const holes = occ.map((o) => o.hole);
    if (isRail) {
      add('error', 'rail-two-nets', `A rail carries two different nets (${nets.map((n) => n.name).join(', ')}) at ${holes.join(', ')}`, { holes });
      continue;
    }
    const partsIn = [...new Set(occ.map((o) => o.part).filter(Boolean))];
    if (partsIn.length === 1 && bridging.has(partsIn[0])) continue; // already reported as not-across-gap
    stripConflicts++;
    const [b, col, half] = k.split(':');
    const range = half === 'top' ? `a${col}-e${col}` : `f${col}-j${col}`;
    add('error', 'strip-conflict', `Two different nets share the 5-hole strip ${multi ? `${boards[Number(b)].id}/` : ''}${range}: ${occ.map((o) => `${o.hole} ${o.what.startsWith('jp') ? `jumper ${o.what}` : pinDesc(o.what)} (${o.net ? o.net.name : '?'})`).join('; ')}. They are shorted together.`, { parts: partsIn, holes });
  }

  // ---- steps
  const steps = [];
  const railUsed = (r) => jumpers.some((j) => [j.from, j.to].some((n) => { const p = parseHole(n); return p && p.rail === r; }));
  const railsOut = {};
  for (const r of RAIL_NAMES) {
    const rn = railNet[r];
    railsOut[r] = rn && rn.net ? { net: rn.net.id, name: rn.net.name, label: rn.label, voltage: groundNets.includes(rn.net) ? 0 : (netVoltage(rn.net) || null), auto: rn.auto, used: railUsed(r) } : null;
  }
  for (const r of RAIL_NAMES) {
    const ro = railsOut[r];
    if (!ro || !ro.used) continue;
    const holes = [];
    for (const j of jumpers) for (const n of [j.from, j.to]) { const p = parseHole(n); if (p && p.rail === r) holes.push(n); }
    const what = r.endsWith('-') ? 'ground (GND)' : `${ro.label} (net ${ro.name})`;
    let text = `The ${railLabel(r)} carries ${what}. Mark it so nothing else goes there.`;
    if (boards.some((bd) => bd.split)) text += ` This board's rails are split in the middle: the two halves are not connected unless you add a jumper.`;
    steps.push({ title: `${railLabel(r).replace(/^./, (c) => c.toUpperCase())}: ${r.endsWith('-') ? 'GND' : ro.label}`, text, rail: r, holes });
  }
  for (const [pid, pl] of Object.entries(placements)) {
    const info = infos.get(pid);
    const holes = Object.values(pl.holes);
    let text;
    const first = info.rows[0].find((n) => n);
    const p1 = /^\d+$/.test(first) ? `pin ${first}` : `pin 1 (${first})`;
    if (info.fit === 'straddle') {
      const dip = info.spacing === 3;
      text = `Insert the ${info.name} across the centre gap, ${dip ? 'notch' : 'pin 1 end'} ${pl.notch}, ${p1} in hole ${pl.pin1}.`;
      const r0 = info.rows[0].filter(Boolean); const r1 = info.rows[1].filter(Boolean);
      if (r0.length && r1.length) text += ` Pins ${r0[0]}-${r0[r0.length - 1]} go in ${pl.holes[r0[0]]} … ${pl.holes[r0[r0.length - 1]]}, pins ${r1[0]}-${r1[r1.length - 1]} in ${pl.holes[r1[0]]} … ${pl.holes[r1[r1.length - 1]]}.`;
    } else {
      text = `Push the ${info.name} header into row ${pl.rows.join('/')}: ` + info.rows[0].filter(Boolean).map((n) => `${n} ${pl.holes[n]}`).join(', ') + '.';
    }
    steps.push({ title: `Insert ${info.name}`, text, part: pid, holes });
  }
  const order = (j) => (j.role === 'power' ? 0 : j.role === 'ground' ? 1 : j.kind === 'direct' ? 3 : 2) * 10 + (j.special ? 0 : 1);
  const sorted = jumpers.map((j, i) => [j, i]).sort((x, y) => order(x[0]) - order(y[0]) || x[1] - y[1]).map((x) => x[0]);
  const endDesc = (n, pk) => {
    const p = parseHole(n);
    if (p && p.rail) { const ro = railsOut[p.rail]; return `${railLabel(p.rail)}${multi ? ` of ${p.board}` : ''}, column ${p.col}${ro ? ` (${p.rail.endsWith('-') ? 'GND' : ro.label})` : ''}`; }
    if (p) { const k = pk.find((x) => pinHole.get(x) && stripKey(pinHole.get(x)) === stripKey({ b: p.boardIndex, y: p.y, col: p.col })); return k ? `${n} (strip of ${pinDesc(k)})` : n; }
    return pinDesc(n);
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  for (const j of sorted) {
    let text;
    if (j.kind === 'direct') text = `${cap(j.color)} wire, directly (not through the board): ${pinDesc(j.from)} → ${pinDesc(j.to)}.`;
    else {
      const kindTxt = j.kind === 'male-female' ? ' male-female' : '';
      const len = j.len_mm != null ? ` (${j.len_mm} mm${j.precut_mm ? `, pre-cut ${j.precut_mm} mm` : ''})` : '';
      const pk = j.pins.length ? j.pins : [];
      text = `${cap(j.color)}${kindTxt} jumper${len}: ${endDesc(j.from, pk)} → ${endDesc(j.to, pk)}.`;
      if (j.note) text += ` ${cap(j.note)}.`;
    }
    steps.push({ title: `${cap(j.color)} jumper ${j.from} → ${j.to}`, text, jumper: j.id, wire: j.wire, holes: j.holes });
  }

  // ---- table
  const table = [];
  for (const [pid, pl] of Object.entries(placements)) {
    const def = model.parts.get(pid);
    for (const [pn, hole] of Object.entries(pl.holes)) {
      const p = def.pinMap.get(pn);
      const net = netOfPin.get(`${pid}.${pn}`);
      table.push({ type: 'pin', part: pid, pin: pn, label: p ? p.label : pn, hole, net: net && net.connected ? net.name : '' });
    }
  }
  for (const j of jumpers) table.push({ type: 'jumper', id: j.id, from: j.from, to: j.to, color: j.color, net: j.net_name, len_mm: j.len_mm, kind: j.kind });

  if (!stripConflicts && Object.keys(placements).length) {
    issues.push({ rule: 'strips-ok', level: 'info', message: 'Each 5-hole strip carries one net; no chip side shares a strip with another.', parts: [], wires: [], holes: [] });
  }

  const wireMap = {};
  for (const w of model.wires) if (wireJumpers.has(w.id)) wireMap[w.id] = wireJumpers.get(w.id);

  return {
    model: multi ? boards.map((b) => b.model) : boards[0].model,
    boards,
    rails: railsOut,
    placements,
    offboard,
    unplaced,
    jumpers,
    wireJumpers: wireMap,
    issues,
    errors: issues.filter((i) => i.level === 'error').length,
    warnings: issues.filter((i) => i.level === 'warning').length,
    steps,
    table,
  };
}

/**
 * Write a layout back into a (cloned) project: part.bb {pin1, rot[, board]},
 * wire.bb {jumpers, holes?, len_mm?} (holes/len_mm when the wire maps to exactly
 * one jumper) and project.breadboard.layout. Returns the new project.
 * @param {any} project @param {ReturnType<typeof layoutBreadboard>} layout
 */
export function applyLayoutToProject(project, layout) {
  const out = JSON.parse(JSON.stringify(project));
  const L = JSON.parse(JSON.stringify(layout));
  for (const p of out.parts || []) {
    const pl = L.placements[p.id];
    if (pl) {
      p.bb = { pin1: pl.pin1, rot: pl.rot };
      if (Array.isArray(L.model)) p.bb.board = pl.board;
    }
  }
  const byId = new Map(L.jumpers.map((j) => [j.id, j]));
  for (const w of out.wires || []) {
    const ids = L.wireJumpers[w.id];
    if (!ids) { delete w.bb; continue; }
    const bb = { jumpers: ids };
    if (ids.length === 1) {
      const j = byId.get(ids[0]);
      bb.holes = [j.from, j.to];
      bb.len_mm = j.len_mm;
    }
    w.bb = bb;
  }
  out.breadboard = { ...(out.breadboard || {}), model: L.model, layout: L };
  return out;
}

/** Plain-text rendering in the PRD's style. */
export function formatLayout(layout) {
  const lines = [];
  const models = Array.isArray(layout.model) ? layout.model.join(' + ') : layout.model;
  lines.push(`Breadboard: ${models} (${layout.boards.map((b) => `${b.columns} columns${b.split ? ', split rails' : ''}`).join(' + ')})`);
  const railTxt = RAIL_NAMES.map((r) => {
    const ro = layout.rails[r];
    const nm = r.replace(/([+-])$/, ' $1');
    if (!ro) return `${nm} = (unused)`;
    return `${nm} = ${r.endsWith('-') ? 'GND' : `${ro.label}`}${ro.used ? '' : ' (unused)'}`;
  });
  lines.push(`  Rails: ${railTxt.join(', ')}`);
  for (const step of layout.steps.filter((s) => s.part)) {
    const pl = layout.placements[step.part];
    lines.push(`  ${pl.fit === 'straddle' ? 'Chip' : 'Part'}:  ${step.text}`);
    const pins = Object.entries(pl.holes).map(([n, h]) => `${n} ${h}`);
    for (let i = 0; i < pins.length; i += 8) lines.push(`         ${pins.slice(i, i + 8).join(' | ')}`);
    if (pl.free) lines.push(`         free holes per pin: ${pl.free.top} above, ${pl.free.bottom} below`);
  }
  if (layout.offboard.length) lines.push(`  Off the board: ${layout.offboard.join(', ')}`);
  if (layout.unplaced.length) lines.push(`  NOT PLACED: ${layout.unplaced.join(', ')}`);
  lines.push('');
  layout.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.text}`));
  lines.push('');
  const errs = layout.issues.filter((i) => i.level === 'error');
  const warns = layout.issues.filter((i) => i.level === 'warning');
  const infos = layout.issues.filter((i) => i.level === 'info');
  lines.push(`  Checks: ${errs.length} error(s), ${warns.length} warning(s)`);
  for (const i of [...errs, ...warns, ...infos]) lines.push(`    ${i.level === 'error' ? 'ERROR' : i.level === 'warning' ? 'WARN ' : 'ok   '} [${i.rule}] ${i.message}`);
  return lines.join('\n');
}
