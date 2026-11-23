#!/usr/bin/env node
// wiremap check: run the electrical checker on a project file.
// Exit code 0 = no errors (warnings allowed), 1 = errors, 2 = bad usage/file.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkProject } from '../lib/check.js';
import { loadLibrary, loadPrinters, readProject } from '../lib/node/library.js';

const HELP = `Usage: wiremap check <projects/name.json> [--json] [--strict]

Runs the electrical rules (shorts, voltages, logic levels, grounds, power
budget, wire gauge, protection, required pins) on a project file.
  --json     machine-readable result
  --strict   exit 1 on warnings too
"0 errors" means no rule violations were found, not that the design is safe.`;

/** Load the library plus a project-local library/ folder next to projects/. */
export function libraryFor(projectFile) {
  const local = join(dirname(resolve(projectFile)), '..', 'library');
  return existsSync(local) && resolve(local) !== resolve(new URL('../library', import.meta.url).pathname)
    ? loadLibrary(undefined, local) : loadLibrary();
}

/** Printer profiles for printed-fit checks (empty if the folder is missing). */
export function safePrinters() {
  try { return loadPrinters(); } catch { return {}; }
}

export function formatReport(res, name = '') {
  const icon = { error: 'ERROR', warning: 'WARN ', info: 'info ' };
  const lines = [];
  if (name) lines.push(`Wiremap check: ${name}`);
  for (const i of res.issues) {
    lines.push(`  ${icon[i.level]}  [${i.rule}] ${i.message}`);
    if (i.fix && i.level !== 'info') lines.push(`         fix: ${i.fix}`);
  }
  if (res.power.rails.length) {
    lines.push('', '  Power rails:');
    for (const r of res.power.rails) {
      const cap = r.capacity ? `${r.capacity} A` : '? A';
      lines.push(`    ${r.name.padEnd(28)} ${String(r.load).padStart(6)} A typ, ${String(r.loadPeak).padStart(6)} A peak / ${cap}  ${r.status.toUpperCase()}`);
    }
    for (const b of res.power.runtime) lines.push(`    ${b.battery}: about ${b.hours} h at ${b.avg} A average (${b.formula})`);
  }
  const M = res.mechanics;
  if (M && M.arm) {
    lines.push('', `  Arm joints (worst pose over the joint range, SF ${M.arm.sf}):`);
    for (const j of M.arm.joints) {
      if (j.type === 'gripper') continue;
      lines.push(`    ${String(j.id).padEnd(12)} needs ${String(j.load_kgcm).padStart(5)} kg·cm  has ${j.stall_kgcm ?? '?'} kg·cm  margin ${j.margin ?? '?'}×`);
    }
    lines.push(`    reach ${M.arm.reach_mm} mm, tip repeatability about ±${M.arm.tip_error_mm} mm, arm mass ${M.arm.total_mass_g} g`);
  }
  if (M && M.fits && M.fits.length) {
    lines.push('', '  Fits:');
    for (const f of M.fits) {
      if (f.kind === 'iso') lines.push(`    ${f.id}: Ø${f.nominal} ${f.fit} ${f.type}, clearance ${f.clearance.min} to ${f.clearance.max} mm`);
      else lines.push(`    ${f.id}: model ${f.feature} at ${f.recommended} mm (${f.fit}, ${f.clearance_per_side} mm per side${f.designed !== null ? `; modelled ${f.designed}` : ''})`);
    }
  }
  lines.push('', `  ${res.errors} error(s), ${res.warnings} warning(s), ${res.infos} note(s). ${res.summary}`);
  if (!res.errors) lines.push('  Not checked: ' + res.notChecked.map((x) => x.split(':')[0]).join('; ') + '.');
  return lines.join('\n');
}

export async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  if (argv.includes('--help') || argv.includes('-h') || !args.length) { console.log(HELP); return args.length ? 0 : 2; }
  let worst = 0;
  const all = [];
  for (const file of args) {
    let project;
    try { project = readProject(file); } catch (e) { console.error(e.message); return 2; }
    const res = checkProject(project, libraryFor(file), { printers: safePrinters() });
    if (argv.includes('--json')) {
      all.push({ file, ok: res.ok, errors: res.errors, warnings: res.warnings, infos: res.infos, summary: res.summary, issues: res.issues, power: res.power, mechanics: res.mechanics, wireInfo: res.wireInfo, notChecked: res.notChecked });
    } else {
      console.log(formatReport(res, file));
    }
    if (res.errors || (argv.includes('--strict') && res.warnings)) worst = 1;
  }
  if (argv.includes('--json')) console.log(JSON.stringify(all.length === 1 ? all[0] : all, null, 2));
  return worst;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
