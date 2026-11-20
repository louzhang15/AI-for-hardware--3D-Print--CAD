import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMesh, parseSTL, writeBinarySTL, planeCut, meshStats, checkClosed, triangulateLoops, polygonArea } from '../lib/node/stl.js';
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
