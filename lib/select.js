// @ts-check
// Part trade-offs: swap each library candidate into the project, re-run the
// mechanical and electrical checks, and explain with numbers why one part is
// picked and another rejected. Deterministic: no AI, no prices.

import { checkMechanics } from './mech.js';
import { checkProject } from './check.js';
import { regulatorHeat } from './calc.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const fl2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.floor(x * 100) / 100 : x);
const r2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(2)) : x);
const fx = (x) => `${(Math.floor(x * 100) / 100).toFixed(2)}x`;
const cap = (t) => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);
/** Exact weakest other-joint margin for a candidate (rounded values hide 1.996 < 2). */
const after2 = (c) => (c.weakest ? c.weakestExact ?? c.weakest.after : Infinity);
const VERDICT_ORDER = { pick: 0, works: 1, rejected: 2 };

/** Swap a project part to another library part; drop overrides that belong to the old part. */
export function swapPart(project, partId, libraryId) {
  const p = clone(project);
  const part = (p.parts || []).find((x) => x.id === partId);
  if (!part) throw new Error(`No part "${partId}" in this project`);
  part.library = libraryId;
  delete part.mechanical;
  delete part.pins;
  delete part.name;
  return p;
}

function railFor(check, partId) {
  return (check.power?.rails || []).find((r) => r.loads.some((l) => l.part === partId)) || null;
}

function jointMargins(report) {
  const out = {};
  for (const j of report?.arm?.joints || []) if (j.type !== 'gripper' && typeof j.margin_exact === 'number') out[j.id] = j.margin_exact;
  return out;
}

/**
 * compareActuators(project, library, { joint }) for one arm joint.
 * Each candidate is swapped in and the whole arm re-analysed, so a heavier
 * actuator's effect on the joints nearer the base is counted. The servo supply
 * rail is re-checked for the electrical effect.
 * → { kind: 'actuator', joint, part, current, sf, baseline, candidates: [{ id, name, verdict, current,
 *     margin, others: [{ joint, before, after }], weakest, mass_g, added_mass_g, rail, requires, reasons }] }
 */
