#!/usr/bin/env node
// Lay out a project on a breadboard and print it hole by hole.
// Usage: node scripts/layout-breadboard.mjs projects/x.json [--model full-830|half-400|full-830,full-830] [--split] [--write] [--json]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, readProject } from '../lib/node/library.js';
import { layoutBreadboard, applyLayoutToProject, formatLayout } from '../lib/breadboard.js';

const USAGE = 'Usage: node scripts/layout-breadboard.mjs <project.json> [--model full-830|half-400|full-830,full-830] [--split] [--write] [--json]';

/** @param {string[]} argv @returns {Promise<number>} exit code */
export async function main(argv = process.argv.slice(2)) {
  let file = null;
  const options = {};
  let write = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') {
      const v = argv[++i];
      if (!v) { console.error(USAGE); return 2; }
      options.model = v.includes(',') ? v.split(',').map((s) => s.trim()) : v;
    } else if (a.startsWith('--model=')) {
      const v = a.slice(8);
      options.model = v.includes(',') ? v.split(',').map((s) => s.trim()) : v;
    } else if (a === '--split') options.split = true;
    else if (a === '--write') write = true;
    else if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); return 0; }
    else if (!file) file = a;
    else { console.error(USAGE); return 2; }
  }
  if (!file) { console.error(USAGE); return 2; }

  let project;
  try {
    project = readProject(file);
  } catch (e) {
    console.error(String(e.message || e));
    return 2;
  }
  const library = loadLibrary();
  const layout = layoutBreadboard(project, library, options);

  if (json) console.log(JSON.stringify(layout, null, 2));
  else console.log(formatLayout(layout));

  if (write) {
    const out = applyLayoutToProject(project, layout);
    if (options.model) out.breadboard.model = options.model;
    writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    if (!json) console.log(`\nSaved the layout into ${file}`);
  }
  return layout.issues.some((i) => i.level === 'error') ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
}
