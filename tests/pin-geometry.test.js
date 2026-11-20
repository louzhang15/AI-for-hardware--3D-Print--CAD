import assert from 'node:assert/strict';
import test from 'node:test';
import { pinPlacement } from '../viewer/pin-geometry.js';

const part = { size: [30, 10, 20], pins: [{ name: 'D21' }, { name: 'D22' }] };

test('pins use the footprint origin and the declared physical height', () => {
  assert.deepEqual(pinPlacement(part, { pos: [2, 17], z: 4 }, 0), { anchor: [-13, 4, 7], mapped: true });
  assert.deepEqual(pinPlacement(part, { pos: [2, 17] }, 0), { anchor: [-13, 10, 7], mapped: true });
});

test('a positioned lateral connector has an estimated height unless it is specified', () => {
  const enclosure = { ...part, breadboard: { fit: 'offboard' }, geometry: { connectors: [{ side: 'left', pos: [0, 10] }] } };
  assert.deepEqual(pinPlacement(enclosure, { pos: [0, 11] }, 0), { anchor: [-15, 5, 1], mapped: false, normal: [-1, 0, 0] });
  assert.deepEqual(pinPlacement(part, {}, 0), { anchor: [-5, 10, 0], mapped: false });
});
