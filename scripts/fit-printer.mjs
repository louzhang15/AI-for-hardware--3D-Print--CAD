#!/usr/bin/env node
// wiremap fit-printer: check parts against a printer's build volume and materials.
// Exit 0 = everything fits, 1 = something does not fit / material not allowed, 2 = bad usage.
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fitPart, materialCheck } from '../lib/printer.js';
import { loadPrinters, readProject } from '../lib/node/library.js';
import { readSTL } from '../lib/node/stl.js';

const HELP = `Usage:
  wiremap fit-printer --printer <id> (--size 200x120x40 | --stl part.stl) [--material PETG] [--margin 5] [--nozzle left|right|both]
  wiremap fit-printer --project projects/x.json

Checks every orientation (and the XY diagonal) against the printer's usable
volume (build volume minus the margin per side). Too-big parts get a split
suggestion (run split-part to cut them). Options:
  --printer   printer profile id (printers/*.json)
  --size      part bounding box in mm, AxBxC
  --stl       read the bounding box from an STL
  --material  check the material against the printer (open frame vs ABS/ASA...)
  --margin    mm kept free per side (default: profile margin_mm, 5)
  --nozzle    H2D: left, right, both (default: one nozzle)
  --no-diagonal  do not try diagonal placement
  --json      machine-readable output`;

const OPTS = {
  printer: { type: 'string' }, size: { type: 'string' }, stl: { type: 'string' }, material: { type: 'string' },
  margin: { type: 'string' }, nozzle: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }, 'no-diagonal': { type: 'boolean' },
};

export function parseSize(s) {
  const parts = String(s).toLowerCase().split(/[x×*, ]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || parts.some((v) => !(v > 0))) throw new Error(`--size must look like 200x120x40 (got ${s})`);
  return parts;
}

/** Resolve a path written in a project file: relative to cwd, the project's root (parent of projects/), or the project dir. */
export function resolveProjectPath(projectFile, p) {
  const pdir = dirname(resolve(projectFile));
  for (const c of [resolve(p), resolve(pdir, '..', p), resolve(pdir, p)]) if (existsSync(c)) return c;
  return null;
}

function getProfile(id) {
  const all = loadPrinters();
  const p = all[id];
  if (!p) throw new Error(`unknown printer "${id}" (have: ${Object.keys(all).join(', ')})`);
  return p;
}

function describe(name, r, mat) {
  const lines = [`${name}: ${r.size.map((v) => +v.toFixed(2)).join(' x ')} mm on ${r.printer}${r.nozzle && r.nozzle !== 'single' ? ` (${r.nozzle} nozzle)` : ''} -> ${r.fits ? 'FITS' : 'DOES NOT FIT'}`];
  lines.push(`  usable ${r.usable.join(' x ')} mm (volume ${r.volume.join(' x ')}, margin ${r.margin} mm per side)`);
  lines.push(`  ${r.suggestion}`);
  if (!r.fits && r.split) {
    lines.push(`  split: ${r.split.pieces} pieces, largest ${r.split.pieceSize.join(' x ')} mm. Run: wiremap split-part --stl <file> --printer ${r.printer}`);
  }
  if (r.fits && r.options.length > 1) lines.push(`  other orientations: ${r.options.slice(1, 4).map((o) => o.orientation.join('x') + (o.rotationDeg ? ` @${o.rotationDeg}°` : '')).join(', ')}`);
  for (const w of r.warnings) lines.push(`  WARN ${w}`);
  if (mat) lines.push(`  material ${mat.material}: ${mat.status.toUpperCase()} - ${mat.reason}`);
  return lines.join('\n');
}

export async function main(argv = []) {
  let a;
  try { a = parseArgs({ args: argv, options: OPTS, allowPositionals: true }).values; } catch (e) { console.error(e.message + '\n\n' + HELP); return 2; }
  if (a.help) { console.log(HELP); return 0; }
  const results = [];
  try {
    if (a.project) {
      const project = readProject(a.project);
      const pid = a.printer || project.printer?.profile;
      if (!pid) throw new Error('project has no printer.profile (and no --printer given)');
      const profile = getProfile(pid);
      const nozzle = a.nozzle || (project.printer?.nozzle && project.printer.nozzle !== 'single' ? project.printer.nozzle : undefined);
      const margin = a.margin !== undefined ? Number(a.margin) : undefined;
      for (const pr of project.prints || []) {
        let size = pr.size, from = 'size';
        const stl = (pr.files || []).find((f) => /\.stl$/i.test(f));
        const stlPath = stl ? resolveProjectPath(a.project, stl) : null;
        if (stlPath) { size = readSTL(stlPath).bbox.size.map((v) => +v.toFixed(3)); from = stl; }
        const material = pr.material || project.printer?.material;
        if (!Array.isArray(size)) {
          results.push({ id: pr.id, name: pr.name, skipped: true, reason: `no size and no readable STL${stl ? ` (${stl} not found)` : ''}` });
          continue;
        }
        const r = fitPart(size, profile, { margin, nozzle, allowDiagonal: !a['no-diagonal'] });
        results.push({ id: pr.id, name: pr.name, from, ...r, material: material ? materialCheck(material, profile) : null });
      }
      if (!results.length) results.push({ id: null, skipped: true, reason: 'project has no prints' });
    } else {
      if (!a.printer) { console.error('fit-printer: --printer is required (or --project)\n\n' + HELP); return 2; }
      const profile = getProfile(a.printer);
      let size;
      if (a.stl) size = readSTL(a.stl).bbox.size.map((v) => +v.toFixed(3));
      else if (a.size) size = parseSize(a.size);
      else { console.error('fit-printer: give --size or --stl\n\n' + HELP); return 2; }
      const r = fitPart(size, profile, { margin: a.margin !== undefined ? Number(a.margin) : undefined, nozzle: a.nozzle, allowDiagonal: !a['no-diagonal'] });
      results.push({ id: a.stl || 'part', from: a.stl ? a.stl : 'size', ...r, material: a.material ? materialCheck(a.material, profile) : null });
    }
  } catch (e) {
    if (a.json) console.log(JSON.stringify({ error: e.message })); else console.error(`fit-printer: ${e.message}`);
    return 2;
  }
  const bad = results.some((r) => r.fits === false || r.material?.status === 'no');
  if (a.json) console.log(JSON.stringify({ ok: !bad, results }, null, 2));
  else {
    for (const r of results) {
      if (r.skipped) console.log(`${r.id ?? ''}: skipped (${r.reason})`);
      else console.log(describe(r.name ? `${r.id} (${r.name})` : r.id, r, r.material));
    }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
