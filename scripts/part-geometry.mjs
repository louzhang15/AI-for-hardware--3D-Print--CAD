#!/usr/bin/env node
// wiremap part-geometry: board size, mounting holes, keep-outs and connectors from the
// part library, for CAD (mounts, standoffs, cut-outs).
// Exit 0 = ok, 1 = part(s) without geometry, 2 = bad usage / not found.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadLibrary, readProject } from '../lib/node/library.js';
import { insertHole, printFit } from '../lib/calc.js';

const HELP = `Usage: wiremap part-geometry <library-id> [--json]
       wiremap part-geometry --project projects/x.json [--part <id>] [--json]

Prints the board outline (L x W x T), mounting holes (footprint coordinates:
origin top-left, u right, v down, mm), keep-out zones with heights, and connector
positions, plus suggested hole sizes for printed mounts. Geometry marked
"confirm" was not measured from a real board: check it with calipers.`;

function libraryFor(projectFile) {
  if (projectFile) {
    const local = join(dirname(resolve(projectFile)), '..', 'library');
    if (existsSync(local)) {
      try { return loadLibrary(undefined, local); } catch { /* fall through */ }
    }
  }
  return loadLibrary();
}

/** Geometry summary for one part definition. */
export function partGeometry(def, id = def?.id) {
  const g = def?.geometry;
  const out = { id, name: def?.name, size: def?.size || null, geometry: g || null, confidence: g?.confidence || def?.confidence || 'confirm', suggestions: [] };
  if (!g) return out;
  const ds = [...new Set((g.holes || []).map((h) => h.d).filter((d) => d > 0))];
  for (const d of ds) {
    // Pick the metric screw that passes through the board hole.
    const screw = d >= 3.1 ? 'M3' : d >= 2.6 ? 'M2.5' : d >= 2.1 ? 'M2' : null;
    const s = { board_hole_d: d, screw };
    if (screw) {
      try {
        const ins = insertHole({ size: screw });
        s.insert = { hole_d: ins.hole_d, depth: ins.depth, boss_d: ins.boss_d, source: 'ruthex' };
      } catch { /* no data */ }
    }
    s.printed_peg_d = printFit({ nominal: d, fit: 'snug', feature: 'shaft' }).value;
    out.suggestions.push(s);
  }
  return out;
}

function fmt(r) {
  const L = [`${r.id}${r.name ? ` - ${r.name}` : ''}`];
  if (!r.geometry) {
    L.push(`  no geometry in the library${r.size ? `; bounding size ${r.size.join(' x ')} mm (x, height, z)` : ''}. Measure the board before designing a mount.`);
    return L.join('\n');
  }
  const g = r.geometry;
  if (g.board) L.push(`  board: ${g.board.join(' x ')} mm (L x W x T)   [${r.confidence}]`);
  if (r.size) L.push(`  bounding box with components: ${r.size.join(' x ')} mm (x, height, z)`);
  for (const h of g.holes || []) L.push(`  hole  at [${h.pos.join(', ')}]  d ${h.d} mm${h.note ? `  (${h.note})` : ''}`);
  for (const k of g.keepout || []) L.push(`  keep-out rect [${(k.rect || []).join(', ')}]${k.height !== undefined ? `, ${k.height} mm tall` : ''}${k.note ? `  (${k.note})` : ''}${k.side ? `, ${k.side} side` : ''}`);
  for (const c of g.connectors || []) L.push(`  connector ${c.name} at [${(c.pos || []).join(', ')}]${c.side ? `, ${c.side} edge` : ''}${c.size ? `, ${c.size.join(' x ')} mm` : ''}`);
  for (const s of r.suggestions) {
    L.push(`  mount for Ø${s.board_hole_d} holes: ${s.screw ? `${s.screw} screw${s.insert ? `, insert hole Ø${s.insert.hole_d} x ${s.insert.depth} mm, boss Ø${s.insert.boss_d} mm` : ''}` : 'too small for M2: use pegs'}; printed locating peg Ø${s.printed_peg_d} mm (snug, calculated)`);
  }
  if (r.confidence === 'confirm') L.push('  CONFIRM: geometry not verified against a real board; measure before printing.');
  return L.join('\n');
}

export async function main(argv = []) {
  let a;
  try { a = parseArgs({ args: argv, options: { project: { type: 'string' }, part: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true }); } catch (e) { console.error(e.message + '\n\n' + HELP); return 2; }
  const { values: o, positionals } = a;
  if (o.help || (!o.project && !positionals.length)) { console.log(HELP); return o.help ? 0 : 2; }
  let results = [];
  try {
    const lib = libraryFor(o.project);
    if (o.project) {
      const project = readProject(o.project);
      let parts = project.parts || [];
      if (o.part) parts = parts.filter((p) => p.id === o.part);
      if (o.part && !parts.length) throw new Error(`no part "${o.part}" in the project`);
      for (const p of parts) {
        const def = p.library ? lib[p.library] : p;
        if (!def) { results.push({ id: p.id, library: p.library, missing: true }); continue; }
        results.push({ ...partGeometry(def, p.id), library: p.library || null });
      }
    } else {
      for (const id of positionals) {
        const def = lib[id];
        if (!def) {
          const ids = Object.keys(lib);
          const close = ids.filter((x) => x.includes(id) || id.includes(x)).slice(0, 5);
          results.push({ id, missing: true, hint: ids.length ? (close.length ? `did you mean: ${close.join(', ')}` : `${ids.length} parts in the library`) : 'the library is empty (library/*.json not written yet?)' });
          continue;
        }
        results.push(partGeometry(def, id));
      }
    }
  } catch (e) {
    if (o.json) console.log(JSON.stringify({ error: e.message })); else console.error(`part-geometry: ${e.message}`);
    return 2;
  }
  if (o.json) console.log(JSON.stringify({ parts: results }, null, 2));
  else for (const r of results) console.log(r.missing ? `${r.id}: not found in the library${r.library ? ` (${r.library})` : ''}${r.hint ? ` - ${r.hint}` : ''}` : fmt(r));
  if (results.some((r) => r.missing)) return 2;
  return results.some((r) => !r.geometry) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