export function compareActuators(project, library, { joint, part } = {}) {
  const arm = project?.mechanics?.arm;
  if (!arm) throw new Error('This project has no mechanics.arm section: add the joints first (docs/FORMAT.md)');
  const j = (arm.joints || []).find((x) => (joint && x.id === joint) || (part && x.part === part));
  if (!j) throw new Error(`No arm joint ${joint ? `"${joint}"` : `uses part "${part}"`}`);
  if (!j.part) throw new Error(`Joint "${j.id}" has no actuator part`);
  const p0 = (project.parts || []).find((x) => x.id === j.part);
  if (!p0) throw new Error(`Joint "${j.id}" uses part "${j.part}", which is not in the project`);
  const sf = typeof arm.safety_factor === 'number' ? arm.safety_factor : (project.mechanics.safety_factor ?? 2);
  const base = checkMechanics(project, library);
  const baseM = jointMargins(base.report);
  const baseCheck = checkProject(project, library, { mechanics: false });
  const baseRail = railFor(baseCheck, j.part);
  const curLib = p0.library;
  const curMass = library[curLib]?.mechanical?.mass_g ?? 0;

  const cands = Object.entries(library).filter(([, d]) => d && d.category === 'actuator' && d.mechanical && (d.mechanical.torque || d.mechanical.holding_nm));
  const candidates = [];
  for (const [id, def] of cands) {
    const mech = def.mechanical;
    const reasons = [];
    const requires = [];
    let verdict = 'works';
    const pj = id === curLib ? project : swapPart(project, j.part, id);
    const M = checkMechanics(pj, library);
    const A = M.report.arm;
    const row = A?.joints.find((x) => x.id === j.id);
    const margin = row && typeof row.margin_exact === 'number' ? row.margin_exact : null;
    const after = jointMargins(M.report);
    const others = Object.keys(after).filter((k) => k !== j.id).map((k) => ({ joint: k, before: fl2(baseM[k]), after: fl2(after[k]) }));
    const weakest = others.reduce((w, o) => (w === null || o.after < w.after ? o : w), null);
    const weakestExact = weakest ? after[weakest.joint] : null;
    const mass = mech.mass_g ?? 0;
    const added = mass - curMass;

    if (mech.kind === 'continuous') { verdict = 'rejected'; reasons.push('Rejected: continuous rotation, it cannot hold an angle, so the joint drops or drifts.'); }
    else if (mech.kind === 'gearmotor') { verdict = 'rejected'; reasons.push('Rejected: a plain gear motor has no position feedback. It needs an encoder and a closed loop to hold a joint angle.'); }
    if (margin !== null) {
      if (margin < 1) { verdict = 'rejected'; reasons.push(`Rejected: ${cap(j.id)} needs ${row.load_kgcm} kg·cm and ${def.name} gives ${row.stall_kgcm} kg·cm at stall (${fx(margin)}). It cannot lift the arm.`); }
      else if (margin < sf && verdict !== 'rejected') reasons.push(`${cap(j.id)} margin ${fx(margin)}, below the ${sf}x safety factor: it runs hot and jitters near the worst pose.`);
      else if (verdict !== 'rejected') reasons.push(`${cap(j.id)} margin ${fx(margin)} (${row.load_kgcm} of ${row.stall_kgcm} kg·cm at the worst pose).`);
    } else if (verdict !== 'rejected') reasons.push('No torque data at this supply voltage: cannot be checked.');
    for (const o of others) {
      if (Math.abs(added) < 0.5 || o.before === undefined || o.after === undefined || Math.abs(o.after - o.before) < 0.01) continue;
      const text = `${added > 0 ? 'Adds' : 'Saves'} ${Math.abs(r2(added))} g at the ${j.id}: ${o.joint} margin ${added > 0 ? 'drops' : 'rises'} from ${fx(o.before)} to ${fx(o.after)}.`;
      if (o.after < 1) { verdict = 'rejected'; reasons.push(`Rejected: ${text} The ${o.joint} stalls.`); }
      else if (o.after < sf && o.before >= sf) { if (verdict === 'pick') verdict = 'works'; reasons.push(`${text} That is below the ${sf}x safety factor.`); }
      else reasons.push(text);
    }
    if (mech.kind === 'stepper') { requires.push('a stepper driver (A4988/DRV8825), a 12 V supply and homing switches'); reasons.push('A stepper holds position only while powered and needs homing after power-up.'); }

    // electrical effect on the rail that feeds this joint
    let rail = null;
    if (mech.kind !== 'stepper' && mech.kind !== 'gearmotor') {
      const ck = id === curLib ? baseCheck : checkProject(pj, library, { mechanics: false });
      const rr = railFor(ck, j.part);
      if (rr) {
        rail = { name: rr.name, voltage: rr.voltage, peak: r2(rr.loadPeak), typical: r2(rr.load), capacity: rr.capacity ?? null, before_peak: baseRail ? r2(baseRail.loadPeak) : null };
        const stall = def.pins?.find((x) => x.kind === 'power_in')?.current_peak;
        if (rr.capacity && rr.loadPeak > rr.capacity + 1e-9) {
          requires.push(`a supply of at least ${r2(rr.loadPeak * 1.25)} A (now ${rr.capacity} A)`);
          reasons.push(`Needs ${stall ?? '?'} A stall per servo; the ${rr.capacity} A supply then peaks at ${r2(rr.loadPeak)} A when the servos stall together.`);
        } else if (rr.capacity && rr.loadPeak > 0.8 * rr.capacity) reasons.push(`Supply peaks at ${r2(rr.loadPeak)} of ${rr.capacity} A: above 80 %, the voltage sags when servos stall.`);
        const vErr = ck.issues.find((i) => i.level === 'error' && i.parts.includes(j.part) && /voltage/.test(i.rule));
        if (vErr) { verdict = 'rejected'; reasons.push(`Rejected: ${vErr.message}`); }
      }
    }
    candidates.push({
      id, name: def.name, verdict, current: id === curLib, kind: mech.kind,
      margin: margin !== null ? fl2(margin) : null, margin_exact: margin, others, weakest, weakestExact,
      mass_g: mass, added_mass_g: r2(added), rail, requires, reasons, confidence: mech.confidence || def.confidence || null,
    });
  }
  // pick: the lightest candidate that meets the safety factor everywhere; ties go to the current part
  const ok = candidates.filter((c) => c.verdict !== 'rejected' && c.margin_exact !== null && c.margin_exact >= sf && (!c.weakest || after2(c) >= sf) && !c.requires.some((r) => /stepper/.test(r)));
  ok.sort((a, b) => a.mass_g - b.mass_g || Number(b.current) - Number(a.current));
  if (ok[0]) {
    ok[0].verdict = 'pick';
    ok[0].reasons.unshift(ok[0].current ? 'Pick: the current part already meets the safety factor at every joint.' : `Pick: lightest part that meets the ${sf}x safety factor at every joint.`);
  }
  candidates.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.margin ?? -1) - (a.margin ?? -1));
  return {
    kind: 'actuator', joint: j.id, part: j.part, sf,
    current: { id: curLib, name: library[curLib]?.name || curLib, margin: fl2(baseM[j.id]) },
    baseline: Object.fromEntries(Object.entries(baseM).map(([k, v]) => [k, fl2(v)])),
    candidates,
  };
}

