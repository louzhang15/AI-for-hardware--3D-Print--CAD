// Wiremap deterministic calculators.
//
// Pure functions, no Node built-ins (runs in the browser too).
// Every calculator returns
//   { value, unit, inputs, formula, steps?: [], warnings: [], label: 'calculated', ...extra }
// and throws an Error on invalid input. Small lookup helpers (e12/e24 helpers,
// ampacity) return plain numbers so other modules can use them directly.

const CALC = 'calculated';

// ---------------------------------------------------------------------------
// Input checks and formatting

function num(name, v, { min = -Infinity, max = Infinity, gt, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw new Error(`${name} is required`);
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${name} must be a number (got ${typeof v === 'number' ? v : JSON.stringify(v)})`);
  if (gt !== undefined && !(n > gt)) throw new Error(`${name} must be greater than ${gt} (got ${n})`);
  if (n < min) throw new Error(`${name} must be at least ${min} (got ${n})`);
  if (n > max) throw new Error(`${name} must be at most ${max} (got ${n})`);
  return n;
}

/** Round to a sensible number of significant digits for display (default 4). */
export function sig(x, digits = 4) {
  if (!Number.isFinite(x) || x === 0) return x;
  return Number(x.toPrecision(digits));
}

/** Format a resistance: 2200 -> "2.2k", 1000000 -> "1M", 47 -> "47". */
export function fmtOhms(r) {
  if (r >= 1e6) return `${sig(r / 1e6, 3)}M`;
  if (r >= 1e3) return `${sig(r / 1e3, 3)}k`;
  return `${sig(r, 3)}`;
}

function result(value, unit, inputs, formula, extra = {}) {
  return { value, unit, inputs, formula, steps: [], warnings: [], label: CALC, ...extra };
}

// ---------------------------------------------------------------------------
// E-series resistor values

export const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
export const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0,
  3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];

function seriesBase(series) {
  const s = String(series || 'E12').toUpperCase();
  if (s === 'E12') return E12;
  if (s === 'E24') return E24;
  throw new Error(`unknown E-series ${series} (use E12 or E24)`);
}

/** All values of a series between min and max ohms (inclusive). */
export function eValues(series = 'E12', min = 1, max = 10e6) {
  const base = seriesBase(series);
  const out = [];
  for (let dec = -1; dec <= 7; dec++) {
    for (const b of base) {
      const v = Number((b * 10 ** dec).toPrecision(3));
      if (v >= min - 1e-9 && v <= max + 1e-9) out.push(v);
    }
  }
  return out;
}

/** Smallest standard value >= value. */
export function nextUp(value, series = 'E12') {
  const v = num('value', value, { gt: 0 });
  return eValues(series, v * 0.5, v * 20).find((x) => x >= v * (1 - 1e-9));
}

/** Largest standard value <= value. */
export function nextDown(value, series = 'E12') {
  const v = num('value', value, { gt: 0 });
  const vals = eValues(series, v / 20, v * 2);
  let best;
  for (const x of vals) if (x <= v * (1 + 1e-9)) best = x;
  return best;
}

/** Standard value closest to value (by ratio, which is how the series is spaced). */
export function nearest(value, series = 'E12') {
  const v = num('value', value, { gt: 0 });
  let best, bestErr = Infinity;
  for (const x of eValues(series, v / 2, v * 2)) {
    const err = Math.abs(Math.log(x / v));
    if (err < bestErr) { bestErr = err; best = x; }
  }
  return best;
}

export const e12 = { values: E12, nextUp: (v) => nextUp(v, 'E12'), nextDown: (v) => nextDown(v, 'E12'), nearest: (v) => nearest(v, 'E12') };
export const e24 = { values: E24, nextUp: (v) => nextUp(v, 'E24'), nextDown: (v) => nextDown(v, 'E24'), nearest: (v) => nearest(v, 'E24') };

/** Values found in common hobby resistor kits (ohm), preferred by the divider search. */
export const COMMON_RESISTORS = new Set([100, 220, 330, 470, 1000, 1500, 2200, 3300, 4700, 6800, 10000, 22000, 47000, 100000]);

/** Standard resistor power ratings (W). */
export const RESISTOR_WATTS = [0.125, 0.25, 0.5, 1, 2, 3, 5, 10];

function suggestWatts(p, factor = 2) {
  const need = p * factor;
  return RESISTOR_WATTS.find((w) => w >= need) ?? null;
}

// ---------------------------------------------------------------------------
// Ohm's law

/**
 * ohm({ v, i, r, p }) — give any two, get all four.
 * value = the object { v, i, r, p }; unit 'V/A/ohm/W'.
 */
export function ohm(args = {}) {
  const v = num('v', args.v, { optional: true });
  const i = num('i', args.i, { optional: true });
  const r = num('r', args.r, { optional: true, gt: 0 });
  const p = num('p', args.p, { optional: true, min: 0 });
  const given = [v, i, r, p].filter((x) => x !== undefined).length;
  if (given !== 2) throw new Error('ohm: give exactly two of v, i, r, p');
  let V = v, I = i, R = r, P = p, formula;
  if (V !== undefined && I !== undefined) { R = V / I; P = V * I; formula = 'R = V / I, P = V × I'; }
  else if (V !== undefined && R !== undefined) { I = V / R; P = V * V / R; formula = 'I = V / R, P = V² / R'; }
  else if (V !== undefined && P !== undefined) { I = P / V; R = V * V / P; formula = 'I = P / V, R = V² / P'; }
  else if (I !== undefined && R !== undefined) { V = I * R; P = I * I * R; formula = 'V = I × R, P = I² × R'; }
  else if (I !== undefined && P !== undefined) { V = P / I; R = P / (I * I); formula = 'V = P / I, R = P / I²'; }
  else { I = Math.sqrt(P / R); V = Math.sqrt(P * R); formula = 'I = √(P / R), V = √(P × R)'; }
  for (const [k, x] of Object.entries({ V, I, R, P })) {
    if (!Number.isFinite(x)) throw new Error(`ohm: ${k} is not finite with these inputs (division by zero?)`);
  }
  const out = result({ v: sig(V, 6), i: sig(I, 6), r: sig(R, 6), p: sig(P, 6) }, 'V/A/ohm/W', { ...args }, formula);
  out.steps.push(`V = ${sig(V)} V, I = ${sig(I)} A, R = ${sig(R)} Ω, P = ${sig(P)} W`);
  return out;
}

// ---------------------------------------------------------------------------
// LED resistor

/**
 * ledResistor({ vsupply, vf, i, series='E12' }) — series resistor for an LED.
 * Rounds UP to the next standard value so the current stays at or below target.
 * value = resistor (ohm); extra: exact, current, power, watts (suggested rating).
 */
export function ledResistor({ vsupply, vf, i, series = 'E12' } = {}) {
  const vs = num('vsupply', vsupply, { gt: 0 });
  const f = num('vf', vf, { min: 0 });
  const I = num('i', i, { gt: 0, max: 5 });
  if (f >= vs) throw new Error(`ledResistor: supply ${vs} V must be above the LED forward voltage ${f} V`);
  const exact = (vs - f) / I;
  const R = nextUp(exact, series);
  const Ia = (vs - f) / R;
  const P = Ia * Ia * R;
  const W = suggestWatts(P);
  const out = result(R, 'ohm', { vsupply: vs, vf: f, i: I, series }, 'R = (Vsupply − Vf) / I, rounded up to the next ' + series + ' value; P = I² × R', {
    exact: sig(exact, 5), current: sig(Ia, 4), power: sig(P, 4), watts: W, display: fmtOhms(R) + 'Ω',
  });
  out.steps.push(`R = (${vs} − ${f}) / ${I} = ${sig(exact)} Ω → next ${series} up: ${fmtOhms(R)}Ω`);
  out.steps.push(`I = (${vs} − ${f}) / ${R} = ${sig(Ia * 1000)} mA`);
  out.steps.push(`P = I² × R = ${sig(P * 1000)} mW → use a ${W} W resistor (2× margin)`);
  if (W === null) out.warnings.push('Power above 5 W: use a constant-current LED driver instead of a resistor.');
  if (I > 0.03) out.warnings.push('More than 30 mA: check the LED datasheet; a GPIO pin cannot source this, use a transistor.');
  return out;
}

// ---------------------------------------------------------------------------
// Voltage divider

/**
 * divider({ vin, r1, r2 })               -> evaluate a given pair (value = Vout)
 * divider({ vin, vout?, vmax?, series, rmin, rmax }) -> search the best standard pair.
 *   R1 is the top resistor (Vin to Vout), R2 the bottom one (Vout to GND).
 *   Target = vout if given, else 92% of vmax. Vout never exceeds vmax.
 * value = Vout (V); extra: r1, r2, current (A), ratio, alternatives[].
 * Example: 5 V, 1k + 2.2k -> 3.44 V.
 */
export function divider({ vin, vout, vmax, r1, r2, series = 'E12', rmin = 1000, rmax = 100000 } = {}) {
  const Vin = num('vin', vin, { gt: 0 });
  if (r1 !== undefined || r2 !== undefined) {
    const R1 = num('r1', r1, { gt: 0 });
    const R2 = num('r2', r2, { gt: 0 });
    const Vo = Vin * R2 / (R1 + R2);
    const I = Vin / (R1 + R2);
    const out = result(sig(Vo, 4), 'V', { vin: Vin, r1: R1, r2: R2 }, 'Vout = Vin × R2 / (R1 + R2)', {
      r1: R1, r2: R2, current: sig(I, 4), ratio: sig(R2 / (R1 + R2), 5),
    });
    out.steps.push(`Vout = ${Vin} × ${fmtOhms(R2)} / (${fmtOhms(R1)} + ${fmtOhms(R2)}) = ${sig(Vo)} V`);
    out.steps.push(`I = ${Vin} / ${R1 + R2} = ${sig(I * 1000)} mA`);
    const Vmax = num('vmax', vmax, { optional: true, gt: 0 });
    if (Vmax !== undefined && Vo > Vmax) out.warnings.push(`Vout ${sig(Vo)} V is above the allowed ${Vmax} V.`);
    return out;
  }
  const Vmax = num('vmax', vmax, { optional: true, gt: 0 });
  let target = num('vout', vout, { optional: true, gt: 0 });
  if (target === undefined) {
    if (Vmax === undefined) throw new Error('divider: give vout (target) or vmax (allowed maximum), or r1 and r2');
    target = sig(Vmax * 0.92, 4);
  }
  if (target >= Vin) throw new Error(`divider: target ${target} V must be below vin ${Vin} V`);
  const limit = Vmax ?? Infinity;
  const vals = eValues(series, num('rmin', rmin, { gt: 0 }), num('rmax', rmax, { gt: 0 }));
  const cands = [];
  for (const R1 of vals) {
    for (const R2 of vals) {
      const Vo = Vin * R2 / (R1 + R2);
      if (Vo > limit + 1e-12) continue;
      const tot = R1 + R2;
      if (Vin / tot > 0.0025 || tot > 200000) continue; // at most 2.5 mA, at most 200k (edges stay fast)
      cands.push({ R1, R2, Vo, err: Math.abs(Vo - target), tot });
    }
  }
  if (!cands.length) throw new Error('divider: no standard pair meets the limits');
  // Ranking: pairs within ±5% of the target made of common kit values come first
  // (people have them on hand), lowest total resistance first (stiffer, faster edges);
  // then every other pair by error.
  const win = 0.05 * target;
  const rank = (c) => (c.err <= win && COMMON_RESISTORS.has(c.R1) && COMMON_RESISTORS.has(c.R2) ? 0 : 1);
  cands.sort((a, b) => (rank(a) - rank(b)) || (rank(a) === 0 ? (a.tot - b.tot) : 0) || (a.err - b.err) || (a.tot - b.tot) || (a.R1 - b.R1));
  // Remove pairs that are just a decade multiple of a better one.
  const seen = new Set();
  const uniq = [];
  for (const c of cands) {
    const k = sig(c.R2 / (c.R1 + c.R2), 6);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(c);
  }
  const best = uniq[0];
  const I = Vin / best.tot;
  const out = result(sig(best.Vo, 4), 'V', { vin: Vin, vout: target, vmax: Vmax, series, rmin, rmax },
    `Vout = Vin × R2 / (R1 + R2); ${series} pairs with Vout ≤ ${Vmax ?? '∞'} V and ≤ 2.5 mA; common kit values within ±5% of ${sig(target)} V preferred (lowest total resistance), else closest to target`, {
      r1: best.R1, r2: best.R2, current: sig(I, 4), ratio: sig(best.R2 / best.tot, 5),
      display: `R1 = ${fmtOhms(best.R1)}Ω (top), R2 = ${fmtOhms(best.R2)}Ω (bottom)`,
      alternatives: uniq.slice(1, 6).map((c) => ({ r1: c.R1, r2: c.R2, vout: sig(c.Vo, 4) })),
    });
  out.steps.push(`Target ${sig(target)} V${Vmax !== undefined ? ` (92% of the ${Vmax} V maximum unless vout given)` : ''}`);
  out.steps.push(`Vout = ${Vin} × ${fmtOhms(best.R2)} / (${fmtOhms(best.R1)} + ${fmtOhms(best.R2)}) = ${sig(best.Vo)} V`);
  out.steps.push(`Divider current = ${Vin} / ${best.tot} Ω = ${sig(I * 1000)} mA`);
  if (best.err / target > 0.05) out.warnings.push(`Best pair is ${sig(100 * best.err / target, 2)}% off target; try E24 values.`);
  out.warnings.push('A divider is for slow, one-way signals (e.g. 5 V TX into a 3.3 V RX). Use a level shifter for I2C or fast/bidirectional lines.');
  return out;
}

// ---------------------------------------------------------------------------
// Power budget

/**
 * powerBudget(loads, capacity, { threshold=0.8 })
 *   loads: [{ name, current (typical A), peak? (A), qty?=1 }]
 *   capacity: what the supply can deliver (A)
 * value = typical total (A); extra: peak, utilization, peakUtilization, ok, flags[].
 */
export function powerBudget(loads, capacity, { threshold = 0.8 } = {}) {
  if (!Array.isArray(loads) || !loads.length) throw new Error('powerBudget: loads must be a non-empty array');
  const cap = num('capacity', capacity, { gt: 0 });
  let typ = 0, peak = 0;
  const rows = loads.map((l, idx) => {
    const name = l.name || `load ${idx + 1}`;
    const qty = num(`${name}.qty`, l.qty ?? 1, { min: 0 });
    const c = num(`${name}.current`, l.current ?? l.typical ?? 0, { min: 0 });
    const p = num(`${name}.peak`, l.peak ?? l.current_peak ?? c, { min: 0 });
    typ += c * qty; peak += p * qty;
    return { name, qty, current: c, peak: p, total: sig(c * qty, 4), peak_total: sig(p * qty, 4) };
  });
  const out = result(sig(typ, 4), 'A', { loads, capacity: cap, threshold }, `Sum of loads (current × qty); flag above ${threshold * 100}% of the ${cap} A rating`, {
    peak: sig(peak, 4), capacity: cap, utilization: sig(typ / cap, 3), peakUtilization: sig(peak / cap, 3), rows, flags: [],
  });
  out.steps.push(`Typical: ${rows.map((r) => `${r.qty}×${r.current}`).join(' + ')} = ${sig(typ)} A (${sig(100 * typ / cap, 3)}% of ${cap} A)`);
  out.steps.push(`Peak: ${rows.map((r) => `${r.qty}×${r.peak}`).join(' + ')} = ${sig(peak)} A (${sig(100 * peak / cap, 3)}% of ${cap} A)`);
  if (typ > cap) out.flags.push({ level: 'error', message: `Typical draw ${sig(typ)} A exceeds the ${cap} A supply.` });
  else if (typ > threshold * cap) out.flags.push({ level: 'warning', message: `Typical draw ${sig(typ)} A is above ${threshold * 100}% of the ${cap} A supply.` });
  if (peak > cap) out.flags.push({ level: 'warning', message: `Peak draw ${sig(peak)} A exceeds the ${cap} A supply: expect brown-outs/resets when everything peaks (e.g. servos stalling).` });
  else if (peak > threshold * cap) out.flags.push({ level: 'info', message: `Peak draw ${sig(peak)} A is above ${threshold * 100}% of the supply.` });
  out.ok = !out.flags.some((f) => f.level !== 'info');
  out.warnings.push(...out.flags.filter((f) => f.level !== 'info').map((f) => f.message));
  return out;
}

// ---------------------------------------------------------------------------
// Linear regulator heat

/** Typical junction-to-ambient / junction-to-case thermal resistance (°C/W), no heatsink, modest copper.
 *  Generic datasheet-typical values; your part's datasheet overrides them. */
export const PACKAGES = {
  'SOT-23': { theta_ja: 250, theta_jc: 80 },
  'SOT-89': { theta_ja: 110, theta_jc: 30 },
  'SOT-223': { theta_ja: 60, theta_jc: 15 },
  'TO-92': { theta_ja: 200, theta_jc: 80 },
  'TO-252': { theta_ja: 50, theta_jc: 5 },
  DPAK: { theta_ja: 50, theta_jc: 5 },
  'TO-220': { theta_ja: 50, theta_jc: 3 },
};

/**
 * regulatorHeat({ vin, vout, i, iq=0, package?, theta_ja?, theta_jc?, theta_cs=0.5, tamb=25, tjmax=125 })
 * value = dissipated power (W); extra: tj (°C, no heatsink), needsHeatsink, theta_sa_required, efficiency, guidance.
 */
export function regulatorHeat({ vin, vout, i, iq = 0, package: pkg, theta_ja, theta_jc, theta_cs = 0.5, tamb = 25, tjmax = 125 } = {}) {
  const Vin = num('vin', vin, { gt: 0 });
  const Vout = num('vout', vout, { gt: 0 });
  const I = num('i', i, { min: 0 });
  const Iq = num('iq', iq, { min: 0 });
  if (Vout >= Vin) throw new Error(`regulatorHeat: vout ${Vout} V must be below vin ${Vin} V for a linear regulator`);
  const Ta = num('tamb', tamb), Tj = num('tjmax', tjmax);
  const P = (Vin - Vout) * I + Vin * Iq;
  const eff = (Vout * I) / (Vin * (I + Iq) || 1);
  const pk = pkg ? PACKAGES[String(pkg).toUpperCase().replace(/^SOT223$/, 'SOT-223').replace(/^TO220$/, 'TO-220')] : undefined;
  if (pkg && !pk) throw new Error(`regulatorHeat: unknown package ${pkg} (known: ${Object.keys(PACKAGES).join(', ')}); or give theta_ja`);
  const tja = num('theta_ja', theta_ja ?? pk?.theta_ja, { optional: true, gt: 0 });
  const tjc = num('theta_jc', theta_jc ?? pk?.theta_jc, { optional: true, gt: 0 });
  const out = result(sig(P, 4), 'W', { vin: Vin, vout: Vout, i: I, iq: Iq, package: pkg, theta_ja: tja, theta_jc: tjc, tamb: Ta, tjmax: Tj },
    'P = (Vin − Vout) × I + Vin × Iq; Tj = Tamb + P × θja', { efficiency: sig(eff, 3) });
  out.steps.push(`P = (${Vin} − ${Vout}) × ${I}${Iq ? ` + ${Vin} × ${Iq}` : ''} = ${sig(P)} W (efficiency ${sig(eff * 100, 3)}%)`);
  const guidance = [];
  if (tja !== undefined) {
    const tjNo = Ta + P * tja;
    out.tj = sig(tjNo, 4);
    out.steps.push(`Tj = ${Ta} + ${sig(P)} × ${tja} = ${sig(tjNo)} °C (limit ${Tj} °C, design for ${Tj - 25} °C)`);
    out.needsHeatsink = tjNo > Tj - 25;
    if (out.needsHeatsink && tjc !== undefined) {
      const tsa = (Tj - 25 - Ta) / P - tjc - theta_cs;
      out.theta_sa_required = sig(tsa, 3);
      if (tsa <= 0) guidance.push('No heatsink is enough: use a buck (switching) converter instead.');
      else guidance.push(`Needs a heatsink of ${sig(tsa, 3)} °C/W or better (θsa = (Tj − 25 − Ta)/P − θjc − θcs).`);
    } else if (!out.needsHeatsink) guidance.push('Runs without a heatsink (keep the copper area the datasheet asks for).');
  } else {
    out.needsHeatsink = P > 1;
    guidance.push('No package given: rule of thumb only. Under ~0.5 W small packages (SOT-223) are fine, 0.5–1 W needs copper area, above ~1 W use a TO-220 with heatsink or a buck converter.');
  }
  if (P > 2) guidance.push(`Wastes ${sig(P, 3)} W as heat: a buck converter would be cooler and run longer on battery.`);
  out.guidance = guidance;
  if (out.needsHeatsink) out.warnings.push(`Regulator dissipates ${sig(P, 3)} W and needs cooling.`);
  return out;
}

// ---------------------------------------------------------------------------
// Wire resistance, drop and ampacity

/** Copper resistivity at 20 °C (Ω·m), annealed copper (IACS). */
export const COPPER_RHO_20C = 1.724e-8;
const COPPER_ALPHA = 0.00393;

/** AWG diameter (mm): d = 0.127 × 92^((36 − AWG) / 39). */
export function awgDiameter(awg) {
  const a = num('awg', awg, { min: -3, max: 40 });
  return 0.127 * 92 ** ((36 - a) / 39);
}

/** Cross-section area (mm²) of a solid AWG conductor. */
export function awgArea(awg) {
  const d = awgDiameter(awg);
  return Math.PI * d * d / 4;
}

/** Resistance (Ω/m) of one copper AWG conductor at temp °C (default 20). */
export function awgOhmPerM(awg, temp = 20) {
  return COPPER_RHO_20C * (1 + COPPER_ALPHA * (temp - 20)) / (awgArea(awg) * 1e-6);
}

/** Ω/m table for AWG 30..10 at 20 °C, computed from the AWG formula. */
export const AWG_OHM_PER_M = Object.fromEntries(
  [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10].map((g) => [g, sig(awgOhmPerM(g), 4)]));

/**
 * wireDrop({ current, length_m, awg, conductors=2, vsupply?, temp=20 })
 *   length_m is the one-way run; conductors=2 counts the return wire too.
 * value = voltage drop (V); extra: resistance (Ω), percent (if vsupply), power (W lost).
 */
export function wireDrop({ current, length_m, awg, conductors = 2, vsupply, temp = 20 } = {}) {
  const I = num('current', current, { min: 0 });
  const L = num('length_m', length_m, { min: 0 });
  const g = num('awg', awg, { min: 0, max: 40 });
  const n = num('conductors', conductors, { min: 1 });
  const rpm = awgOhmPerM(g, num('temp', temp));
  const R = rpm * L * n;
  const Vd = I * R;
  const out = result(sig(Vd, 4), 'V', { current: I, length_m: L, awg: g, conductors: n, vsupply, temp },
    'Vdrop = I × R per metre × conductors × length; R/m from d = 0.127 × 92^((36 − AWG)/39) mm and ρCu = 1.724e-8 Ω·m', {
      resistance: sig(R, 4), ohm_per_m: sig(rpm, 4), power: sig(I * Vd, 4),
    });
  out.steps.push(`${g} AWG: ${sig(rpm * 1000)} mΩ/m × ${n} × ${L} m = ${sig(R * 1000)} mΩ`);
  out.steps.push(`Vdrop = ${I} A × ${sig(R)} Ω = ${sig(Vd)} V`);
  const Vs = num('vsupply', vsupply, { optional: true, gt: 0 });
  if (Vs !== undefined) {
    out.percent = sig(100 * Vd / Vs, 3);
    out.steps.push(`${sig(out.percent)}% of ${Vs} V`);
    if (out.percent > 5) out.warnings.push(`Drop is ${out.percent}% of the supply: use a thicker wire or a shorter run.`);
    else if (out.percent > 3) out.warnings.push(`Drop is ${out.percent}% of the supply (aim for under 3%).`);
  }
  return out;
}

/**
 * Conservative continuous current (A) per AWG and insulation type, single wire in
 * free air, 30 °C ambient.
 *
 * Assumptions (honest): there is no single chart for small hobby wire. These
 * values are conservative design limits, roughly half of the single-wire
 * free-air figures in aerospace/chassis wiring curves (SAE AS50881 / MIL-W-5088
 * style) for each insulation's temperature class, so short runs inside an
 * enclosure, moderate bundling and cheap wire with thin strands stay cool:
 *   pvc      : 80–105 °C PVC hook-up wire (UL1007/UL1015, ribbon, jumpers)
 *   silicone : 150–200 °C silicone wire (RC / battery leads)
 *   ptfe     : 200 °C PTFE / ETFE wire
 * Bundled wires (more than one current-carrying wire together) are derated
 * by BUNDLE_DERATE. Cheap "AWG" jumper wire is often thinner than labelled:
 * treat jumpers as 26–28 AWG unless measured.
 */
export const AMPACITY = {
  pvc:      { 30: 0.5, 28: 0.8, 26: 1.3, 24: 2.0, 22: 3.0, 20: 4.5, 18: 7, 16: 10, 14: 15, 12: 20, 10: 30 },
  silicone: { 30: 0.9, 28: 1.4, 26: 2.2, 24: 3.5, 22: 5.0, 20: 7.5, 18: 11, 16: 15, 14: 22, 12: 30, 10: 40 },
  ptfe:     { 30: 1.0, 28: 1.5, 26: 2.5, 24: 3.7, 22: 5.5, 20: 8, 18: 12, 16: 17, 14: 24, 12: 33, 10: 45 },
};
export const AMPACITY_INFO = {
  basis: 'single wire, free air, 30 °C ambient, conservative (about 50% of aerospace free-air curves for the insulation temperature class)',
  sources: ['SAE AS50881 / MIL-W-5088 wire current curves (single wire, free air)', 'UL1007/UL1015 insulation temperature ratings'],
  confidence: 'estimate (conservative)',
};
export const BUNDLE_DERATE = 0.7;
const INSULATION_ALIASES = { pvc: 'pvc', silicone: 'silicone', silicon: 'silicone', ptfe: 'ptfe', teflon: 'ptfe', etfe: 'ptfe' };

function normInsulation(ins) {
  const k = INSULATION_ALIASES[String(ins || 'pvc').toLowerCase()];
  if (!k) throw new Error(`unknown insulation ${ins} (use pvc, silicone or ptfe)`);
  return k;
}

/**
 * ampacity(awg, insulation='pvc', { bundled=false }) -> amps (plain number).
 * Odd gauges are interpolated (geometric mean of neighbours). Throws outside 10..30 AWG.
 */
export function ampacity(awg, insulation = 'pvc', { bundled = false } = {}) {
  const g = num('awg', awg, { min: 10, max: 30 });
  const table = AMPACITY[normInsulation(insulation)];
  let a = table[g];
  if (a === undefined) {
    const lo = Math.floor(g / 2) * 2, hi = lo + 2;
    a = Math.sqrt(table[lo] * table[Math.min(hi, 30)]);
  }
  return sig(a * (bundled ? BUNDLE_DERATE : 1), 3);
}

/**
 * minGauge(current, insulation='pvc', bundled=false)
 * value = thinnest AWG (largest number) whose ampacity covers the current.
 */
export function minGauge(current, insulation = 'pvc', bundled = false) {
  const I = num('current', current, { min: 0 });
  const ins = normInsulation(insulation);
  const gauges = [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10];
  const g = gauges.find((x) => ampacity(x, ins, { bundled }) >= I);
  const out = result(g ?? null, 'AWG', { current: I, insulation: ins, bundled },
    `Thinnest gauge whose rated current for ${ins} insulation${bundled ? ` (bundled ×${BUNDLE_DERATE})` : ''} ≥ I. Table: ${AMPACITY_INFO.basis}`, {
      ampacity: g ? ampacity(g, ins, { bundled }) : null, confidence: AMPACITY_INFO.confidence,
    });
  if (g === undefined) {
    out.warnings.push(`${I} A is beyond this table (10 AWG): use bus bars or parallel conductors and check a proper standard.`);
  } else {
    out.steps.push(`${g} AWG ${ins}: ${out.ampacity} A ≥ ${I} A`);
  }
  out.warnings.push('Conservative starting value; long runs also need the voltage-drop check (wireDrop).');
  return out;
}

// ---------------------------------------------------------------------------
// Battery runtime

/**
 * batteryRuntime({ capacity_ah, avg_a, usable=0.8 }) — value = hours.
 */
export function batteryRuntime({ capacity_ah, avg_a, usable = 0.8 } = {}) {
  const C = num('capacity_ah', capacity_ah, { gt: 0 });
  const I = num('avg_a', avg_a, { gt: 0 });
  const u = num('usable', usable, { gt: 0, max: 1 });
  const h = C * u / I;
  const out = result(sig(h, 3), 'h', { capacity_ah: C, avg_a: I, usable: u }, 'runtime = capacity × usable fraction / average current', {
    minutes: sig(h * 60, 3),
  });
  out.steps.push(`${C} Ah × ${u} / ${I} A = ${sig(h)} h (${sig(h * 60)} min)`);
  if (I > C * 2) out.warnings.push(`Draw is ${sig(I / C, 2)}C: high discharge rates reduce usable capacity; check the battery C rating.`);
  return out;
}

// ---------------------------------------------------------------------------
// Fuse size

/** Standard ATO/ATC (and mini) blade fuse ratings, A. Blade fuses are rated 32 V DC. */
export const BLADE_FUSES = [1, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 35, 40];
export const BLADE_FUSE_VDC = 32;

/**
 * fuseSize({ current, wireAwg?, insulation='pvc', partRatingA?, voltage? })
 *   current: max continuous current (A)
 * value = fuse rating (A) or null if no blade fuse fits between load and limits.
 * extra: target (125%), ceiling (A), ceilingFrom, type.
 */
export function fuseSize({ current, wireAwg, insulation = 'pvc', partRatingA, voltage } = {}) {
  const I = num('current', current, { gt: 0 });
  const target = I * 1.25;
  const limits = [];
  if (wireAwg !== undefined && wireAwg !== null) {
    const a = ampacity(num('wireAwg', wireAwg), insulation);
    limits.push({ a, from: `${wireAwg} AWG ${normInsulation(insulation)} wire` });
  }
  if (partRatingA !== undefined && partRatingA !== null) limits.push({ a: num('partRatingA', partRatingA, { gt: 0 }), from: 'part rating' });
  const ceiling = limits.length ? Math.min(...limits.map((l) => l.a)) : Infinity;
  const ceilingFrom = limits.length ? limits.find((l) => l.a === ceiling).from : null;
  let fuse = BLADE_FUSES.find((f) => f >= target - 1e-9) ?? null;
  const out = result(null, 'A', { current: I, wireAwg, insulation, partRatingA, voltage },
    'fuse ≈ 125% of max continuous current, rounded up to a standard blade size, never above the wire or part rating', {
      target: sig(target, 4), ceiling: Number.isFinite(ceiling) ? ceiling : null, ceilingFrom, type: 'ATO/ATC blade',
    });
  out.steps.push(`125% × ${I} A = ${sig(target)} A`);
  if (fuse !== null && fuse > ceiling) {
    // Fall back to the largest standard size that still protects the wire, if it does not blow in normal use.
    const lower = [...BLADE_FUSES].reverse().find((f) => f <= ceiling && f >= I);
    if (lower !== undefined) {
      out.warnings.push(`${fuse} A would exceed the ${ceiling} A limit of the ${ceilingFrom}; using ${lower} A, which leaves less than 25% headroom (may blow on peaks). A thicker wire is better.`);
      fuse = lower;
    } else {
      out.warnings.push(`No fuse fits: the load needs at least ${I} A but the ${ceilingFrom} is only good for ${ceiling} A. Use a thicker wire / higher-rated part first.`);
      fuse = null;
    }
  }
  if (fuse === null && !out.warnings.length) out.warnings.push(`${sig(target)} A is above the largest blade fuse (40 A): use a MIDI/ANL or DC breaker.`);
  out.value = fuse;
  if (fuse !== null) out.steps.push(`Standard blade size: ${fuse} A${Number.isFinite(ceiling) ? ` (limit ${ceiling} A from ${ceilingFrom})` : ''}`);
  const V = num('voltage', voltage, { optional: true, gt: 0 });
  if (V !== undefined && V > BLADE_FUSE_VDC) out.warnings.push(`${V} V is above the 32 V DC rating of blade fuses: use a fuse DC-rated for at least ${V} V.`);
  out.warnings.push('Put the fuse as close to the battery/supply positive terminal as possible.');
  return out;
}

// ---------------------------------------------------------------------------
// Print fits

/** Starting clearances per side (mm) when no printer profile is given. */
export const DEFAULT_CLEARANCE = { press: 0.1, snug: 0.15, sliding: 0.25, free: 0.4 };
export const FIT_TYPES = ['press', 'snug', 'sliding', 'free'];

/**
 * printFit({ nominal, fit, profile?, clearance?, feature='hole' })
 *   nominal: the real mating size (e.g. a 3 mm pin, a 22 mm bearing)
 *   feature: 'hole'  -> printed hole for a real shaft/pin   (nominal + 2c)
 *            'slot'  -> printed slot for a real part width  (nominal + 2c)
 *            'shaft' -> printed peg going into a real hole  (nominal − 2c)
 *   clearance: per-side override (mm); else profile.clearance_mm[fit]; else DEFAULT_CLEARANCE.
 * value = size to model (mm); extra: clearance_per_side, source.
 */
export function printFit({ nominal, fit = 'sliding', profile, clearance, feature = 'hole' } = {}) {
  const d = num('nominal', nominal, { gt: 0 });
  if (!FIT_TYPES.includes(fit)) throw new Error(`printFit: fit must be one of ${FIT_TYPES.join(', ')}`);
  if (!['hole', 'shaft', 'slot', 'peg'].includes(feature)) throw new Error('printFit: feature must be hole, shaft or slot');
  let c, source;
  if (clearance !== undefined && clearance !== null) { c = num('clearance', clearance, { min: -1, max: 2 }); source = 'override'; }
  else if (profile?.clearance_mm?.[fit] !== undefined) { c = profile.clearance_mm[fit]; source = `printer profile ${profile.id || ''}`.trim(); }
  else { c = DEFAULT_CLEARANCE[fit]; source = 'Wiremap default'; }
  const sign = feature === 'shaft' || feature === 'peg' ? -1 : 1;
  const size = d + sign * 2 * c;
  if (size <= 0) throw new Error('printFit: clearance larger than the part');
  const out = result(sig(size, 4), 'mm', { nominal: d, fit, feature, clearance: c, printer: profile?.id },
    sign > 0 ? 'modelled = nominal + 2 × clearance per side' : 'modelled = nominal − 2 × clearance per side', {
      clearance_per_side: c, source,
    });
  out.steps.push(`${fit} ${feature}: ${d} ${sign > 0 ? '+' : '−'} 2 × ${c} = ${sig(size)} mm`);
  out.warnings.push('Starting value: depends on printer, material and orientation. Print the tolerance coupon and store measured clearances in the printer profile.');
  if (feature === 'hole' && d < 6) out.warnings.push('Small vertical holes print undersize and holes printed sideways print oval: drill or ream to size if it matters.');
  return out;
}

// ---------------------------------------------------------------------------
// Heat-set inserts

/**
 * Ruthex brass heat-set inserts (standard series RX-Mx).
 *   hole: recommended hole diameter (mm), length: insert length (mm), wall: minimum wall (mm)
 * M3 (4.0 mm hole, 5.7 mm long, 1.6 mm wall) matches the Ruthex table as reproduced by a
 * retailer (checked 2026-11-20). Other sizes are from the Ruthex table as commonly
 * reproduced and could not be fetched from ruthex.de in this session: confirm before release.
 */
export const INSERTS = {
  ruthex: {
    source: 'https://www.ruthex.de (technical table on each insert product page)',
    sizes: {
      M2: { hole: 3.2, length: 4.0, wall: 1.3, outer: 3.6, confidence: 'confirm' },
      'M2.5': { hole: 3.6, length: 5.7, wall: 1.5, outer: 4.0, confidence: 'confirm' },
      M3: { hole: 4.0, length: 5.7, wall: 1.6, outer: 4.6, confidence: 'checked' },
      M4: { hole: 5.6, length: 8.1, wall: 2.0, outer: 6.3, confidence: 'confirm' },
      M5: { hole: 6.4, length: 9.5, wall: 2.5, outer: 7.0, confidence: 'confirm' },
    },
  },
};

function normSize(size) {
  const s = String(size || '').toUpperCase().replace(/^M?/, 'M').replace(',', '.');
  return s;
}

/**
 * insertHole({ size, maker='ruthex', blind_extra=1.0 })
 * value = hole diameter (mm); extra: depth (insert length + blind_extra), min_wall, boss_d, insert_length, confidence.
 */
export function insertHole({ size, maker = 'ruthex', blind_extra = 1.0 } = {}) {
  const m = INSERTS[String(maker).toLowerCase()];
  if (!m) throw new Error(`insertHole: unknown insert maker ${maker} (known: ${Object.keys(INSERTS).join(', ')})`);
  const key = normSize(size);
  const s = m.sizes[key];
  if (!s) throw new Error(`insertHole: no ${maker} data for ${size} (known: ${Object.keys(m.sizes).join(', ')})`);
  const extra = num('blind_extra', blind_extra, { min: 0 });
  const depth = s.length + extra;
  const boss = s.hole + 2 * s.wall;
  const out = result(s.hole, 'mm', { size: key, maker },
    "hole = insert maker's published hole diameter (never the insert length); depth = insert length + extra for displaced plastic; boss = hole + 2 × min wall", {
      hole_d: s.hole, depth: sig(depth, 3), min_wall: s.wall, boss_d: sig(boss, 3), insert_length: s.length, outer_d: s.outer,
      confidence: s.confidence, source: m.source,
    });
  out.steps.push(`${maker} ${key}: hole Ø${s.hole} mm, depth ${sig(depth)} mm (${s.length} + ${extra}), wall ≥ ${s.wall} mm → boss Ø${sig(boss)} mm`);
  if (s.confidence !== 'checked' && s.confidence !== 'verified') out.warnings.push(`${maker} ${key} values not re-checked against the maker's page: confirm before printing.`);
  out.warnings.push(`Install with the iron at ~${key === 'M2' || key === 'M2.5' ? 200 : 220} °C for PLA (higher for PETG/ABS); press straight, stop flush.`);
  return out;
}

// ---------------------------------------------------------------------------
// Screw length

/** ISO 4762 / ISO 7380 commonly stocked lengths (mm). */
export const SCREW_LENGTHS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40, 45, 50, 55, 60];
/** ISO metric coarse pitch and ISO 4032 hex nut height (mm). */
export const METRIC = {
  M2: { d: 2, pitch: 0.4, nut: 1.6 },
  'M2.5': { d: 2.5, pitch: 0.45, nut: 2.0 },
  M3: { d: 3, pitch: 0.5, nut: 2.4 },
  M4: { d: 4, pitch: 0.7, nut: 3.2 },
  M5: { d: 5, pitch: 0.8, nut: 4.7 },
  M6: { d: 6, pitch: 1.0, nut: 5.2 },
};

