#!/usr/bin/env node
// wiremap calc: command-line wrapper over lib/calc.js. Prints inputs, formula,
// steps and the result, or JSON with --json. Exit 0 = ok, 2 = bad input.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as calc from '../lib/calc.js';
import * as mech from '../lib/mech.js';
import { loadPrinters } from '../lib/node/library.js';

const HELP = `Usage: wiremap calc <calculator> [options] [--json]

  ohm        --v 5 --r 220            (any two of --v --i --r --p)
  led        --vs 5 --vf 2 --i 0.015 [--series E24]
  divider    --vin 5 --vmax 3.6 [--vout 3.3] [--series E24]   or  --vin 5 --r1 1000 --r2 2200
  budget     --cap 5 --load "MG996R:0.5:2.5:4" --load "ESP32:0.25:0.5"   (name:typical:peak:qty)
  regulator  --vin 7.4 --vout 3.3 --i 0.3 [--package SOT-223|TO-220|...] [--tamb 25]
  wire       --i 4 --len 0.5 --awg 18 [--vs 12] [--conductors 2]
  gauge      --i 4 [--insulation pvc|silicone|ptfe] [--bundled]
  ampacity   --awg 22 [--insulation pvc] [--bundled]
  runtime    --ah 2.2 --a 1.5 [--usable 0.8]
  fuse       --i 4 [--awg 18 --insulation pvc] [--part 5] [--v 12]
  fit        --nominal 3 --fit sliding [--printer bambu-a1 | --clearance 0.2] [--feature hole|shaft|slot]
  insert     --size M3 [--maker ruthex]
  screw      --stack 6 --size M3 --engagement insert|thread-plastic|nut [--depth 10] [--washer 0.5]
  eseries    --value 4300 [--series E12|E24]

Mechanical and robotics (lib/mech.js):
  iso-fit    --nominal 22 --fit H7/p6           ISO 286 limits, clearance or interference
  stackup    --dim "housing:20:0.1" --dim "-shaft:19.8:0.05" [--min-gap 0.05]   (name:nominal:tol, leading - subtracts)
  bolt       --size M3 --count 4 --load 400 [--mode shear|tension] [--class 8.8] [--plate 3 --material PLA]
  beam       --len 80 --width 18 --height 6 [--wall 2 | --od 10 --id 6] (--force 2 | --moment 900) [--material PLA] [--fill 0.6] [--layer xy|z] [--sf 2]
  gear       --module 1 --z1 12 --z2 36 [--torque 0.5 --face 6] [--material PLA]
  lead       --torque 0.4 --lead 8 [--eff 0.35]    lead-screw or belt linear force
  drone      --auw 650 --thrust 600 [--motors 4] [--current 18] [--frame 220 --prop 5] [--mah 1500 --c 75] [--esc 30]
  rover      --mass 1200 --wheel 65 [--driven 2 --wheels 4] [--slope 10] [--stall 0.08] [--rpm 200]
  kgcm       --value 1.8                          servo kg·cm to N·m

Every result is labelled "calculated" and shows its inputs and formula.`;

function parse(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const next = argv[i + 1];
      const val = inline !== undefined ? inline : (next !== undefined && !next.startsWith('--') ? (i++, next) : true);
      if (k in opt) opt[k] = [].concat(opt[k], val); else opt[k] = val;
    } else pos.push(a);
  }
  return { pos, opt };
}

const n = (v) => (v === undefined || v === true ? undefined : Number(v));

