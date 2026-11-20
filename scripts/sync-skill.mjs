#!/usr/bin/env node
// Generate the mirrored skill files from the single source skills/wiremap/SKILL.md:
//   .claude/skills/wiremap/SKILL.md  (Claude Code, when the repo is opened directly)
//   AGENTS.md                         (Codex)
// `--check` exits 1 if they are out of date (used by the tests).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'skills', 'wiremap', 'SKILL.md');

export function splitFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return m ? { front: m[1], body: text.slice(m[0].length) } : { front: '', body: text };
}

export function renderAgents(skill) {
  const { body } = splitFrontmatter(skill);
  return `<!-- Generated from skills/wiremap/SKILL.md by scripts/sync-skill.mjs. Do not edit by hand. -->
# AGENTS.md: Wiremap

For any hardware, electronics, wiring, CAD or 3D printing task in this
repository (or when the user says "use wiremap"), follow the Wiremap skill
below. This file mirrors \`skills/wiremap/SKILL.md\` for Codex.

${body.replace(/^\s*# Wiremap\n+/, '')}`;
}

export function targets() {
  const skill = readFileSync(SOURCE, 'utf8');
  return [
    [join(root, '.claude', 'skills', 'wiremap', 'SKILL.md'), skill],
    [join(root, 'AGENTS.md'), renderAgents(skill)],
  ];
}

export async function main(argv) {
  let stale = 0;
  for (const [file, content] of targets()) {
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (cur === content) continue;
    if (argv.includes('--check')) { console.error(`out of date: ${file}`); stale++; continue; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`wrote ${file}`);
  }
  return stale ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
