import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMesh, orientMesh, parseSTL, writeBinarySTL, planeCut, meshStats, checkClosed, triangulateLoops, polygonArea } from '../lib/node/stl.js';
import { crc32, writeZip, build3MF, packPlates, shelfPack } from '../lib/node/threemf.js';

// Quad (a, b, c, d) CCW seen from outside -> two triangles.
function quad(out, a, b, c, d) { out.push(...a, ...b, ...c, ...a, ...c, ...d); }

export function boxMesh([sx, sy, sz], [ox, oy, oz] = [0, 0, 0]) {
  const p = [];
  const v = (x, y, z) => [ox + x * sx, oy + y * sy, oz + z * sz];
  quad(p, v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)); // bottom (-z)
  quad(p, v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)); // top (+z)
  quad(p, v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)); // -y
  quad(p, v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)); // +y
  quad(p, v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)); // -x
  quad(p, v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)); // +x
  return makeMesh(p);
}

// Square frame: outer O x O, centred square hole H x H, height Hz, hole along z.
export function frameMesh(O = 20, H = 10, Hz = 10) {
  const p = [];
  const a = (O - H) / 2, b = a + H;
  const P = (x, y, z) => [x, y, z];
  const outer = [[0, 0], [O, 0], [O, O], [0, O]];
  const inner = [[a, a], [b, a], [b, b], [a, b]];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = outer[i], [x1, y1] = outer[(i + 1) % 4];
    quad(p, P(x0, y0, 0), P(x1, y1, 0), P(x1, y1, Hz), P(x0, y0, Hz)); // outer wall, faces out
    const [u0, v0] = inner[i], [u1, v1] = inner[(i + 1) % 4];
    quad(p, P(u1, v1, 0), P(u0, v0, 0), P(u0, v0, Hz), P(u1, v1, Hz)); // inner wall, faces into hole
    // top ring trapezoid (+z) and bottom (-z)
    quad(p, P(x0, y0, Hz), P(x1, y1, Hz), P(u1, v1, Hz), P(u0, v0, Hz));
    quad(p, P(x0, y0, 0), P(u0, v0, 0), P(u1, v1, 0), P(x1, y1, 0));
  }
  return makeMesh(p);
}

test('generated meshes are closed with the right volume', () => {
  const b = boxMesh([10, 20, 30]);
  assert.ok(checkClosed(b).closed);
  assert.ok(Math.abs(meshStats(b).volume - 6000) < 1e-6);
  const f = frameMesh();
  assert.ok(checkClosed(f).closed, JSON.stringify(checkClosed(f)));
  assert.ok(Math.abs(meshStats(f).volume - (400 - 100) * 10) < 1e-6);
});

test('binary STL round trip', () => {
  const b = boxMesh([10, 20, 30], [1, 2, 3]);
  const buf = writeBinarySTL(b);
  assert.equal(buf.length, 84 + 12 * 50);
  const m = parseSTL(buf);
  assert.equal(m.triangles, 12);
  assert.deepEqual(m.bbox.size, [10, 20, 30]);
  assert.deepEqual(m.bbox.min, [1, 2, 3]);
});

test('malformed binary STL coordinates and duplicate surfaces are detected', () => {
  const mesh = boxMesh([10, 10, 10]);
  const bytes = writeBinarySTL(mesh);
  bytes.writeFloatLE(NaN, 96);
  assert.throws(() => parseSTL(bytes), /non-finite/);
  const duplicate = makeMesh([...mesh.positions, ...mesh.positions]);
  assert.equal(checkClosed(duplicate).closed, false);
});

test('ASCII STL parse (even when the header says solid)', () => {
  const txt = `solid test
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1.5e0 0
 endloop
endfacet
endsolid test
`;
  const m = parseSTL(Buffer.from(txt));
  assert.equal(m.triangles, 1);
  assert.deepEqual(m.bbox.max, [1, 1.5, 0]);
  // Binary file whose header starts with "solid" is still read as binary.
  const b = writeBinarySTL(boxMesh([1, 1, 1]), 'solid but binary');
  assert.equal(parseSTL(b).triangles, 12);
});