function run(name, o) {
  switch (name) {
    case 'ohm': return calc.ohm({ v: n(o.v), i: n(o.i), r: n(o.r), p: n(o.p) });
    case 'led': return calc.ledResistor({ vsupply: n(o.vs ?? o.vsupply), vf: n(o.vf), i: n(o.i), series: o.series || 'E12' });
    case 'divider': return calc.divider({ vin: n(o.vin), vout: n(o.vout), vmax: n(o.vmax), r1: n(o.r1), r2: n(o.r2), series: o.series || 'E12' });
    case 'budget': {
      const loads = [].concat(o.load || []).map((s) => {
        const [lname, typ, peak, qty] = String(s).split(':');
        return { name: lname, current: Number(typ), peak: peak ? Number(peak) : undefined, qty: qty ? Number(qty) : 1 };
      });
      return calc.powerBudget(loads, n(o.cap ?? o.capacity));
    }
    case 'regulator': return calc.regulatorHeat({ vin: n(o.vin), vout: n(o.vout), i: n(o.i), iq: n(o.iq) ?? 0, package: o.package, theta_ja: n(o['theta-ja']), theta_jc: n(o['theta-jc']), tamb: n(o.tamb) ?? 25 });
    case 'wire': return calc.wireDrop({ current: n(o.i), length_m: n(o.len ?? o.length), awg: n(o.awg), conductors: n(o.conductors) ?? 2, vsupply: n(o.vs ?? o.vsupply) });
    case 'gauge': return calc.minGauge(n(o.i), o.insulation || 'pvc', !!o.bundled);
    case 'ampacity': {
      const a = calc.ampacity(n(o.awg), o.insulation || 'pvc', { bundled: !!o.bundled });
      return { value: a, unit: 'A', inputs: { awg: n(o.awg), insulation: o.insulation || 'pvc', bundled: !!o.bundled }, formula: `table lookup: ${calc.AMPACITY_INFO.basis}`, steps: [], warnings: ['Conservative estimate table, not a standard: see lib/calc.js AMPACITY.'], label: 'calculated' };
    }
    case 'runtime': return calc.batteryRuntime({ capacity_ah: n(o.ah), avg_a: n(o.a), usable: n(o.usable) ?? 0.8 });
    case 'fuse': return calc.fuseSize({ current: n(o.i), wireAwg: n(o.awg), insulation: o.insulation || 'pvc', partRatingA: n(o.part), voltage: n(o.v) });
    case 'fit': {
      let profile;
      if (o.printer) {
        profile = loadPrinters()[o.printer];
        if (!profile) throw new Error(`unknown printer ${o.printer} (have: ${Object.keys(loadPrinters()).join(', ')})`);
      }
      return calc.printFit({ nominal: n(o.nominal), fit: o.fit || 'sliding', profile, clearance: n(o.clearance), feature: o.feature || 'hole' });
    }
    case 'insert': return calc.insertHole({ size: o.size, maker: o.maker || 'ruthex' });
    case 'screw': return calc.screwLength({ stack: n(o.stack), size: o.size, engagement: o.engagement || 'insert', depth: n(o.depth), washer: n(o.washer) ?? 0 });
    case 'eseries': {
      const v = n(o.value), s = o.series || 'E12';
      return { value: { nextUp: calc.nextUp(v, s), nearest: calc.nearest(v, s), nextDown: calc.nextDown(v, s) }, unit: 'ohm', inputs: { value: v, series: s }, formula: `${s} standard values`, steps: [], warnings: [], label: 'calculated' };
    }
    case 'iso-fit': {
      const r = mech.isoFit({ nominal: n(o.nominal), fit: o.fit });
      return { ...r, value: `${r.clearance.min} to ${r.clearance.max}`, display: r.type, inputs: { nominal: r.nominal, fit: r.fit } };
    }
    case 'stackup': {
      const dims = [].concat(o.dim || []).map((d) => {
        const neg = String(d).startsWith('-');
        const [nm, nom, tol] = String(d).replace(/^-/, '').split(':');
        return { name: nm, nominal: Number(nom), tol: Number(tol || 0), sign: neg ? -1 : 1 };
      });
      const r = mech.stackup({ dims, min_gap: n(o['min-gap']), max_gap: n(o['max-gap']) });
      return { ...r, display: `worst ${r.worst.min} to ${r.worst.max}, RSS ${r.rss.min} to ${r.rss.max}${r.ok ? '' : r.ok_rss ? '  (worst case fails)' : '  (FAILS)'}`, inputs: {} };
    }
    case 'bolt': return { ...mech.bolt({ size: o.size, class: o.class || '8.8', count: n(o.count) ?? 1, load_n: n(o.load), mode: o.mode || 'shear', plate_mm: n(o.plate), plate_material: o.material || 'PLA', sf: n(o.sf) ?? 2 }), inputs: { size: o.size, count: n(o.count) ?? 1, load_n: n(o.load) } };
    case 'beam': return { ...mech.beam({ length_mm: n(o.len), section: o.od ? { type: o.id ? 'tube' : 'round', od: n(o.od), id: n(o.id) } : o.wall ? { type: 'box', w: n(o.width), h: n(o.height), t: n(o.wall) } : { type: 'rect', w: n(o.width), h: n(o.height) }, tip_load_n: n(o.force), moment_nmm: n(o.moment), material: o.material || 'PLA', fill: n(o.fill) ?? 0.6, layer: o.layer || 'xy', sf: n(o.sf) ?? 2 }), inputs: { length_mm: n(o.len) } };
    case 'gear': {
      const r = mech.gear({ module: n(o.module), z1: n(o.z1), z2: n(o.z2), torque_nm: n(o.torque), face_mm: n(o.face), material: o.material || 'PLA', process: o.process || 'fdm' });
      return { ...r, display: `centre distance ${r.centre_distance_mm} mm`, warnings: [...r.warnings, ...r.problems.map((p) => `${p.level.toUpperCase()}: ${p.text}`)], inputs: { module: n(o.module), z1: n(o.z1), z2: n(o.z2) } };
    }
    case 'lead': return { ...mech.linearDrive({ torque_nm: n(o.torque), lead_mm: n(o.lead), efficiency: n(o.eff) ?? 0.35 }), inputs: { torque_nm: n(o.torque), lead_mm: n(o.lead) } };
    case 'drone': {
      const r = mech.drone({ auw_g: n(o.auw), thrust_g: n(o.thrust), motors: n(o.motors) ?? 4, current_a: n(o.current), frame_mm: n(o.frame), prop_in: n(o.prop), battery: o.mah ? { mah: n(o.mah), c: n(o.c) } : undefined, esc_a: n(o.esc) });
      return { ...r, value: r.twr, unit: ': 1 thrust-to-weight', display: r.flight_min ? `about ${r.flight_min} min hover` : undefined, formula: 'TWR = n × thrust / weight; hover current ∝ thrust^1.5', warnings: r.problems.map((p) => `${p.level.toUpperCase()}: ${p.text}`), inputs: {} };
    }
    case 'rover': {
      const r = mech.rover({ mass_g: n(o.mass), wheel_d_mm: n(o.wheel), driven_wheels: n(o.driven) ?? 2, wheels: n(o.wheels), slope_deg: n(o.slope), stall_nm: n(o.stall), no_load_rpm: n(o.rpm) });
      return { ...r, value: r.torque_per_wheel_nm, unit: 'N·m per driven wheel', display: `${r.torque_per_wheel_kgcm} kg·cm`, formula: 'τ = (m g (sin θ + Crr cos θ) + m a) × r / driven wheels', warnings: r.problems.map((p) => `${p.level.toUpperCase()}: ${p.text}`), inputs: {} };
    }
    case 'kgcm': return { value: Number(mech.kgcmToNm(n(o.value)).toFixed(4)), unit: 'N·m', inputs: { kgcm: n(o.value) }, formula: 'N·m = kgf·cm × 9.80665 / 100', steps: [], warnings: [], label: 'calculated' };
    default: throw Object.assign(new Error(`unknown calculator "${name}"`), { usage: true });
  }
}

