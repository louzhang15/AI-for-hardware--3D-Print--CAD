import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fitPart, suggestSplit, materialCheck, nozzleVolume, usableVolume, diagonalFit } from '../lib/printer.js';

const load = (id) => JSON.parse(readFileSync(new URL(`../printers/${id}.json`, import.meta.url), 'utf8'));
const mini = load('bambu-a1-mini');
const a1 = load('bambu-a1');
const p1s = load('bambu-p1s');
const h2d = load('bambu-h2d');

test('printer profiles have the required fields', () => {
  const ids = readdirSync(new URL('../printers/', import.meta.url)).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  for (const id of ['bambu-a1-mini', 'bambu-a1', 'bambu-p1s', 'bambu-p2s', 'bambu-x1c', 'bambu-h2d', 'generic']) assert.ok(ids.includes(id), id);
  for (const id of ids) {
    const p = load(id);
    assert.equal(p.id, id);
    for (const k of ['name', 'maker', 'volume', 'nozzle_diameter', 'enclosed', 'heated_bed', 'materials', 'margin_mm', 'send', 'clearance_mm', 'notes', 'sources', 'spec_checked']) assert.ok(k in p, `${id}.${k}`);
    assert.equal(p.volume.length, 3);
    for (const f of ['press', 'snug', 'sliding', 'free']) assert.ok(p.clearance_mm[f] > 0);
    assert.ok(Array.isArray(p.materials.ok) && typeof p.materials.warn === 'object' && Array.isArray(p.materials.no));
  }
  assert.deepEqual(mini.volume, [180, 180, 180]);
  for (const id of ['bambu-a1', 'bambu-p1s', 'bambu-p2s', 'bambu-x1c']) assert.deepEqual(load(id).volume, [256, 256, 256]);
  assert.deepEqual(h2d.nozzles.both, [300, 320, 325]);
  assert.deepEqual(h2d.volume, [325, 320, 325]);
});

test('fitPart: fits as given, picks the lowest height', () => {
  const r = fitPart([200, 120, 40], a1);
  assert.equal(r.fits, true);
  assert.deepEqual(r.orientation, [200, 120, 40]);
  assert.deepEqual(r.usable, [246, 246, 256]);
  const t = fitPart([20, 150, 30], mini);
  assert.equal(t.fits, true);
  assert.equal(t.orientation[2], 20);
});

test('fitPart: reorients a tall part', () => {
  const r = fitPart([100, 175, 100], { ...mini, margin_mm: 5 }); // 175 > 170 usable in XY but fine in Z
  assert.equal(r.fits, true);
  assert.equal(r.orientation[2], 175);
});

test('fitPart: diagonal fit on the A1 mini', () => {
  // 200 x 20 does not fit 170 x 170 straight but does on the diagonal.
  const r = fitPart([200, 20, 10], mini);
  assert.equal(r.fits, true);
  assert.ok(r.rotationDeg > 0 && r.rotationDeg < 90);
  assert.equal(fitPart([200, 20, 10], mini, { allowDiagonal: false }).fits, false);
  assert.ok(diagonalFit(200, 20, 170, 170) !== null);
});

test('fitPart: too big gets a split suggestion', () => {
  const r = fitPart([300, 200, 40], mini);
  assert.equal(r.fits, false);
  assert.ok(r.split.pieces >= 2);
  assert.match(r.suggestion, /Split into/);
});

test('suggestSplit: even planes, keep-outs avoided, pieces fit', () => {
  const s = suggestSplit([300, 150, 40], mini);
  assert.equal(s.pieces, 2);
  assert.deepEqual(s.cuts, [{ axis: 'x', at: [150] }]);
  const k = suggestSplit([300, 150, 40], mini, { keepouts: { x: [[145, 155]] } });
  assert.equal(k.pieces, 2);
  const at = k.cuts[0].at[0];
  assert.ok(at <= 142 || at >= 158, String(at));
  assert.ok(Math.max(at, 300 - at) <= 170);
  const big = suggestSplit([500, 400, 30], mini);
  assert.equal(big.pieces, 9);
  for (const v of big.pieceSize.slice(0, 2)) assert.ok(v <= 170);
});

test('H2D: per-nozzle volumes', () => {
  assert.deepEqual(nozzleVolume(h2d, 'left'), [325, 320, 325]);
  assert.deepEqual(nozzleVolume(h2d, 'both'), [300, 320, 325]);
  assert.deepEqual(nozzleVolume(h2d), [325, 320, 325]);
  assert.throws(() => nozzleVolume(h2d, 'middle'));
  assert.throws(() => nozzleVolume(mini, 'both'));
  const part = [300, 300, 300];
  assert.equal(fitPart(part, h2d, { nozzle: 'left' }).fits, true);
  assert.equal(fitPart(part, h2d, { nozzle: 'both', allowDiagonal: false }).fits, false);
  assert.deepEqual(usableVolume(h2d, { nozzle: 'both' }), [290, 310, 325]);
});

test('materialCheck: open frame vs ABS', () => {
  assert.equal(materialCheck('ABS', a1).status, 'warn');
  assert.equal(materialCheck('abs', p1s).status, 'ok');
  assert.equal(materialCheck('PLA', mini).status, 'ok');
  assert.equal(materialCheck('PC', mini).status, 'no');
  assert.equal(materialCheck('unobtainium', mini).status, 'unknown');
  assert.match(materialCheck('ASA', mini).reason, /Open frame/);
});
