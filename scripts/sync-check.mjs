import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cloudBranch = 'origin/claude/focused-keller-cwv8nf';
const hook = process.argv.includes('--hook');
const refresh = process.argv.includes('--refresh');

function git(...args) {
  return spawnSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 6000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
}

const output = (...args) => {
  const result = git(...args);
  return result.status === 0 ? result.stdout.trimEnd() : '';
};

function recent(path) {
  try { return Date.now() - statSync(path).mtimeMs < 60_000; }
  catch { return false; }
}

function inspect() {
  const stampPath = output('rev-parse', '--git-path', 'wiremap-sync-stamp');
  if (!stampPath) return ['Could not identify the Git checkout.'];
  const notes = [];
  const stamp = resolve(root, stampPath);
  const against = output('rev-parse', '--abbrev-ref', '@{u}') || cloudBranch;
  const remote = output('config', '--get', 'branch.' + output('branch', '--show-current') + '.remote') || 'origin';
  let refreshed = false;
  if (refresh || !recent(stamp)) {
    const previous = output('rev-parse', '--verify', against);
    refreshed = git('fetch', '--quiet', '--no-tags', remote).status === 0;
    if (refreshed) {
      try { writeFileSync(stamp, ''); } catch { /* a cache hit is optional */ }
      const current = output('rev-parse', '--verify', against);
      if (current && previous !== current) notes.push(`Fetched an update to ${against}.`);
    } else {
      notes.push('Git fetch failed. The remote comparison uses the last fetched references.');
    }
  }
  const counts = output('rev-list', '--left-right', '--count', `HEAD...${against}`);
  if (counts) {
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    if (ahead || behind) notes.push(`Compared with ${against}: ${ahead} local-only and ${behind} remote-only commits.`);
  } else {
    notes.push(`No comparison ref for ${against}. Local file status is still available.`);
  }
  const status = git('status', '--porcelain', '--untracked-files=normal');
  if (status.status !== 0) notes.push('Git could not check local files.');
  else if (status.stdout.trim()) {
    const lines = status.stdout.trimEnd().split(/\r?\n/);
    notes.push(`Local changes (${lines.length}):\n${lines.slice(0, 15).join('\n')}`);
  }
  return notes;
}

let event;
if (hook) {
  try { event = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, '')).hook_event_name; } catch { /* no hook input */ }
  if (!['SessionStart', 'UserPromptSubmit'].includes(event)) process.exit(0);
}
const notes = inspect();
if (notes.length) {
  const report = `Wiremap Git status\n${notes.join('\n')}`;
  console.log(hook ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: report } }) : report);
} else if (!hook) {
  console.log('The checkout matches the comparison branch and has no local changes.');
}
