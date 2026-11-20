#!/usr/bin/env node
// wiremap split-part: cut an STL that is too big for the printer into closed pieces,
// write each as an STL and any printable pieces as 3MF, with a joint plan + CAD snippets.
// Plain mesh cutting cannot add joints; the plan says exactly what to add in CAD.
// Exit 0 = every piece has a 3MF, 1 = some pieces need rework, 2 = bad usage.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { printPlacement, suggestSplit } from '../lib/printer.js';
import { insertHole, printFit } from '../lib/calc.js';
import { loadPrinters } from '../lib/node/library.js';
import { readSTL, saveSTL, planeCut, polygonArea, pointInPolygon, meshStats, checkClosed } from '../lib/node/stl.js';
import { preparePrintMesh } from '../lib/node/print.js';
import { packPlates } from '../lib/node/threemf.js';

const HELP = `Usage: wiremap split-part --stl in.stl --printer <id> [--axis x --at 120,240] [--cut y:100]...
                          [--joint pins|dovetail|flange] [--keepout x:40-60] [--out prints/base/] [--name base] [--json]

Cuts the mesh with planes (closed pieces, flat caps), writes <name>_1-of-N.stl per
piece and .3mf for printable pieces, <name>.joints.json, and CAD snippets (<name>.joints.py for
build123d, <name>.joints.scad for OpenSCAD) that add the joint features.
  --axis/--at  planes on one axis, mm from the part's minimum on that axis
  --cut        axis:pos[,pos] (repeatable) for several axes
  (no planes)  planes are chosen by the printer fit (evenly spaced, avoiding --keepout ranges)
  --joint      pins (3 mm dowel pins in 3.1 mm holes, default), dovetail, flange (M3 bolts + heat-set inserts)
  --keepout    axis:from-to (repeatable): keep planes out of mounting holes / bosses
  --nozzle     H2D nozzle (left, right, both)  --margin  mm per side
Joint features are NOT added to the mesh: apply them in CAD with the snippet.`;

const OPTS = {
  stl: { type: 'string' }, printer: { type: 'string' }, axis: { type: 'string' }, at: { type: 'string' },
  cut: { type: 'string', multiple: true }, joint: { type: 'string' }, keepout: { type: 'string', multiple: true },
  out: { type: 'string' }, name: { type: 'string' }, nozzle: { type: 'string' }, margin: { type: 'string' },
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
};

const AX = { x: 0, y: 1, z: 2 };
const r2 = (v) => Math.round(v * 100) / 100;

function parseCuts(a) {
  const cuts = [];
  if (a.axis || a.at) {
    if (!a.axis || !a.at || !(a.axis in AX)) throw new Error('--axis (x|y|z) and --at go together');
    cuts.push({ axis: a.axis, at: a.at.split(',').map(Number) });
  }
  for (const c of a.cut || []) {
    const m = /^([xyz]):([-0-9.,]+)$/.exec(c);
    if (!m) throw new Error(`--cut must look like x:120,240 (got ${c})`);
    cuts.push({ axis: m[1], at: m[2].split(',').map(Number) });
  }
  for (const c of cuts) if (c.at.some((v) => !Number.isFinite(v))) throw new Error(`bad cut position in ${c.axis}`);
  return cuts;
}

function parseKeepouts(list = []) {
  const out = {};
  for (const k of list) {
    const m = /^([xyz]):([-0-9.]+)-([-0-9.]+)$/.exec(k);
    if (!m) throw new Error(`--keepout must look like x:40-60 (got ${k})`);
    (out[m[1]] ||= []).push([Number(m[2]), Number(m[3])]);
  }
  return out;
}

function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Group cap loops into regions (outer + holes) by containment depth. */
function regionsOf(loops) {
  const area = loops.map((l) => polygonArea(l));
  const depth = loops.map((l, i) => loops.reduce((d, m, j) => d + (j !== i && Math.abs(area[j]) > Math.abs(area[i]) && pointInPolygon(l[0], m) ? 1 : 0), 0));
  const regions = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((m, j) => depth[j] === depth[i] + 1 && Math.abs(area[j]) < Math.abs(area[i]) && pointInPolygon(m[0], l));
    regions.push({ outer: l, holes, area: Math.abs(area[i]) - holes.reduce((s, h) => s + Math.abs(polygonArea(h)), 0) });
  });
  return regions;
}