function show(v) {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k} = ${x}`).join(', ');
  return String(v);
}

export function format(name, r) {
  const lines = [`${name}: ${show(r.value)} ${r.unit}${r.display ? `  (${r.display})` : ''}   [${r.label}]`];
  const inputs = Object.entries(r.inputs || {}).filter(([, v]) => v !== undefined && typeof v !== 'object');
  if (inputs.length) lines.push(`  inputs:  ${inputs.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  lines.push(`  formula: ${r.formula}`);
  for (const s of r.steps || []) lines.push(`    ${s}`);
  for (const g of r.guidance || []) lines.push(`  -> ${g}`);
  if (r.alternatives?.length) lines.push(`  alternatives: ${r.alternatives.map((a) => `${calc.fmtOhms(a.r1)}/${calc.fmtOhms(a.r2)} = ${a.vout} V`).join(', ')}`);
  for (const w of r.warnings || []) lines.push(`  WARN ${w}`);
  return lines.join('\n');
}

export async function main(argv = []) {
  const { pos, opt } = parse(argv);
  if (opt.help || opt.h || !pos.length) { console.log(HELP); return pos.length || opt.help ? 0 : 2; }
  const name = pos[0];
  try {
    const r = run(name, opt);
    if (opt.json) console.log(JSON.stringify({ calculator: name, ...r }, null, 2));
    else console.log(format(name, r));
    return 0;
  } catch (e) {
    if (opt.json) console.log(JSON.stringify({ calculator: name, error: e.message }));
    else console.error(`calc ${name}: ${e.message}${e.usage ? `\n\n${HELP}` : ''}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
