#!/usr/bin/env node
// Scan a firmware repo for pins, board and libraries; optionally compare with a map.
//   node scripts/import-repo.mjs <repo dir> [--project projects/x.json] [--json]
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, readProject } from '../lib/node/library.js';
import { scanFirmware, comparePinsDetailed } from '../lib/firmware.js';

const EXTS = /\.(ino|cpp|cc|c|h|hpp|py)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pio', 'build', '.vscode-test', '__pycache__', '.venv', 'venv']);
const MAX_BYTES = 1_000_000;
const MAX_FILES = 2000;

const HELP = `Usage: node scripts/import-repo.mjs <repo dir> [options]

Reads firmware (.ino .cpp .c .h .hpp .py and platformio.ini; skips .git,
node_modules, .pio, build) and prints the board, pins, libraries and the
library parts it infers. Inferred parts must be confirmed by the user.

Options:
  --project FILE    compare the code's pins with this wiring map
                    (exit code 1 when a pin number disagrees)
  --controller ID   controller part in the map (default: first "controller")
  --json            print JSON
  --help            this text
`;

/** Collect firmware files under dir as {path, text} with paths relative to dir. */
export function collectFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && (EXTS.test(e.name) || e.name === 'platformio.ini' || e.name === 'sketch.yaml' || e.name === 'arduino.json')) {
        if (statSync(p).size > MAX_BYTES) continue;
        out.push({ path: relative(dir, p).split('\\').join('/'), text: readFileSync(p, 'utf8') });
      }
    }
  };
  walk(dir);
  return out;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
      i++;
    } else opts._.push(a);
  }
  return opts;
}

const fmt = (v) => (v === null || v === undefined ? '?' : String(v));

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) { console.log(HELP); return 0; }
  const dir = opts._[0];
  if (!dir) { console.error(HELP); return 2; }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`Not a folder: ${dir}`); return 2; }

  const library = loadLibrary();
  const files = collectFiles(resolve(dir));
  const scan = scanFirmware(files, { library });
  let compare = null;
  if (opts.project) {
    try {
      const project = readProject(opts.project);
      compare = comparePinsDetailed(project, library, scan, { controller: opts.controller });
    } catch (e) {
      console.error(`Cannot compare with ${opts.project}: ${e.message}`);
      return 2;
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ ...scan, compare }, null, 2));
  } else {
    console.log(`Scanned ${files.length} file(s) in ${dir}`);
    console.log(`Board: ${fmt(scan.board)}${scan.boardSource ? ` (from ${scan.boardSource})` : ''}   Framework: ${fmt(scan.framework)}`);
    console.log('\nPins found:');
    if (!scan.pins.length) console.log('  (none)');
    for (const p of scan.pins) console.log(`  ${p.name.padEnd(22)} ${fmt(p.value).padEnd(6)} ${p.kind.padEnd(16)} ${p.file}:${p.line}`);
    console.log('\nLibraries:');
    const libs = [...new Set(scan.libraries.map((l) => l.name))];
    console.log(libs.length ? `  ${libs.join(', ')}` : '  (none)');
    console.log('\nInferred parts (mark "inferred": true until the user confirms):');
    if (!scan.inferredParts.length) console.log('  (none)');
    for (const p of scan.inferredParts) {
      console.log(`  ${p.library}${p.qty ? ` x${p.qty}` : ''}  - ${p.reason}${p.candidates ? `  [candidates: ${p.candidates.join(', ')}]` : ''}`);
    }
    if (compare) {
      console.log(`\nCompared with ${opts.project}:`);
      if (!compare.mismatches.length) console.log('  No pin number disagrees with the map.');
      for (const m of compare.mismatches) console.log(`  MISMATCH ${m.message}`);
      for (const u of compare.unwired) console.log(`  note     ${u.message}`);
      console.log(`  ${compare.matched.length} pin use(s) agree with the map.`);
    }
  }
  return compare && compare.mismatches.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