for (const axis of ['x', 'y', 'z']) {
  test(`plane cut of a box along ${axis} gives two closed pieces`, () => {
    const b = boxMesh([40, 30, 20]);
    const at = { x: 15, y: 10, z: 5 }[axis];
    const r = planeCut(b, axis, at);
    const cb = checkClosed(r.below), ca = checkClosed(r.above);
    assert.ok(cb.closed, `below ${JSON.stringify(cb)}`);
    assert.ok(ca.closed, `above ${JSON.stringify(ca)}`);
    const vb = meshStats(r.below).volume, va = meshStats(r.above).volume;
    const ai = { x: 0, y: 1, z: 2 }[axis];
    const full = [40, 30, 20];
    const area = full.reduce((s, v) => s * v, 1) / full[ai];
    assert.ok(Math.abs(vb - area * at) < 1e-3, `below volume ${vb}`);
    assert.ok(Math.abs(va - area * (full[ai] - at)) < 1e-3, `above volume ${va}`);
    assert.ok(Math.abs(r.below.bbox.max[ai] - at) < 1e-3);
  });
}

test('plane cut through a box with a through-hole caps with a hole', () => {
  const f = frameMesh(20, 10, 10);
  // Cut across the hole axis: cap is a square ring.
  const r = planeCut(f, 'z', 4);
  assert.equal(r.caps.loops2d.length, 2);
  assert.ok(checkClosed(r.below).closed);
  assert.ok(checkClosed(r.above).closed);
  assert.ok(Math.abs(meshStats(r.below).volume - 300 * 4) < 1e-3);
  assert.ok(Math.abs(meshStats(r.above).volume - 300 * 6) < 1e-3);
  // Cut along the hole: two separate rectangles (no hole), each piece closed.
  const s = planeCut(f, 'x', 10);
  assert.equal(s.caps.loops2d.length, 2);
  assert.ok(checkClosed(s.below).closed && checkClosed(s.above).closed);
  assert.ok(Math.abs(meshStats(s.below).volume - 1500) < 1e-3);
  // Cut through the solid wall region beside the hole.
  const t = planeCut(f, 'y', 2.5);
  assert.equal(t.caps.loops2d.length, 1);
  assert.ok(checkClosed(t.below).closed && checkClosed(t.above).closed);
});

test('plane exactly on vertices is nudged, still closed', () => {
  const b = planeCut(boxMesh([10, 10, 10]), 'x', 5);
  const twice = planeCut(b.above, 'y', 5);
  assert.ok(checkClosed(twice.below).closed && checkClosed(twice.above).closed);
  const f = frameMesh();
  const r = planeCut(f, 'x', 5); // x = 5 is the hole edge
  assert.ok(checkClosed(r.below).closed && checkClosed(r.above).closed);
  assert.ok(Math.abs(r.offset - 5) < 1e-3);
});

test('triangulateLoops: polygon with two holes covers outer minus holes', () => {
  const outer = [[0, 0], [30, 0], [30, 10], [0, 10]];
  const h1 = [[2, 2], [2, 8], [8, 8], [8, 2]];
  const h2 = [[20, 3], [25, 3], [25, 7], [20, 7]];
  const loops = [outer, h1, h2];
  const { triangles } = triangulateLoops(loops);
  let area = 0;
  for (const t of triangles) area += polygonArea(t.map(([l, k]) => loops[l][k]));
  assert.ok(Math.abs(area - (300 - 36 - 20)) < 1e-9, `area ${area}`);
});

