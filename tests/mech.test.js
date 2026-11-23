// Mechanical and robotics engine: values checked by hand against ISO 286
// tables, beam/bolt formulas and closed-form kinematics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../lib/mech.js';
import { checkProject } from '../lib/check.js';
import { loadLibrary, loadPrinters } from '../lib/node/library.js';

const close = (a, b, tol = 1e-3, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b}, got ${a}`);

test('ISO 286 fits match the published tables', () => {
  // Ø20 H7/g6: hole 0/+21 µm, shaft -7/-20 µm
  const a = M.isoFit({ nominal: 20, fit: 'H7/g6' });
  assert.deepEqual(a.clearance, { min: 0.007, max: 0.041 });
  assert.equal(a.type, 'clearance');
  // Ø22 H7/p6: shaft +22/+35 µm -> interference
  const b = M.isoFit({ nominal: 22, fit: 'H7/p6' });
  assert.deepEqual(b.clearance, { min: -0.035, max: -0.001 });
  assert.equal(b.type, 'interference');
  // Ø8 H7/k6: transition; Ø60 s6 = +53/+72 (split range)
  assert.equal(M.isoFit({ nominal: 8, fit: 'H7/k6' }).type, 'transition');
  assert.deepEqual([M.isoFit({ nominal: 60, fit: 'H7/s6' }).shaft.ei_um, M.isoFit({ nominal: 60, fit: 'H7/s6' }).shaft.es_um], [53, 72]);
  // Ø10 H7/h6 locating: 0 to 0.024
  assert.deepEqual(M.isoFit({ nominal: 10, fit: 'H7/h6' }).clearance, { min: 0, max: 0.024 });
  assert.equal(M.itTolerance(7, 25), 21);
  assert.throws(() => M.isoFit({ nominal: 10, fit: 'K7/h6' }), /hole letter/);
  assert.throws(() => M.isoFit({ nominal: 200, fit: 'H7/g6' }), /120/);
});

test('stack-up: worst case vs RSS', () => {
  const r = M.stackup({ dims: [{ nominal: 20, tol: 0.1 }, { nominal: 10, tol: 0.05, sign: -1 }, { nominal: 9.8, tol: 0.05, sign: -1 }], min_gap: 0.05 });
  close(r.nominal, 0.2); close(r.worst.min, 0); close(r.worst.max, 0.4);
  close(r.rss.min, 0.2 - Math.sqrt(0.01 + 0.0025 + 0.0025));
  assert.equal(r.ok, false); assert.equal(r.ok_rss, true);
});

test('bolt: steel shear vs printed plate bearing', () => {
  const r = M.bolt({ size: 'M3', count: 4, load_n: 400, mode: 'shear', plate_mm: 3, plate_material: 'PLA' });
  close(r.steel_n, 0.6 * 5.03 * 580, 0.1);
  close(r.plate_n, 3 * 3 * 50, 0.1);
  assert.equal(r.limited_by, 'printed plate');
  close(r.margin, 4.5, 0.01);
});

test('beam: σ = M/Z and δ = FL³/3EI', () => {
  const r = M.beam({ length_mm: 100, section: { type: 'rect', w: 10, h: 4 }, tip_load_n: 10, fill: 1, sf: 1 });
  // Z = 10·4²/6 = 26.67, M = 1000 → σ = 37.5 MPa
  close(r.stress_mpa, 37.5, 0.01);
  // I = 10·64/12 = 53.33, E = 3500 MPa → δ = 10·1e6 / (3·3500·53.33) = 17.86 mm
  close(r.deflection_mm, 17.857, 0.01);
  close(M.section({ type: 'tube', od: 10, id: 6 }).I, (Math.PI * (10 ** 4 - 6 ** 4)) / 64, 1e-6);
});

test('gears: ratio, centre distance, Lewis stress and printability', () => {
  const g = M.gear({ module: 1, z1: 12, z2: 36, torque_nm: 0.5, face_mm: 6 });
  assert.equal(g.ratio, 3); assert.equal(g.centre_distance_mm, 24);
  close(g.root_stress_mpa, 83.33 / (6 * 1 * 0.245), 0.05);
  assert.ok(g.problems.some((p) => /undercut/.test(p.text)));
  assert.ok(M.gear({ module: 0.5, z1: 20, z2: 40 }).problems.some((p) => /nozzle/.test(p.text)));
  close(M.lewisY(20), 0.322, 1e-9);
});

test('kinematics: FK, IK round trip, singularity', () => {
  const chain = [{ id: 'b', type: 'yaw', link_mm: 40 }, { id: 's', type: 'pitch', link_mm: 100 }, { id: 'e', type: 'pitch', link_mm: 100 }];
  const fk = M.forwardKinematics(chain, [90, 0, 90]);
  close(fk.tip.x, 0, 1e-6); close(fk.tip.y, 100, 1e-6); close(fk.tip.z, 140, 1e-6);
  const target = M.forwardKinematics(chain, [30, 40, -70]).tip;
  const ik = M.inverseKinematics(chain, target, { start: [0, 20, -30] });
  assert.ok(ik.ok, `IK error ${ik.error_mm}`);
  // stretched straight = singular, bent elbow = dexterous
  assert.ok(M.manipulability(chain, [0, 30, 0]) < 0.01);
  assert.ok(M.manipulability(chain, [0, 30, -90]) > 0.2);
});

test('arm torque: worst pose over the range, by hand', () => {
  const chain = [{ id: 'base', type: 'yaw', link_mm: 40 }, { id: 'sh', type: 'pitch', link_mm: 100, link_mass_g: 20, range: [0, 0] }, { id: 'el', type: 'pitch', link_mm: 100, link_mass_g: 20, range: [0, 0] }];
  const A = M.armAnalysis({ payload_g: 50, joints: chain, accel_rad_s2: 0 }, { actuators: { el: { mass_g: 10, stall_nm: 1 }, sh: { stall_nm: 1 } } });
  // shoulder: 20 g @ 50 + 10 g (elbow servo) @ 100 + 20 g @ 150 + 50 g @ 200 = 15000 g·mm
  close(A.joints[1].static_nm, (15000 / 1e6) * M.G, 0.001);
  // elbow: 20 g @ 50 + 50 g @ 100 = 6000 g·mm
  close(A.joints[2].static_nm, (6000 / 1e6) * M.G, 0.001);
  close(A.reach_mm, 200, 0.1);
});

test('drone and rover sizing', () => {
  const d = M.drone({ auw_g: 650, motors: 4, thrust_g: 600, current_a: 18, frame_mm: 220, prop_in: 5, battery: { mah: 1500, c: 75 } });
  close(d.twr, 3.69, 0.01); close(d.prop_gap_mm, 220 / Math.SQRT2 - 127, 0.1);
  assert.deepEqual(d.problems, []);
  const r = M.rover({ mass_g: 1000, wheel_d_mm: 60, driven_wheels: 2, slope_deg: 0, crr: 0, accel_m_s2: 1 });
  close(r.force_n, 1, 1e-6); close(r.torque_per_wheel_nm, 0.015, 1e-6);
});

test('servo torque data and unit conversion', () => {
  close(M.kgcmToNm(1.8), 0.1765, 1e-4);
  const t = [{ v: 4.8, stall_nm: 0.922 }, { v: 6, stall_nm: 1.079 }];
  close(M.actuatorTorque({ torque: t }, 5.4), 1.0005, 1e-3);
  close(M.actuatorTorque({ torque: t }), 0.922, 1e-9);
});

test('reference projects get a mechanical report with printer-aware fits', () => {
  const lib = loadLibrary();
  const printers = loadPrinters();
  const arm = checkProject(JSON.parse(readFileSync(new URL('../projects/robot-arm.json', import.meta.url))), lib, { printers });
  assert.equal(arm.errors, 0);
  assert.ok(arm.mechanics.arm.joints.find((j) => j.id === 'shoulder').margin > 1);
  assert.ok(arm.mechanics.fits.every((f) => f.source.startsWith('printer profile')));
  assert.ok(!arm.issues.some((i) => i.rule === 'mech-printed-fit'), 'reference fits match the A1 mini profile');
  assert.ok(arm.mechanics.arm.targets.every((t) => t.ok));
  const rover = checkProject(JSON.parse(readFileSync(new URL('../projects/rover.json', import.meta.url))), lib, { printers });
  assert.ok(rover.mechanics.rover.margin >= 2);
  assert.ok(arm.mechanics.arm.tipping.ratio >= 1.5, 'reference arm base does not tip');
  assert.ok(rover.mechanics.rover.tipping.tip_angle_deg > 45);
  assert.deepEqual(arm.mechanics.assembly.interference, []);
});
