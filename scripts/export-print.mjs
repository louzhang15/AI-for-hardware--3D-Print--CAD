#!/usr/bin/env node
// wiremap export-print: per-print folders with a settings card, and plate 3MFs
// that pack the project's STLs onto the printer bed (one plate set per material).
// Exit 0 = ok, 1 = some print does not fit / is missing files, 2 = bad usage.
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fitPart, materialCheck, nozzleVolume, usableVolume } from '../lib/printer.js';
import { loadPrinters, readProject } from '../lib/node/library.js';
import { readSTL, meshStats, orientMesh } from '../lib/node/stl.js';
import { packPlates } from '../lib/node/threemf.js';
import { resolveProjectPath } from './fit-printer.mjs';

const HELP = `Usage: wiremap export-print --project projects/x.json [--out prints/] [--json]

For each entry in project.prints, package the available CAD source and print files,
the print settings, oriented 3MF files, and combined plates grouped by material.
An STL is required for each piece to be fit-checked and placed on a plate.
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
  for (const piece of info.pieceFits) L.push(`- ${piece.name}: ${piece.suggestion}`);
  if (info.pieceFits.length) L.push('');
  if (info.files.length) L.push('Files:', ...info.files.map((f) => `- \`${f}\``), '');
  if (info.estimate) {
    const e = info.estimate;
    L.push(`Estimate (rough, not from a slicer): about **${e.hours} h**, **${e.grams} g** (${e.meters} m of 1.75 mm filament).`);
    L.push(`Method: ${e.method}. Basis: ${e.basis}. Slice it for real numbers.`, '');
  } else L.push('Estimate: not available (no size or STL).', '');
  if (info.warnings.length) L.push('Warnings:', ...info.warnings.map((w) => `- ${w}`), '');
  return L.join('\n');
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safe3mfPath = /^(?:plates\/|[^/:*?"<>|\\]+\/oriented\/)[^/:*?"<>|\\]+\.3mf$/i;

// Only remove 3MFs recorded by Wiremap whose contents still match that export.
function savePrintFiles(outRoot, files, warnings) {
  mkdirSync(outRoot, { recursive: true });
  const root = realpathSync(outRoot);
  const manifest = join(root, '.wiremap-print-manifest.json');
  const lock = join(root, '.wiremap-print.lock');
  let fd;
  try { fd = openSync(lock, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Print output is locked at ${root}. Use another --out directory.`); throw e; }
  let committed = false;
  try {
    const manifestStatus = lstatSync(manifest, { throwIfNoEntry: false });
    if (manifestStatus && !manifestStatus.isFile()) throw new Error(`Invalid print manifest at ${manifest}.`);
    const previous = manifestStatus ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
    const paths = new Set([...files.keys(), ...Object.keys(previous)]);
    const removed = [];
    const current = Object.create(null);
    for (const name of paths) {
      if (!safe3mfPath.test(name) || name.split('/').some((part) => part === '.' || part === '..')) throw new Error(`Invalid print output path ${name}.`);
      const file = join(root, name);
      const directory = dirname(file);
      const directoryStatus = lstatSync(directory, { throwIfNoEntry: false });
      if (directoryStatus && relative(directory, realpathSync(directory))) throw new Error(`Print output folder resolves elsewhere: ${directory}.`);
      const status = lstatSync(file, { throwIfNoEntry: false });
      const owned = status?.isFile() && Object.hasOwn(previous, name) && digest(readFileSync(file)) === previous[name];
      if (files.has(name)) {
        if (status && !owned) throw new Error(`Preserved existing 3MF ${file}. Use another --out directory to export.`);
        current[name] = digest(files.get(name));
      } else if (owned) removed.push(name);
      else if (status) warnings.push(`Preserved modified 3MF ${file}. It is outside this export.`);
    }
    const plateDir = join(root, 'plates');
    if (lstatSync(plateDir, { throwIfNoEntry: false })?.isDirectory()) {
      for (const entry of readdirSync(plateDir)) {
        const name = `plates/${entry}`;
        if (/\.3mf$/i.test(entry) && !paths.has(name)) warnings.push(`Preserved untracked 3MF ${join(root, name)}. It is outside this export.`);
      }
    }
    for (const [name, bytes] of files) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    for (const name of removed) unlinkSync(join(root, name));
    writeFileSync(fd, JSON.stringify(current, null, 2) + '\n');
    closeSync(fd);
    fd = undefined;
    renameSync(lock, manifest);
    committed = true;
    return removed;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!committed) unlinkSync(lock);
  }
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
    const volume = nozzleVolume(profile, nozzle);
    volume[2] = usableVolume(profile, { nozzle })[2];
    const margin = profile.margin_mm ?? 5;
    const keepouts = (profile.keepout || []).map(({ rect }) => rect).filter(Boolean)
      .map(([x, y, w, h]) => [x - margin, y - margin, w + 2 * margin, h + 2 * margin]);
    const packing = { margin, keepouts };
    const root = resolve(dirname(resolve(a.project)), '..');
    const outRoot = a.out ? resolve(a.out) : join(root, 'prints');
    report = { project: a.project, printer: profile.id, prints: [], plates: [], tooBig: [], warnings: [] };
    if (!pid || !printers[pid]) report.warnings.push(`Printer "${pid}" not found; used the generic profile.`);
    const byMaterial = new Map();
    const generated = new Map();
    let bad = false;
    for (const pr of project.prints || []) {
      if (typeof pr.id !== 'string' || !pr.id.trim() || /[\\/:*?"<>|]/.test(pr.id) || /[. ]$/.test(pr.id)
        || pr.id.toLowerCase() === 'plates') {
        report.warnings.push(`Invalid print folder name: ${JSON.stringify(pr.id)}`);
        bad = true;
        continue;
      }
      const dir = join(outRoot, pr.id);
      const material = (pr.material || project.printer?.material || 'PLA').trim().toUpperCase();
      const st = pr.settings || {};
      const pieceFiles = (pr.pieces || []).map((piece) => piece.file).filter(Boolean);
      const files = [...new Set([pr.source, ...(pr.files || []), ...pieceFiles].filter(Boolean))];
      const selectedSTLs = new Set(pieceFiles.length ? pieceFiles : (pr.files || []));
      const packaged = [];
      const meshes = [];
      const warnings = [];
      const names = new Set();
      for (const f of files) {
        const pth = resolveProjectPath(a.project, f);
        if (!pth) { bad = true; warnings.push(`${f} not found.`); continue; }
        const ext = extname(pth);
        const stem = basename(pth, ext);
        let name = stem;
        for (let i = 2; names.has(`${name}${ext}`.toLowerCase()); i++) name = `${stem}-${i}`;
        names.add(`${name}${ext}`.toLowerCase());
        try {
          const dest = join(dir, 'assets', `${name}${ext}`);
          mkdirSync(dirname(dest), { recursive: true });
          if (resolve(pth) !== dest) copyFileSync(pth, dest);
          packaged.push(`assets/${name}${ext}`);
          if (ext.toLowerCase() === '.stl' && selectedSTLs.has(f)) {
            const mesh = readSTL(pth);
            const fit = fitPart(mesh.bbox.size, profile, { nozzle });
            const meshName = `${pr.id}:${name}${ext}`;
            meshes.push({ name: meshName, fileStem: name, mesh, fit });
            if (!fit.fits) { bad = true; report.tooBig.push(meshName); }
            warnings.push(...fit.warnings.map((warning) => `${name}${ext}: ${warning}`));
          }
        } catch (e) {
          bad = true;
          warnings.push(`${f}: ${e.message}`);
        }
      }
      if (!meshes.length) { bad = true; warnings.push('No readable STL available for a fit-checked plate.'); }
      let size = pr.size;
      let meshVolume = 0, area = 0;
      for (const m of meshes) { const s = meshStats(m.mesh); meshVolume += Math.abs(s.volume); area += s.area; }
      if (meshes.length === 1) size = meshes[0].mesh.bbox.size;
      const fit = meshes.length === 1 ? meshes[0].fit : !meshes.length && Array.isArray(size) ? fitPart(size, profile, { nozzle }) : null;
      const pieceFits = meshes.map(({ name, fit }) => ({ name, fits: fit.fits, orientation: fit.orientation, rotationDeg: fit.rotationDeg, suggestion: fit.suggestion }));
      const mc = materialCheck(material, profile);
      if (mc.status === 'no') { bad = true; warnings.push(mc.reason); } else if (mc.status === 'warn') warnings.push(mc.reason);
      const ready = meshes.filter(({ fit }) => fit.fits && mc.status !== 'no');
      for (const item of ready) {
        const file = join(dir, 'oriented', `${item.fileStem}.3mf`);
        const oriented = { name: item.name, mesh: orientMesh(item.mesh, item.fit) };
        const { plates } = packPlates([oriented], volume, packing);
        if (!plates.length) {
          bad = true;
          report.tooBig.push(item.name);
          const piece = pieceFits.find(({ name }) => name === item.name);
          piece.fits = false;
          piece.suggestion = 'Does not fit the printable bed after margins and reserved areas.';
          continue;
        }
        generated.set(relative(outRoot, file).split(sep).join('/'), plates[0].bytes);
        packaged.push(`oriented/${item.fileStem}.3mf`);
        if (!byMaterial.has(material)) byMaterial.set(material, []);
        byMaterial.get(material).push(oriented);
      }
      const infill = st.infill ?? 15;
      const settings = {
        orientation: st.orientation || (fit?.fits ? fit.suggestion : 'See individual fit results'),
        supports: st.supports === true ? 'yes (tree supports)' : st.supports === false ? 'none' : (st.supports || 'check in the slicer: overhangs steeper than 50° need supports'),
        infill, layer: st.layer ?? 0.2, walls: st.walls ?? 2,
        brim: st.brim ?? (profile.enclosed === false && /ABS|ASA|PC|PA/i.test(material) ? '5 mm (warp-prone material on an open frame)' : null),
      };
      const estimate = estimatePrint({ volume: meshVolume, area, size: Array.isArray(size) ? size : null, infill: infill / 100, material, profile });
      mkdirSync(dir, { recursive: true });
      const fitSummary = meshes.length === 1 ? pieceFits[0] : fit;
      const info = { printer: profile.name || profile.id, nozzle, material, materialCheck: mc, settings, fit: fitSummary && { fits: fitSummary.fits, suggestion: fitSummary.suggestion }, pieceFits, files: packaged, estimate, warnings };
      writeFileSync(join(dir, 'settings.md'), card(pr, info));
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ id: pr.id, ...info }, null, 2) + '\n');
      report.prints.push({ id: pr.id, dir, material, estimate, fits: meshes.length ? pieceFits.every((piece) => piece.fits) : fit?.fits ?? null, pieceFits, warnings });
    }
    for (const [material, meshes] of byMaterial) {
      const { plates, tooBig } = packPlates(meshes, volume, { ...packing, title: `${project.meta?.name || 'Wiremap'} ${material}` });
      plates.forEach((pl, i) => {
        const slug = encodeURIComponent(material.toLowerCase()).replace(/\*/g, '%2A');
        const file = join(outRoot, 'plates', `${slug}_plate_${i + 1}.3mf`);
        generated.set(relative(outRoot, file).split(sep).join('/'), pl.bytes);
        report.plates.push({ file, material, parts: pl.parts });
      });
      report.tooBig.push(...tooBig);
      if (tooBig.length) bad = true;
    }
    report.retired3mfs = savePrintFiles(outRoot, generated, report.warnings);
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
    for (const file of report.retired3mfs) console.log(`  retired previous export: ${file}`);
    if (report.tooBig.length) console.log(`  Too big for the bed (not on any plate): ${report.tooBig.join(', ')}`);
    for (const w of report.warnings) console.log(`  WARN ${w}`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
