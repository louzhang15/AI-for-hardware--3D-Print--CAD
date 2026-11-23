// @ts-check
// Design-for-printing and assembly checks. Pure functions (no file access), so
// they run in Node and in the browser. Meshes come from lib/node/stl.js:
// { positions: Float32Array (9 floats per triangle), bbox: { min, max, size } }.
//
// Print checks: model size against the size the project declares, closed
// (watertight) mesh, overhangs past 45° that need support, bed contact and
// height-to-base ratio, mass from volume. Assembly checks: overlapping
// components, screwdriver access to every fastener, and assembly order.

export const DENSITY = { PLA: 1.24, 'PLA-CF': 1.29, PETG: 1.27, 'PETG-CF': 1.3, ABS: 1.04, ASA: 1.07, PC: 1.2, PA: 1.14, 'PA-CF': 1.2, TPU: 1.21 };
export const OVERHANG_DEG = 45;
const r1 = (x) => Number(x.toFixed(1)) + 0;
const r2 = (x) => Number(x.toFixed(2)) + 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Per-triangle area and unit normal. */
function triInfo(p, o) {
  const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
  const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  return { area: l / 2, n: l ? [nx / l, ny / l, nz / l] : [0, 0, 0], zmin: Math.min(p[o + 2], p[o + 5], p[o + 8]), zmax: Math.max(p[o + 2], p[o + 5], p[o + 8]) };
}

/** Every edge used once in each direction (the same test as lib/node/stl.js checkClosed). */
export function closedMesh(positions, decimals = 4) {
  const p = positions;
  const key = (o) => `${p[o].toFixed(decimals)},${p[o + 1].toFixed(decimals)},${p[o + 2].toFixed(decimals)}`;
  const edges = new Map();
  for (let o = 0; o < p.length; o += 9) {
    const k = [key(o), key(o + 3), key(o + 6)];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue;
    for (let e = 0; e < 3; e++) { const id = `${k[e]}|${k[(e + 1) % 3]}`; edges.set(id, (edges.get(id) || 0) + 1); }
  }
  let open = 0, bad = 0;
  for (const [id, c] of edges) {
    const [a, b] = id.split('|');
    const r = edges.get(`${b}|${a}`) || 0;
    if (r === 0) open++; else if (r !== 1 || c !== 1) bad++;
  }
  return { closed: edges.size > 0 && open === 0 && bad === 0, open_edges: open, non_manifold: bad };
}

/** Is the printer a bed slinger (bed moves in Y)? From the profile id, kinematics or notes. */
export function isBedSlinger(profile) {
  if (!profile) return false;
  if (profile.kinematics) return /slinger|cartesian-bed/i.test(profile.kinematics);
  return /\ba1\b|a1-mini|a1 mini/i.test(`${profile.id} ${profile.name}`) || (profile.notes || []).some((n) => /bed slinger/i.test(n));
}

/**
 * analyzeMesh(mesh, { declaredSize, material, profile, supports, infill, walls })
 * Assumes the STL is exported in print orientation (Z up, bed at min Z), as slicers load it.
 */