test('plane cut rejects planes outside the part', () => {
  assert.throws(() => planeCut(boxMesh([10, 10, 10]), 'z', 12), /outside/);
  assert.throws(() => planeCut(boxMesh([10, 10, 10]), 'q', 5), /axis/);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

function hasPython() { try { execFileSync('python3', ['--version']); return true; } catch { return false; } }

test('3MF zip is valid and its model XML parses', { skip: !hasPython() && 'python3 not available' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-3mf-'));
  const { plates, tooBig } = packPlates([
    { name: 'a', mesh: boxMesh([50, 40, 10]) },
    { name: 'b', mesh: boxMesh([60, 60, 5], [100, 100, 100]) },
    { name: 'c & <d>', mesh: frameMesh() },
  ], [180, 180]);
  assert.equal(plates.length, 1);
  assert.deepEqual(tooBig, []);
  const file = join(dir, 'plate.3mf');
  writeFileSync(file, plates[0].bytes);
  const py = `
import sys, zipfile, xml.etree.ElementTree as ET
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
names = z.namelist()
assert names == ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model'], names
ns = {'m': 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02'}
root = ET.fromstring(z.read('3D/3dmodel.model'))
objs = root.findall('m:resources/m:object', ns)
items = root.findall('m:build/m:item', ns)
ET.fromstring(z.read('[Content_Types].xml')); ET.fromstring(z.read('_rels/.rels'))
tris = sum(len(o.findall('m:mesh/m:triangles/m:triangle', ns)) for o in objs)
print(len(objs), len(items), tris, objs[2].get('name'))
`;
  const out = execFileSync('python3', ['-I', '-c', py, file], { encoding: 'utf8' }).trim();
  assert.equal(out, '3 3 56 c & <d>');
});

test('shelf packing respects the bed and reports overflow', () => {
  const r = shelfPack([{ size: [100, 100] }, { size: [100, 100] }, { size: [200, 10] }], [180, 180]);
  assert.equal(r.placed.length, 1);
  assert.deepEqual(r.overflow.sort(), [1, 2]);
  const z = writeZip([{ name: 'a.txt', data: 'hello' }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
});

test('shelf packing stays outside the slicer exclusion even on a full-width row', () => {
  const opts = { keepouts: [[0, 0, 18, 28]] };
  const result = shelfPack([{ size: [235, 50] }, { size: [50, 45] }], [256, 256], opts);
  assert.deepEqual(result.placed, [{ index: 0, x: 5, y: 28 }, { index: 1, x: 5, y: 83 }]);
  assert.deepEqual(result.overflow, []);
  const narrow = shelfPack([{ size: [85, 60] }], [256, 256], opts);
  assert.deepEqual(narrow.placed, [{ index: 0, x: 18, y: 5 }]);
});

test('rotating an odd axis permutation preserves winding and packing rejects excessive height', () => {
  const mesh = boxMesh([60, 125, 30], [-30, 10, 50]);
  const rotated = orientMesh(mesh, { axes: [0, 2, 1], rotationDeg: 0 });
  assert.deepEqual(rotated.bbox.size, [60, 30, 125]);
  assert.ok(checkClosed(rotated).closed);
  assert.equal(meshStats(rotated).volume, meshStats(mesh).volume);
  const result = packPlates([{ name: 'tall', mesh: rotated }], [100, 100, 120]);
  assert.deepEqual(result.plates, []);
  assert.deepEqual(result.tooBig, ['tall']);
});

test('print export rotates each fitting split mesh and leaves an out-of-bounds piece off the plate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-print-'));
  const source = join(dir, 'design.scad');
  const original = join(dir, 'original.stl');
  const rotated = join(dir, 'rotated.stl');
  const tall = join(dir, 'tall.stl');
  writeFileSync(source, 'cube([200, 20, 3]);');
  writeFileSync(original, writeBinarySTL(boxMesh([300, 100, 100])));
  writeFileSync(rotated, writeBinarySTL(boxMesh([200, 20, 3], [-50, 3, -7])));
  writeFileSync(tall, writeBinarySTL(boxMesh([169, 169, 181])));
  const project = join(dir, 'project.json');
  writeFileSync(project, JSON.stringify({
    printer: { profile: 'bambu-a1-mini', material: 'PLA' },
    prints: [{ id: 'frame', source, files: [original], pieces: [{ file: rotated }, { file: tall }] }],
  }));
  const out = join(dir, 'out');
  const cli = fileURLToPath(new URL('../bin/wiremap.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, 'export-print', '--project', project, '--out', out, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.plates.map(({ parts }) => parts), [['frame:rotated.stl']]);
  assert.deepEqual(report.tooBig, ['frame:tall.stl']);
  assert.equal(report.prints[0].fits, false);
  assert.ok(report.prints[0].pieceFits[0].rotationDeg > 0);
  assert.ok(existsSync(join(out, 'frame', 'assets', 'design.scad')));
  assert.ok(existsSync(join(out, 'frame', 'assets', 'rotated.stl')));
  assert.ok(existsSync(join(out, 'frame', 'oriented', 'rotated.3mf')));
  assert.equal(existsSync(join(out, 'frame', 'oriented', 'tall.3mf')), false);
  const plate = readFileSync(report.plates[0].file, 'utf8');
  const vertices = [...plate.matchAll(/<vertex x="([0-9.]+)" y="([0-9.]+)" z="([0-9.]+)"\/>/g)];
  assert.equal(vertices.length, 8);
  assert.ok(vertices.every(([, x, y, z]) => x <= 170 && y <= 170 && z <= 3));
});

test('print export retires stale generated 3MFs while preserving edited and untracked files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-print-rerun-'));
  const source = join(dir, 'deck.stl');
  const project = join(dir, 'project.json');
  const out = join(dir, 'out');
  writeFileSync(project, JSON.stringify({
    printer: { profile: 'bambu-a1-mini' },
    prints: [{ id: 'deck', files: [source] }],
  }));
  writeFileSync(source, writeBinarySTL(boxMesh([100, 60, 30])));
  const cli = fileURLToPath(new URL('../bin/wiremap.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [cli, 'export-print', '--project', project, '--out', out, '--json'], { encoding: 'utf8' });
  const original = run();
  assert.equal(original.status, 0, original.stdout + original.stderr);
  const same = run();
  assert.equal(same.status, 0, same.stdout + same.stderr);
  const plate = JSON.parse(original.stdout).plates[0].file;
  const userPlate = join(out, 'plates', 'user-slicer-project.3mf');
  const edited = join(out, 'deck', 'oriented', 'deck.3mf');
  writeFileSync(userPlate, 'existing user file');
  writeFileSync(edited, 'user-edited export');
  writeFileSync(source, writeBinarySTL(boxMesh([169, 169, 181])));

  const rerun = run();
  assert.equal(rerun.status, 1, rerun.stdout + rerun.stderr);
  const report = JSON.parse(rerun.stdout);
  assert.deepEqual(report.plates, []);
  assert.deepEqual(report.retired3mfs, ['plates/pla_plate_1.3mf']);
  assert.equal(existsSync(plate), false);
  assert.equal(readFileSync(userPlate, 'utf8'), 'existing user file');
  assert.equal(readFileSync(edited, 'utf8'), 'user-edited export');
  assert.match(report.warnings.join('\n'), /Preserved modified 3MF/);
  assert.match(report.warnings.join('\n'), /Preserved untracked 3MF/);
});

test('project fit and export check all selected STLs and try an alternate orientation for a reserved bed corner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-print-placement-'));
  const panel = join(dir, 'panel.stl');
  const oversized = join(dir, 'oversized.stl');
  const open = join(dir, 'open.stl');
  writeFileSync(panel, writeBinarySTL(boxMesh([240, 240, 10])));
  writeFileSync(oversized, writeBinarySTL(boxMesh([260, 260, 260])));
  writeFileSync(open, writeBinarySTL(makeMesh(boxMesh([10, 10, 10]).positions.slice(9))));
  const missing = join(dir, 'missing.stl');
  const project = join(dir, 'project.json');
  writeFileSync(project, JSON.stringify({
    printer: { profile: 'bambu-p1s' },
    prints: [
      { id: 'source-only', source: panel },
      { id: 'all-files', files: [panel, oversized] },
      { id: 'explicit-pieces', size: [10, 10, 10], files: [oversized], pieces: [{ file: panel }, { file: missing }, { file: open }] },
    ],
  }));
  const cli = fileURLToPath(new URL('../bin/wiremap.mjs', import.meta.url));
  const run = (command, ...extra) => {
    const result = spawnSync(process.execPath, [cli, command, '--project', project, '--json', ...extra], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const fit = run('fit-printer');
  assert.deepEqual(fit.results.map(({ from, fits }) => [from, fits]), [
    [panel, true], [panel, true], [oversized, false], [panel, true], [missing, false], [open, true],
  ]);
  assert.equal(fit.results.at(-1).closed, false);
  assert.equal(fit.results[0].orientation[2], 240);
  const report = run('export-print', '--out', join(dir, 'out'));
  assert.deepEqual(report.tooBig, ['all-files:oversized.stl']);
  assert.deepEqual(report.prints.map(({ fits }) => fits), [true, false, false]);
  assert.deepEqual(report.prints[0].pieceFits[0].orientation, fit.results[0].orientation);
  assert.equal(report.prints[2].pieceFits.at(-1).closed, false);
  assert.deepEqual(report.plates.flatMap(({ parts }) => parts).sort(), [
    'all-files:panel.stl', 'explicit-pieces:panel.stl', 'source-only:panel.stl',
  ]);
});

// Extrude an outer polygon (CCW) with one hole (CCW given, reversed inside) along z.
function tubeMesh(n = 32, R = 20, r = 6, h = 15) {
  const p = [];
  const ring = (rad) => Array.from({ length: n }, (_, i) => [rad * Math.cos(2 * Math.PI * i / n), rad * Math.sin(2 * Math.PI * i / n)]);
  const O = ring(R), I = ring(r);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quad(p, [...O[i], 0], [...O[j], 0], [...O[j], h], [...O[i], h]);
    quad(p, [...I[j], 0], [...I[i], 0], [...I[i], h], [...I[j], h]);
    quad(p, [...O[i], h], [...O[j], h], [...I[j], h], [...I[i], h]);
    quad(p, [...O[i], 0], [...I[i], 0], [...I[j], 0], [...O[j], 0]);
  }
  return makeMesh(p);
}

