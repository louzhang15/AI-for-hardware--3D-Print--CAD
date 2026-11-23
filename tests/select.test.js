// Part trade-offs: candidates are swapped into the real project and re-checked,
// so mass coupling between joints and supply current show up in the verdicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareActuators, compareSupplies, compareRole, swapPart } from '../lib/select.js';
import { loadLibrary } from '../lib/node/library.js';

const library = loadLibrary();
const load = (name) => JSON.parse(readFileSync(new URL(`../projects/${name}.json`, import.meta.url)));
const arm = load('robot-arm');
const rover = load('rover');
const byId = (r, id) => r.candidates.find((c) => c.id === id);

test('shoulder: MG996R is the pick for torque and the supply cost is spelled out', () => {
  const r = compareActuators(arm, library, { joint: 'shoulder' });
  assert.equal(r.kind, 'actuator');
  assert.equal(r.current.id, 'servo-sg90');
  const mg = byId(r, 'servo-mg996r');
  assert.equal(mg.verdict, 'pick');
  assert.ok(mg.margin > 5, `MG996R shoulder margin ${mg.margin}`);
  assert.ok(mg.rail.peak > mg.rail.capacity, 'four stalls exceed the 4 A supply');
  assert.ok(mg.requires.some((x) => /supply of at least/.test(x)));
  assert.ok(mg.reasons.some((x) => /peaks at 4\.6 A/.test(x)));
  const sg = byId(r, 'servo-sg90');
  assert.equal(sg.current, true);
  assert.equal(sg.verdict, 'works', 'SG90 shoulder sits just under the 2x safety factor');
  assert.equal(r.candidates[0].verdict, 'pick');
});

test('continuous servos and plain gear motors are rejected with the reason', () => {
  const r = compareActuators(arm, library, { joint: 'shoulder' });
  const fs90r = byId(r, 'servo-fs90r');
  assert.equal(fs90r.verdict, 'rejected');
  assert.match(fs90r.reasons[0], /continuous rotation/);
  assert.equal(byId(r, 'dc-motor-tt').verdict, 'rejected');
  assert.equal(byId(r, 'nema17-stepper').verdict, 'rejected');
});

test('mass coupling: a heavier elbow servo lowers the shoulder margin', () => {
  const r = compareActuators(arm, library, { joint: 'elbow' });
  const mg = byId(r, 'servo-mg996r');
  assert.equal(mg.added_mass_g, 46);
  const sh = mg.others.find((o) => o.joint === 'shoulder');
  assert.ok(sh.after < sh.before, `shoulder ${sh.before} -> ${sh.after}`);
  assert.ok(mg.reasons.some((x) => /Adds 46 g at the elbow: shoulder margin drops/.test(x)));
  assert.notEqual(mg.verdict, 'pick', 'below the safety factor at the shoulder after the swap');
  const stepper = byId(r, 'nema17-stepper');
  assert.equal(stepper.verdict, 'rejected', '280 g at the elbow stalls the shoulder');
  assert.ok(stepper.reasons.some((x) => /shoulder stalls/.test(x)));
});

test('supplies: current 5 V 4 A servo supply is the pick, out-of-window sources are rejected', () => {
  const r = compareSupplies(arm, library, { part: 'servo-supply' });
  assert.equal(r.rail.peak, 2.8);
  const cur = r.candidates.find((c) => c.current);
  assert.equal(cur.verdict, 'pick');
  assert.equal(cur.capacity, 4, 'project override of the rated current is used');
  const six = byId(r, 'dc-adapter-6v-5a');
  assert.equal(six.verdict, 'rejected');
  assert.match(six.reasons.join(' '), /6\.3 V \(full\) is over the 6 V limit of 4 loads/);
  assert.equal(byId(r, 'lipo-2s').verdict, 'rejected');
  assert.match(byId(r, 'buck-lm2596').reasons.join(' '), /Rated 2 A, below the 2\.8 A peak/);
  assert.ok(byId(r, 'buck-lm2596').requires.some((x) => /input supply/.test(x)));
});

test('linear regulator heat is reported in watts', () => {
  const r = compareSupplies(arm, library, { part: 'esp' });
  const ams = byId(r, 'ams1117-3v3-module');
  assert.ok(ams.heat_w > 0, 'heat from (5 - 3.3) V x load');
  assert.match(ams.reasons.join(' '), /Linear: drops 1\.7 V/);
});

test('compareRole dispatches by category and explains unsupported parts', () => {
  assert.equal(compareRole(arm, library, 'servo-elbow').joint, 'elbow');
  assert.equal(compareRole(rover, library, 'drive-supply').kind, 'supply');
  assert.throws(() => compareRole(rover, library, 'motor-left'), /not an arm joint/);
  assert.throws(() => compareRole(rover, library, 'esp'), /No comparison for esp/);
  assert.throws(() => swapPart(arm, 'nope', 'servo-sg90'), /No part/);
});

test('wiremap compare CLI prints verdicts and JSON', () => {
  const cli = fileURLToPath(new URL('../bin/wiremap.mjs', import.meta.url));
  const proj = fileURLToPath(new URL('../projects/robot-arm.json', import.meta.url));
  const t = spawnSync(process.execPath, [cli, 'compare', proj, '--joint', 'shoulder'], { encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /PICK MG996R/);
  const j = spawnSync(process.execPath, [cli, 'compare', proj, '--part', 'servo-supply', '--json'], { encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  assert.equal(JSON.parse(j.stdout).kind, 'supply');
  assert.equal(spawnSync(process.execPath, [cli, 'compare', proj, '--part', 'esp'], { encoding: 'utf8' }).status, 2);
});