const SOURCE_KINDS = ['power', 'battery'];

/**
 * compareSupplies(project, library, { part | rail }) for the rail a power part feeds.
 * → { kind: 'supply', rail: { name, voltage, typical, peak, capacity, loads }, current, candidates:
 *     [{ id, name, verdict, current, voltage, capacity, margin, heat_w, runtime_h, requires, reasons }] }
 */
export function compareSupplies(project, library, { part, rail: railName } = {}) {
  const ck = checkProject(project, library, { mechanics: false });
  const rail = (ck.power?.rails || []).find((r) => (part && r.sourcePart === part) || (railName && (r.net === railName || r.name === railName)));
  if (!rail) throw new Error(part ? `"${part}" does not feed a power rail in this project` : `No rail "${railName}"`);
  const srcPart = ck.model.parts.get(rail.sourcePart);
  const curLib = srcPart?.libraryId || null;
  const loads = rail.loads.map((l) => {
    const pin = ck.model.parts.get(l.part)?.pinMap.get(l.key.split('.').slice(1).join('.'));
    return { key: l.key, part: l.part, vmin: pin?.vmin, vmax: pin?.vmax, typ: l.current, peak: l.peak };
  });
  const parentRail = rail.parent ? ck.power.rails.find((r) => r.net === rail.parent) : null;
  const upstreamV = parentRail?.voltage ?? null;
  const V = rail.voltage;
  const typ = rail.load, peak = rail.loadPeak;

  const candidates = [];
  for (const [id, def] of Object.entries(library)) {
    if (!def || !SOURCE_KINDS.includes(def.category)) continue;
    const isCur = id === curLib;
    const libOut = def.pins?.find((x) => x.kind === 'power_out');
    if (!libOut) continue;
    // the current part keeps its project overrides (rated current, measured voltage window)
    const out = isCur ? (srcPart?.pinMap.get(rail.source.split('.').slice(1).join('.')) || libOut) : libOut;
    const reg = (def.regulators || [])[0] || null;
    const reasons = [];
    const requires = [];
    let verdict = 'works';
    let vNom = typeof out.voltage === 'number' ? out.voltage : null;
    let vLo = out.voltage_min ?? vNom, vHi = out.voltage_max ?? vNom;
    if (reg && (typeof reg.vout !== 'number')) { vNom = V; vLo = V; vHi = V; } // adjustable: set to the rail voltage
    else if (reg && typeof reg.vout === 'number') { vNom = reg.vout; vLo = vNom; vHi = vNom; }
    const capA = isCur && rail.capacity ? rail.capacity : (reg?.current_max ?? out.current_max ?? null);
    if (vNom === null) continue;
    // voltage fit for every load
    const groups = new Map();
    const note = (k, text, rejected, key) => { if (!groups.has(k)) groups.set(k, { text, rejected, keys: [] }); groups.get(k).keys.push(key); };
    for (const l of loads) {
      if (typeof l.vmax === 'number' && vHi > l.vmax + 1e-9) note(`hi${l.vmax}`, `${vHi} V${vHi !== vNom ? ' (full)' : ''} is over the ${l.vmax} V limit of`, true, l.key);
      else if (typeof l.vmin === 'number' && vLo < l.vmin - 1e-9) {
        if (vNom < l.vmin - 1e-9) note(`lo${l.vmin}`, `${vNom} V is under the ${l.vmin} V minimum of`, true, l.key);
        else note(`sag${l.vmin}`, `Sags to ${vLo} V, under the ${l.vmin} V minimum of`, false, l.key);
      }
    }
    for (const g of groups.values()) {
      const who = g.keys.length > 2 ? `${g.keys.length} loads (${g.keys.slice(0, 2).join(', ')}, ...)` : g.keys.join(' and ');
      if (g.rejected) { verdict = 'rejected'; reasons.push(`Rejected: ${g.text} ${who}.`); }
      else reasons.push(`${g.text} ${who}: brownouts near empty or at peak load.`);
    }
    const margin = capA ? capA / Math.max(peak, 1e-9) : null;
    if (capA !== null && verdict !== 'rejected') {
      if (typ > capA + 1e-9) { verdict = 'rejected'; reasons.push(`Rejected: rated ${capA} A but the rail draws ${r2(typ)} A typical.`); }
      else if (peak > capA + 1e-9) reasons.push(`Rated ${capA} A, below the ${r2(peak)} A peak when every load stalls: voltage dips and boards reset.`);
      else reasons.push(`Rated ${capA} A for a ${r2(peak)} A peak (${fx(margin)} headroom).`);
    }
    let heat = null, runtime = null;
    if (reg) {
      if (reg.type === 'linear') {
        const vin = upstreamV ?? 5;
        if (vin <= vNom + (reg.dropout ?? 0)) { verdict = 'rejected'; reasons.push(`Rejected: a ${vin} V input is below ${vNom} V + ${reg.dropout} V dropout.`); }
        else {
          const h = regulatorHeat({ vin, vout: vNom, i: Math.max(typ, 1e-6), iq: reg.iq || 0, package: 'SOT-223' });
          heat = r2(h.value);
          reasons.push(`Linear: drops ${r2(vin - vNom)} V at ${r2(typ)} A = ${heat} W${h.needsHeatsink ? ': too hot in SOT-223 without extra copper or a heatsink' : ' as heat'}.`);
          if (h.needsHeatsink && verdict !== 'rejected') verdict = 'works';
        }
      } else {
        requires.push(`an input supply of at least ${r2(vNom + (reg.dropout ?? 1))} V`);
        reasons.push(`Buck converter, about ${Math.round((reg.efficiency ?? 0.85) * 100)} % efficient; set its output to ${vNom} V before connecting loads.`);
      }
    }
    if (def.battery) {
      const ah = def.battery.capacity_ah;
      runtime = typ > 0 ? r2((ah * 0.8) / typ) : null;
      if (runtime !== null) reasons.push(`About ${runtime} h at ${r2(typ)} A (80 % of ${ah} Ah).`);
      if (!def.battery.bms) requires.push('an inline fuse, a switch and a low-voltage cutoff (no BMS)');
      const cMax = def.battery.bms_current_a ?? (def.battery.c_rating ? def.battery.c_rating * ah : null);
      if (cMax && peak > cMax + 1e-9) { verdict = 'rejected'; reasons.push(`Rejected: the pack or its BMS allows ${r2(cMax)} A, the rail peaks at ${r2(peak)} A.`); }
    }
    candidates.push({ id, name: def.name, verdict, current: isCur, voltage: vNom, capacity: capA, margin: margin !== null ? fl2(margin) : null, heat_w: heat, runtime_h: runtime, requires, reasons });
  }
  // pick: meets peak with 25 % headroom, no regulator heat problem, fewest extra parts; prefer the current part
  const ok = candidates.filter((c) => c.verdict !== 'rejected' && c.margin !== null && c.margin >= 1.25 && !(c.heat_w > 1) && !c.reasons.some((r) => /^Sags/.test(r)));
  ok.sort((a, b) => a.requires.length - b.requires.length || Number(b.current) - Number(a.current) || a.margin - b.margin);
  if (ok[0]) { ok[0].verdict = 'pick'; ok[0].reasons.unshift(ok[0].current ? 'Pick: the current supply covers the peak with 25 % headroom.' : 'Pick: covers the peak with 25 % headroom and needs the fewest extra parts.'); }
  candidates.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || (b.margin ?? -1) - (a.margin ?? -1));
  return {
    kind: 'supply',
    rail: { name: rail.name, voltage: V, typical: r2(typ), peak: r2(peak), capacity: rail.capacity ?? null, loads: loads.map((l) => l.key) },
    current: { id: curLib, name: srcPart?.name || curLib, part: rail.sourcePart },
    candidates,
  };
}

/** Compare alternatives for a project part, by what it does. */
export function compareRole(project, library, partId) {
  const p = (project.parts || []).find((x) => x.id === partId);
  if (!p) throw new Error(`No part "${partId}" in this project`);
  const def = p.library ? library[p.library] : p;
  const cat = p.category || def?.category;
  if (cat === 'actuator') {
    const joint = (project.mechanics?.arm?.joints || []).find((j) => j.part === partId);
    if (!joint) throw new Error(`${partId} is not an arm joint: actuator comparison needs mechanics.arm.joints with "part": "${partId}"`);
    return compareActuators(project, library, { joint: joint.id });
  }
  if (cat === 'power' || cat === 'battery') return compareSupplies(project, library, { part: partId });
  throw new Error(`No comparison for ${partId} (category ${cat || 'unknown'}): supported are arm-joint actuators and power or battery parts`);
}