/** Points inside a region, at least `edge` mm from every boundary, spread along its long direction. */
function pickPoints(region, edge, count) {
  const all = [region.outer, ...region.holes];
  const xs = region.outer.map((p) => p[0]), ys = region.outer.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const step = Math.max(0.5, Math.min(x1 - x0, y1 - y0) / 40);
  const cand = [];
  for (let x = x0 + step / 2; x < x1; x += step) {
    for (let y = y0 + step / 2; y < y1; y += step) {
      const p = [x, y];
      if (!pointInPolygon(p, region.outer) || region.holes.some((h) => pointInPolygon(p, h))) continue;
      let d = Infinity;
      for (const l of all) for (let i = 0, j = l.length - 1; i < l.length; j = i++) d = Math.min(d, distToSeg(p, l[j], l[i]));
      if (d >= edge) cand.push({ p, d });
    }
  }
  if (!cand.length) return [];
  const long = x1 - x0 >= y1 - y0 ? 0 : 1;
  const lo = Math.min(...cand.map((c) => c.p[long])), hi = Math.max(...cand.map((c) => c.p[long]));
  const picks = [];
  const n = hi - lo < edge * 2 ? 1 : count;
  const short = 1 - long;
  const mid = (Math.min(...cand.map((c) => c.p[short])) + Math.max(...cand.map((c) => c.p[short]))) / 2;
  for (let k = 0; k < n; k++) {
    // Inset from the ends (15% .. 85%) so pins sit in solid material, centred across the face.
    const target = n === 1 ? (lo + hi) / 2 : lo + (hi - lo) * (0.15 + 0.7 * k / (n - 1));
    let best = null;
    for (const c of cand) {
      const key = [Math.round(Math.abs(c.p[long] - target) / step), -Math.round(c.d / step), Math.abs(c.p[short] - mid)];
      if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) best = { key, c };
    }
    if (best && !picks.some((q) => Math.hypot(q[0] - best.c.p[0], q[1] - best.c.p[1]) < edge * 2)) picks.push(best.c.p.map((v) => Math.round(v * 10) / 10));
  }
  return picks;
}

function to3D(axis, offset, uv, p) {
  const out = [0, 0, 0];
  out[AX[axis]] = offset;
  out[AX[uv[0]]] = p[0];
  out[AX[uv[1]]] = p[1];
  return out.map(r2);
}

const SCAD_ROT = { x: '[0, 90, 0]', y: '[90, 0, 0]', z: '[0, 0, 0]' };
const B123_ROT = { x: 'Rot(0, 90, 0)', y: 'Rot(90, 0, 0)', z: 'Rot(0, 0, 0)' };

