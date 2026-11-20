#!/usr/bin/env node
// Wiremap command-line entry point. Every command is a script in scripts/
// exporting `main(argv)`, so the AI can also run `node scripts/<name>.mjs`.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = {
  check: ['check.mjs', 'Run the electrical checker on a project'],
  'layout-breadboard': ['layout-breadboard.mjs', 'Place parts and jumpers on a breadboard'],
  calc: ['calc.mjs', 'Deterministic calculators (divider, led, wire, fuse, runtime, insert, screw, fit, regulator)'],
  'fit-printer': ['fit-printer.mjs', "Check parts against a printer's build volume and materials"],
  'split-part': ['split-part.mjs', 'Split an STL that is too big for the printer'],
  'export-print': ['export-print.mjs', 'Per-part print folders, settings cards and plate 3MF'],
  'part-geometry': ['part-geometry.mjs', 'Board sizes, holes and keep-outs for CAD'],
  'solidworks-session': ['solidworks-session.mjs', 'Read the active SOLIDWORKS document and selection'],
  export: ['export.mjs', 'pins.h, BOM CSV, WireViz, KiCad netlist, HTML guide'],
  'import-repo': ['import-repo.mjs', 'Read pin definitions and parts from firmware'],
  inbox: ['inbox.mjs', 'Requests sent from the viewer to the AI'],
  feedback: ['feedback.mjs', 'Record and review reusable design corrections'],
  serve: ['../viewer/serve.mjs', 'Start the local viewer'],
  new: ['new-project.mjs', 'Create a project from a template'],
  install: ['install.mjs', 'Install the skill for Claude Code / Codex (asks first)'],
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === '--help' || cmd === '-h' || !COMMANDS[cmd]) {
  console.log('Usage: wiremap <command> [args]\n');
  for (const [name, [, desc]] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(18)} ${desc}`);
  process.exitCode = cmd && !COMMANDS[cmd] ? 2 : 0;
} else {
  const file = join(root, 'scripts', COMMANDS[cmd][0]);
  if (!existsSync(file)) {
    console.error(`wiremap ${cmd}: ${file} is missing from this install.`);
    process.exitCode = 2;
  } else {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.main === 'function') process.exitCode = await mod.main(rest);
  }
}
