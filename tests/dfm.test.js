// Print files and assembly: hand-built meshes with known areas and volumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { analyzeMesh, closedMesh, checkAssembly, itemBox, isBedSlinger } from '../lib/dfm.js';
import { armTipping, vehicleTipping, droneBalance, rcCar, kgcmToNm, centreOfMass } from '../lib/mech.js';
import { loadPrinters } from '../lib/node/library.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b}, got ${a}`);

/** Closed box from (x0,y0,z0) to (x1,y1,z1), outward normals. */
function box([x0, y0, z0], [x1, y1, z1]) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.flatMap((t) => t.flatMap((i) => v[i]));
}
function mesh(...boxes) {
  const positions = Float32Array.from(boxes.flat());
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], positions[i + a]); max[a] = Math.max(max[a], positions[i + a]); }
  return { positions, triangles: positions.length / 9, bbox: { min, max, size: [0, 1, 2].map((a) => max[a] - min[a]) } };
}
const A1M = loadPrinters()['bambu-a1-mini'];

test('size, mass and bed contact of a plain block', () => {
  const m = mesh(box([0, 0, 0], [10, 10, 10]));
  const A = analyzeMesh(m, { declaredSize: [10, 10, 10], material: 'PLA', infill: 100 });
  assert.deepEqual(A.problems, []);
  close(A.volume_cm3, 1, 1e-6); close(A.solid_mass_g, 1.2, 0.05); close(A.contact_mm2, 100, 1e-6);
  assert.equal(A.closed.closed, true);
});

test('wrong size and inch/mm mix-ups are errors', () => {
  const A = analyzeMesh(mesh(box([0, 0, 0], [85, 60, 3.2])), { declaredSize: [85, 60, 5] });
  assert.ok(A.problems.some((p) => p.rule === 'dfm-size' && p.level === 'error'));
  const B = analyzeMesh(mesh(box([0, 0, 0], [25.4, 50.8, 12.7])), { declaredSize: [1, 2, 0.5] });
  assert.match(B.problems.find((p) => p.rule === 'dfm-size').text, /inch/);
  const C = analyzeMesh(mesh(box([0, 0, 0], [60, 85, 3.2])), { declaredSize: [85, 60, 3.2] });
  assert.ok(!C.problems.some((p) => p.rule === 'dfm-size'), 'orientation does not matter');
});

test('open mesh, overhangs, tall parts', () => {
  const open = box([0, 0, 0], [10, 10, 10]).slice(9);
  assert.equal(closedMesh(Float32Array.from(open)).closed, false);
  // mushroom: 10 x 10 stem, 40 x 40 cap from z 20 to 25 (separate shells)
  const M = analyzeMesh(mesh(box([15, 15, 0], [25, 25, 20]), box([0, 0, 20], [40, 40, 25])), { supports: false });
  close(M.overhang_mm2, 1600, 1);
  assert.ok(M.problems.some((p) => p.rule === 'dfm-overhang'));
  const T = analyzeMesh(mesh(box([0, 0, 0], [20, 20, 100])), { profile: A1M });
  assert.ok(isBedSlinger(A1M));
  assert.ok(T.problems.some((p) => p.rule === 'dfm-tall'), 'height 100 on a 20 mm base wobbles on a bed slinger');
});

test('assembly boxes follow the viewer frame and 90° turns', () => {
  const b = itemBox('print', { id: 'p', size: [100, 80, 20], position: [0, 0, 0] });
  assert.deepEqual([b.min, b.max], [[-50, 0, -40], [50, 20, 40]]);
  const r = itemBox('print', { id: 'p', size: [100, 80, 20], position: [0, 0, 0], rotation: [0, 90, 0] });
  assert.deepEqual([r.min, r.max], [[-40, 0, -50], [40, 20, 50]]);
  const res = checkAssembly({ mechanics: { assembly: { allow_overlap: [['a', 'b']] } }, prints: [{ id: 'a', size: [10, 10, 10], position: [0, 0, 0] }, { id: 'b', size: [10, 10, 10], position: [2, 0, 0] }] });
  assert.deepEqual(res.problems, [], 'declared nesting is allowed');
  assert.equal(checkAssembly({ prints: [] }).report, null, 'opt-in only');
});

test('stability and balance, by hand', () => {
  // (200 + 74) g × 60 mm = 16440 g·mm against 8670 g·mm
  close(armTipping({ moment_gmm: 8670, arm_mass_g: 74, base: { mass_g: 200, footprint_mm: 60 } }).ratio, 1.9, 0.01);
  const t = vehicleTipping({ cg_height_mm: 40, track_mm: 150 });
  close(t.tip_angle_deg, (Math.atan(75 / 40) * 180) / Math.PI, 0.05);
  close(t.lateral_g, 1.88, 0.01);
  // worst motor = 650/4 × (1 + 2 × 10 / 110.3)
  close(droneBalance({ cg: [10, 0], motors: [[78, 78], [-78, 78], [-78, -78], [78, -78]], auw_g: 650 }).worst_motor_g, 162.5 * (1 + 20 / (78 * Math.SQRT2)), 0.1);
  const c = centreOfMass([{ id: 'a', mass_g: 100, position: [0, 0, 0] }, { id: 'b', mass_g: 300, position: [40, 0, 0] }, { id: 'c', position: [1, 1, 1] }]);
  assert.deepEqual(c.cg, [30, 0, 0]); assert.deepEqual(c.missing, ['c']);
});

test('RC steering torque, turning radius and top speed', () => {
  // F = 1.5 kg × 9.81 × 0.5 / 2 = 3.68 N; T = 0.9 × 3.68 × 10 mm = 33.1 N·mm per wheel; servo = 2 × T
  const r = rcCar({ mass_g: 1500, wheelbase_mm: 260, wheel_d_mm: 85, steering: { tire_width_mm: 30, horn_mm: 15, arm_mm: 15 }, drive: { kv: 3300, cells: 2, gear_ratio: 8 } }, { servoStallNm: kgcmToNm(1.8), servoSpeed: 0.1 });
  close(r.servo_needed_nm, 0.0662, 0.001);
  close(r.turn_radius_mm, 260 / Math.tan(Math.PI / 6), 0.1);
  close(r.top_speed_m_s, (3300 * 7.4 * 0.8 / 8) * Math.PI * 0.085 / 60, 0.01);
  const weak = rcCar({ mass_g: 4000, wheelbase_mm: 320, steering: { tire_width_mm: 60 } }, { servoStallNm: kgcmToNm(1.8) });
  assert.ok(weak.problems.some((p) => p.rule === 'mech-steering' && p.level === 'error'));
});

test('wiremap cad-check runs on the reference arm and a single STL', () => {
  const ok = spawnSync(process.execPath, [join(root, 'bin', 'wiremap.mjs'), 'cad-check', '--project', join(root, 'projects', 'robot-arm.json')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /electronics-deck: 85 × 60 × 3.2 mm/);
  const bad = spawnSync(process.execPath, [join(root, 'bin', 'wiremap.mjs'), 'cad-check', '--stl', join(root, 'cad', 'robot-arm', 'electronics-deck.stl'), '--printer', 'bambu-a1-mini', '--size', '85,60,5'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /dfm-size/);
});