test('plane cuts of a round tube stay closed and conserve volume', () => {
  const t = tubeMesh();
  assert.ok(checkClosed(t).closed);
  const V = meshStats(t).volume;
  for (const [axis, at] of [['z', 7.3], ['x', 0.7], ['x', 10], ['y', -13.1]]) {
    const r = planeCut(t, axis, at);
    assert.ok(checkClosed(r.below).closed, `${axis}=${at} below ${JSON.stringify(checkClosed(r.below))}`);
    assert.ok(checkClosed(r.above).closed, `${axis}=${at} above`);
    const sum = meshStats(r.below).volume + meshStats(r.above).volume;
    assert.ok(Math.abs(sum - V) < 1e-2, `${axis}=${at}: ${sum} vs ${V}`);
    assert.ok(meshStats(r.below).volume > 0 && meshStats(r.above).volume > 0);
  }
});

test('split-part script: pieces are closed, fit, and the plan says no joints were added to the mesh', async () => {
  const { main } = await import('../scripts/split-part.mjs');
  const { saveSTL, readSTL } = await import('../lib/node/stl.js');
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-split-'));
  const src = join(dir, 'frame.stl');
  // A 320 mm long frame with a through-hole: too big for the A1 mini.
  const f = frameMesh(40, 10, 320);
  saveSTL(src, f);
  const log = console.log; console.log = () => {};
  let code;
  try { code = await main(['--stl', src, '--printer', 'bambu-a1-mini', '--out', join(dir, 'out'), '--name', 'frame']); } finally { console.log = log; }
  assert.equal(code, 0);
  const plan = JSON.parse(readFileSync(join(dir, 'out', 'frame.joints.json'), 'utf8'));
  assert.equal(plan.pieces.length, 2);
  assert.deepEqual(plan.applied_to_mesh, []);
  let vol = 0;
  for (const p of plan.pieces) {
    const m = readSTL(p.file);
    assert.ok(checkClosed(m).closed, p.file);
    assert.ok(p.fits);
    vol += meshStats(m).volume;
  }
  assert.ok(Math.abs(vol - meshStats(f).volume) < 1);
  assert.ok(readFileSync(join(dir, 'out', 'frame.joints.scad'), 'utf8').includes('cylinder(d = pin_d'));
  assert.ok(plan.cuts[0].features.length >= 2);
  for (const ft of plan.cuts[0].features) assert.ok(!(ft.pos[0] > 15 && ft.pos[0] < 25 && ft.pos[1] > 15 && ft.pos[1] < 25), 'pin not in the hole');
});