/**
 * screwLength({ stack, size, engagement='insert', depth?, washer=0, maker='ruthex' })
 *   stack: thickness clamped under the screw head (mm), not counting the threaded part.
 *   engagement: 'insert' (heat-set insert in a blind hole), 'thread-plastic' (self-tapped
 *     printed hole; give depth = hole depth if it is blind), 'nut' (through, hex nut).
 * value = standard length (mm); extra: min, max, engaged (mm), range.
 */
export function screwLength({ stack, size, engagement = 'insert', depth, washer = 0, maker = 'ruthex' } = {}) {
  const S = num('stack', stack, { gt: 0 });
  const key = normSize(size);
  const m = METRIC[key];
  if (!m) throw new Error(`screwLength: unknown size ${size} (known: ${Object.keys(METRIC).join(', ')})`);
  const W = num('washer', washer, { min: 0 });
  const base = S + W;
  let min, max, why;
  if (engagement === 'insert') {
    const ins = insertHole({ size: key, maker });
    const holeDepth = num('depth', depth ?? ins.depth, { gt: 0 });
    min = base + Math.min(ins.insert_length, 1.5 * m.d);
    max = base + holeDepth - 0.5;
    why = `engage at least ${sig(Math.min(ins.insert_length, 1.5 * m.d))} mm of the ${ins.insert_length} mm insert; stop 0.5 mm short of the ${sig(holeDepth)} mm hole bottom`;
  } else if (engagement === 'thread-plastic') {
    min = base + 2.5 * m.d;
    const D = num('depth', depth, { optional: true, gt: 0 });
    max = D !== undefined ? base + D - 0.5 : base + 4 * m.d;
    why = `self-tapping into plastic needs about 2.5 × d = ${sig(2.5 * m.d)} mm of thread${D !== undefined ? `; hole is ${D} mm deep` : ''}`;
  } else if (engagement === 'nut') {
    min = base + m.nut + 2 * m.pitch;
    max = base + m.nut + 2 * m.pitch + 4;
    why = `pass through the ${m.nut} mm nut plus 2 threads (${sig(2 * m.pitch)} mm), not more than ~4 mm beyond`;
  } else throw new Error("screwLength: engagement must be 'insert', 'thread-plastic' or 'nut'");
  const L = SCREW_LENGTHS.find((l) => l >= min - 1e-9);
  const out = result(null, 'mm', { stack: S, size: key, engagement, depth, washer: W }, `L ≥ stack + engagement; L ≤ stack + available depth (${why})`, {
    min: sig(min, 3), max: sig(max, 3), range: [sig(min, 3), sig(max, 3)],
  });
  out.steps.push(`Need ${sig(min)} mm ≤ L ≤ ${sig(max)} mm`);
  if (L === undefined || L > max + 1e-9) {
    const below = [...SCREW_LENGTHS].reverse().find((l) => l <= max + 1e-9 && l >= base + 0.5 * m.d);
    if (below !== undefined) {
      out.value = below;
      out.engaged = sig(below - base, 3);
      out.warnings.push(`No standard length fits the full range; ${key}x${below} engages only ${out.engaged} mm. Adjust the stack or hole depth, or cut a screw to ${sig((min + max) / 2, 3)} mm.`);
    } else {
      out.value = null;
      out.warnings.push(`No standard ${key} length fits: deepen the hole or change the stack (needs ${sig(min)}–${sig(max)} mm).`);
    }
  } else {
    out.value = L;
    out.engaged = sig(L - base, 3);
    out.steps.push(`Standard length: ${key}x${L} (engages ${out.engaged} mm)`);
  }
  return out;
}

/** All calculators by CLI name. */
export const CALCULATORS = { ohm, ledResistor, divider, powerBudget, regulatorHeat, wireDrop, minGauge, batteryRuntime, fuseSize, printFit, insertHole, screwLength };