function snippets(plan) {
  const pins = plan.cuts.flatMap((c) => c.features.filter((f) => f.type === 'pin_hole' || f.type === 'insert_bolt').map((f) => ({ ...f, axis: c.axis })));
  const planes = plan.cuts.map((c) => `${c.axis} = ${c.offset}`).join(', ');
  const ins = plan.insert;
  const scad = [
    `// Wiremap split-part joint features for ${plan.source} (${plan.joint})`,
    `// Cut planes (absolute, STL coordinates): ${planes}`,
    `// These features were NOT added to the STL pieces. Apply them to your source model,`,
    `// or to each piece: difference() { import("${plan.pieces[0]?.file || 'piece.stl'}"); joint_features(); }`,
    `pin_d = ${plan.pin?.hole_d ?? 3.1};      // 3 mm dowel pin, sliding fit`,
    `pin_depth = ${plan.pin?.depth_each_side ?? 6.5}; // per side (3 x 12 mm pin + 0.5 mm)`,
    ins ? `insert_d = ${ins.hole_d}; insert_depth = ${ins.depth}; bolt_clear_d = ${plan.bolt_clear_d};` : '',
    'module joint_features() {',
    ...pins.map((f) => f.type === 'pin_hole'
      ? `  translate([${f.pos.join(', ')}]) rotate(${SCAD_ROT[f.axis]}) cylinder(d = pin_d, h = 2 * pin_depth, center = true, $fn = 32);`
      : `  // M3 bolt at [${f.pos.join(', ')}] across the ${f.axis} plane: clearance hole in one flange, insert hole in the other\n  translate([${f.pos.join(', ')}]) rotate(${SCAD_ROT[f.axis]}) cylinder(d = insert_d, h = 2 * insert_depth, center = true, $fn = 32);`),
    '}',
  ];
  if (plan.joint === 'dovetail') {
    for (const c of plan.cuts) for (const f of c.features.filter((x) => x.type === 'dovetail')) {
      scad.push(`// Dovetail on ${c.axis} = ${c.offset}: centre [${f.center.join(', ')}], along ${f.along}, neck ${f.neck} mm, mouth ${f.mouth} mm, depth ${f.depth} mm, ${f.clearance} mm clearance per side on the female side.`);
    }
    scad.push('// Model the tail on one piece and the socket (tail + clearance) on the other in your CAD; a mesh boolean cannot do it reliably.');
  }
  const py = [
    `# Wiremap split-part joint features for ${plan.source} (${plan.joint}) - build123d`,
    '# Apply to your SOURCE model (not the STL), then split and export each piece.',
    'from build123d import *',
    '',
    '# part = ...  # your source Part, in the same coordinates as the STL',
    `PIN_D, PIN_DEPTH = ${plan.pin?.hole_d ?? 3.1}, ${plan.pin?.depth_each_side ?? 6.5}`,
    ins ? `INSERT_D, INSERT_DEPTH, BOLT_CLEAR_D = ${ins.hole_d}, ${ins.depth}, ${plan.bolt_clear_d}` : '',
    'features = [',
    ...pins.map((f) => f.type === 'pin_hole'
      ? `    Pos(${f.pos.join(', ')}) * ${B123_ROT[f.axis]} * Cylinder(PIN_D / 2, 2 * PIN_DEPTH),`
      : `    Pos(${f.pos.join(', ')}) * ${B123_ROT[f.axis]} * Cylinder(INSERT_D / 2, 2 * INSERT_DEPTH),  # M3 insert side; use BOLT_CLEAR_D on the other flange`),
    ']',
    'part = part - features if features else part',
    ...plan.cuts.map((c) => `pieces = split(part, bisect_by=Plane.${{ x: 'YZ', y: 'XZ', z: 'XY' }[c.axis]}.offset(${c.offset}), keep=Keep.BOTH)`),
    '# export each solid: export_stl(piece, "name_1-of-N.stl")',
  ];
  if (plan.joint === 'flange') py.push('# Flanges: add a tab (>= 6 mm thick) on each side of the cut at the bolt positions, clearance hole on one, insert hole on the other.');
  if (plan.joint === 'dovetail') py.push('# Dovetail: extrude a trapezoid (neck/mouth/depth from the joints JSON) as the tail on one piece; cut tail + clearance from the other.');
  return { scad: scad.filter(Boolean).join('\n') + '\n', py: py.filter(Boolean).join('\n') + '\n' };
}

