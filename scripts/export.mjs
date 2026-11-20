#!/usr/bin/env node
// Export a project: node scripts/export.mjs <format> projects/x.json [--out file|-]
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLibrary, readProject, WIREMAP_ROOT } from '../lib/node/library.js';
import { pinsHeader, bomCsv, wirevizYaml, kicadNetlist, buildGuideHtml, shoppingChecklist } from '../lib/export.js';

const FORMATS = {
  'pins-h': { file: 'pins.h', what: 'pin header for firmware, generated from the map' },
  'bom-csv': { file: 'bom.csv', what: 'BOM / cart list as CSV (parts, fasteners, filament)' },
  wireviz: { file: 'wiring.yml', what: 'WireViz harness YAML (render with `wireviz wiring.yml`)' },
  kicad: { file: 'netlist.net', what: 'KiCad S-expression netlist (hand-off; no PCB layout)' },
  html: { file: 'build-guide.html', what: 'self-contained static HTML build guide' },
  shopping: { file: 'shopping.md', what: 'markdown shopping checklist' },
};

const HELP = `Usage: node scripts/export.mjs <format> <project.json> [options]

Formats:
${Object.entries(FORMATS).map(([k, v]) => `  ${k.padEnd(9)} ${v.file.padEnd(17)} ${v.what}`).join('\n')}

Options:
  --out FILE        write here (use "-" for stdout). Default: exports/<project>/<file>
  --library DIR     extra part folder (overrides the built-in library)
  --controller ID   pins-h: controller part id (default: first "controller" part)
  --style S         pins-h: define (default) or constexpr
  --help            this text
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith('--') && v !== '-')) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
      i++;
    } else opts._.push(a);
  }
  return opts;
}

/** exports/<name>/ next to the projects/ folder, else under the current directory. */
export function defaultOutDir(projectPath) {
  const abs = resolve(projectPath);
  const name = basename(abs).replace(/\.json$/i, '');
  const parent = dirname(abs);
  const root = basename(parent) === 'projects' ? dirname(parent) : process.cwd();
  return join(root, 'exports', name);
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.help) { console.log(HELP); return 0; }
  const [format, projectPath] = opts._;
  if (!format || !projectPath) { console.error(HELP); return 2; }
  if (!FORMATS[format]) { console.error(`Unknown format "${format}". Formats: ${Object.keys(FORMATS).join(', ')}`); return 2; }
  if (!existsSync(projectPath)) { console.error(`No such project file: ${projectPath}`); return 2; }

  let project;
  try { project = readProject(projectPath); } catch (e) { console.error(e.message); return 2; }
  const extra = [];
  if (opts.library) extra.push(resolve(opts.library));
  const library = loadLibrary(join(WIREMAP_ROOT, 'library'), ...extra);

  let text;
  try {
    switch (format) {
      case 'pins-h': text = pinsHeader(project, library, { controller: opts.controller, style: opts.style }); break;
      case 'bom-csv': text = bomCsv(project, library); break;
      case 'wireviz': text = wirevizYaml(project, library); break;
      case 'kicad': text = kicadNetlist(project, library, { date: new Date().toISOString(), source: basename(projectPath) }); break;
      case 'shopping': text = shoppingChecklist(project, library); break;
      case 'html': {
        let check;
        try {
          const mod = await import('../lib/check.js');
          if (typeof mod.checkProject === 'function') check = mod.checkProject(project, library);
        } catch { /* checker not available: guide without the check section */ }
        text = buildGuideHtml(project, library, check);
        break;
      }
    }
  } catch (e) {
    console.error(`Export failed: ${e.message}`);
    return 1;
  }

  if (opts.out === '-') { process.stdout.write(text); return 0; }
  const out = opts.out ? resolve(opts.out) : join(defaultOutDir(projectPath), FORMATS[format].file);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, 'utf8');
  console.log(`Wrote ${out}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
