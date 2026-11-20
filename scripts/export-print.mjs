#!/usr/bin/env node
// wiremap export-print: per-print folders with a settings card, and plate 3MFs
// that pack the project's STLs onto the printer bed (one plate set per material).
// Exit 0 = ok, 1 = some print does not fit / is missing files, 2 = bad usage.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fitPart, materialCheck } from '../lib/printer.js';
import { loadPrinters, readProject } from '../lib/node/library.js';
import { readSTL, meshStats } from '../lib/node/stl.js';
import { packPlates } from '../lib/node/threemf.js';
import { resolveProjectPath } from './fit-printer.mjs';

const HELP = `Usage: wiremap export-print --project projects/x.json [--out prints/] [--json]

For each entry in project.prints: prints/<id>/settings.md (+ settings.json) with
material, orientation, supports, infill, layer height and a rough time/filament
estimate, then prints/plates/<material>_plate_N.3mf packing every STL onto the bed.
Estimates are labelled as estimates; slice in Bambu Studio / OrcaSlicer for real numbers.`;

/** g/cm³, typical datasheet values. */
export const DENSITY = { PLA: 1.24, PETG: 1.27, ABS: 1.04, ASA: 1.07, TPU: 1.21, PC: 1.2, PA: 1.14, 'PLA-CF': 1.3, 'PETG-CF': 1.3, 'PA-CF': 1.2, PVA: 1.23 };

/** Average effective volumetric rate (mm³/s) including travel, for the time estimate. */
function avgFlow(profile, material) {
  const fast = /^bambu-/.test(profile.id || '');
  let f = fast ? 9 : 5;
  if (/TPU/i.test(material)) f = 2.5;
  else if (/PETG|ABS|ASA|PC|PA/i.test(material)) f *= 0.8;
  return f;
}

/**
 * Rough print estimate. Method (documented, an ESTIMATE):
 *   solid volume V and surface area A from the STL (or, without an STL, the bounding
 *   box with an assumed 50% fill); shell ≈ min(V, A × 0.8 mm) for 2 walls / top / bottom;
 *   material = shell + (V − shell) × infill; mass = material × density;
 *   length = material / (π × 0.875²) for 1.75 mm filament; time = material / average flow
 *   × 1.3 (travel, retractions) + 6 min (heating, levelling).
 */
export function estimatePrint({ volume, area, size, infill = 0.15, material = 'PLA', profile }) {
  let V = volume, A = area, basis = 'STL volume and surface area';
  if (!(V > 0)) {
    if (!size) return null;
    const [a, b, c] = size;
    V = a * b * c * 0.5;
    A = 2 * (a * b + b * c + a * c);
    basis = 'bounding box with 50% assumed fill (very rough: no STL yet)';
  }
  const shell = Math.min(V, A * 0.8);
  const mat = shell + (V - shell) * infill;
  const dens = DENSITY[String(material).toUpperCase()] ?? 1.24;
  const grams = mat / 1000 * dens;
  const meters = mat / (Math.PI * 0.875 * 0.875) / 1000;
  const flow = avgFlow(profile || {}, material);
  const hours = mat / flow / 3600 * 1.3 + 0.1;
  return { grams: Math.round(grams), meters: Math.round(meters * 10) / 10, hours: Math.round(hours * 10) / 10, material_mm3: Math.round(mat), basis, label: 'estimate', method: 'shell ≈ min(V, A × 0.8 mm); material = shell + (V − shell) × infill; time = material / avg flow × 1.3 + 6 min' };
}

function card(pr, info) {
  const s = info.settings;
  const L = [];
  L.push(`# ${pr.name || pr.id}`, '');
  L.push(`Printer: **${info.printer}**${info.nozzle ? ` (${info.nozzle} nozzle)` : ''}`, '');
  L.push('| Setting | Value |', '| --- | --- |');
  L.push(`| Material | ${info.material}${info.materialCheck ? ` (${info.materialCheck.status}: ${info.materialCheck.reason})` : ''} |`);
  L.push(`| Orientation | ${s.orientation} |`);
  L.push(`| Supports | ${s.supports} |`);
  L.push(`| Infill | ${s.infill}% |`);
  L.push(`| Layer height | ${s.layer} mm |`);
  L.push(`| Walls | ${s.walls} |`);
  if (s.brim) L.push(`| Brim | ${s.brim} |`);
  L.push('');
  if (info.fit) L.push(`Fit: ${info.fit.fits ? 'fits' : '**does not fit**'} - ${info.fit.suggestion}`, '');
  if (info.files.length) L.push('Files:', ...info.files.map((f) => `- \`${f}\``), '');
  if (info.estimate) {
    const e = info.estimate;
    L.push(`Estimate (rough, not from a slicer): about **${e.hours} h**, **${e.grams} g** (${e.meters} m of 1.75 mm filament).`);
    L.push(`Method: ${e.method}. Basis: ${e.basis}. Slice it for real numbers.`, '');
  } else L.push('Estimate: not available (no size or STL).', '');
  if (info.warnings.length) L.push('Warnings:', ...info.warnings.map((w) => `- ${w}`), '');
  return L.join('\n');
}

