// @ts-check
// Wire edits from the viewer: move one end of a wire to another pin, add a
// wire, delete a wire, recolour it. Pure functions on the project object, so
// the viewer can preview the checker result before the server writes the file.

import { parseEndpoint, resolveProject } from './model.js';
import { checkProject } from './check.js';
import { ROLE_COLORS } from './nets.js';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const COLORS = new Set(Object.values(ROLE_COLORS).map((c) => c.name).concat(['white', 'grey', 'gray', 'green', 'brown']));

function clone(x) { return JSON.parse(JSON.stringify(x)); }

/** Check that "part.PIN" exists in the resolved project. */
function endpointError(model, ep) {
  const e = parseEndpoint(ep);
  if (!e) return `"${ep}" must look like part.PIN`;
  const part = model.parts.get(e.part);
  if (!part) return `No part "${e.part}" in this project`;
  if (!part.pinMap.has(e.pin)) return `${part.name || e.part} has no pin "${e.pin}" (pins: ${[...part.pinMap.keys()].slice(0, 30).join(', ')})`;
  return null;
}

function nextWireId(project) {
  let n = 1;
  const ids = new Set((project.wires || []).map((w) => w.id));
  while (ids.has(`w${n}`)) n++;
  return `w${n}`;
}

/**
 * applyWireEdit(project, library, op) → { project, changed, wire } or throws.
 * op: { op: 'move', id, end: 'from'|'to', to: 'part.PIN', color? }
 *     { op: 'add', from, to, color?, gauge?, label?, id? }
 *     { op: 'delete', id }
 *     { op: 'color', id, color }
 */
export function applyWireEdit(project, library, op = {}) {
  const p = clone(project || {});
  p.wires = Array.isArray(p.wires) ? p.wires : [];
  const model = resolveProject(p, library || {});
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const find = (id) => {
    const w = p.wires.find((x) => x.id === id);
    if (!w) throw bad(`No wire "${id}"`);
    return w;
  };
  const color = (c) => {
    if (c === undefined || c === null || c === '') return undefined;
    if (!COLORS.has(String(c))) throw bad(`Unknown wire colour "${c}"`);
    return String(c);
  };
  let wire;
  if (op.op === 'move') {
    wire = find(op.id);
    if (op.end !== 'from' && op.end !== 'to') throw bad('end must be "from" or "to"');
    const err = endpointError(model, op.to);
    if (err) throw bad(err);
    const other = op.end === 'from' ? wire.to : wire.from;
    if (other === op.to) throw bad('Both ends would be on the same pin');
    wire[op.end] = op.to;
    const c = color(op.color);
    if (c) wire.color = c;
  } else if (op.op === 'add') {
    for (const ep of [op.from, op.to]) { const err = endpointError(model, ep); if (err) throw bad(err); }
    if (op.from === op.to) throw bad('Both ends are the same pin');
    const id = op.id || nextWireId(p);
    if (!ID_RE.test(id) || p.wires.some((w) => w.id === id)) throw bad(`Wire id "${id}" is invalid or taken`);
    wire = { id, from: op.from, to: op.to };
    const c = color(op.color); if (c) wire.color = c;
    if (op.gauge !== undefined) wire.gauge = Number(op.gauge);
    if (op.label) wire.label = String(op.label).slice(0, 80);
    p.wires.push(wire);
  } else if (op.op === 'delete') {
    wire = find(op.id);
    p.wires = p.wires.filter((w) => w.id !== op.id);
    for (const s of p.steps || []) if (Array.isArray(s.wires)) s.wires = s.wires.filter((x) => x !== op.id);
  } else if (op.op === 'color') {
    wire = find(op.id);
    wire.color = color(op.color);
  } else throw bad('op must be move, add, delete or color');
  return { project: p, wire, changed: [`wires.${wire.id}`] };
}

/**
 * Rank where one end of a wire could go: every pin on the chosen part (or all
 * parts), each with the checker result if the wire went there. Pins that add
 * no error come first, then fewer new problems.
 */
export function pinOptions(project, library, { id, end, part } = {}) {
  const fast = { mechanics: false };
  const base = checkProject(project, library, fast);
  // Same rule, level, wires and parts = the same problem, even if its text names a moved pin.
  const key = (i) => `${i.rule}|${i.level}|${[...(i.wires || [])].sort()}|${[...(i.parts || [])].sort()}`;
  const before = new Set(base.issues.filter((i) => i.level !== 'info').map(key));
  const w = (project.wires || []).find((x) => x.id === id);
  if (!w) return [];
  const current = w[end];
  const parts = part ? [base.model.parts.get(part)].filter(Boolean) : base.model.partList;
  const out = [];
  for (const pd of parts) {
    for (const pin of pd.pins) {
      const ep = `${pd.id}.${pin.name}`;
      if (ep === current || ep === (end === 'from' ? w.to : w.from)) continue;
      let res;
      try {
        const { project: next } = applyWireEdit(project, library, { op: 'move', id, end, to: ep });
        res = checkProject(next, library, fast);
      } catch { continue; }
      const added = res.issues.filter((i) => i.level !== 'info' && !before.has(key(i)));
      const errors = added.filter((i) => i.level === 'error');
      const role = res.wireInfo?.[id]?.role || null;
      const used = (base.pinInfo?.[ep]?.connected) || false;
      out.push({
        endpoint: ep, part: pd.id, pin: pin.name, label: pin.label || pin.name, kind: pin.kind, used,
        role, color: role ? ROLE_COLORS[role]?.name : undefined,
        errors: errors.length, warnings: added.length - errors.length,
        problems: added.slice(0, 3).map((i) => ({ level: i.level, message: i.message })),
        totalErrors: res.errors,
      });
    }
  }
  out.sort((a, b) => a.errors - b.errors || a.warnings - b.warnings || Number(a.used) - Number(b.used) || a.endpoint.localeCompare(b.endpoint));
  return out;
}