test('split-part exports the fitted 3MF orientation and preserves the STL joint coordinates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-split-orientation-'));
  const src = join(dir, 'bar.stl');
  writeFileSync(src, writeBinarySTL(boxMesh([200, 20, 3], [-30, 2, 20])));
  const program = fileURLToPath(new URL('../scripts/split-part.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [program, '--stl', src, '--printer', 'bambu-a1-mini', '--cut', 'y:10', '--out', dir, '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.equal(plan.pieces.length, 2);
  for (const piece of plan.pieces) {
    assert.equal(parseSTL(readFileSync(piece.file)).bbox.min[2], 20);
    assert.ok(piece.rotationDeg > 0, 'uses the fitted diagonal orientation');
    const xml = readFileSync(piece.threemf).toString('utf8'); // The 3MF ZIP stores its XML uncompressed.
    const placement = xml.match(/<item objectid="1" transform="([\d .-]+)"\/>/)[1].split(' ').slice(9).map(Number);
    const vertices = Array.from(xml.matchAll(/<vertex x="([\d.-]+)" y="([\d.-]+)" z="([\d.-]+)"\/>/g), (vertex) => vertex.slice(1).map((value, axis) => Number(value) + placement[axis]));
    assert.ok(vertices.length > 0);
    assert.ok(vertices.every(([x, y]) => x >= 5 && x <= 175 && y >= 5 && y <= 175));
    assert.equal(Math.min(...vertices.map((vertex) => vertex[2])), 0);
  }
});

