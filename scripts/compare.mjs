#!/usr/bin/env node
// wiremap compare: swap every library candidate into a project part, re-run
// the mechanical and electrical checks and explain why one part is picked.
//   wiremap compare projects/robot-arm.json --part servo-shoulder
//   wiremap compare projects/robot-arm.json --joint elbow [--json]
// Exit 0 = compared, 2 = bad input.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareRole, compareActuators } from '../lib/select.js';
import { readProject } from '../lib/node/library.js';
import { libraryFor } from './check.mjs';

const HELP = `Usage: wiremap compare <project.json> (--part <id> | --joint <id>) [--json]

Compares every library part that could do the same job: arm-joint actuators
(torque margin at every joint after the swap, added mass, servo supply peak)
or power sources (voltage window per load, current headroom, regulator heat,
battery runtime). Verdicts: pick, works, rejected, each with the reason.`;

const MARK = { pick: 'PICK', works: 'ok  ', rejected: 'NO  ' };

export function format(r) {
  const lines = [];
  if (r.kind === 'actuator') {
    lines.push(`Joint "${r.joint}" (part ${r.part}), now ${r.current.name}, margin ${r.current.margin}x, safety factor ${r.sf}x`);
    for (const c of r.candidates) {
      lines.push(`  ${MARK[c.verdict]} ${c.name}${c.current ? ' (current)' : ''}: margin ${c.margin ?? '?'}x, ${c.mass_g} g${c.rail ? `, supply peak ${c.rail.peak}${c.rail.capacity ? ` of ${c.rail.capacity}` : ''} A` : ''}`);
      for (const why of c.reasons) lines.push(`         ${why}`);
      for (const need of c.requires) lines.push(`         needs ${need}`);
    }
  } else {
    lines.push(`Rail ${r.rail.name}: ${r.rail.typical} A typical, ${r.rail.peak} A peak, now ${r.current.name}`);
    for (const c of r.candidates) {
      lines.push(`  ${MARK[c.verdict]} ${c.name}${c.current ? ' (current)' : ''}: ${c.voltage} V${c.capacity ? `, ${c.capacity} A` : ''}${c.runtime_h ? `, about ${c.runtime_h} h` : ''}`);
      for (const why of c.reasons) lines.push(`         ${why}`);
      for (const need of c.requires) lines.push(`         needs ${need}`);
    }
  }
  return lines.join('\n');
}

export async function main(argv = []) {
  const file = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--part' && argv[argv.indexOf(a) - 1] !== '--joint');
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--help') || argv.includes('-h') || !file || (!opt('--part') && !opt('--joint'))) { console.log(HELP); return argv.includes('--help') || argv.includes('-h') ? 0 : 2; }
  let project;
  try { project = readProject(file); } catch (e) { console.error(e.message); return 2; }
  const library = libraryFor(file);
  let r;
  try { r = opt('--joint') ? compareActuators(project, library, { joint: opt('--joint') }) : compareRole(project, library, opt('--part')); }
  catch (e) { console.error(`wiremap compare: ${e.message}`); return 2; }
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : format(r));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