export function analyzeMesh(mesh, { declaredSize, material = 'PLA', profile, supports, infill = 15, walls = 2 } = {}) {
  const p = mesh.positions;
  const bbox = mesh.bbox;
  const zBed = bbox.min[2];
  const cosLim = Math.cos((OVERHANG_DEG * Math.PI) / 180);
  let area = 0, overhang = 0, contact = 0, vol = 0;
  for (let o = 0; o < p.length; o += 9) {
    const t = triInfo(p, o);
    area += t.area;
    vol += (p[o] * (p[o + 4] * p[o + 8] - p[o + 5] * p[o + 7]) - p[o + 1] * (p[o + 3] * p[o + 8] - p[o + 5] * p[o + 6]) + p[o + 2] * (p[o + 3] * p[o + 7] - p[o + 4] * p[o + 6])) / 6;
    const onBed = t.zmax - zBed < 0.05;
    if (t.n[2] < -0.999 && onBed) contact += t.area;
    else if (t.n[2] < -cosLim && t.zmin - zBed > 0.2) overhang += t.area;
  }
  vol = Math.abs(vol);
  const closed = closedMesh(p);
  const dens = DENSITY[String(material).toUpperCase()] ?? DENSITY.PLA;
  const nozzle = profile?.nozzle_diameter || 0.4;
  const shell = Math.min(vol, area * walls * nozzle);
  const printedVol = shell + Math.max(0, vol - shell) * (Math.min(100, Math.max(0, infill)) / 100);
  const size = bbox.size.map(r2);
  const height = bbox.size[2];
  const out = {
    size, volume_cm3: r2(vol / 1000), area_mm2: r1(area), closed,
    solid_mass_g: r1((vol / 1000) * dens), printed_mass_g: r1((printedVol / 1000) * dens),
    overhang_mm2: r1(overhang), overhang_pct: area ? r1((100 * overhang) / area) : 0,
    contact_mm2: r1(contact), height_mm: r1(height),
    slenderness: contact > 0 ? r2(height / Math.sqrt(contact)) : null,
    problems: [],
    formula: `overhang = downward faces steeper than ${OVERHANG_DEG}° from vertical and above the bed; mass = (shell + infill × core) × density`,
  };
  const add = (level, rule, text, fix) => out.problems.push({ level, rule, text, fix });
  if (Array.isArray(declaredSize) && declaredSize.length === 3) {
    const a = [...size].sort((x, y) => x - y), b = [...declaredSize].map(Number).sort((x, y) => x - y);
    const diff = a.map((v, i) => r2(v - b[i]));
    out.size_diff = diff;
    if (diff.some((d) => Math.abs(d) > 0.5)) {
      const unit = a.every((v, i) => Math.abs(v - b[i] * 25.4) < 0.5 || Math.abs(v * 25.4 - b[i]) < 0.5) ? ' It looks like an inch/mm mix-up.' : '';
      add('error', 'dfm-size', `The model is ${size.join(' × ')} mm but the project says ${declaredSize.join(' × ')} mm.${unit}`, 'Re-export the STL from the CAD at the intended size (mm, scale 1), or fix prints[].size.');
    }
  }
  if (!closed.closed) add('error', 'dfm-mesh', `The mesh is not watertight (${closed.open_edges} open edges, ${closed.non_manifold} non-manifold).`, 'Re-export from CAD as a solid body; in the slicer, repair only as a last resort.');
  if (overhang > 0 && out.overhang_pct > 3 && supports === false) add('warning', 'dfm-overhang', `${out.overhang_mm2} mm² (${out.overhang_pct} %) of the surface overhangs more than ${OVERHANG_DEG}° with supports off.`, 'Reorient, add 45° chamfers under overhangs, split the part, or turn supports on for those faces.');
  if (contact < 1) add('error', 'dfm-bed', 'Nothing in the model lies flat on the bed in this orientation.', 'Rotate it so a flat face is down, or add a flat base.');
  else if (contact < 40) add('warning', 'dfm-bed', `Only ${out.contact_mm2} mm² touches the bed.`, 'Add a brim or mouse ears, or lay the part on a larger face.');
  if (out.slenderness !== null && out.slenderness > (isBedSlinger(profile) ? 3 : 5)) add('warning', 'dfm-tall', `Height ${out.height_mm} mm on a ${out.contact_mm2} mm² footprint (ratio ${out.slenderness}): it wobbles${isBedSlinger(profile) ? ' on this bed slinger' : ''} and can break loose.`, 'Print it lying down if the loads allow, or add a brim and slow the outer walls.');
  return out;
}

// ---------------------------------------------------------------------------
// Assembly

/** Axis-aligned box in the viewer frame (Y up) for a part or a print. */
export function itemBox(kind, item, library) {
  const pos = Array.isArray(item.position) ? item.position.map(Number) : null;
  if (!pos) return null;
  let size;
  if (kind === 'print') {
    if (!Array.isArray(item.size)) return null;
    const [x, y, z] = item.size.map(Number); size = [x, z, y]; // slicer X, Y, Z → viewer x, height, z
  } else {
    const lib = item.library ? library?.[item.library] : null;
    const s = item.size || lib?.size;
    if (!Array.isArray(s)) return null;
    size = s.map(Number);
  }
  const rot = Array.isArray(item.rotation) ? item.rotation.map(Number) : [0, 0, 0];
  const quarter = (a) => Math.abs(((a % 180) + 180) % 180 - 90) < 1e-6;
  if (rot[0] % 360 !== 0 || rot[2] % 360 !== 0 || !(rot[1] % 90 === 0)) return { id: item.id, kind, rotated: true };
  if (quarter(rot[1])) size = [size[2], size[1], size[0]];
  return { id: item.id, kind, min: [pos[0] - size[0] / 2, pos[1], pos[2] - size[2] / 2], max: [pos[0] + size[0] / 2, pos[1] + size[1], pos[2] + size[2] / 2] };
}

function overlap(a, b) {
  const d = [0, 1, 2].map((k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]));
  return d.every((v) => v > 0) ? d : null;
}

/**
 * checkAssembly(project, library) → { problems, report }
 * Runs when the project opts in with mechanics.assembly (or a top-level assembly object).
 *   allow_overlap: [[a, b]] pairs meant to nest (a board in its pocket)
 *   rests_on: { id: [ids] } what each print or part sits on, for the assembly order
 * Fasteners: mechanics.bolts[] or fasteners[] with position [x,y,z] and axis ('+y' default),
 * through: [ids] they pass through. A screwdriver needs a clear Ø8 × 60 mm path.
 */