test('split-part keeps CAD pieces but withholds unplaceable plates and rejects ineffective cuts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-split-failure-'));
  const src = join(dir, 'panel.stl');
  writeFileSync(src, writeBinarySTL(boxMesh([265, 200, 8])));
  const program = fileURLToPath(new URL('../scripts/split-part.mjs', import.meta.url));
  const args = [program, '--stl', src, '--printer', 'bambu-a1-mini', '--out', dir, '--json'];
  const ineffective = spawnSync(process.execPath, [...args, '--cut', 'y:200'], { encoding: 'utf8' });
  assert.equal(ineffective.status, 2, ineffective.stdout + ineffective.stderr);
  assert.match(JSON.parse(ineffective.stdout).error, /does not split any piece/i);

  const blocked = spawnSync(process.execPath, [...args, '--cut', 'y:100'], { encoding: 'utf8' });
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  const plan = JSON.parse(blocked.stdout);
  assert.equal(plan.pieces.length, 2);
  for (const [index, piece] of plan.pieces.entries()) {
    assert.equal(piece.fits, false);
    assert.equal(piece.threemf, null);
    assert.ok(existsSync(piece.file));
    assert.ok(!existsSync(join(dir, `panel_${index + 1}-of-2.3mf`)));
  }
});

test('split-part labels older plates when the current mesh is open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-split-open-'));
  const src = join(dir, 'case.stl');
  const box = boxMesh([100, 20, 20]);
  writeFileSync(src, writeBinarySTL(box));
  const oldPlate = join(dir, 'case_1-of-1.3mf');
  const program = fileURLToPath(new URL('../scripts/split-part.mjs', import.meta.url));
  const args = [program, '--stl', src, '--printer', 'bambu-a1-mini', '--out', dir, '--json'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const previous = readFileSync(oldPlate);

  writeFileSync(src, writeBinarySTL(makeMesh(box.positions.slice(9))));
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(second.status, 1, second.stdout + second.stderr);
  const plan = JSON.parse(second.stdout);
  assert.equal(plan.pieces[0].closed, false);
  assert.equal(plan.pieces[0].threemf, null);
  assert.match(plan.warnings.join('\n'), /open edges/);
  assert.match(plan.warnings.join('\n'), /Earlier 3MFs.*case_1-of-1\.3mf/);
  assert.deepEqual(readFileSync(oldPlate), previous);
});