export async function main(argv = []) {
  let a;
  try { a = parseArgs({ args: argv, options: { project: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true }).values; } catch (e) { console.error(e.message + '\n\n' + HELP); return 2; }
  if (a.help) { console.log(HELP); return 0; }
  if (!a.project) { console.error('export-print: --project is required\n\n' + HELP); return 2; }
  let report;
  try {
    const project = readProject(a.project);
    const printers = loadPrinters();
    const pid = project.printer?.profile;
    const profile = printers[pid] || printers.generic;
    if (!profile) throw new Error(`unknown printer ${pid}`);
    const nozzle = project.printer?.nozzle && project.printer.nozzle !== 'single' ? project.printer.nozzle : undefined;
    const root = resolve(dirname(resolve(a.project)), '..');
    const outRoot = a.out ? resolve(a.out) : join(root, 'prints');
    report = { project: a.project, printer: profile.id, prints: [], plates: [], tooBig: [], warnings: [] };
    if (!pid || !printers[pid]) report.warnings.push(`Printer "${pid}" not found; used the generic profile.`);
    const byMaterial = new Map();
    let bad = false;
    for (const pr of project.prints || []) {
      if (!pr.id) { report.warnings.push('A print without an id was skipped.'); continue; }
      const material = pr.material || project.printer?.material || 'PLA';
      const st = pr.settings || {};
      const files = [...(pr.files || []), ...(pr.pieces || []).map((p) => p.file).filter(Boolean)];
      const meshes = [];
      const warnings = [];
      for (const f of files.filter((x) => /\.stl$/i.test(x))) {
        const pth = resolveProjectPath(a.project, f);
        if (!pth) { warnings.push(`${f} not found (export it from CAD first).`); continue; }
        try { meshes.push({ name: `${pr.id}:${f.split('/').pop()}`, mesh: readSTL(pth) }); } catch (e) { warnings.push(`${f}: ${e.message}`); }
      }
      let size = pr.size;
      let volume = 0, area = 0;
      for (const m of meshes) { const s = meshStats(m.mesh); volume += Math.abs(s.volume); area += s.area; }
      if (meshes.length === 1) size = meshes[0].mesh.bbox.size;
      const fit = Array.isArray(size) ? fitPart(size, profile, { nozzle }) : null;
      if (fit && !fit.fits && !(pr.pieces || []).length) { bad = true; warnings.push('Does not fit the printer: run wiremap split-part.'); }
      const mc = materialCheck(material, profile);
      if (mc.status === 'no') { bad = true; warnings.push(mc.reason); } else if (mc.status === 'warn') warnings.push(mc.reason);
      const infill = st.infill ?? 15;
      const settings = {
        orientation: st.orientation || (fit?.fits ? `${fit.orientation[0]} x ${fit.orientation[1]} mm on the bed, ${fit.orientation[2]} mm tall (largest flat face down)` : 'see split pieces'),
        supports: st.supports === true ? 'yes (tree supports)' : st.supports === false ? 'none' : (st.supports || 'check in the slicer: overhangs steeper than 50° need supports'),
        infill, layer: st.layer ?? 0.2, walls: st.walls ?? 2,
        brim: st.brim ?? (profile.enclosed === false && /ABS|ASA|PC|PA/i.test(material) ? '5 mm (warp-prone material on an open frame)' : null),
      };
      const estimate = estimatePrint({ volume, area, size: Array.isArray(size) ? size : null, infill: infill / 100, material, profile });
      const dir = join(outRoot, pr.id);
      mkdirSync(dir, { recursive: true });
      const info = { printer: profile.name || profile.id, nozzle, material, materialCheck: mc, settings, fit: fit && { fits: fit.fits, suggestion: fit.suggestion }, files, estimate, warnings };
      writeFileSync(join(dir, 'settings.md'), card(pr, info));
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ id: pr.id, ...info }, null, 2) + '\n');
      report.prints.push({ id: pr.id, dir, material, estimate, fits: fit?.fits ?? null, warnings });
      if (!byMaterial.has(material)) byMaterial.set(material, []);
      byMaterial.get(material).push(...meshes);
    }
    const vol = nozzle && profile.nozzles ? profile.nozzles[nozzle] : profile.volume;
    for (const [material, meshes] of byMaterial) {
      if (!meshes.length) continue;
      const { plates, tooBig } = packPlates(meshes, [vol[0], vol[1]], { margin: profile.margin_mm ?? 5, gap: 5, title: `${project.meta?.name || 'Wiremap'} ${material}` });
      mkdirSync(join(outRoot, 'plates'), { recursive: true });
      plates.forEach((pl, i) => {
        const file = join(outRoot, 'plates', `${material.toLowerCase()}_plate_${i + 1}.3mf`);
        writeFileSync(file, pl.bytes);
        report.plates.push({ file, material, parts: pl.parts });
      });
      report.tooBig.push(...tooBig);
      if (tooBig.length) bad = true;
    }
    report.ok = !bad;
  } catch (e) {
    if (a.json) console.log(JSON.stringify({ error: e.message })); else console.error(`export-print: ${e.message}`);
    return 2;
  }
  if (a.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`export-print: ${report.prints.length} print(s) for ${report.printer}`);
    for (const p of report.prints) {
      const e = p.estimate ? `~${p.estimate.hours} h, ~${p.estimate.grams} g (estimate)` : 'no estimate';
      console.log(`  ${relative(process.cwd(), p.dir) || p.dir}/settings.md  ${p.material}  ${e}${p.fits === false ? '  DOES NOT FIT' : ''}`);
      for (const w of p.warnings) console.log(`    WARN ${w}`);
    }
    for (const pl of report.plates) console.log(`  plate ${relative(process.cwd(), pl.file)}: ${pl.parts.join(', ')}`);
    if (report.tooBig.length) console.log(`  Too big for the bed (not on any plate): ${report.tooBig.join(', ')}`);
    for (const w of report.warnings) console.log(`  WARN ${w}`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
