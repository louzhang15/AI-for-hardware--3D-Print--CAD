#!/usr/bin/env node
// wiremap cad-check: check exported print files and the assembly before slicing.
//   wiremap cad-check --project projects/robot-arm.json [--json]
//   wiremap cad-check --stl part.stl --printer bambu-a1-mini [--material PLA] [--size 85,60,3.2] [--no-supports]
// Exit 0 = no errors, 1 = errors found, 2 = bad usage or unreadable file.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { analyzeMesh, checkAssembly, checkPrintsDFM } from '../lib/dfm.js';
import { readSTL } from '../lib/node/stl.js';
import { loadLibrary, loadPrinters, readProject } from '../lib/node/library.js';

const HELP = `Usage: wiremap cad-check --project projects/<name>.json [--json]
       wiremap cad-check --stl part.stl --printer <id> [--material PLA] [--size x,y,z] [--no-supports] [--json]

Checks each print's STL (exported in print orientation, Z up): size against
prints[].size, watertight mesh, overhangs past 45°, bed contact, tall thin
parts, printed mass. With mechanics.assembly in the project it also checks
overlapping components, screwdriver access and assembly order.`;

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { o[k] = next; i++; } else o[k] = true;
  }
  return o;
}

/** STL file for a print: first .stl in pieces, files or source, resolved against the repo root. */
export function printStl(print, root) {
  const cands = [...(print.pieces || []).map((p) => p.file), ...(print.files || []), print.source].filter((f) => typeof f === 'string' && /\.stl$/i.test(f));
  for (const f of cands) { const p = resolve(root, f); if (existsSync(p)) return p; }
  return null;
}

const mark = { error: 'ERROR', warning: 'WARN ', info: 'info ' };

function printAnalysis(name, A) {
  const lines = [`  ${name}: ${A.size.join(' × ')} mm, ${A.volume_cm3} cm³, about ${A.printed_mass_g} g printed (${A.solid_mass_g} g solid)`,
    `    bed contact ${A.contact_mm2} mm², overhang ${A.overhang_mm2} mm² (${A.overhang_pct} %), ${A.closed.closed ? 'watertight' : 'NOT watertight'}`];
  for (const p of A.problems) lines.push(`    ${mark[p.level]} [${p.rule}] ${p.text}`, `           fix: ${p.fix}`);
  return lines.join('\n');
}

export async function main(argv = []) {
  const o = parse(argv);
  if (o.help || o.h || (!o.project && !o.stl)) { console.log(HELP); return o.help ? 0 : 2; }
  const printers = loadPrinters();
  if (o.stl) {
    let mesh;
    try { mesh = readSTL(o.stl); } catch (e) { console.error(`cad-check: ${e.message}`); return 2; }
    const profile = o.printer ? printers[o.printer] : null;
    if (o.printer && !profile) { console.error(`cad-check: unknown printer ${o.printer} (have: ${Object.keys(printers).join(', ')})`); return 2; }
    const size = typeof o.size === 'string' ? o.size.split(',').map(Number) : undefined;
    const A = analyzeMesh(mesh, { declaredSize: size, material: o.material || 'PLA', profile, supports: o['no-supports'] ? false : undefined });
    if (o.json) console.log(JSON.stringify(A, null, 2)); else console.log(`Wiremap cad-check\n${printAnalysis(o.stl, A)}`);
    return A.problems.some((p) => p.level === 'error') ? 1 : 0;
  }
  let project;
  try { project = readProject(o.project); } catch (e) { console.error(e.message); return 2; }
  const root = resolve(dirname(resolve(o.project)), '..');
  const profile = printers[project.printer?.profile] || null;
  const meshes = {}; const missing = []; const unreadable = [];
  for (const pr of project.prints || []) {
    const f = printStl(pr, root);
    if (!f) { missing.push(pr.id); continue; }
    try { meshes[pr.id] = readSTL(f); } catch (e) { unreadable.push(`${pr.id}: ${e.message}`); }
  }
  const dfm = checkPrintsDFM(project, meshes, { profile });
  const asm = checkAssembly(project, loadLibrary());
  const problems = [...dfm.problems, ...asm.problems];
  if (o.json) {
    console.log(JSON.stringify({ prints: dfm.report, assembly: asm.report, missing, unreadable, problems }, null, 2));
  } else {
    const lines = [`Wiremap cad-check: ${o.project}${profile ? ` (${profile.name})` : ''}`];
    for (const [id, A] of Object.entries(dfm.report)) lines.push(printAnalysis(id, A));
    for (const id of missing) lines.push(`  ${id}: no STL listed or found; export it and list it in prints[].files.`);
    for (const u of unreadable) lines.push(`  ERROR ${u}`);
    if (asm.report) {
      lines.push('', `  Assembly: ${asm.report.interference.length} overlap(s), ${asm.report.access.filter((a) => !a.clear).length} blocked fastener(s), ${asm.report.order.length} order problem(s)`);
      for (const p of asm.problems) lines.push(`    ${mark[p.level]} [${p.rule}] ${p.text}`);
    } else lines.push('', '  Assembly not checked: add mechanics.assembly (allow_overlap, rests_on) to opt in.');
    const errors = problems.filter((p) => p.level === 'error').length + unreadable.length;
    lines.push('', `  ${errors} error(s), ${problems.filter((p) => p.level === 'warning').length} warning(s).`);
    console.log(lines.join('\n'));
  }
  return problems.some((p) => p.level === 'error') || unreadable.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