export function checkAssembly(project, library = {}) {
  const asm = project?.mechanics?.assembly || (project?.assembly && typeof project.assembly === 'object' ? project.assembly : null);
  const problems = [];
  const report = { interference: [], access: [], order: [], skipped: [] };
  if (!asm) return { problems, report: null };
  const add = (level, rule, text, fix, parts = []) => problems.push({ level, rule, text, fix, parts });
  const allowed = new Set((asm.allow_overlap || []).map((pair) => [...pair].sort().join('|')));
  const boxes = [];
  for (const p of project.parts || []) { const b = itemBox('part', p, library); if (b) boxes.push(b); }
  for (const p of project.prints || []) { const b = itemBox('print', p, library); if (b) boxes.push(b); }
  for (const b of boxes.filter((x) => x.rotated)) report.skipped.push(b.id);
  const solid = boxes.filter((b) => !b.rotated);
  const tol = isNum(asm.tolerance_mm) ? asm.tolerance_mm : 0.2;
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      const a = solid[i], b = solid[j];
      if (allowed.has([a.id, b.id].sort().join('|'))) continue;
      const d = overlap(a, b);
      if (!d || Math.min(...d) <= tol) continue;
      const depth = r1(Math.min(...d));
      report.interference.push({ a: a.id, b: b.id, depth_mm: depth });
      const both = a.kind === 'print' && b.kind === 'print';
      add(both ? 'error' : 'warning', 'mech-interference', `${a.id} and ${b.id} overlap by ${depth} mm in the assembly.`, both ? 'Move one, or cut a pocket and list the pair in assembly.allow_overlap.' : 'Check the part positions; if it sits in a pocket, list the pair in assembly.allow_overlap.', [a.id, b.id]);
    }
  }
  // fastener access
  const fasteners = [...(project.mechanics?.bolts || []), ...(project.fasteners || [])].filter((f) => Array.isArray(f.position));
  const AX = { '+x': [0, 1], '-x': [0, -1], '+y': [1, 1], '-y': [1, -1], '+z': [2, 1], '-z': [2, -1] };
  for (const f of fasteners) {
    const ax = AX[f.axis || '+y'];
    if (!ax) { add('warning', 'mech-input', `Fastener ${f.id}: axis must be ±x, ±y or ±z.`, 'Fix the axis.'); continue; }
    const [k, sgn] = ax;
    const r = (f.driver_d_mm ?? 8) / 2, len = f.driver_len_mm ?? 60;
    const start = f.position.map(Number);
    const min = start.map((v, i) => (i === k ? (sgn > 0 ? v + 2 : v - 2 - len) : v - r));
    const max = start.map((v, i) => (i === k ? (sgn > 0 ? v + 2 + len : v - 2) : v + r));
    const cyl = { min, max };
    const through = new Set(f.through || []);
    const hits = solid.filter((b) => !through.has(b.id) && overlap(cyl, b)).map((b) => b.id);
    report.access.push({ id: f.id, clear: !hits.length, blocked_by: hits });
    if (hits.length) add('error', 'mech-access', `No screwdriver access to ${f.id}: the Ø${2 * r} × ${len} mm path along ${f.axis || '+y'} hits ${hits.join(', ')}.`, 'Add an access hole, change the fastening order, or turn the screw to come from the open side.', hits);
  }
  // assembly order
  const rests = { ...(asm.rests_on || {}) };
  for (const p of project.prints || []) if (Array.isArray(p.rests_on)) rests[p.id] = p.rests_on;
  if (Object.keys(rests).length) {
    const installed = new Set();
    for (const step of project.steps || []) {
      const items = [...(step.prints || []), ...(step.parts || [])];
      for (const id of items) {
        if (installed.has(id)) continue;
        if (step.phase === 'assemble' && rests[id]) {
          const missing = rests[id].filter((x) => !installed.has(x) && !items.includes(x));
          if (missing.length) {
            report.order.push({ step: step.id, id, missing });
            add('error', 'mech-assembly-order', `Step "${step.title || step.id}" installs ${id} before ${missing.join(', ')}, which it sits on.`, 'Reorder the steps so supporting parts go in first.', [id, ...missing]);
          }
        }
      }
      for (const id of items) installed.add(id);
    }
  }
  if (report.skipped.length) add('info', 'mech-interference', `Not checked for overlap (rotated other than 90° about Y): ${report.skipped.join(', ')}.`, 'Give axis-aligned positions or check in CAD.');
  return { problems, report };
}

/**
 * checkPrintsDFM(project, meshes, { profile }) → { problems, report }
 * meshes: { [printId]: mesh } loaded by the caller (Node: lib/node/stl.js).
 */
export function checkPrintsDFM(project, meshes = {}, { profile } = {}) {
  const problems = [];
  const report = {};
  for (const pr of project?.prints || []) {
    const mesh = meshes[pr.id];
    if (!mesh) continue;
    const A = analyzeMesh(mesh, {
      declaredSize: pr.size, material: pr.material || project.printer?.material || 'PLA', profile,
      supports: pr.settings?.supports, infill: pr.settings?.infill ?? 15, walls: pr.settings?.walls ?? 2,
    });
    report[pr.id] = A;
    for (const p of A.problems) problems.push({ ...p, text: `${pr.name || pr.id}: ${p.text}`, parts: [] });
  }
  return { problems, report };
}
