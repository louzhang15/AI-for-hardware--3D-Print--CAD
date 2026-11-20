import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/wiremap.mjs', import.meta.url));

test('new creates a usable copy of the robot arm in the requested directory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-new-'));
  const args = [cli, 'new', '--dir', dir, 'robot-arm', 'Test Arm'];
  const file = join(dir, 'test-arm.json');
  t.after(() => {
    if (existsSync(file)) unlinkSync(file);
    rmdirSync(dir);
  });
  const created = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const contents = readFileSync(file, 'utf8');
  const project = JSON.parse(contents);
  assert.equal(project.meta.name, 'Test Arm');
  assert.equal(project.meta.phase, 'define');
  assert.ok(project.steps.every((step) => !step.done));
  assert.deepEqual(project.parts.find((part) => part.id === 'esp').bb, { offboard: true });
  const checked = spawnSync(process.execPath, [cli, 'check', file], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);

  const duplicate = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /already exists/);
  assert.equal(readFileSync(file, 'utf8'), contents);
});
