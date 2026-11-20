// Skill packaging: mirrored files in sync, auto-activation keywords hit the
// PRD's targets (>= 95% of hardware prompts, < 5% of coding prompts), the hook
// emits valid JSON, and the installer is idempotent and reversible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchHardware } from '../hooks/keywords.js';
import { plan, GLOBAL_LINE } from '../scripts/install.mjs';
import { renderAgents } from '../scripts/sync-skill.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const HARDWARE = [
  'my servo jitters', 'design a case for this Pi', 'will this fit my A1 mini?', 'how do I wire an HC-SR04 to an ESP32',
  'my ESP32 resets when the motors start', 'what buck converter do I need for 4 servos', 'help me build a robot arm',
  'make a bracket for a NEMA 17', 'which AWG for 5 amps', 'is 7.4V ok for an SG90', 'breadboard layout for an L293D',
  'I2C device not found', 'print settings for PETG on a P1S', 'enclosure for my weather station', 'pinout of the Arduino Nano',
  'design a mount for a 18650 holder', 'split this STL so it fits my printer', 'how many mAh do I need for 2 hours',
  'my stepper motor gets hot', 'connect a PCA9685 to a Pi Pico', 'generate an OpenSCAD model of a phone stand',
  'heat set insert hole size for M3', 'can I power the servo from the 5V pin', 'what fuse for a 2S lipo',
  'build123d script for a box with a lid', 'the motor driver gets warm', 'rover with two DC motors', 'smart lamp with neopixels',
  'my quadcopter frame broke, design a new arm', 'export a 3MF for Bambu Studio', 'what resistor for an LED on 5V',
  'level shifter between 5V and 3.3V', 'Fusion 360 script for a gearbox housing', 'TB6612 STBY pin floating', 'printer is an H2D, will 300 mm fit',
  'how do I solder header pins', 'my board browns out', 'measure voltage with a multimeter', 'drone ESC wiring', 'check my circuit for shorts',
];
const CODING = [
  'fix the failing unit test in auth.ts', 'refactor this React component to use hooks', 'add an API route for users', 'why is my SQL query slow',
  'write a regex for emails', 'set up eslint with typescript', 'dockerize this flask app', 'center a div with CSS', 'explain this python traceback',
  'rename the variable across the codebase', 'add pagination to the endpoint', 'migrate the database schema', 'write a commit message',
  'optimize this loop in rust', 'kubernetes deployment yaml', 'how do promises work in javascript', 'add dark mode to the settings page',
  'parse a CSV file in go', 'update the README', 'the build fails on webpack 5', 'implement binary search', 'handle the 404 error page',
  'make the button supports keyboard focus in the React component', 'add a case for null in this switch statement', 'upgrade django to 5',
  'write tests for the payment service', 'what does this git error mean', 'convert this class to a dataclass', 'sort the list by date',
  'add logging to the worker', 'create a GitHub action for CI', 'speed up the jest tests', 'fix the memory leak in the server',
  'translate this function to typescript', 'add i18n to the app', 'debounce the search input', 'set up a cron job', 'cache the API responses',
  'review my pull request', 'generate an OpenAPI spec',
];

test('auto-activation: >= 95% of hardware prompts, < 5% of coding prompts', () => {
  assert.equal(HARDWARE.length, 40);
  const hits = HARDWARE.filter((p) => matchHardware(p).match);
  const misses = HARDWARE.filter((p) => !matchHardware(p).match);
  assert.ok(hits.length / HARDWARE.length >= 0.95, `missed: ${misses.join(' | ')}`);
  const falsePos = CODING.filter((p) => matchHardware(p).match);
  assert.ok(falsePos.length / CODING.length < 0.05, `false positives: ${falsePos.join(' | ')}`);
});

test('prompt hook returns valid hook JSON for hardware and nothing otherwise', () => {
  const hook = join(root, 'hooks', 'prompt-hook.mjs');
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: 'my servo jitters', hook_event_name: 'UserPromptSubmit' }) });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout.toString());
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /wiremap/);
  const r2 = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: 'refactor this React component' }) });
  assert.equal(r2.stdout.toString(), '');
  const r3 = spawnSync(process.execPath, [hook], { input: 'not json' });
  assert.equal(r3.status, 0, 'never blocks a prompt');
});

