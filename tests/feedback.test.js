import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { feedbackPath, listFeedback, recordFeedback, reviewFeedback } from '../lib/node/feedback.js';

const cli = fileURLToPath(new URL('../bin/wiremap.mjs', import.meta.url));

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-feedback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const correction = {
  project: 'projects/Arm.json',
  original: 'The board has a 5 V signal input.',
  correction: 'The controller input is 3.3 V only.',
  evidence: 'Measured logic rail and checked the part datasheet.',
};

test('feedback stays pending until explicitly approved and respects scope', (t) => {
  const dir = workspace(t);
  assert.deepEqual(listFeedback(dir, { all: true }), []);
  const first = recordFeedback(dir, { ...correction, status: 'approved', scope: 'workspace' });
  const second = recordFeedback(dir, { ...correction, project: 'rover', evidence: undefined });
  assert.equal(first.project, 'Arm');
  assert.equal(first.status, 'pending');
  assert.equal(first.scope, 'project');
  assert.equal(second.evidence, '');
  assert.deepEqual(listFeedback(dir, { project: 'Arm' }), []);
  assert.deepEqual(listFeedback(dir, { project: 'Arm', all: true }), [first]);
  assert.deepEqual(listFeedback(dir, { all: true }), [second, first]);

  const projectApproval = reviewFeedback(dir, first.id, { status: 'approved' });
  assert.deepEqual(listFeedback(dir, { project: 'projects/Arm.json' }), [projectApproval]);
  assert.deepEqual(listFeedback(dir, { project: 'arm' }), []);
  assert.deepEqual(listFeedback(dir), []);

  const workspaceApproval = reviewFeedback(dir, first.id, { status: 'approved', scope: 'workspace' });
  assert.deepEqual(listFeedback(dir, { project: 'rover' }), [workspaceApproval]);
  assert.deepEqual(listFeedback(dir, { project: 'rover', all: true }), [second, workspaceApproval]);
  assert.deepEqual(listFeedback(dir), [workspaceApproval]);

  const dismissed = reviewFeedback(dir, first.id, { status: 'dismissed' });
  assert.deepEqual(listFeedback(dir), []);
  assert.deepEqual(listFeedback(dir, { project: 'Arm', all: true }), [dismissed]);
  const log = readFileSync(feedbackPath(dir), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((entry) => entry.type), ['record', 'record', 'review', 'review', 'review']);
  assert.equal(log[0].status, 'pending');
});

test('malformed and interrupted lines preserve earlier feedback and allow later appends', (t) => {
  const dir = workspace(t);
  const first = recordFeedback(dir, correction);
  appendFileSync(feedbackPath(dir), JSON.stringify({
    type: 'review', id: first.id, ts: first.ts, status: 'approved', scope: 'everywhere',
  }) + '\n{"type":"review"');
  assert.deepEqual(listFeedback(dir, { project: 'Arm' }), []);
  const approved = reviewFeedback(dir, first.id, { status: 'approved' });
  const second = recordFeedback(dir, { ...correction, project: 'arm.json' });
  assert.deepEqual(listFeedback(dir, { project: 'Arm' }), [approved]);
  assert.deepEqual(listFeedback(dir, { project: 'arm.json', all: true }), [second]);
  assert.ok(readFileSync(feedbackPath(dir), 'utf8').includes('{"type":"review"\n{"type":"review",'));
});

test('feedback validates required text, bounds, and review decisions', (t) => {
  const dir = workspace(t);
  assert.throws(() => recordFeedback(dir, { ...correction, original: '   ' }), /Original is required/);
  assert.throws(() => recordFeedback(dir, { ...correction, correction: 'x'.repeat(4001) }), /at most 4000/);
  assert.throws(() => recordFeedback(dir, { ...correction, evidence: { hidden: true } }), /Evidence must be text/);
  assert.throws(() => recordFeedback(dir, { ...correction, project: 'folder/foo' }), /project name or a path/);
  assert.throws(() => reviewFeedback(dir, 'missing', { status: 'approved' }), /Unknown feedback id/);
  assert.throws(() => reviewFeedback(dir, 'missing', { status: 'pending' }), /status must be/);
  assert.deepEqual(listFeedback(dir, { all: true }), []);
});

test('feedback CLI records, approves, lists, and dismisses corrections', (t) => {
  const dir = workspace(t);
  function run(...args) {
    const result = spawnSync(process.execPath, [cli, 'feedback', ...args, '--dir', dir, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  const record = run('record', '--project', 'projects\\Arm.json', '--original', correction.original,
    '--correction', correction.correction, '--evidence', correction.evidence);
  assert.equal(record.project, 'Arm');
  assert.deepEqual(run('list', '--project', 'Arm'), []);
  assert.deepEqual(run('list', '--all'), [record]);
  const approved = run('approve', record.id, '--workspace');
  assert.deepEqual(run('list', '--project', 'another'), [approved]);
  const dismissed = run('dismiss', record.id);
  assert.deepEqual(run('list', '--all'), [dismissed]);
  assert.deepEqual(run('list'), []);
});
