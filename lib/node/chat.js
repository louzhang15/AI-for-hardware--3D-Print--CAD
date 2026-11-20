// Node-only: answer a chat question with the user's own Claude Code or Codex
// CLI (their subscription, no API key). The user picks the access level:
//   read  (default) read files and run Wiremap's checks
//   edit  also edit files in the project folder
//   full  every tool, no permission prompts (the user confirms this in the UI)
//
// Provider "auto" tries the one that worked last; when a CLI is missing, fails,
// or reports a usage/token limit, it falls back to the other and remembers that
// for 30 minutes.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LIMIT_RE = /(usage limit|rate.?limit|hit your .*limit|out of (credits|tokens)|quota|insufficient (credits|balance)|limit reached|too many requests|\b429\b)/i;
const COOLDOWN_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 180 * 1000;
const isWin = process.platform === 'win32';

const state = { preferred: 'claude', blockedUntil: { claude: 0, codex: 0 }, available: null };

function bin(name) {
  return process.env[`WIREMAP_${name.toUpperCase()}_BIN`] || name;
}

/** Run a command with the prompt on stdin. Args are constants; user text never reaches a shell. */
function run(cmd, args, input, { cwd, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const quoted = isWin ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)) : args;
    let child;
    try {
      child = spawn(isWin ? `"${cmd}"` : cmd, quoted, { cwd, shell: isWin, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e.message), missing: true });
      return;
    }
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); stderr += '\nTimed out.'; }, timeout);
    child.stdout.on('data', (d) => { stdout += d; if (stdout.length > 2e6) child.kill(); });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 2e6) child.kill(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e.message), missing: e.code === 'ENOENT' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Windows shells report a missing command as exit 1 with "is not recognized".
      resolve({ code, stdout, stderr, missing: isWin && /not recognized|cannot find/i.test(stderr) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Which CLIs are installed. Cached; pass refresh to re-check. */
export async function detectProviders(refresh = false) {
  if (state.available && !refresh) return state.available;
  const check = async (name) => {
    const r = await run(bin(name), ['--version'], '', { timeout: 15000 });
    return !r.missing && r.code === 0;
  };
  const [claude, codex] = await Promise.all([check('claude'), check('codex')]);
  state.available = { claude, codex };
  return state.available;
}

export const ACCESS = ['read', 'edit', 'full'];

export function claudeArgs(access, wiremapRoot) {
  const base = ['-p', '--output-format', 'text', '--max-turns', access === 'read' ? '12' : '30'];
  if (access === 'full') return [...base, '--dangerously-skip-permissions'];
  const allowed = ['Read', 'Grep', 'Glob', `Bash(node ${join(wiremapRoot, 'bin', 'wiremap.mjs')}:*)`, 'Bash(graphify query:*)'];
  if (access === 'edit') return [...base, '--permission-mode', 'acceptEdits', '--allowedTools', ...allowed, 'Edit', 'Write', 'Bash(graphify update:*)'];
  return [...base, '--allowedTools', ...allowed];
}

export function codexArgs(access, out) {
  const mode = access === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', access === 'edit' ? 'workspace-write' : 'read-only'];
  return ['exec', ...mode, '--skip-git-repo-check', '--color', 'never', '--output-last-message', out, '-'];
}

async function askClaude(prompt, { cwd, wiremapRoot, access = 'read' }) {
  const r = await run(bin('claude'), claudeArgs(access, wiremapRoot), prompt, { cwd, timeout: access === 'read' ? TIMEOUT_MS : TIMEOUT_MS * 3 });
  return { ...r, answer: r.stdout.trim() };
}

async function askCodex(prompt, { cwd, access = 'read' }) {
  const dir = mkdtempSync(join(tmpdir(), 'wiremap-codex-'));
  const out = join(dir, 'answer.txt');
  try {
    const r = await run(bin('codex'), codexArgs(access, out), prompt, { cwd, timeout: access === 'read' ? TIMEOUT_MS : TIMEOUT_MS * 3 });
    let answer = '';
    try { answer = readFileSync(out, 'utf8').trim(); } catch { answer = r.stdout.trim(); }
    return { ...r, answer };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const RUNNERS = { claude: askClaude, codex: askCodex };

/** Build the prompt: beginner-friendly, short, exact pin names, read-only. */
export function buildPrompt({ question, project, projectFile, step, selection, history = [], wiremapRoot, context, access = 'read' }) {
  const turns = history.slice(-6).map((t) => `${t.who === 'you' ? 'User' : 'Assistant'}: ${String(t.text).slice(0, 600)}`).join('\n');
  return [
    'You are Ask Wiremap, a friendly workshop assistant inside the Wiremap hardware build viewer.',
    'The user may never have touched electronics before. Answer in plain words, short sentences, under 150 words unless they ask for more.',
    'Name exact pins as printed on the boards (for example "ESP32 pin D21 to PCA9685 pin SDA") and wire colours. Say to unplug power before moving wires.',
    'Never guess a pinout or a voltage: read the project file and the library, and run the checker when it helps:',
    `  node "${join(wiremapRoot, 'bin', 'wiremap.mjs')}" check "${projectFile}" --json`,
    `Wiremap library parts are in ${join(wiremapRoot, 'library')}. If graphify-out/ exists, use \`graphify query\` before reading code.`,
    access === 'read'
      ? 'You can only read. Do not edit files. If a change is needed, say exactly what to change; the user can switch Ask Wiremap to "Can edit" to let you do it.'
      : `You may ${access === 'full' ? 'use any tool' : 'edit files in this project folder'}. Follow the wiremap skill: after changing parts or wires, run the checker and fix errors. Say briefly what you changed. The viewer reloads the project file live.`,
    'The user may be working in SOLIDWORKS or Bambu Studio next to this window; answer CAD and printing questions too.',
    'When live SOLIDWORKS context is given, use it: name the exact feature, sketch or mate, explain a rebuild error in plain words starting with the first failing feature, and give the exact menu clicks to fix it.',
    `For a fresh SOLIDWORKS snapshot after the user changes something, run: node "${join(wiremapRoot, 'bin', 'wiremap.mjs')}" solidworks-session --json`,
    '',
    `Project: ${project || '(none open)'}${projectFile ? ` (file: ${projectFile})` : ''}`,
    step ? `Current build step: ${step}` : '',
    selection ? `Selected in the viewer: ${selection}` : '',
    context ? `Live context:\n${String(context).slice(0, 4000)}` : '',
    turns ? `Conversation so far:\n${turns}` : '',
    '',
    `User: ${question}`,
  ].filter(Boolean).join('\n');
}

/**
 * Ask a question. provider: 'auto' | 'claude' | 'codex'.
 * Returns { provider, answer, fellBack, tried: [{provider, reason}] }.
 */
export async function chat(opts, provider = 'auto') {
  const avail = await detectProviders();
  const now = Date.now();
  let order;
  if (provider === 'claude' || provider === 'codex') order = [provider, provider === 'claude' ? 'codex' : 'claude'];
  else {
    const first = state.blockedUntil[state.preferred] > now ? (state.preferred === 'claude' ? 'codex' : 'claude') : state.preferred;
    order = [first, first === 'claude' ? 'codex' : 'claude'];
  }
  const tried = [];
  const prompt = buildPrompt(opts);
  for (const name of order) {
    if (!avail[name]) { tried.push({ provider: name, reason: 'not installed' }); continue; }
    if (provider === 'auto' && state.blockedUntil[name] > now && tried.length === 0 && order.some((n) => n !== name && avail[n])) {
      tried.push({ provider: name, reason: 'limit reached recently' });
      continue;
    }
    const r = await RUNNERS[name](prompt, opts);
    const text = `${r.answer}\n${r.stderr}`;
    if (r.missing) { avail[name] = false; tried.push({ provider: name, reason: 'not installed' }); continue; }
    if (LIMIT_RE.test(text) && (r.code !== 0 || !r.answer || r.answer.length < 400)) {
      state.blockedUntil[name] = Date.now() + COOLDOWN_MS;
      tried.push({ provider: name, reason: 'usage limit reached' });
      continue;
    }
    if (r.code !== 0 || !r.answer) {
      tried.push({ provider: name, reason: (r.stderr.trim().split('\n').pop() || `exit ${r.code}`).slice(0, 200) });
      continue;
    }
    state.preferred = name;
    return { provider: name, answer: r.answer.slice(0, 20000), fellBack: tried.length > 0, tried };
  }
  const err = new Error(avail.claude || avail.codex
    ? `Neither assistant could answer: ${tried.map((t) => `${t.provider}: ${t.reason}`).join('; ')}`
    : 'Neither Claude Code (claude) nor Codex (codex) is installed on this computer. Install one, sign in, and try again.');
  err.tried = tried;
  err.status = 503;
  throw err;
}

/** For tests. */
export function _resetChatState() {
  state.preferred = 'claude';
  state.blockedUntil = { claude: 0, codex: 0 };
  state.available = null;
}