test('standalone SolidWorks questions activate Wiremap without requiring a build project', () => {
  for (const prompt of [
    'Help me with SOLIDWORKS',
    'Why is my sketch over defined in Solid Works?',
    'Can you open bracket.SLDPRT?',
    'What changed in arm.SLDASM?',
    'Help me update the dimensions on Sheet1.SLDDRW',
    'How do I use MateXpert?',
  ]) {
    assert.ok(matchHardware(prompt).match, prompt);
  }
  const hook = join(root, 'hooks', 'prompt-hook.mjs');
  const run = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: 'Help me with SolidWorks' }) });
  assert.equal(run.status, 0);
  assert.match(JSON.parse(run.stdout).hookSpecificOutput.additionalContext, /standalone CAD questions/i);
  assert.equal(matchHardware('Parse a solid worker configuration in TypeScript').match, false);
});

test('SolidWorks session CLI reports availability as JSON without requiring the app', () => {
  const cli = join(root, 'bin', 'wiremap.mjs');
  const help = spawnSync(process.execPath, [cli, 'solidworks-session', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: wiremap solidworks-session/);
  const run = spawnSync(process.execPath, [cli, 'solidworks-session', '--json'], { encoding: 'utf8', timeout: 10_000 });
  assert.ifError(run.error);
  const report = JSON.parse(run.stdout);
  if (process.platform !== 'win32') assert.equal(report.status, 'unsupported');
  else assert.ok(['active', 'no_document', 'unavailable', 'busy'].includes(report.status));
  assert.equal(run.status, report.status === 'active' ? 0 : 1);
});

test('skill mirrors (AGENTS.md, .claude/skills) are in sync with skills/wiremap/SKILL.md', () => {
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'sync-skill.mjs'), '--check']);
  assert.equal(r.status, 0, r.stderr.toString() + ' — run `node scripts/sync-skill.mjs`');
  const skill = readFileSync(join(root, 'skills', 'wiremap', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(skill, /^---\nname: wiremap\ndescription: .+\n---\n/);
  assert.equal(renderAgents(skill.replace(/\n/g, '\r\n')), renderAgents(skill));
});

test('every command the skill names exists in the CLI', () => {
  const skill = readFileSync(join(root, 'skills', 'wiremap', 'SKILL.md'), 'utf8');
  const cli = readFileSync(join(root, 'bin', 'wiremap.mjs'), 'utf8');
  const cmds = new Set([...skill.matchAll(/`wiremap ([a-z-]+)/g)].map((m) => m[1]));
  for (const c of cmds) assert.match(cli, new RegExp(`['\\s]${c}['"]?:`), `wiremap ${c} missing from bin/wiremap.mjs`);
});

test('installer: skill copies, global line, hook — idempotent and reversible', () => {
  const home = mkdtempSync(join(tmpdir(), 'wiremap-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'x', hooks: { Stop: [] } }));
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# mine\n');
  const opts = { claudeSkill: true, codexSkill: true, globalLine: true, hook: true, home };
  for (let i = 0; i < 2; i++) for (const a of plan(opts)) a.apply();
  const skill = readFileSync(join(home, '.claude', 'skills', 'wiremap', 'SKILL.md'), 'utf8');
  assert.match(skill, /WIREMAP_ROOT is `/);
  assert.ok(existsSync(join(home, '.codex', 'skills', 'wiremap', 'SKILL.md')));
  const claudeMd = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
  assert.equal(claudeMd.split(GLOBAL_LINE).length - 1, 1, 'line added once');
  assert.ok(claudeMd.startsWith('# mine'));
  const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'x');
  assert.equal(settings.hooks.UserPromptSubmit.length, 1, 'hook added once');
  for (const a of plan(opts)) a.undo();
  assert.ok(!readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8').includes(GLOBAL_LINE));
  const after = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.hooks.UserPromptSubmit, undefined);
  assert.deepEqual(after.hooks.Stop, []);
  assert.ok(!existsSync(join(home, '.claude', 'skills', 'wiremap')));
});
