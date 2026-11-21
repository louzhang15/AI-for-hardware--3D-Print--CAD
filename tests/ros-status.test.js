import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectRosGraph, inspectRosLog } from '../scripts/ros-status.mjs';

const cli = fileURLToPath(new URL('../scripts/ros-status.mjs', import.meta.url));
const scratch = () => mkdtempSync(join(tmpdir(), 'wiremap-ros-'));

test('ROS launch text retains source, timestamp, severity and unknown lines', () => {
  const file = join(scratch(), 'bringup.log');
  writeFileSync(file, [
    '[INFO] [launch]: All log files can be found below',
    '[controller-1] \x1b[33m[WARN]\x1b[0m [1716719200.5] [rover.controller]: Motor response delayed',
    '[controller-1] [ERROR] [1716719202.1] [rover.controller]: Motor command timed out',
    '  at wheel_node.cpp:42',
  ].join('\n'));
  const report = inspectRosLog(file);
  assert.equal(report.source, 'bringup.log');
  assert.deepEqual(report.counts, { DEBUG: 0, INFO: 1, WARN: 1, ERROR: 1, FATAL: 0, UNKNOWN: 1 });
  assert.deepEqual(report.issues[0], {
    level: 'WARN', logger: 'rover.controller', timestamp: '1716719200.5', message: 'Motor response delayed',
  });
  assert.equal(report.recent.at(-1).message, 'at wheel_node.cpp:42');
});

test('bounded text tail and PowerShell UTF-16 JSONL are readable', () => {
  const dir = scratch();
  const long = join(dir, 'large.txt');
  writeFileSync(long, 'x'.repeat(150_000) + '\n[ERROR] [node]: Relevant tail\n');
  const bounded = inspectRosLog(long);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.sampledEntries, 1);

  const path = join(dir, 'rosout.jsonl');
  writeFileSync(path, Buffer.from('\ufeff' + [
    JSON.stringify({ level: 40, name: '/robot/driver', stamp: { sec: 12, nanosec: 3 }, msg: 'Device disconnected' }),
    '{invalid}',
    JSON.stringify({ level: '__proto__', msg: 'Nonstandard level' }),
  ].join('\r\n'), 'utf16le'));
  const report = JSON.parse(execFileSync(process.execPath, [cli, '--file', path, '--json'], { encoding: 'utf8' }));
  assert.equal(report.sampledEntries, 2);
  assert.equal(report.counts.UNKNOWN, 1);
  assert.equal(report.skipped, 1);
  assert.deepEqual(report.issues[0], {
    level: 'ERROR', logger: '/robot/driver', timestamp: '12.000000003', message: 'Device disconnected',
  });
});

test('ROS 2 graph reports typed topics, verbose endpoint metadata, sample and partial failures', async () => {
  const responses = new Map([
    ['node list --no-daemon', { ok: true, output: '/robot/controller\n/robot/controller', warning: 'Duplicate names' }],
    ['topic list -t --no-daemon', { ok: true, output: '/imu/data [sensor_msgs/msg/Imu]\n/rosout [rcl_interfaces/msg/Log]' }],
    ['topic info --verbose --no-daemon /imu/data', { ok: true, output: 'Type: sensor_msgs/msg/Imu\nPublisher count: 1\nSubscription count: 0\nReliability: BEST_EFFORT' }],
    ['topic echo --once --no-daemon /imu/data', { ok: true, output: 'angular_velocity:\n  x: 0.1\n---' }],
  ]);
  const report = await inspectRosGraph({ topic: '/imu/data', sample: true, timeoutMs: 4000, run: async (args, timeout) => {
    assert.equal(timeout, 4000);
    assert.ok(responses.has(args.join(' ')));
    return responses.get(args.join(' '));
  } });
  assert.deepEqual(report.nodes, ['/robot/controller', '/robot/controller']);
  assert.deepEqual(report.topics[0], { name: '/imu/data', types: ['sensor_msgs/msg/Imu'] });
  assert.equal(report.publisherCount, 1);
  assert.equal(report.subscriberCount, 0);
  assert.match(report.endpoint, /BEST_EFFORT/);
  assert.match(report.sample, /x: 0.1/);
  assert.equal(report.warnings[0].source, 'nodes');

  const partial = await inspectRosGraph({ run: async ([source]) => source === 'node'
    ? { ok: false, error: 'ROS 2 timed out' } : { ok: true, output: '/test [std_msgs/msg/String]' } });
  assert.deepEqual(partial.failures, [{ source: 'nodes', message: 'ROS 2 timed out' }]);
  assert.equal(partial.topics[0].name, '/test');
  await assert.rejects(() => inspectRosGraph({ topic: '--include-hidden', run: assert.fail }), /absolute ROS topic/);
});

test('missing ROS 2 exits with a useful error and usage errors are distinct', () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = scratch();
  const missing = spawnSync(process.execPath, [cli, '--json'], { env, encoding: 'utf8' });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(JSON.parse(missing.stdout).failures[0].message, /ROS 2 CLI is unavailable/);
  assert.equal(spawnSync(process.execPath, [cli, '--sample']).status, 2);
});
