import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('sync hook finds divergence and local changes without changing tracked files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wiremap-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const cloud = join(root, 'cloud');
  const workstation = join(root, 'workstation');
  const branch = 'claude/focused-keller-cwv8nf';
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, filename, content) => {
    writeFileSync(join(cwd, filename), content);
    git(cwd, 'add', filename);
    git(cwd, '-c', 'user.name=Wiremap Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', filename);
  };
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', branch, cloud);
  commit(cloud, 'common.txt', 'base\n');
  git(cloud, 'remote', 'add', 'origin', remote);
  git(cloud, 'push', '-u', 'origin', branch);
  git(root, 'clone', '--branch', branch, remote, workstation);
  git(workstation, 'checkout', '--no-track', '-b', 'local-review');
  commit(workstation, 'local.txt', 'local\n');
  commit(cloud, 'remote.txt', 'remote\n');
  git(cloud, 'push');
  writeFileSync(join(workstation, 'common.txt'), 'uncommitted\n');
  mkdirSync(join(workstation, 'scripts'));
  const script = join(workstation, 'scripts', 'sync-check.mjs');
  copyFileSync(new URL('../scripts/sync-check.mjs', import.meta.url), script);
  const before = git(workstation, 'rev-parse', 'HEAD');
  const report = JSON.parse(execFileSync(process.execPath, [script, '--hook', '--refresh'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit' }),
  })).hookSpecificOutput;
  assert.equal(report.hookEventName, 'UserPromptSubmit');
  assert.match(report.additionalContext, /Fetched an update/);
  assert.match(report.additionalContext, /1 local-only and 1 remote-only/);
  assert.match(report.additionalContext, /^ M common\.txt$/m);
  assert.equal(git(workstation, 'rev-parse', 'HEAD'), before);
  assert.match(git(workstation, 'diff', '--', 'common.txt'), /\+uncommitted/);
});
