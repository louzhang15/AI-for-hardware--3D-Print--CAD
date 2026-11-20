#!/usr/bin/env node
// wiremap install: make the skill available everywhere, with the user's OK.
// Nothing is written without a "y" answer (or --yes with explicit flags).
//
//   --claude-skill   ~/.claude/skills/wiremap/SKILL.md   (Claude Code, all projects)
//   --codex-skill    ~/.codex/skills/wiremap/SKILL.md    (Codex, all projects)
//   --global-line    one line in ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
//   --hook           UserPromptSubmit hook in ~/.claude/settings.json (Claude Code only)
//   --all            all of the above
//   --uninstall      remove what this installer added
//   --dry-run        show what would change     --yes   don't ask (needs flags)
//   --home <dir>     use another home directory (testing)
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
export const GLOBAL_LINE = 'For any hardware, electronics, CAD or 3D printing task, use the wiremap skill.';
const MARK = '<!-- wiremap -->';
const HOOK_CMD = `node "${join(ROOT, 'hooks', 'prompt-hook.mjs')}"`;

export function skillWithRoot(root = ROOT) {
  const src = readFileSync(join(root, 'skills', 'wiremap', 'SKILL.md'), 'utf8');
  return src.replace('<!-- installer: WIREMAP_ROOT line goes here -->',
    `Installed copy: **WIREMAP_ROOT is \`${root}\`** (run \`node "${join(root, 'bin', 'wiremap.mjs')}" <command>\`).`);
}

/** Build the list of actions for the chosen targets. Each action can apply() or undo(). */
export function plan(opts) {
  const home = opts.home || homedir();
  const actions = [];
  if (opts.claudeSkill) {
    const file = join(home, '.claude', 'skills', 'wiremap', 'SKILL.md');
    actions.push({
      what: `Claude Code skill for every project: ${file}`,
      apply: () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, skillWithRoot()); },
      undo: () => rmSync(dirname(file), { recursive: true, force: true }),
    });
  }
  if (opts.codexSkill) {
    const file = join(home, '.codex', 'skills', 'wiremap', 'SKILL.md');
    actions.push({
      what: `Codex skill for every project: ${file}`,
      apply: () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, skillWithRoot()); },
      undo: () => rmSync(dirname(file), { recursive: true, force: true }),
    });
  }
  if (opts.globalLine) {
    for (const file of [join(home, '.claude', 'CLAUDE.md'), join(home, '.codex', 'AGENTS.md')]) {
      actions.push({
        what: `Add one line to ${file}: "${GLOBAL_LINE}"`,
        apply: () => {
          const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
          if (cur.includes(MARK)) return;
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}\n${GLOBAL_LINE} ${MARK}\n`);
        },
        undo: () => {
          if (!existsSync(file)) return;
          const cur = readFileSync(file, 'utf8');
          writeFileSync(file, cur.split('\n').filter((l) => !l.includes(MARK)).join('\n').replace(/\n{3,}$/, '\n\n'));
        },
      });
    }
  }
  if (opts.hook) {
    const file = join(home, '.claude', 'settings.json');
    actions.push({
      what: `Add a UserPromptSubmit hook to ${file} (reminds Claude to use wiremap for hardware prompts; a backup is kept)`,
      apply: () => {
        let settings = {};
        if (existsSync(file)) {
          copyFileSync(file, `${file}.wiremap-backup`);
          try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; not touching it.`); }
        }
        settings.hooks ||= {};
        settings.hooks.UserPromptSubmit ||= [];
        const exists = settings.hooks.UserPromptSubmit.some((g) => (g.hooks || []).some((h) => String(h.command || '').includes('prompt-hook.mjs')));
        if (!exists) settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: HOOK_CMD, timeout: 5 }] });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
      },
      undo: () => {
        if (!existsSync(file)) return;
        const settings = JSON.parse(readFileSync(file, 'utf8'));
        const list = settings.hooks?.UserPromptSubmit;
        if (!Array.isArray(list)) return;
        settings.hooks.UserPromptSubmit = list
          .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes('prompt-hook.mjs')) }))
          .filter((g) => g.hooks.length);
        if (!settings.hooks.UserPromptSubmit.length) delete settings.hooks.UserPromptSubmit;
        writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
      },
    });
  }
  return actions;
}

export async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  const all = argv.includes('--all');
  const homeIdx = argv.indexOf('--home');
  const opts = {
    claudeSkill: all || argv.includes('--claude-skill'),
    codexSkill: all || argv.includes('--codex-skill'),
    globalLine: all || argv.includes('--global-line'),
    hook: all || argv.includes('--hook'),
    home: homeIdx >= 0 ? argv[homeIdx + 1] : undefined,
  };
  const explicit = opts.claudeSkill || opts.codexSkill || opts.globalLine || opts.hook;
  if (!explicit) Object.assign(opts, { claudeSkill: true, codexSkill: true, globalLine: true, hook: true });
  const undo = argv.includes('--uninstall');
  const yes = argv.includes('--yes') && explicit;
  const dry = argv.includes('--dry-run');
  const actions = plan(opts);

  console.log(`Wiremap ${undo ? 'uninstall' : 'install'} (Wiremap root: ${ROOT})`);
  const rl = !yes && !dry ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    for (const a of actions) {
      if (dry) { console.log(`  would ${undo ? 'undo' : 'do'}: ${a.what}`); continue; }
      let ok = yes;
      if (!ok) ok = /^y(es)?$/i.test((await rl.question(`${undo ? 'Remove' : 'Install'}: ${a.what}? [y/N] `)).trim());
      if (!ok) { console.log('  skipped'); continue; }
      (undo ? a.undo : a.apply)();
      console.log(`  ${undo ? 'removed' : 'done'}: ${a.what}`);
    }
  } finally { rl?.close(); }
  if (!undo && !dry) {
    console.log('\nClaude Code plugin alternative: /plugin marketplace add <this repo> then /plugin install wiremap@wiremap');
    console.log('Restart Claude Code / Codex so they pick up the skill.');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
