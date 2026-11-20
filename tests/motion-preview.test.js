import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceRover, armPose } from '../viewer/motion-preview.js';

test('arm yaw, elevation and gripper adjustments preserve the base and move different endpoints', () => {
  const neutral = armPose(0, 0, 0, 0);
  const yawed = armPose(45, 0, 0, 0);
  const raised = armPose(0, 20, 0, 0);
  const open = armPose(0, 0, 0, 20);
  assert.deepEqual(yawed.links[0], neutral.links[0]);
  assert.notDeepEqual(yawed.links[2], neutral.links[2]);
  assert.ok(raised.links[1][1] < neutral.links[1][1]);
  assert.deepEqual(open.links, neutral.links);
  assert.notDeepEqual(open.jaws, neutral.jaws);
});

test('rover preview moves forward with matched motors and rotates with opposing motors', () => {
  const center = { x: 300, y: 195, heading: 0 };
  const forward = advanceRover(center, 40, 40, .5);
  assert.ok(forward.x > center.x);
  assert.equal(forward.y, center.y);
  const rotate = advanceRover(center, -30, 30, .5);
  assert.equal(rotate.x, center.x);
  assert.equal(rotate.y, center.y);
  assert.ok(rotate.heading > center.heading);
});