export async function main(argv = []) {
  let a;
  try { a = parseArgs({ args: argv, options: OPTS, allowPositionals: true }).values; } catch (e) { console.error(e.message + '\n\n' + HELP); return 2; }
  if (a.help) { console.log(HELP); return 0; }
  if (!a.stl || !a.printer) { console.error('split-part: --stl and --printer are required\n\n' + HELP); return 2; }
  const joint = a.joint || 'pins';
  if (!['pins', 'dovetail', 'flange'].includes(joint)) { console.error('split-part: --joint must be pins, dovetail or flange'); return 2; }
  let plan;
  try {
    const profile = loadPrinters()[a.printer];
    if (!profile) throw new Error(`unknown printer ${a.printer}`);
    const margin = a.margin !== undefined ? Number(a.margin) : undefined;
    const placement = printPlacement(profile, { margin, nozzle: a.nozzle });
    const { volume, ...packing } = placement;
    const mesh = readSTL(a.stl);
    const bb = mesh.bbox;
    let cuts = parseCuts(a);
    const auto = !cuts.length;
    const keepouts = auto ? parseKeepouts(a.keepout) : undefined;
    const warnings = [];
    const sourcePlacement = auto ? preparePrintMesh(mesh, profile, placement, { nozzle: a.nozzle }) : null;
    if (auto && sourcePlacement.mesh) warnings.push('Part already fits; no split needed.');
    else if (auto) {
      const split = suggestSplit(bb.size, profile, { margin, nozzle: a.nozzle, keepouts });
      cuts = split.cuts;
      if (cuts.length) warnings.push(...split.warnings);
    }
    const name = a.name || basename(a.stl).replace(/\.stl$/i, '');
    const outDir = a.out || join('prints', name);

    // Cut sequentially; record cap loops per plane.
    let pieces = [mesh];
    const planeInfo = [];
    for (const c of cuts) {
      for (const at of [...c.at].sort((x, y) => x - y)) {
        const offset = bb.min[AX[c.axis]] + at;
        const info = { axis: c.axis, at, offset: r2(offset), loops: [], uv: null };
        const next = [];
        for (const p of pieces) {
          const i = AX[c.axis];
          if (p.bbox.min[i] < offset - 1e-6 && p.bbox.max[i] > offset + 1e-6) {
            const r = planeCut(p, c.axis, offset);
            warnings.push(...r.warnings);
            if (r.below.triangles) next.push(r.below);
            if (r.above.triangles) next.push(r.above);
            info.loops.push(...r.caps.loops2d);
            info.uv = r.caps.uv;
          } else next.push(p);
        }
        if (next.length === pieces.length) throw new Error(`Cut ${c.axis} at ${at} mm does not split any piece.`);
        pieces = next;
        planeInfo.push(info);
      }
    }
    const N = pieces.length;
    // Order pieces by position (x, then y, then z of bbox min) so numbering is stable.
    pieces.sort((p, q) => p.bbox.min[0] - q.bbox.min[0] || p.bbox.min[1] - q.bbox.min[1] || p.bbox.min[2] - q.bbox.min[2]);
    mkdirSync(outDir, { recursive: true });
    const pieceOut = pieces.map((p, k) => {
      const file = `${name}_${k + 1}-of-${N}`;
      const stl = join(outDir, `${file}.stl`);
      saveSTL(stl, p, `Wiremap ${file}`);
      const volume_mm3 = meshStats(p).volume;
      const closed = checkClosed(p).closed;
      let threemf = null;
      let fit;
      if (!closed || volume_mm3 <= 0) {
        warnings.push(`${file}: mesh has open edges or inconsistent winding/volume. Repair the STL before slicing.`);
      } else {
        const prepared = (p === mesh && sourcePlacement) || preparePrintMesh(p, profile, placement, { nozzle: a.nozzle });
        fit = prepared.fit;
        const plate = prepared.mesh && packPlates([{ name: file, mesh: prepared.mesh }], volume, { ...packing, title: file }).plates[0];
        if (plate) {
          threemf = join(outDir, `${file}.3mf`);
          writeFileSync(threemf, plate.bytes);
        } else warnings.push(`${file}: ${fit.suggestion}`);
      }
      return {
        file: stl, threemf, size: p.bbox.size.map(r2), min: p.bbox.min.map(r2), volume_mm3: r2(volume_mm3),
        closed, fits: threemf !== null, orientation: threemf ? fit.orientation : null,
        rotationDeg: threemf ? fit.rotationDeg : 0, joint,
      };
    });
    const currentPlates = new Set(pieceOut.filter((p) => p.threemf).map((p) => basename(p.threemf)));
    const olderPlates = readdirSync(outDir).filter((file) =>
      file.startsWith(`${name}_`) && /^\d+-of-\d+\.3mf$/i.test(file.slice(name.length + 1)) && !currentPlates.has(file));
    if (olderPlates.length) warnings.push(`Earlier 3MFs in this folder were not regenerated: ${olderPlates.join(', ')}. Use the 3MF paths listed in this plan.`);

    // Joint features per plane.
    const pinHole = printFit({ nominal: 3, fit: 'sliding', profile, feature: 'hole' });
    const ins = joint === 'flange' ? insertHole({ size: 'M3' }) : null;
    plan = {
      source: a.stl, printer: profile.id, joint, name, out: outDir, pieces: pieceOut,
      auto_planes: auto,
      cuts: [],
      pin: joint === 'pins' ? { pin: '3 mm x 12 mm steel dowel pin', hole_d: 3.1, hole_d_calc: pinHole.value, depth_each_side: 6.5, note: 'Hole 3.1 mm for a 3 mm pin (sliding). Printer-profile sliding fit gives ' + pinHole.value + ' mm; use the larger if pins bind.' } : undefined,
      insert: ins ? { size: 'M3', maker: 'ruthex', hole_d: ins.hole_d, depth: ins.depth, min_wall: ins.min_wall, boss_d: ins.boss_d } : undefined,
      bolt_clear_d: ins ? 3.4 : undefined,
      applied_to_mesh: [],
      apply_in_cad: [],
      warnings: [...new Set(warnings)],
    };
    for (const info of planeInfo) {
      const regions = regionsOf(info.loops);
      const features = [];
      for (const reg of regions) {
        if (joint === 'pins' || joint === 'flange') {
          const edge = joint === 'pins' ? 1.55 + 2.4 : ins.boss_d / 2 + 1;
          const xs = reg.outer.map((p) => p[0]), ys = reg.outer.map((p) => p[1]);
          const long = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
          const count = Math.max(2, Math.min(4, Math.round(long / 60) + 1));
          const pts = pickPoints(reg, edge, count);
          if (pts.length < 2) plan.warnings.push(`Cut ${info.axis} = ${info.offset}: a region of ${r2(reg.area)} mm² is too small for ${joint === 'pins' ? 'two 3 mm pins' : 'two M3 bolts'}; glue it or add a ${joint === 'pins' ? 'flange' : 'bigger flange'} in CAD.`);
          for (const p of pts) {
            features.push(joint === 'pins'
              ? { type: 'pin_hole', pos: to3D(info.axis, info.offset, info.uv, p), d: 3.1, depth_each_side: 6.5 }
              : { type: 'insert_bolt', pos: to3D(info.axis, info.offset, info.uv, p), insert_hole_d: ins.hole_d, insert_depth: ins.depth, clearance_d: 3.4, screw: 'M3 (length: wiremap calc screw --stack <flange mm> --size M3 --engagement insert)' });
          }
        } else {
          const xs = reg.outer.map((p) => p[0]), ys = reg.outer.map((p) => p[1]);
          const w = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
          const along = w[0] >= w[1] ? info.uv[0] : info.uv[1];
          const span = Math.min(w[0], w[1]);
          const mouth = r2(Math.min(30, span * 0.5)), neck = r2(mouth * 0.65);
          const c2 = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
          features.push({ type: 'dovetail', center: to3D(info.axis, info.offset, info.uv, c2), along, mouth, neck, depth: r2(Math.min(10, span * 0.4)), clearance: printFit({ nominal: 1, fit: 'sliding', profile }).clearance_per_side, angle_deg: 15 });
          if (span < 12) plan.warnings.push(`Cut ${info.axis} = ${info.offset}: face is only ${r2(span)} mm thick, too thin for a dovetail; use pins or a flange.`);
        }
      }
      plan.cuts.push({ axis: info.axis, at: info.at, offset: info.offset, regions: regions.length, features });
    }
    const featureCount = plan.cuts.reduce((s, c) => s + c.features.length, 0);
    plan.apply_in_cad.push(`${featureCount} ${joint === 'pins' ? 'pin holes (3.1 mm, 6.5 mm deep each side)' : joint === 'flange' ? 'bolted flange positions (M3 + Ruthex insert)' : 'dovetail joints'}: see ${name}.joints.py (build123d) or ${name}.joints.scad (OpenSCAD).`);
    const sn = snippets(plan);
    writeFileSync(join(outDir, `${name}.joints.scad`), sn.scad);
    writeFileSync(join(outDir, `${name}.joints.py`), sn.py);
    plan.snippets = { openscad: join(outDir, `${name}.joints.scad`), build123d: join(outDir, `${name}.joints.py`) };
    writeFileSync(join(outDir, `${name}.joints.json`), JSON.stringify(plan, null, 2) + '\n');
    plan.joints_file = join(outDir, `${name}.joints.json`);
  } catch (e) {
    if (a.json) console.log(JSON.stringify({ error: e.message })); else console.error(`split-part: ${e.message}`);
    return 2;
  }
  const allFit = plan.pieces.every((p) => p.fits);
  if (a.json) console.log(JSON.stringify(plan, null, 2));
  else {
    console.log(`split-part: ${plan.source} -> ${plan.pieces.length} pieces for ${plan.printer} (${plan.auto_planes ? 'planes chosen by printer fit' : 'your planes'})`);
    for (const c of plan.cuts) console.log(`  cut ${c.axis} at ${c.at} mm from the part minimum (${c.axis} = ${c.offset}), ${c.regions} region(s)`);
    for (const p of plan.pieces) console.log(`  ${p.file}  ${p.size.join(' x ')} mm  ${p.threemf ? `fits (+ ${basename(p.threemf)})` : 'NO PRINTABLE 3MF'}`);
    console.log(`  Joint features added to the mesh: none (plain mesh cutting cannot add joints).`);
    for (const x of plan.apply_in_cad) console.log(`  Apply in CAD: ${x}`);
    console.log(`  Plan: ${plan.joints_file}`);
    for (const w of plan.warnings) console.log(`  WARN ${w}`);
  }
  return allFit ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
