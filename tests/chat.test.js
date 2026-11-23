// Chatbot bridge: fake `claude` and `codex` programs stand in for the real
// CLIs, so the test checks fallback, access flags and the HTTP route offline.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const skip = process.platform === 'win32' && 'fake CLIs are POSIX scripts';
const dir = mkdtempSync(join(tmpdir(), 'wiremap-chat-'));
const log = join(dir, 'calls.log');

// Fake CLI: logs its args and stdin; behaviour from env FAKE_<NAME>.
function fake(name) {
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('${name} 1.0'); process.exit(0); }
let input = ''; process.stdin.on('data', (d) => input += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: '${name}', args, input }) + '\\n');
  const mode = process.env.FAKE_${name.toUpperCase()} || 'ok';
  if (mode === 'limit') { console.error("You've hit your usage limit. Try again later."); process.exit(1); }
  const answer = '${name} says: connect ESP32 pin D21 to PCA9685 pin SDA.';
  const i = args.indexOf('--output-last-message');
  if (i >= 0) fs.writeFileSync(args[i + 1], answer); else console.log(answer);
});
`);
  chmodSync(file, 0o755);
  return file;
}
process.env.WIREMAP_CLAUDE_BIN = fake('claude');
process.env.WIREMAP_CODEX_BIN = fake('codex');
const { chat, _resetChatState, buildPrompt, claudeArgs, codexArgs } = await import('../lib/node/chat.js');
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const opts = { question: 'how do I wire I2C?', project: 'robot-arm', projectFile: '/x/projects/robot-arm.json', wiremapRoot: '/w', cwd: dir };

beforeEach(() => { _resetChatState(); writeFileSync(log, ''); delete process.env.FAKE_CLAUDE; delete process.env.FAKE_CODEX; });

test('auto uses Claude Code first and passes the question on stdin, read-only', { skip }, async () => {
  const r = await chat(opts);
  assert.equal(r.provider, 'claude');
  assert.match(r.answer, /D21/);
  const c = calls()[0];
  assert.match(c.input, /User: how do I wire I2C\?/);
  assert.ok(c.args.includes('--allowedTools') && !c.args.includes('--dangerously-skip-permissions') && !c.args.includes('Edit'));
});

test('auto falls back to Codex when Claude hits its usage limit, and remembers it', { skip }, async () => {
  process.env.FAKE_CLAUDE = 'limit';
  const r = await chat(opts);
  assert.equal(r.provider, 'codex');
  assert.equal(r.fellBack, true);
  assert.equal(r.tried[0].reason, 'usage limit reached');
  writeFileSync(log, '');
  const r2 = await chat(opts);
  assert.equal(r2.provider, 'codex');
  assert.deepEqual(calls().map((c) => c.name), ['codex'], 'skips Claude during the cooldown');
});

test('both out of tokens gives a clear error', { skip }, async () => {
  process.env.FAKE_CLAUDE = 'limit';
  process.env.FAKE_CODEX = 'limit';
  await assert.rejects(chat(opts), /usage limit reached/);
});

test('access levels map to the right CLI flags and prompt', () => {
  assert.ok(claudeArgs('edit', '/w').includes('acceptEdits'));
  assert.ok(claudeArgs('edit', '/w').includes('Write'));
  assert.ok(claudeArgs('full', '/w').includes('--dangerously-skip-permissions'));
  assert.ok(codexArgs('read', '/o').join(' ').includes('--sandbox read-only'));
  assert.ok(codexArgs('edit', '/o').join(' ').includes('--sandbox workspace-write'));
  assert.ok(codexArgs('full', '/o').includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.match(buildPrompt({ ...opts, access: 'read' }), /You can only read/);
  assert.match(buildPrompt({ ...opts, access: 'edit' }), /edit files in this project folder/);
});

test('HTTP route answers, refuses foreign origins, and validates input', { skip }, async (t) => {
  const { startServer } = await import('../viewer/serve.mjs');
  const server = await startServer({ port: 0, projectsDir: fileURLToPath(new URL('../projects', import.meta.url)) });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  const post = (body, o = origin) => fetch(new URL('/api/chat', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o }, body: JSON.stringify(body) });
  const ok = await post({ question: 'where does SDA go?', project: 'robot-arm', provider: 'codex', access: 'edit' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.provider, 'codex');
  const call = calls().at(-1);
  assert.ok(call.args.join(' ').includes('workspace-write'));
  assert.match(call.input, /robot-arm\.json/);
  assert.equal((await post({ question: 'x' }, 'https://evil.example')).status, 403);
  assert.equal((await post({ question: '' })).status, 400);
  const prov = await (await fetch(new URL('/api/chat/providers', server.url))).json();
  assert.deepEqual(prov, { claude: true, codex: true });
});

test('SOLIDWORKS snapshot becomes plain chatbot context and a panel status', async () => {
  process.env.WIREMAP_SOLIDWORKS_FIXTURE = fileURLToPath(new URL('./fixtures/solidworks/bracket.json', import.meta.url));
  const sw = await import('../scripts/solidworks-session.mjs');
  const report = await sw.readSession();
  const text = sw.describeSession(report);
  assert.match(text, /"servo-bracket\.SLDPRT" \(part\)/);
  assert.match(text, /62\.5 x 40 x 3\.2 mm/);
  assert.match(text, /--size 63x40x4/);
  assert.match(text, /Fillet1 \[Fillet\] error code 33/);
  assert.match(text, /Coincident3 \[MateCoincident\] warning/);
  assert.match(text, /Selected \(1\): Face<1> \(face\)/);
  assert.doesNotMatch(text, /Origin \[/, 'reference features are left out');
  assert.deepEqual(sw.sessionStatus(report), { active: true, title: 'servo-bracket.SLDPRT', type: 'part', selected: 1, problems: 2, selectionNames: ['Face<1>'],
    text: 'servo-bracket.SLDPRT · part · 1 selected · 2 rebuild problems' });
  delete process.env.WIREMAP_SOLIDWORKS_FIXTURE;
});

test('chat route sends live SOLIDWORKS context unless the user turns it off', { skip }, async (t) => {
  process.env.WIREMAP_SOLIDWORKS_FIXTURE = fileURLToPath(new URL('./fixtures/solidworks/bracket.json', import.meta.url));
  t.after(() => { delete process.env.WIREMAP_SOLIDWORKS_FIXTURE; });
  const { startServer } = await import('../viewer/serve.mjs');
  const server = await startServer({ port: 0, projectsDir: fileURLToPath(new URL('../projects', import.meta.url)) });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  const post = (body) => fetch(new URL('/api/chat', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post({ question: 'why is my model failing?' })).status, 200);
  assert.match(calls().at(-1).input, /Live context:[\s\S]*Fillet1 \[Fillet\] error code 33/);
  assert.equal((await post({ question: 'why is my model failing?', solidworks: false })).status, 200);
  assert.doesNotMatch(calls().at(-1).input, /servo-bracket/);
  const status = await (await fetch(new URL('/api/solidworks', server.url))).json();
  assert.equal(status.active, true);
  assert.equal(status.problems, 2);
});

test('chat route adds the saved Bambu Studio project unless the user turns it off', { skip }, async (t) => {
  process.env.WIREMAP_BAMBU_FILE = fileURLToPath(new URL('./fixtures/bambu/servo-bracket.3mf', import.meta.url));
  process.env.WIREMAP_BAMBU_CONF = join(dir, 'no-conf.json');
  t.after(() => { delete process.env.WIREMAP_BAMBU_FILE; delete process.env.WIREMAP_BAMBU_CONF; });
  const { startServer } = await import('../viewer/serve.mjs');
  const server = await startServer({ port: 0, projectsDir: fileURLToPath(new URL('../projects', import.meta.url)) });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  const post = (body) => fetch(new URL('/api/chat', server.url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  assert.equal((await post({ question: 'does this print need supports?' })).status, 200);
  assert.match(calls().at(-1).input, /Bambu Studio project "servo-bracket\.3mf"[\s\S]*slicer warnings: Enclosure recommended for ABS/);
  assert.equal((await post({ question: 'does this print need supports?', bambu: false })).status, 200);
  assert.doesNotMatch(calls().at(-1).input, /servo-bracket\.3mf/);
  const status = await (await fetch(new URL('/api/bambu', server.url))).json();
  assert.equal(status.text, 'servo-bracket.3mf · 45 min, 8.12 g · 1 warning');
});
