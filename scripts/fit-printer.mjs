#!/usr/bin/env node
// wiremap fit-printer: check parts against a printer's build volume and materials.
// Exit 0 = everything fits, 1 = something does not fit / material not allowed, 2 = bad usage.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fitPart, materialCheck, printPlacement } from '../lib/printer.js';
import { loadPrinters, readProject } from '../lib/node/library.js';
import { printSTLs, preparePrintMesh, resolveProjectPath } from '../lib/node/print.js';
import { checkClosed, readSTL } from '../lib/node/stl.js';

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

function meshFit(path, profile, placement, opts) {
  const mesh = readSTL(path);
  const { fit } = preparePrintMesh(mesh, profile, placement, opts);
  const { closed } = checkClosed(mesh);
  if (!closed) fit.warnings.push('Mesh has open or mismatched edges. Repair the STL before slicing.');
  return { ...fit, closed };
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
      const opts = { nozzle, allowDiagonal: !a['no-diagonal'] };
      const placement = printPlacement(profile, { margin, nozzle });
      for (const pr of project.prints || []) {
        const material = a.material || pr.material || project.printer?.material;
        const part = { id: pr.id, name: pr.name, material: material ? materialCheck(material, profile) : null };
        const files = printSTLs(pr);
        for (const from of files) {
          try {
            const path = resolveProjectPath(a.project, from);
            if (!path) throw new Error('STL file not found');
            results.push({ ...part, from, ...meshFit(path, profile, placement, opts) });
          } catch (e) {
            results.push({ ...part, from, fits: false, error: e.message });
          }
        }
        if (!files.length) {
          if (Array.isArray(pr.size) && !pr.pieces?.length) {
            const fit = fitPart(pr.size, profile, { ...opts, margin });
            fit.warnings.push('Checked planned dimensions only. Add an STL for a slicer-ready export.');
            results.push({ ...part, from: 'size', ...fit });
          } else {
            results.push({ ...part, fits: false, error: 'No STL or planned dimensions to check' });
          }
        }
      }
      if (!results.length) results.push({ id: null, skipped: true, reason: 'project has no prints' });
    } else {
      if (!a.printer) { console.error('fit-printer: --printer is required (or --project)\n\n' + HELP); return 2; }
      const profile = getProfile(a.printer);
      if (!a.stl && !a.size) { console.error('fit-printer: give --size or --stl\n\n' + HELP); return 2; }
      const opts = { nozzle: a.nozzle, allowDiagonal: !a['no-diagonal'] };
      const margin = a.margin !== undefined ? Number(a.margin) : undefined;
      const r = a.stl
        ? meshFit(a.stl, profile, printPlacement(profile, { nozzle: a.nozzle, margin }), opts)
        : fitPart(parseSize(a.size), profile, { ...opts, margin });
      results.push({ id: a.stl || 'part', from: a.stl ? a.stl : 'size', ...r, material: a.material ? materialCheck(a.material, profile) : null });
    }
  } catch (e) {
    if (a.json) console.log(JSON.stringify({ error: e.message })); else console.error(`fit-printer: ${e.message}`);
    return 2;
  }
  const bad = results.some((r) => r.fits === false || r.closed === false || r.material?.status === 'no');
  if (a.json) console.log(JSON.stringify({ ok: !bad, results }, null, 2));
  else {
    for (const r of results) {
      if (r.skipped) console.log(`${r.id ?? ''}: skipped (${r.reason})`);
      else {
        const name = [r.name ? `${r.id} (${r.name})` : r.id, r.from !== r.id && r.from !== 'size' ? r.from : null].filter(Boolean).join(' / ');
        console.log(r.error ? `${name}: ${r.error}` : describe(name, r, r.material));
      }
    }
  }
  return bad ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
