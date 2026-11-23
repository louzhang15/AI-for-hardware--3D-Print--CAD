// @ts-check
// Wiremap mechanical and robotics checker: plain deterministic engineering
// formulas, no AI. Runs in Node (CLI, tests) and in the browser (viewer).
//
// Covers: ISO 286 limits and fits, FDM printed fits, tolerance stack-ups
// (worst case and RSS), bolts (tension, shear, bearing on printed plates),
// printed beam stress and deflection, robot-arm joint torque over the whole
// joint range (gravity + acceleration), forward/inverse kinematics, workspace,
// tip accuracy, gripper force, gear trains (Lewis bending), lead screws,
// multirotor sizing and rover drive torque/traction.
//
// Every number is an engineering estimate from published formulas and typical
// material data. It flags designs that cannot work; it does not prove that a
// design will work. Print and test.

import { printFit, DEFAULT_CLEARANCE } from './calc.js';
import { checkAssembly, checkPrintsDFM } from './dfm.js';

export const G = 9.80665;
export const CALC = 'calculated';

// ---------------------------------------------------------------------------
// helpers

const r3 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(3)) + 0 : x);
const r2 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(2)) : x);
const r1 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(1)) : x);
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;
const cap = (t) => String(t || '').charAt(0).toUpperCase() + String(t || '').slice(1);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function need(name, v, { gt, min } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!isNum(n)) throw new Error(`${name} must be a number (got ${JSON.stringify(v)})`);
  if (gt !== undefined && !(n > gt)) throw new Error(`${name} must be greater than ${gt} (got ${n})`);
  if (min !== undefined && n < min) throw new Error(`${name} must be at least ${min} (got ${n})`);
  return n;
}

/** kgf·cm to N·m. Servo datasheets quote kg·cm. */
export const kgcmToNm = (kgcm) => (kgcm * G) / 100;
export const nmToKgcm = (nm) => (nm * 100) / G;

// ---------------------------------------------------------------------------
// ISO 286-1/-2 limits and fits (nominal sizes 0-120 mm)

/** Upper bounds of the ISO 286 size ranges (mm). "over A up to and including B". */
const RANGES = [3, 6, 10, 18, 30, 50, 80, 120];
/** Standard tolerance grades IT5-IT11 in micrometres, per range above (ISO 286-1 table 1). */
const IT = {
  5: [4, 5, 6, 8, 9, 11, 13, 15],
  6: [6, 8, 9, 11, 13, 16, 19, 22],
  7: [10, 12, 15, 18, 21, 25, 30, 35],
  8: [14, 18, 22, 27, 33, 39, 46, 54],
  9: [25, 30, 36, 43, 52, 62, 74, 87],
  10: [40, 48, 58, 70, 84, 100, 120, 140],
  11: [60, 75, 90, 110, 130, 160, 190, 220],
  12: [100, 120, 150, 180, 210, 250, 300, 350],
  13: [140, 180, 220, 270, 330, 390, 460, 540],
  14: [250, 300, 360, 430, 520, 620, 740, 870],
};
/** Shaft fundamental deviations (µm). es for d..h (upper), ei for k..s (lower). ISO 286-1 tables 2/3. */
const SHAFT_FD = {
  d: [-20, -30, -40, -50, -65, -80, -100, -120],
  e: [-14, -20, -25, -32, -40, -50, -60, -72],
  f: [-6, -10, -13, -16, -20, -25, -30, -36],
  g: [-2, -4, -5, -6, -7, -9, -10, -12],
  h: [0, 0, 0, 0, 0, 0, 0, 0],
  k: [0, 1, 1, 1, 2, 2, 2, 3], // IT4..IT7; above IT7 k is 0
  m: [2, 4, 6, 7, 8, 9, 11, 13],
  n: [4, 8, 10, 12, 15, 17, 20, 23],
  p: [6, 12, 15, 18, 22, 26, 32, 37],
};
/** r and s change inside the 50-120 range: [upTo, value]. */
const SHAFT_FD_SPLIT = {
  r: [[3, 10], [6, 15], [10, 19], [18, 23], [30, 28], [50, 34], [65, 41], [80, 43], [100, 51], [120, 54]],
  s: [[3, 14], [6, 19], [10, 23], [18, 28], [30, 35], [50, 43], [65, 53], [80, 59], [100, 71], [120, 79]],
};

function rangeIndex(d) {
  const n = need('nominal', d, { gt: 0 });
  if (n > 120) throw new Error('ISO fits: nominal sizes above 120 mm are not tabulated here');
  return RANGES.findIndex((u) => n <= u);
}

/** Standard tolerance IT<grade> for a nominal size, in µm. */
export function itTolerance(grade, d) {
  const g = Number(grade);
  if (!IT[g]) throw new Error(`ISO fits: IT${grade} not tabulated (IT5-IT14)`);
  return IT[g][rangeIndex(d)];
}

/** Shaft limits deviations {es, ei} in µm for e.g. ('g', 6, 20). */
export function shaftDeviation(letter, grade, d) {
  const L = String(letter).toLowerCase();
  const it = itTolerance(grade, d);
  const i = rangeIndex(d);
  if (L === 'js') return { es: it / 2, ei: -it / 2 };
  if (SHAFT_FD_SPLIT[L]) {
    const ei = SHAFT_FD_SPLIT[L].find(([u]) => d <= u)[1];
    return { es: ei + it, ei };
  }
  if (!(L in SHAFT_FD)) throw new Error(`ISO fits: shaft letter "${letter}" not supported (d e f g h js k m n p r s)`);
  if ('defgh'.includes(L)) { const es = SHAFT_FD[L][i]; return { es, ei: es - it }; }
  const ei = L === 'k' && Number(grade) > 7 ? 0 : SHAFT_FD[L][i];
  return { es: ei + it, ei };
}

/** Hole limit deviations {ES, EI} in µm. Supports the hole-basis letters H, G, F, E, D and JS. */
export function holeDeviation(letter, grade, d) {
  const L = String(letter).toUpperCase();
  const it = itTolerance(grade, d);
  if (L === 'JS') return { ES: it / 2, EI: -it / 2 };
  if (L === 'H') return { ES: it, EI: 0 };
  const lower = L.toLowerCase();
  if ('defg'.includes(lower) && lower.length === 1) {
    const EI = -SHAFT_FD[lower][rangeIndex(d)]; // EI = -es for A..H
    return { ES: EI + it, EI };
  }
  throw new Error(`ISO fits: hole letter "${letter}" not supported (H, G, F, E, D, JS). Use a hole-basis fit like H7/g6.`);
}

/**
 * isoFit({ nominal, fit: 'H7/g6' })
 * Returns hole and shaft limits (mm), clearance range (mm, negative = interference)
 * and the fit type: clearance, transition or interference.
 */
export function isoFit({ nominal, fit } = {}) {
  const d = need('nominal', nominal, { gt: 0 });
  const m = /^\s*([A-Z]{1,2})(\d{1,2})\s*\/\s*([a-z]{1,2})(\d{1,2})\s*$/.exec(String(fit || ''));
  if (!m) throw new Error(`isoFit: fit must look like H7/g6 (got ${JSON.stringify(fit)})`);
  const [, hl, hg, sl, sg] = m;
  const H = holeDeviation(hl, hg, d);
  const S = shaftDeviation(sl, sg, d);
  const hole = { max: d + H.ES / 1000, min: d + H.EI / 1000 };
  const shaft = { max: d + S.es / 1000, min: d + S.ei / 1000 };
  const cmax = (H.ES - S.ei) / 1000;
  const cmin = (H.EI - S.es) / 1000;
  const type = cmin >= 0 ? 'clearance' : cmax <= 0 ? 'interference' : 'transition';
  const round = (x) => Number(x.toFixed(4));
  return {
    value: { min: round(cmin), max: round(cmax) }, unit: 'mm', label: CALC,
    nominal: d, fit: `${hl}${hg}/${sl}${sg}`, type,
    hole: { max: round(hole.max), min: round(hole.min), ES_um: H.ES, EI_um: H.EI, grade: Number(hg) },
    shaft: { max: round(shaft.max), min: round(shaft.min), es_um: S.es, ei_um: S.ei, grade: Number(sg) },
    clearance: { min: round(cmin), max: round(cmax) },
    formula: 'ISO 286: hole = nominal + (EI..ES), shaft = nominal + (ei..es); clearance = hole − shaft',
    steps: [
      `Hole ${hl}${hg}: ${round(hole.min)} – ${round(hole.max)} mm`,
      `Shaft ${sl}${sg}: ${round(shaft.min)} – ${round(shaft.max)} mm`,
      `Clearance ${round(cmin)} to ${round(cmax)} mm (${type})`,
    ],
    warnings: [],
  };
}

/** Typical achievable IT grade for a process (for "can this process hold that tolerance?"). */
export const PROCESS_IT = { fdm: 13, sla: 11, 'cnc': 7, reamed: 7, drilled: 11, ground: 6, laser: 12, bought: 6 };

// ---------------------------------------------------------------------------
// Tolerance stack-up

/**
 * stackup({ dims: [{ name, nominal, tol | plus/minus, sign: +1|-1 }], min_gap?, max_gap? })
 * Gap = Σ sign·nominal. Worst case adds every tolerance; RSS assumes independent
 * normal parts with tolerance = 3σ (√Σ tol²). Returns both and whether the gap
 * requirement holds.
 */
export function stackup({ dims, min_gap, max_gap } = {}) {
  if (!Array.isArray(dims) || !dims.length) throw new Error('stackup: dims must be a non-empty list');
  let nominal = 0, wcLow = 0, wcHigh = 0, varSum = 0, mid = 0;
  const steps = [];
  for (const [i, dm] of dims.entries()) {
    const n = need(`dims[${i}].nominal`, dm.nominal);
    const s = dm.sign === -1 || dm.sign === '-' ? -1 : 1;
    const plus = isNum(dm.plus) ? Math.abs(dm.plus) : Math.abs(need(`dims[${i}].tol`, dm.tol ?? 0));
    const minus = isNum(dm.minus) ? Math.abs(dm.minus) : plus;
    nominal += s * n;
    // contribution range of this dimension to the gap
    const lo = s > 0 ? n - minus : -(n + plus);
    const hi = s > 0 ? n + plus : -(n - minus);
    wcLow += lo; wcHigh += hi;
    mid += (lo + hi) / 2;
    varSum += ((plus + minus) / 2) ** 2;
    steps.push(`${s > 0 ? '+' : '−'} ${dm.name || `dim ${i + 1}`} ${n} (+${plus}/−${minus})`);
  }
  const rss = Math.sqrt(varSum);
  const out = {
    value: r3(nominal), unit: 'mm', label: CALC,
    nominal: r3(nominal),
    worst: { min: r3(wcLow), max: r3(wcHigh) },
    rss: { min: r3(mid - rss), max: r3(mid + rss) },
    formula: 'gap = Σ sign × nominal; worst case = Σ every tolerance; RSS = mean ± √Σ tol² (tolerances taken as ±3σ)',
    steps, warnings: [], ok: true, ok_rss: true,
  };
  if (isNum(min_gap)) {
    if (wcLow < min_gap - 1e-9) out.ok = false;
    if (mid - rss < min_gap - 1e-9) out.ok_rss = false;
  }
  if (isNum(max_gap)) {
    if (wcHigh > max_gap + 1e-9) out.ok = false;
    if (mid + rss > max_gap + 1e-9) out.ok_rss = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Materials (FDM printed, typical XY values; real parts vary with settings)

/**
 * Tensile strength (MPa, printed in XY, 100% solid) and modulus (GPa), heat
 * deflection temperature (°C). Typical maker data sheet ranges, rounded down.
 */
export const MATERIALS = {
  PLA: { strength: 50, E: 3.5, hdt: 55, note: 'Creeps under constant load and softens near 55 °C (warm motors, cars in summer).' },
  'PLA-CF': { strength: 45, E: 4.5, hdt: 55 },
  PETG: { strength: 45, E: 2.0, hdt: 70 },
  'PETG-CF': { strength: 45, E: 3.5, hdt: 75 },
  ABS: { strength: 38, E: 2.0, hdt: 90 },
  ASA: { strength: 40, E: 2.0, hdt: 95 },
  PC: { strength: 60, E: 2.3, hdt: 115 },
  PA: { strength: 50, E: 1.5, hdt: 80 },
  'PA-CF': { strength: 70, E: 5.0, hdt: 150 },
  TPU: { strength: 25, E: 0.03, hdt: 50, flexible: true },
  aluminium: { strength: 240, E: 69, hdt: 400, metal: true },
  steel: { strength: 350, E: 200, hdt: 600, metal: true },
};

export function material(name) {
  const key = Object.keys(MATERIALS).find((k) => k.toLowerCase() === String(name || 'PLA').toLowerCase());
  if (!key) throw new Error(`Unknown material ${name} (known: ${Object.keys(MATERIALS).join(', ')})`);
  return { id: key, ...MATERIALS[key] };
}

/**
 * Allowable stress for a printed part.
 *   fill: share of the solid strength the part keeps (walls, infill). 0.6 default
 *         for 3+ walls and ≥ 15 % infill in bending; 1 for solid.
 *   layer: 'xy' if the stress runs along the layers, 'z' if it pulls layers apart (× 0.5).
 *   sf: safety factor (default 2; use 3 for parts that hold something over people).
 */
export function allowableStress({ material: mat = 'PLA', fill = 0.6, layer = 'xy', sf = 2 } = {}) {
  const m = material(mat);
  const zf = m.metal ? 1 : layer === 'z' ? 0.5 : 1;
  const f = m.metal ? 1 : need('fill', fill, { gt: 0 });
  return { value: (m.strength * f * zf) / need('sf', sf, { gt: 0 }), material: m, fill: f, layer_factor: zf, sf };
}

// ---------------------------------------------------------------------------
// Beam sections and printed link bending

/** Section properties: I (mm⁴) about the bending axis and Z = I / c (mm³). h is in the load direction. */
export function section(sec = {}) {
  const t = sec.type || 'rect';
  if (t === 'rect') {
    const w = need('section.w', sec.w, { gt: 0 }), h = need('section.h', sec.h, { gt: 0 });
    const I = (w * h ** 3) / 12;
    return { type: t, I, Z: I / (h / 2), area: w * h };
  }
  if (t === 'box') {
    const w = need('section.w', sec.w, { gt: 0 }), h = need('section.h', sec.h, { gt: 0 }), th = need('section.t', sec.t, { gt: 0 });
    if (2 * th >= Math.min(w, h)) return section({ type: 'rect', w, h });
    const I = (w * h ** 3 - (w - 2 * th) * (h - 2 * th) ** 3) / 12;
    return { type: t, I, Z: I / (h / 2), area: w * h - (w - 2 * th) * (h - 2 * th) };
  }
  if (t === 'tube' || t === 'round') {
    const od = need('section.od', sec.od, { gt: 0 }), id = t === 'round' ? 0 : need('section.id', sec.id ?? 0, { min: 0 });
    if (id >= od) throw new Error('section: tube id must be smaller than od');
    const I = (Math.PI * (od ** 4 - id ** 4)) / 64;
    return { type: t, I, Z: I / (od / 2), area: (Math.PI * (od ** 2 - id ** 2)) / 4 };
  }
  throw new Error(`section: type must be rect, box, tube or round (got ${t})`);
}

/**
 * beam({ length_mm, section, tip_load_n | moment_nmm, material, fill, layer, sf })
 * Cantilever: root moment M = F·L, σ = M / Z, tip deflection δ = F·L³ / (3·E·I).
 */
export function beam({ length_mm, section: sec, tip_load_n, moment_nmm, material: mat = 'PLA', fill = 0.6, layer = 'xy', sf = 2 } = {}) {
  const L = need('length_mm', length_mm, { gt: 0 });
  const s = section(sec);
  const F = isNum(tip_load_n) ? tip_load_n : need('moment_nmm', moment_nmm) / L;
  const M = isNum(moment_nmm) ? moment_nmm : F * L;
  const allow = allowableStress({ material: mat, fill, layer, sf });
  const sigma = M / s.Z;
  const Eeff = allow.material.E * 1000 * (allow.material.metal ? 1 : Math.max(0.5, Number(fill) || 0.6));
  const delta = (F * L ** 3) / (3 * Eeff * s.I);
  const out = {
    value: r2(sigma), unit: 'MPa', label: CALC,
    stress_mpa: r2(sigma), allowable_mpa: r2(allow.value), utilisation: r2(sigma / allow.value),
    deflection_mm: r3(delta), moment_nmm: r1(M), I_mm4: r1(s.I), Z_mm3: r1(s.Z),
    formula: 'σ = M / Z; δ = F·L³ / (3·E·I) (cantilever, load at the tip)',
    steps: [`M = ${r1(M)} N·mm, Z = ${r1(s.Z)} mm³ → σ = ${r2(sigma)} MPa`, `allowable = ${allow.material.strength} × ${allow.fill} fill × ${allow.layer_factor} layer ÷ SF ${sf} = ${r2(allow.value)} MPa`],
    warnings: [],
  };
  if (!allow.material.metal) out.warnings.push('Printed strength depends on walls, infill and layer direction. Estimate only: print one and load-test it.');
  if (allow.material.id === 'PLA') out.warnings.push('PLA creeps under steady load: keep steady stress well below the short-term allowable.');
  return out;
}

// ---------------------------------------------------------------------------
// Bolts (ISO 898-1 property classes; tensile stress areas ISO 724)

export const BOLT_AREA = { M2: 2.07, 'M2.5': 3.39, M3: 5.03, M4: 8.78, M5: 14.2, M6: 20.1, M8: 36.6, M10: 58.0 };
/** Proof stress (MPa). Stainless A2/A4-70 uses the 0.2 % yield. */
export const BOLT_PROOF = { '4.8': 310, '5.8': 380, '8.8': 580, '10.9': 830, '12.9': 970, 'A2-50': 210, 'A2-70': 450, 'A4-70': 450, 'A2-80': 600 };

/**
 * bolt({ size, class: '8.8', count, load_n, mode: 'tension'|'shear', plate_mm?, plate_material?, sf })
 * Capacity per bolt = As × proof (tension) or 0.6 × As × proof (shear, threads in the shear plane).
 * With plate_mm (a printed part) also checks bearing of the bolt on the plastic: F ≤ d·t·σ_allow.
 */
export function bolt({ size, class: cls = '8.8', count = 1, load_n, mode = 'shear', plate_mm, plate_material = 'PLA', sf = 2 } = {}) {
  const key = String(size || '').toUpperCase().replace(/^M?/, 'M');
  const As = BOLT_AREA[key];
  if (!As) throw new Error(`bolt: unknown size ${size} (known: ${Object.keys(BOLT_AREA).join(', ')})`);
  const proof = BOLT_PROOF[String(cls).toUpperCase()] ?? BOLT_PROOF[String(cls)];
  if (!proof) throw new Error(`bolt: unknown class ${cls} (known: ${Object.keys(BOLT_PROOF).join(', ')})`);
  const n = need('count', count, { gt: 0 });
  const F = need('load_n', load_n, { min: 0 });
  const per = F / n;
  const capSteel = (mode === 'tension' ? 1 : 0.6) * As * proof;
  const d = Number(key.slice(1));
  let capPlate = Infinity;
  const steps = [`load per bolt = ${r1(F)} / ${n} = ${r1(per)} N`, `steel ${mode} capacity = ${mode === 'tension' ? '' : '0.6 × '}${As} mm² × ${proof} MPa = ${r1(capSteel)} N`];
  if (isNum(plate_mm)) {
    const allow = allowableStress({ material: plate_material, fill: 1, layer: 'xy', sf: 1 });
    // printed bearing strength ~ 1.0 × tensile (conservative for plastics)
    capPlate = d * plate_mm * allow.value;
    steps.push(`plate bearing = ${d} mm × ${plate_mm} mm × ${allow.value} MPa = ${r1(capPlate)} N`);
  }
  const cap = Math.min(capSteel, capPlate);
  const margin = per > 0 ? cap / per : Infinity;
  return {
    value: r2(margin), unit: '× (capacity / load)', label: CALC,
    per_bolt_n: r1(per), capacity_n: r1(cap), steel_n: r1(capSteel), plate_n: isFinite(capPlate) ? r1(capPlate) : null,
    limited_by: capPlate < capSteel ? 'printed plate' : 'bolt',
    margin: r2(margin), ok: margin >= sf,
    formula: mode === 'tension' ? 'F ≤ As × proof' : 'F ≤ 0.6 × As × proof; plate: F ≤ d × t × σ',
    steps, warnings: capPlate < capSteel ? ['The plastic around the bolt fails long before the bolt: use a washer, a larger boss or more bolts.'] : [],
  };
}

// ---------------------------------------------------------------------------
// Gears (spur, Lewis bending)

/** Lewis form factor Y for 20° full-depth teeth (by tooth count). */
const LEWIS = [[12, 0.245], [13, 0.261], [14, 0.277], [15, 0.29], [16, 0.296], [17, 0.303], [18, 0.309], [19, 0.314], [20, 0.322], [21, 0.328], [22, 0.331], [24, 0.337], [26, 0.346], [28, 0.353], [30, 0.359], [34, 0.371], [38, 0.384], [43, 0.397], [50, 0.409], [60, 0.422], [75, 0.435], [100, 0.447], [150, 0.46], [300, 0.472], [1e9, 0.485]];
export function lewisY(z) {
  const t = need('z', z, { gt: 0 });
  if (t <= 12) return LEWIS[0][1];
  for (let i = 1; i < LEWIS.length; i++) {
    const [z1, y1] = LEWIS[i - 1], [z2, y2] = LEWIS[i];
    if (t <= z2) return y1 + ((t - z1) * (y2 - y1)) / (z2 - z1);
  }
  return 0.485;
}

/**
 * gear({ module, z1, z2, torque_nm (on gear 1), face_mm, material, process: 'fdm'|'machined', efficiency, sf, nozzle })
 * Ratio, centre distance a = m(z1+z2)/2, output torque, Lewis bending σ = Ft / (b·m·Y) on the weaker (smaller) gear.
 */
export function gear({ module: m, z1, z2, torque_nm, face_mm, material: mat = 'PLA', process = 'fdm', efficiency, sf = 2, nozzle = 0.4 } = {}) {
  const mod = need('module', m, { gt: 0 });
  const a = need('z1', z1, { gt: 0 }), b = need('z2', z2, { gt: 0 });
  const ratio = b / a;
  const eta = isNum(efficiency) ? efficiency : process === 'fdm' ? 0.9 : 0.97;
  const out = {
    value: r3(ratio), unit: ':1', label: CALC, ratio: r3(ratio),
    centre_distance_mm: r3((mod * (a + b)) / 2),
    pitch_d1_mm: r3(mod * a), pitch_d2_mm: r3(mod * b),
    formula: 'ratio = z2/z1; a = m(z1+z2)/2; σ = Ft / (b·m·Y), Ft = 2T / d1',
    steps: [], warnings: [], problems: [],
  };
  if (Math.min(a, b) < 17) out.problems.push({ level: 'warning', text: `${Math.min(a, b)} teeth is below 17: 20° teeth undercut (weak roots) unless the gear is profile-shifted.` });
  if (process === 'fdm' && mod < 2.5 * nozzle) out.problems.push({ level: 'warning', text: `Module ${mod} is small for a ${nozzle} mm nozzle: teeth print rough. Use module ≥ ${r2(2.5 * nozzle)} (≥ 1 for a 0.4 mm nozzle) or a 0.2 mm nozzle.` });
  if (isNum(torque_nm)) {
    const T = torque_nm * 1000; // N·mm
    const Ft = (2 * T) / (mod * a);
    const bw = need('face_mm', face_mm, { gt: 0 });
    const Y = lewisY(Math.min(a, b));
    const sigma = Ft / (bw * mod * Y);
    const allow = allowableStress({ material: mat, fill: process === 'fdm' ? 0.8 : 1, layer: 'xy', sf });
    out.tangential_force_n = r1(Ft);
    out.root_stress_mpa = r2(sigma);
    out.allowable_mpa = r2(allow.value);
    out.output_torque_nm = r3(torque_nm * ratio * eta);
    out.utilisation = r2(sigma / allow.value);
    out.steps.push(`Ft = 2 × ${r1(T)} / ${r2(mod * a)} = ${r1(Ft)} N`, `σ = ${r1(Ft)} / (${bw} × ${mod} × ${r3(Y)}) = ${r2(sigma)} MPa (allow ${r2(allow.value)})`);
    if (sigma > allow.value * sf) out.problems.push({ level: 'error', text: `Tooth root stress ${r2(sigma)} MPa exceeds the ${allow.material.id} strength (${r2(allow.value * sf)} MPa before safety factor): teeth will break. Wider face, bigger module or stronger material.` });
    else if (sigma > allow.value) out.problems.push({ level: 'warning', text: `Tooth root stress ${r2(sigma)} MPa is above the allowable ${r2(allow.value)} MPa (SF ${sf}).` });
  }
  return out;
}

/** Lead screw / belt linear force: F = 2π·η·T / lead. */
export function linearDrive({ torque_nm, lead_mm, efficiency = 0.35 } = {}) {
  const T = need('torque_nm', torque_nm, { gt: 0 }), l = need('lead_mm', lead_mm, { gt: 0 });
  const F = (2 * Math.PI * efficiency * T * 1000) / l;
  return { value: r1(F), unit: 'N', label: CALC, formula: 'F = 2π × η × T / lead', steps: [`2π × ${efficiency} × ${T * 1000} N·mm / ${l} mm = ${r1(F)} N`], warnings: efficiency < 0.5 ? ['η 0.35 is a plain trapezoidal/acme screw; ball screws are ~0.9. Self-locking screws (η < 0.5) hold the load with the motor off.'] : [] };
}

// ---------------------------------------------------------------------------
// Robot arm: yaw + planar pitch chain

/**
 * Actuator data from a library part's `mechanical` block.
 * torque: [{ v, stall_nm }] interpolated at supply_v (lowest listed if unknown).
 */
export function actuatorTorque(mech, supplyV) {
  const t = (mech && mech.torque) || [];
  if (!t.length) return null;
  const pts = [...t].sort((a, b) => a.v - b.v);
  if (!isNum(supplyV)) return pts[0].stall_nm;
  if (supplyV <= pts[0].v) return pts[0].stall_nm * (supplyV / pts[0].v);
  if (supplyV >= pts[pts.length - 1].v) return pts[pts.length - 1].stall_nm;
  for (let i = 1; i < pts.length; i++) {
    if (supplyV <= pts[i].v) {
      const f = (supplyV - pts[i - 1].v) / (pts[i].v - pts[i - 1].v);
      return pts[i - 1].stall_nm + f * (pts[i].stall_nm - pts[i - 1].stall_nm);
    }
  }
  return pts[0].stall_nm;
}

/**
 * Forward kinematics for a yaw joint followed by pitch joints in one vertical plane.
 * chain: [{ type: 'yaw'|'pitch'|'gripper', link_mm, offset_z_mm? }], angles in degrees.
 * First pitch angle is from horizontal; later pitch angles are relative to the previous link.
 * Returns points along the chain [{x,y,z}] in mm, the tip, horizontal reach r and absolute link angles.
 */
export function forwardKinematics(chain, anglesDeg) {
  let yaw = 0, phi = 0, r = 0, z = 0;
  const pts = [{ x: 0, y: 0, z: 0, joint: chain[0]?.id }];
  const abs = [];
  chain.forEach((j, i) => {
    const a = rad(anglesDeg[i] || 0);
    if (j.type === 'yaw') { yaw += a; z += j.link_mm || 0; abs.push(null); }
    else if (j.type === 'pitch') { phi += a; r += (j.link_mm || 0) * Math.cos(phi); z += (j.link_mm || 0) * Math.sin(phi); abs.push(phi); }
    else { r += (j.link_mm || 0) * Math.cos(phi); z += (j.link_mm || 0) * Math.sin(phi); abs.push(phi); }
    pts.push({ x: r * Math.cos(yaw), y: r * Math.sin(yaw), z, joint: chain[i + 1]?.id });
  });
  const tip = pts[pts.length - 1];
  return { points: pts, tip, reach: Math.hypot(tip.x, tip.y), z: tip.z, yaw, abs };
}

/** Joints that move the tip (yaw and pitch, not the gripper). */
const movers = (chain) => chain.map((j, i) => ({ j, i })).filter(({ j }) => j.type === 'yaw' || j.type === 'pitch');

/** Position Jacobian (3 × n) by central differences, in mm/rad. */
export function jacobian(chain, anglesDeg) {
  const h = 1e-4;
  const cols = [];
  for (const { i } of movers(chain)) {
    const ap = [...anglesDeg], am = [...anglesDeg];
    ap[i] += deg(h); am[i] -= deg(h);
    const p = forwardKinematics(chain, ap).tip, m = forwardKinematics(chain, am).tip;
    cols.push([(p.x - m.x) / (2 * h), (p.y - m.y) / (2 * h), (p.z - m.z) / (2 * h)]);
  }
  return cols; // column-major
}

function det3(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}
function solve3(A, b) {
  const d = det3(A);
  if (Math.abs(d) < 1e-12) return null;
  const rep = (c) => A.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)));
  return [det3(rep(0)) / d, det3(rep(1)) / d, det3(rep(2)) / d];
}

/** Eigenvalues of a symmetric 3×3 matrix (trigonometric method). */
function eigSym3(A) {
  const p1 = A[0][1] ** 2 + A[0][2] ** 2 + A[1][2] ** 2;
  if (p1 < 1e-18) return [A[0][0], A[1][1], A[2][2]].sort((a, b) => a - b);
  const q = (A[0][0] + A[1][1] + A[2][2]) / 3;
  const p2 = (A[0][0] - q) ** 2 + (A[1][1] - q) ** 2 + (A[2][2] - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B = A.map((row, i) => row.map((v, j) => (v - (i === j ? q : 0)) / p));
  const r = Math.max(-1, Math.min(1, det3(B) / 2));
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  return [e3, 3 * q - e1 - e3, e1].sort((a, b) => a - b);
}

/**
 * Dexterity at a pose: inverse condition number of the position Jacobian,
 * √(λmin/λmax), from 0 (singular: arm stretched straight or folded, some tip
 * directions impossible and small joint errors give large tip errors) to 1
 * (equally able to move in every direction). Scale-free.
 */
export function manipulability(chain, anglesDeg) {
  const J = jacobian(chain, anglesDeg);
  const n = J.length;
  if (!n) return 0;
  let ev;
  if (n >= 3) {
    const JJ = [0, 1, 2].map((a) => [0, 1, 2].map((b) => J.reduce((s, c) => s + c[a] * c[b], 0)));
    ev = eigSym3(JJ);
  } else if (n === 2) {
    const a = J[0][0] ** 2 + J[0][1] ** 2 + J[0][2] ** 2, d = J[1][0] ** 2 + J[1][1] ** 2 + J[1][2] ** 2;
    const b = J[0][0] * J[1][0] + J[0][1] * J[1][1] + J[0][2] * J[1][2];
    const tr = a + d, disc = Math.sqrt(Math.max(0, ((a - d) / 2) ** 2 + b * b));
    ev = [tr / 2 - disc, tr / 2 + disc];
  } else return 1;
  const max = ev[ev.length - 1];
  return max > 0 ? Math.sqrt(Math.max(0, ev[0]) / max) : 0;
}

/**
 * Inverse kinematics for the tip position (damped least squares, joint limits respected).
 * target {x,y,z} mm. Returns { ok, angles, error_mm }.
 */
export function inverseKinematics(chain, target, { start, limits, iterations = 200, tol = 0.5 } = {}) {
  let q = start ? [...start] : chain.map((j, i) => (limits?.[i] ? (limits[i][0] + limits[i][1]) / 2 : 0));
  const clamp = (v, i) => (limits?.[i] ? Math.min(limits[i][1], Math.max(limits[i][0], v)) : v);
  const lambda = 5; // mm damping
  let err = Infinity;
  for (let it = 0; it < iterations; it++) {
    const p = forwardKinematics(chain, q).tip;
    const e = [target.x - p.x, target.y - p.y, target.z - p.z];
    err = Math.hypot(...e);
    if (err < tol) break;
    const J = jacobian(chain, q);
    // dq = Jᵀ (J Jᵀ + λ²I)⁻¹ e
    const A = [0, 1, 2].map((a) => [0, 1, 2].map((b) => J.reduce((s, c) => s + c[a] * c[b], 0) + (a === b ? lambda * lambda : 0)));
    const y = solve3(A, e);
    if (!y) break;
    const mv = movers(chain);
    mv.forEach(({ i }, k) => {
      const dq = J[k][0] * y[0] + J[k][1] * y[1] + J[k][2] * y[2];
      q[i] = clamp(q[i] + deg(Math.max(-0.3, Math.min(0.3, dq))), i);
    });
  }
  const tip = forwardKinematics(chain, q).tip;
  err = Math.hypot(target.x - tip.x, target.y - tip.y, target.z - tip.z);
  return { ok: err < Math.max(tol, 1), angles: q.map((a) => r2(a)), error_mm: r2(err) };
}

/**
 * Gravity torque (N·m) on every joint for one pose, plus the bending moment on
 * the yaw joint. masses: [{ at: 'link', index, com } | { at: 'joint', index } | { at: 'tip' }, mass_g].
 */
function poseLoads(chain, anglesDeg, masses) {
  const fk = forwardKinematics(chain, anglesDeg);
  // horizontal distance of each mass from the base axis, and its position along the plane
  const posOf = (m) => {
    if (m.at === 'tip') return fk.points[fk.points.length - 1];
    if (m.at === 'joint') return fk.points[m.index];
    const a = fk.points[m.index], b = fk.points[m.index + 1];
    return { x: a.x + (b.x - a.x) * m.com, y: a.y + (b.y - a.y) * m.com, z: a.z + (b.z - a.z) * m.com };
  };
  const planar = (p) => Math.hypot(p.x, p.y) * (Math.cos(Math.atan2(p.y, p.x) - fk.yaw) >= 0 ? 1 : -1);
  const torques = chain.map(() => 0);
  const inertia = chain.map(() => 0);
  let baseMoment = 0, yawInertia = 0;
  for (const m of masses) {
    const p = posOf(m);
    const kg = m.mass_g / 1000;
    const rp = planar(p);
    baseMoment += kg * G * Math.abs(rp) / 1000;
    yawInertia += kg * (rp / 1000) ** 2;
    chain.forEach((j, i) => {
      if (j.type !== 'pitch' && j.type !== 'gripper') return;
      // mass outboard of joint i? joint i sits at points[i]
      const outboard = m.at === 'tip' || (m.at === 'joint' ? m.index > i : m.index >= i);
      if (!outboard) return;
      const jp = fk.points[i];
      const dx = rp - planar(jp);
      const dz = p.z - jp.z;
      torques[i] += kg * G * Math.abs(dx) / 1000;
      inertia[i] += kg * ((dx * dx + dz * dz) / 1e6);
    });
  }
  chain.forEach((j, i) => { if (j.type === 'yaw') inertia[i] = yawInertia; });
  return { torques, inertia, baseMoment, fk };
}

/**
 * armAnalysis(arm, { actuators }) with
 *   arm.joints: [{ id, part, type, link_mm, link_mass_g, com?, range?: [min,max] deg, bearing?: bool }]
 *   arm.payload_g, arm.accel_rad_s2 (default 3), arm.safety_factor (default 2), arm.supply_v
 *   arm.gripper?: { jaw_mm, friction } ; arm.targets?: [{ name, x, y, z }]
 *   actuators: map joint id -> { mass_g, stall_nm, continuous, deadband_deg, name, confidence }
 * Sweeps the joint ranges and reports the worst static + dynamic torque per joint.
 */
export function armAnalysis(arm, { actuators = {} } = {}) {
  const chain = (arm.joints || []).map((j) => ({ ...j, type: j.type || 'pitch', link_mm: Number(j.link_mm) || 0 }));
  if (!chain.length) throw new Error('arm: joints is empty');
  const sf = isNum(arm.safety_factor) ? arm.safety_factor : 2;
  const alpha = isNum(arm.accel_rad_s2) ? arm.accel_rad_s2 : 3;
  const payload = isNum(arm.payload_g) ? arm.payload_g : 0;
  // masses
  const masses = [];
  chain.forEach((j, i) => {
    if (j.link_mass_g) masses.push({ at: 'link', index: i, com: isNum(j.com) ? j.com : 0.5, mass_g: j.link_mass_g });
    // actuator of joint i sits at points[i] (start of its link); joint 0 actuator is at the base
    const act = actuators[j.id];
    if (act && act.mass_g && i > 0) masses.push({ at: 'joint', index: i, mass_g: act.mass_g });
    if (j.extra_mass_g) masses.push({ at: 'joint', index: i + 1, mass_g: j.extra_mass_g });
  });
  if (payload) masses.push({ at: 'tip', mass_g: payload });

  // sweep the joint ranges (pitch joints only; yaw does not change gravity)
  const ranges = chain.map((j) => (Array.isArray(j.range) && j.range.length === 2 ? j.range : j.type === 'yaw' ? [-90, 90] : j.type === 'gripper' ? [0, 0] : [-90, 90]));
  const pitchIdx = chain.map((j, i) => (j.type === 'pitch' ? i : -1)).filter((i) => i >= 0);
  const steps = pitchIdx.length > 3 ? 9 : pitchIdx.length === 3 ? 19 : 37;
  const worst = chain.map(() => ({ torque: 0, inertia: 0, pose: null }));
  let worstBase = 0, maxReach = 0, minZ = Infinity, maxZ = -Infinity, samples = 0;
  const pose = chain.map((j, i) => (j.type === 'gripper' ? 0 : (ranges[i][0] + ranges[i][1]) / 2));
  const rec = (k) => {
    if (k === pitchIdx.length) {
      samples++;
      const L = poseLoads(chain, pose, masses);
      L.torques.forEach((t, i) => { if (t > worst[i].torque) worst[i] = { torque: t, inertia: worst[i].inertia, pose: [...pose] }; });
      L.inertia.forEach((I, i) => { if (I > worst[i].inertia) worst[i].inertia = I; });
      worstBase = Math.max(worstBase, L.baseMoment);
      maxReach = Math.max(maxReach, L.fk.reach);
      minZ = Math.min(minZ, L.fk.z); maxZ = Math.max(maxZ, L.fk.z);
      return;
    }
    const i = pitchIdx[k];
    const [lo, hi] = ranges[i];
    for (let s = 0; s < steps; s++) { pose[i] = lo + ((hi - lo) * s) / (steps - 1); rec(k + 1); }
  };
  rec(0);

  const joints = chain.map((j, i) => {
    const act = actuators[j.id] || {};
    const stat = worst[i].torque;
    const dyn = worst[i].inertia * alpha;
    const load = j.type === 'gripper' ? 0 : stat + dyn;
    const stall = isNum(act.stall_nm) ? act.stall_nm : null;
    const margin = stall && load > 0 ? stall / load : null;
    return {
      id: j.id, type: j.type, part: j.part, actuator: act.name || null,
      static_nm: r3(stat), dynamic_nm: r3(dyn), load_nm: r3(load), load_kgcm: r2(nmToKgcm(load)),
      stall_nm: stall !== null ? r3(stall) : null, stall_kgcm: stall !== null ? r2(nmToKgcm(stall)) : null,
      margin: margin !== null ? r2(margin) : null, margin_exact: margin, worst_pose: worst[i].pose ? worst[i].pose.map(r1) : null,
      continuous: Boolean(act.continuous), confidence: act.confidence || null,
    };
  });

  // tip accuracy from actuator deadband at full reach
  let tipErr = 0;
  const stretched = chain.map(() => 0);
  const fkS = forwardKinematics(chain, stretched);
  chain.forEach((j, i) => {
    if (j.type !== 'pitch' && j.type !== 'yaw') return;
    const db = actuators[j.id]?.deadband_deg;
    if (!isNum(db)) return;
    const jp = fkS.points[i];
    const lever = j.type === 'yaw' ? fkS.reach : Math.hypot(fkS.tip.x - jp.x, fkS.tip.y - jp.y, fkS.tip.z - jp.z);
    tipErr += lever * rad(db);
  });

  // gripper force
  let grip = null;
  const gj = chain.find((j) => j.type === 'gripper');
  if (gj && arm.gripper && isNum(arm.gripper.jaw_mm) && actuators[gj.id]?.stall_nm) {
    const mu = isNum(arm.gripper.friction) ? arm.gripper.friction : 0.4;
    const force = (actuators[gj.id].stall_nm * 1000) / arm.gripper.jaw_mm; // N at the jaw (stall)
    const needN = (payload / 1000) * G / (2 * mu); // two friction faces
    grip = { force_n: r2(force), needed_n: r2(needN), friction: mu, margin: needN > 0 ? r2(force / needN) : null };
  }

  // targets
  const limits = ranges;
  const targets = (arm.targets || []).map((t) => {
    const yawJ = chain.findIndex((j) => j.type === 'yaw');
    let best = null;
    // seed from a few poses to avoid local minima
    const seeds = [0.25, 0.5, 0.75].map((f) => chain.map((j, i) => (j.type === 'gripper' ? 0 : limits[i][0] + f * (limits[i][1] - limits[i][0]))));
    if (yawJ >= 0) seeds.forEach((s) => { s[yawJ] = Math.max(limits[yawJ][0], Math.min(limits[yawJ][1], deg(Math.atan2(t.y || 0, t.x || 0)))); });
    for (const s of seeds) {
      const res = inverseKinematics(chain, { x: t.x || 0, y: t.y || 0, z: t.z || 0 }, { start: s, limits });
      if (!best || res.error_mm < best.error_mm) best = res;
    }
    const w = best.ok ? manipulability(chain, best.angles) : 0;
    return { name: t.name || `(${t.x}, ${t.y}, ${t.z})`, ...best, manipulability: r3(w) };
  });

  // yaw / base moment
  const yaw = chain.find((j) => j.type === 'yaw');
  return {
    sf, alpha, payload_g: payload, samples,
    joints, base_moment_nm: r3(worstBase), yaw_bearing: yaw ? Boolean(yaw.bearing) : null,
    reach_mm: r1(maxReach), z_range_mm: [r1(minZ), r1(maxZ)],
    tip_error_mm: r2(tipErr), grip, targets,
    total_mass_g: r1(masses.reduce((s, m) => s + m.mass_g, 0)),
  };
}

// ---------------------------------------------------------------------------
// Multirotor and rover

/**
 * drone({ auw_g, motors, thrust_g (max per motor), current_a (max per motor), frame_mm (motor-to-motor diagonal),
 *         prop_in, battery: { cells, mah, c }, esc_a, layout: 'x'|'plus'|'hex' })
 */
export function drone(d = {}) {
  const n = need('motors', d.motors ?? 4, { gt: 0 });
  const auw = need('auw_g', d.auw_g, { gt: 0 });
  const T = need('thrust_g', d.thrust_g, { gt: 0 });
  const twr = (n * T) / auw;
  const hoverPer = auw / n;
  const hoverThrottle = hoverPer / T;
  const out = { label: CALC, twr: r2(twr), hover_thrust_g: r1(hoverPer), hover_throttle: r2(hoverThrottle), problems: [], steps: [`TWR = ${n} × ${T} g / ${auw} g = ${r2(twr)}`] };
  if (twr < 1.5) out.problems.push({ level: 'error', text: `Thrust-to-weight ${r2(twr)}:1 is too low to fly with control authority (need ≥ 2:1, 3:1+ for agile flight). Lighter build, bigger props/motors or more cells.` });
  else if (twr < 2) out.problems.push({ level: 'warning', text: `Thrust-to-weight ${r2(twr)}:1 is marginal: it hovers near ${Math.round(hoverThrottle * 100)} % throttle with little left to correct gusts. Aim for ≥ 2:1.` });
  if (isNum(d.current_a)) {
    // momentum theory: power ∝ thrust^1.5, so current ≈ Imax (T/Tmax)^1.5 at fixed voltage
    const iHover = d.current_a * Math.pow(hoverThrottle, 1.5);
    out.hover_current_a = r2(iHover * n);
    out.max_current_a = r2(d.current_a * n);
    out.steps.push(`hover current ≈ ${n} × ${d.current_a} A × (${r2(hoverThrottle)})^1.5 = ${r2(iHover * n)} A (momentum theory)`);
    if (d.battery && isNum(d.battery.mah)) {
      const ah = d.battery.mah / 1000;
      out.flight_min = r1(((ah * 0.8) / (iHover * n)) * 60);
      out.steps.push(`flight ≈ 0.8 × ${ah} Ah / ${r2(iHover * n)} A × 60 = ${out.flight_min} min (hover, 80 % usable)`);
      if (isNum(d.battery.c)) {
        const cmax = d.battery.c * ah;
        out.battery_max_a = r1(cmax);
        if (d.current_a * n > cmax) out.problems.push({ level: 'error', text: `At full throttle the motors draw ${r1(d.current_a * n)} A but the ${d.battery.mah} mAh ${d.battery.c}C pack is rated for ${r1(cmax)} A: it sags, heats and can swell. Higher C rating or bigger pack.` });
      }
    }
    if (isNum(d.esc_a) && d.esc_a < d.current_a * 1.2) out.problems.push({ level: d.esc_a < d.current_a ? 'error' : 'warning', text: `ESC rated ${d.esc_a} A per motor vs ${d.current_a} A peak motor current: keep ≥ 20 % headroom (≥ ${r1(d.current_a * 1.2)} A).` });
  }
  if (isNum(d.frame_mm) && isNum(d.prop_in)) {
    const propMm = d.prop_in * 25.4;
    const layout = d.layout || (n === 6 ? 'hex' : 'x');
    const adj = layout === 'hex' ? d.frame_mm / 2 : layout === 'plus' || layout === 'x' ? d.frame_mm / Math.SQRT2 : d.frame_mm * Math.sin(Math.PI / n);
    out.prop_gap_mm = r1(adj - propMm);
    out.steps.push(`adjacent motors ${r1(adj)} mm apart, props ${r1(propMm)} mm → tip gap ${r1(adj - propMm)} mm`);
    if (adj - propMm < 0) out.problems.push({ level: 'error', text: `${d.prop_in}" props overlap on a ${d.frame_mm} mm frame (tip gap ${r1(adj - propMm)} mm). Smaller props or a bigger frame.` });
    else if (adj - propMm < 5) out.problems.push({ level: 'warning', text: `Only ${r1(adj - propMm)} mm between prop tips: arms flex and props can touch. Keep ≥ 5 mm.` });
  }
  return out;
}

/**
 * rover({ mass_g, wheel_d_mm, driven_wheels, wheels, slope_deg (10), crr (0.03), accel_m_s2 (0.5), friction (0.6),
 *         stall_nm (per motor, at the wheel), no_load_rpm (at the wheel), sf })
 */
export function rover(v = {}) {
  const m = need('mass_g', v.mass_g, { gt: 0 }) / 1000;
  const r = need('wheel_d_mm', v.wheel_d_mm, { gt: 0 }) / 2000;
  const nd = need('driven_wheels', v.driven_wheels ?? 2, { gt: 0 });
  const nw = isNum(v.wheels) ? v.wheels : nd;
  const th = rad(isNum(v.slope_deg) ? v.slope_deg : 10);
  const crr = isNum(v.crr) ? v.crr : 0.03;
  const a = isNum(v.accel_m_s2) ? v.accel_m_s2 : 0.5;
  const mu = isNum(v.friction) ? v.friction : 0.6;
  const sf = isNum(v.sf) ? v.sf : 2;
  const F = m * G * (Math.sin(th) + crr * Math.cos(th)) + m * a;
  const perWheel = (F * r) / nd;
  const out = { label: CALC, force_n: r2(F), torque_per_wheel_nm: r3(perWheel), torque_per_wheel_kgcm: r2(nmToKgcm(perWheel)), problems: [], steps: [`F = m g (sin θ + Crr cos θ) + m a = ${r2(F)} N`, `τ per driven wheel = F × r / ${nd} = ${r3(perWheel)} N·m`] };
  const traction = mu * m * G * Math.cos(th) * (nd / nw);
  out.traction_n = r2(traction);
  if (F > traction) out.problems.push({ level: 'warning', text: `Driven wheels can only push ${r2(traction)} N before slipping (μ ${mu}); the slope/acceleration needs ${r2(F)} N. Drive more wheels or reduce the slope.` });
  if (isNum(v.stall_nm)) {
    const margin = v.stall_nm / perWheel;
    out.margin = r2(margin);
    if (margin < 1) out.problems.push({ level: 'error', text: `Motors stall: ${r3(v.stall_nm)} N·m available per wheel, ${r3(perWheel)} N·m needed on a ${r1(deg(th))}° slope. Higher gear ratio, smaller wheels or stronger motors.` });
    else if (margin < sf) out.problems.push({ level: 'warning', text: `Torque margin ${r2(margin)}× (want ≥ ${sf}×): motors run near stall, get hot and draw stall current from the driver.` });
  }
  if (isNum(v.no_load_rpm)) out.top_speed_m_s = r2((v.no_load_rpm * 2 * Math.PI * r) / 60 * 0.8);
  return out;
}


// ---------------------------------------------------------------------------
// Stability and centre of mass

/**
 * armTipping({ moment_gmm, arm_mass_g, base: { mass_g, footprint_mm, clamped } })
 * Tipping about the base edge at radius R: the arm tips the base when
 * Σ m·r (arm, worst pose) > (m_base + m_arm)·R. Ratio = restoring / overturning.
 */
export function armTipping({ moment_gmm, arm_mass_g, base = {} } = {}) {
  const R = need('base.footprint_mm', base.footprint_mm, { gt: 0 });
  const mb = need('base.mass_g', base.mass_g, { min: 0 });
  const over = need('moment_gmm', moment_gmm, { min: 0 });
  const restore = (mb + (arm_mass_g || 0)) * R;
  const ratio = over > 0 ? restore / over : Infinity;
  return {
    label: CALC, ratio: r2(ratio), restoring_gmm: r1(restore), overturning_gmm: r1(over),
    counterweight_g: ratio < 1.5 ? r1(Math.max(0, (1.5 * over) / R - mb - (arm_mass_g || 0))) : 0,
    formula: 'tips when Σ m·r (arm at worst pose) > (m_base + m_arm) × R',
    steps: [`restoring (${mb} + ${r1(arm_mass_g || 0)}) g × ${R} mm = ${r1(restore)} g·mm`, `overturning Σ m·r = ${r1(over)} g·mm → ratio ${r2(ratio)}`],
  };
}

/**
 * vehicleTipping({ cg_height_mm, track_mm, slope_deg, friction })
 * Static rollover slope θ = atan((t/2)/h); lateral limit a = g·(t/2)/h (rigid body, no suspension roll).
 * If a_tip < μ·g the vehicle rolls over before its tyres slide.
 */
export function vehicleTipping({ cg_height_mm, track_mm, slope_deg, friction = 0.8 } = {}) {
  const h = need('cg_height_mm', cg_height_mm, { gt: 0 });
  const t = need('track_mm', track_mm, { gt: 0 });
  const ratio = t / 2 / h;
  const angle = deg(Math.atan(ratio));
  const aTip = G * ratio;
  return {
    label: CALC, tip_angle_deg: r1(angle), lateral_g: r2(ratio), lateral_m_s2: r2(aTip),
    rolls_before_sliding: ratio < friction, slope_margin_deg: isNum(slope_deg) ? r1(angle - slope_deg) : null,
    formula: 'static stability factor SSF = t / (2h); tip angle = atan(SSF); rolls before sliding when SSF < μ',
    steps: [`SSF = ${t} / (2 × ${h}) = ${r2(ratio)}`, `tip angle = atan(${r2(ratio)}) = ${r1(angle)}°`],
  };
}

/** Mass of a project part: part.mass_g, part.mechanical.mass_g, library mechanical.mass_g, library mass_g. */
export function partMass(part, library) {
  if (!part) return null;
  const lib = part.library ? library?.[part.library] : null;
  const v = part.mass_g ?? part.mechanical?.mass_g ?? lib?.mechanical?.mass_g ?? lib?.mass_g;
  return isNum(v) ? v * (isNum(part.qty) && part.qty > 1 ? part.qty : 1) : null;
}

/**
 * centreOfMass(items) with items [{ id, mass_g, position: [x, y, z] }] (viewer frame, Y up).
 * Returns { mass_g, cg: [x, y, z], counted, missing }.
 */
export function centreOfMass(items) {
  let m = 0; const c = [0, 0, 0]; const counted = []; const missing = [];
  for (const it of items) {
    if (!isNum(it.mass_g) || !Array.isArray(it.position)) { missing.push(it.id); continue; }
    m += it.mass_g;
    for (let k = 0; k < 3; k++) c[k] += it.mass_g * (Number(it.position[k]) || 0);
    counted.push(it.id);
  }
  return { mass_g: r1(m), cg: m > 0 ? c.map((v) => r1(v / m)) : null, counted, missing };
}

/**
 * droneBalance({ cg: [x, z], motors: [[x, z], ...], auw_g, thrust_g })
 * Least-norm thrust split for n symmetric rotors: T_i = W/n + W (d·r_i) / (n a²/2),
 * so the worst motor carries W/n × (1 + 2 d / a), with d the CG offset from the motor centroid and a the arm radius.
 */
export function droneBalance({ cg, motors, auw_g, thrust_g } = {}) {
  if (!Array.isArray(motors) || motors.length < 3) throw new Error('drone balance needs 3 or more motor positions');
  const n = motors.length;
  const cx = motors.reduce((s, m) => s + m[0], 0) / n, cz = motors.reduce((s, m) => s + m[1], 0) / n;
  const a = motors.reduce((s, m) => s + Math.hypot(m[0] - cx, m[1] - cz), 0) / n;
  const d = Math.hypot(cg[0] - cx, cg[1] - cz);
  const W = need('auw_g', auw_g, { gt: 0 });
  const per = W / n;
  const imbalance = a > 0 ? (2 * d) / a : 0;
  const worst = per * (1 + imbalance);
  return {
    label: CALC, offset_mm: r1(d), arm_mm: r1(a), imbalance: r3(imbalance), worst_motor_g: r1(worst),
    worst_throttle: isNum(thrust_g) ? r2(worst / thrust_g) : null,
    formula: 'worst motor = W/n × (1 + 2d/a) (least-norm thrust split, symmetric frame)',
    steps: [`CG ${r1(d)} mm from the motor centre, arm ${r1(a)} mm → ${r1(imbalance * 100)} % extra on the worst motor`],
  };
}

// ---------------------------------------------------------------------------
// RC car (Ackermann steering, drive)

/**
 * rcCar(rc, { servoStallNm, servoSpeed })
 * Standstill steering torque per wheel: a uniformly loaded circular contact patch of
 * diameter B pivots with T = (2/3) μ F (B/2) = μ F B / 3, plus μ F e for a scrub radius e
 * (upper bound; a rolling car needs far less). Servo torque = 2 T × horn / steering arm.
 * Turning radius (bicycle model, rear axle): R = L / tan δ. Top speed = Kv × V × η / gear × π d.
 */
export function rcCar(rc = {}, { servoStallNm, servoSpeed } = {}) {
  const m = need('mass_g', rc.mass_g, { gt: 0 }) / 1000;
  const L = need('wheelbase_mm', rc.wheelbase_mm, { gt: 0 });
  const st = rc.steering || {};
  const front = isNum(rc.front_fraction) ? rc.front_fraction : 0.5;
  const mu = isNum(st.friction) ? st.friction : 0.9;
  const B = isNum(st.tire_width_mm) ? st.tire_width_mm : 25;
  const e = isNum(st.scrub_mm) ? st.scrub_mm : 0;
  const Fw = (m * G * front) / 2;
  const Twheel = mu * Fw * ((B / 3) + e) / 1000; // N·m
  const horn = isNum(st.horn_mm) ? st.horn_mm : 15;
  const arm = isNum(st.arm_mm) ? st.arm_mm : 15;
  const Tservo = (2 * Twheel * horn) / arm;
  const out = { label: CALC, problems: [], steps: [], wheel_load_n: r2(Fw), steer_torque_wheel_nm: r3(Twheel), servo_needed_nm: r3(Tservo), servo_needed_kgcm: r2(nmToKgcm(Tservo)) };
  out.steps.push(`front wheel load = ${r1(m * 1000)} g × ${front} / 2 × g = ${r2(Fw)} N`);
  out.steps.push(`standstill pivot torque = μ F (B/3 + e) = ${mu} × ${r2(Fw)} × (${B}/3 + ${e}) mm = ${r3(Twheel)} N·m per wheel`);
  out.steps.push(`servo torque = 2 × ${r3(Twheel)} × ${horn}/${arm} = ${r3(Tservo)} N·m`);
  const sf = isNum(rc.safety_factor) ? rc.safety_factor : 1.5;
  if (isNum(servoStallNm)) {
    const margin = servoStallNm / Tservo;
    out.servo_stall_nm = r3(servoStallNm); out.steer_margin = r2(margin); out.steer_margin_exact = margin;
    if (margin < 1) out.problems.push({ level: 'error', rule: 'mech-steering', text: `Steering needs ${r2(nmToKgcm(Tservo))} kg·cm at standstill but the servo gives ${r2(nmToKgcm(servoStallNm))} kg·cm: it cannot turn the wheels when parked or slow.` });
    else if (margin < sf) out.problems.push({ level: 'warning', rule: 'mech-steering', text: `Steering servo margin ${(Math.floor(margin * 100) / 100).toFixed(2)}× (want ≥ ${sf}×): it strains and buzzes at full lock.` });
  }
  const dmax = isNum(st.max_steer_deg) ? st.max_steer_deg : 30;
  out.turn_radius_mm = r1(L / Math.tan(rad(dmax)));
  out.steps.push(`turning radius = ${L} / tan ${dmax}° = ${r1(L / Math.tan(rad(dmax)))} mm`);
  if (isNum(servoSpeed)) {
    const servoDeg = dmax * (arm / horn);
    const t = (2 * servoDeg / 60) * servoSpeed;
    out.lock_to_lock_s = r2(t);
    if (t > 0.35) out.problems.push({ level: 'info', rule: 'mech-steering', text: `Lock to lock takes about ${r2(t)} s: slow for an autopilot correcting at speed. Shorter horn or a faster servo.` });
  }
  const dr = rc.drive || {};
  const d = isNum(rc.wheel_d_mm) ? rc.wheel_d_mm : null;
  let rpm = null;
  if (isNum(dr.kv) && isNum(dr.cells)) rpm = dr.kv * dr.cells * 3.7 * 0.8;
  else if (isNum(dr.rpm)) rpm = dr.rpm * 0.8;
  if (rpm && d) {
    const ratio = isNum(dr.gear_ratio) ? dr.gear_ratio : 1;
    const v = (rpm / ratio) * Math.PI * (d / 1000) / 60;
    out.top_speed_m_s = r2(v);
    out.steps.push(`top speed ≈ ${r1(rpm)} rpm (80 % of no-load) / ${ratio} × π × ${d} mm = ${r2(v)} m/s`);
    if (isNum(rc.top_speed_m_s) && v < rc.top_speed_m_s) out.problems.push({ level: 'warning', rule: 'mech-rc-drive', text: `Gearing gives about ${r2(v)} m/s, below the ${rc.top_speed_m_s} m/s target. Lower gear ratio, bigger wheels, more cells or a higher Kv motor.` });
    if (isNum(rc.track_mm) && isNum(rc.cg_height_mm)) {
      const a = (v * v) / (out.turn_radius_mm / 1000);
      const aTip = G * (rc.track_mm / 2) / rc.cg_height_mm;
      out.full_lock_lateral_m_s2 = r2(a);
      if (a > aTip && aTip < mu * G) out.problems.push({ level: 'warning', rule: 'mech-tipping', text: `A full-lock turn at top speed asks ${r2(a)} m/s² sideways; the car rolls over above ${r2(aTip)} m/s². Limit steering at speed in the autopilot.` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Project-level mechanical check

/** Merge a library part's mechanical block with project overrides. */
function partMechanical(project, library, partId) {
  const p = (project.parts || []).find((x) => x.id === partId);
  if (!p) return null;
  const lib = p.library ? library?.[p.library] : null;
  const mech = { ...(lib?.mechanical || {}), ...(p.mechanical || {}) };
  return { part: p, lib, mech, name: p.name || lib?.name || partId };
}

function printerProfile(project, printers) {
  const id = project.printer?.profile;
  if (!id || !printers) return null;
  if (Array.isArray(printers)) return printers.find((p) => p.id === id) || null;
  return printers[id] || null;
}

/**
 * checkMechanics(project, library, { printers }) → { issues, report }
 * issues use the same shape as the electrical checker (rule, level, message, fix, parts).
 * Reads project.mechanics (arm, fits, stackups, bolts, beams, gears, drone, rover) and project.prints.
 */
export function checkMechanics(project, library = {}, { printers, meshes } = {}) {
  const issues = [];
  const add = (rule, level, message, fix, parts = []) => issues.push({ rule, level, message, fix, parts });
  const mech = project?.mechanics || {};
  const report = {};
  const profile = printerProfile(project || {}, printers);
  const nozzle = profile?.nozzle_diameter || 0.4;
  const defMat = mech.material || project?.printer?.material || 'PLA';
  const sfDefault = isNum(mech.safety_factor) ? mech.safety_factor : 2;
  const safe = (label, fn) => { try { return fn(); } catch (e) { add('mech-input', 'warning', `${label}: ${e.message}`, 'Fix the mechanics entry in the project file.'); return null; } };

  // ---------------------------------------------------------------- arm
  if (mech.arm) {
    const arm = mech.arm;
    const actuators = {};
    for (const j of arm.joints || []) {
      if (!j.part) continue;
      const info = partMechanical(project, library, j.part);
      if (!info) { add('mech-input', 'error', `Arm joint "${j.id}" uses part "${j.part}", which is not in the project.`, 'Use a part id from the parts list.'); continue; }
      const stall = actuatorTorque(info.mech, arm.supply_v);
      actuators[j.id] = {
        name: info.name, mass_g: info.mech.mass_g, stall_nm: isNum(info.mech.stall_nm) ? info.mech.stall_nm : stall,
        continuous: info.mech.kind === 'continuous', deadband_deg: info.mech.deadband_deg, confidence: info.mech.confidence,
      };
      if (actuators[j.id].stall_nm === null || actuators[j.id].stall_nm === undefined) add('mech-data', 'warning', `${info.name} has no torque data, so joint "${j.id}" cannot be checked.`, 'Add mechanical.torque [{ v, stall_nm }] to the part from its datasheet.', [j.part]);
    }
    // default joint ranges from the motion preview
    const previewJoints = project.preview?.joints || [];
    const joints = (arm.joints || []).map((j) => {
      if (j.range) return j;
      const pj = previewJoints.find((p) => p.part === j.part);
      return pj ? { ...j, range: [pj.min, pj.max] } : j;
    });
    const A = safe('Arm', () => armAnalysis({ ...arm, joints, safety_factor: arm.safety_factor ?? sfDefault }, { actuators }));
    if (A) {
      report.arm = A;
      for (const j of A.joints) {
        const act = actuators[j.id];
        if (act?.continuous && (j.type === 'pitch' || j.type === 'yaw')) {
          add('mech-continuous-servo', 'error', `${act.name} on joint "${j.id}" is a continuous-rotation servo: it cannot hold an angle, so the arm drops or drifts.`, 'Use a positional servo (SG90, MG90S, MG996R) or a motor with an encoder.', [j.part]);
        }
        if (j.margin === null || j.type === 'gripper') continue;
        const what = `${cap(j.id)} needs ${j.load_kgcm} kg·cm (${j.static_nm} N·m holding + ${j.dynamic_nm} N·m to accelerate at ${A.alpha} rad/s²) at its worst pose; ${act?.name || 'the actuator'} gives ${j.stall_kgcm} kg·cm at stall`;
        const mx = isNum(j.margin_exact) ? j.margin_exact : j.margin;
        if (mx < 1) add('mech-joint-torque', 'error', `${what}. It stalls: the joint cannot lift the arm.`, 'Shorten the links, move heavy parts (servos, gripper) toward the base, add a counterweight or spring, or use a stronger actuator or gearing.', [j.part]);
        else if (mx < A.sf) add('mech-joint-torque', 'warning', `${what} (margin ${(Math.floor(mx * 100) / 100).toFixed(2)}×, want ≥ ${A.sf}×). It will run hot, jitter and wear its gears.`, 'Lighter links or payload, counterbalance, or a stronger servo.', [j.part]);
      }
      const yawJ = (arm.joints || []).find((j) => j.type === 'yaw');
      if (yawJ && !yawJ.bearing && A.base_moment_nm > 0.02) {
        add('mech-yaw-bearing', 'warning', `The base joint carries a ${A.base_moment_nm} N·m tipping moment from the arm. A hobby servo's output shaft is not built for side load: it wobbles and strips.`, 'Support the turntable on a bearing (lazy-susan, 6800-series or a printed thrust race) so the servo spline only provides rotation. Set "bearing": true on the joint when done.', [yawJ.part]);
      }
      if (A.grip && A.grip.margin !== null && A.grip.margin < 1.5) add('mech-grip', A.grip.margin < 1 ? 'error' : 'warning', `Gripper squeezes ${A.grip.force_n} N at stall but needs ${A.grip.needed_n} N to hold ${A.payload_g} g with friction ${A.grip.friction}.`, 'Shorter jaws, rubber pads (higher friction) or a stronger gripper servo.', []);
      for (const t of A.targets) {
        if (!t.ok) add('mech-reach', 'error', `Target "${t.name}" is out of reach (closest ${t.error_mm} mm away within the joint limits).`, 'Move the target, lengthen links or widen joint ranges.');
        else if (t.manipulability < 0.05) add('mech-singularity', 'warning', `Target "${t.name}" is reached with the arm almost stretched straight or folded (manipulability ${t.manipulability}): tiny servo errors give big tip errors there.`, 'Place the work closer so the elbow stays bent.');
      }
      const base = arm.base;
      if (base && !base.clamped && isNum(base.footprint_mm) && isNum(base.mass_g)) {
        const T = safe('Arm base', () => armTipping({ moment_gmm: (A.base_moment_nm / G) * 1e6, arm_mass_g: A.total_mass_g, base }));
        if (T) {
          A.tipping = T;
          if (T.ratio < 1) add('mech-tipping', 'error', `The arm tips its base over at full reach: ${T.overturning_gmm} g·mm of arm moment against ${T.restoring_gmm} g·mm from the base (${base.mass_g} g at ${base.footprint_mm} mm).`, `Clamp or screw the base down, widen the footprint, or add about ${T.counterweight_g} g of ballast in the base.`);
          else if (T.ratio < 1.5) add('mech-tipping', 'warning', `Base stability ratio ${T.ratio} (want ≥ 1.5): a fast move or a heavier object can tip it.`, `Add about ${T.counterweight_g} g of ballast, widen the feet or clamp the base.`);
        }
      } else if (!base) add('mech-tipping', 'info', 'Arm base mass and footprint are not set, so tipping is not checked.', 'Add mechanics.arm.base { mass_g, footprint_mm } or { clamped: true }.');
      if (A.tip_error_mm > 3) add('mech-accuracy', 'info', `Servo deadband alone gives about ±${A.tip_error_mm} mm at the gripper at full reach.`, 'Expect this repeatability; shorter links or better servos improve it.');
    }
  }

  // --------------------------------------------------------------- fits
  report.fits = [];
  for (const f of mech.fits || []) {
    const id = f.id || `fit ${report.fits.length + 1}`;
    if (f.iso) {
      const R = safe(`Fit ${id}`, () => isoFit({ nominal: f.nominal, fit: f.iso }));
      if (!R) continue;
      const it = Math.min(R.hole.grade, R.shaft.grade);
      const proc = f.process || 'machined';
      const pit = PROCESS_IT[proc] ?? 7;
      const row = { id, kind: 'iso', fit: R.fit, nominal: R.nominal, type: R.type, clearance: R.clearance, hole: R.hole, shaft: R.shaft, process: proc };
      report.fits.push(row);
      if (pit > it) add('mech-fit-process', 'warning', `${cap(id)}: ${R.fit} needs IT${it} (±${itTolerance(it, R.nominal) / 2000} mm) but ${proc} typically holds about IT${pit} (±${r3(itTolerance(Math.min(pit, 14), R.nominal) / 2000)} mm).`, proc === 'fdm' ? 'Print the hole undersize and ream/drill it, or design with printed clearances (calc fit) instead of ISO grades.' : 'Choose a looser grade or a more precise process.', f.parts || []);
      if (f.want && f.want !== R.type) add('mech-fit-type', 'error', `${cap(id)}: ${R.fit} is a ${R.type} fit at Ø${R.nominal} (clearance ${R.clearance.min} to ${R.clearance.max} mm), but a ${f.want} fit is wanted.`, f.want === 'clearance' ? 'Use H7/g6 (sliding) or H7/h6 (locating).' : f.want === 'interference' ? 'Use H7/p6 (press) or H7/s6 (shrink).' : 'Use H7/k6 or H7/n6.', f.parts || []);
    } else {
      const R = safe(`Fit ${id}`, () => printFit({ nominal: f.nominal, fit: f.fit || 'sliding', feature: f.feature || 'hole', profile }));
      if (!R) continue;
      const row = { id, kind: 'printed', nominal: R.inputs.nominal, fit: R.inputs.fit, feature: R.inputs.feature, recommended: R.value, designed: f.designed ?? null, clearance_per_side: R.clearance_per_side, source: R.source };
      report.fits.push(row);
      if (isNum(f.designed)) {
        const diff = f.designed - R.value;
        const sign = R.inputs.feature === 'shaft' || R.inputs.feature === 'peg' ? -1 : 1;
        if (Math.abs(diff) > 0.05) {
          const tight = sign * diff < 0;
          add('mech-printed-fit', Math.abs(diff) > 0.2 ? 'error' : 'warning', `${cap(id)}: modelled ${R.inputs.feature} is ${f.designed} mm, the ${R.inputs.fit} fit for Ø${R.inputs.nominal} on ${profile?.name || 'this printer'} is ${R.value} mm (${tight ? 'too tight: it will not go in or will crack the part' : 'too loose: it will rattle'}).`, `Model it at ${R.value} mm, print the tolerance coupon, and store your measured clearances in the printer profile.`, f.parts || []);
        }
      }
      if (R.inputs.feature === 'hole' && R.inputs.nominal < 2 * nozzle) add('mech-printed-fit', 'warning', `${cap(id)}: a Ø${R.inputs.nominal} mm hole is close to the ${nozzle} mm nozzle size and will close up.`, 'Drill it after printing.', f.parts || []);
    }
  }

  // ------------------------------------------------------------ stack-ups
  report.stackups = [];
  for (const s of mech.stackups || []) {
    const R = safe(`Stack-up ${s.id}`, () => stackup(s));
    if (!R) continue;
    report.stackups.push({ id: s.id, ...R });
    if (!R.ok && !R.ok_rss) add('mech-stackup', 'error', `${cap(s.id)}: gap ranges ${R.worst.min} to ${R.worst.max} mm (statistically ${R.rss.min} to ${R.rss.max}); required ${isNum(s.min_gap) ? `≥ ${s.min_gap}` : ''}${isNum(s.max_gap) ? ` ≤ ${s.max_gap}` : ''} mm. Most builds will not assemble.`, 'Change a nominal size or tighten the largest tolerance in the chain.', s.parts || []);
    else if (!R.ok) add('mech-stackup', 'warning', `${cap(s.id)}: worst case gap ${R.worst.min} to ${R.worst.max} mm misses the requirement; statistically (RSS) it is fine.`, 'Accept a few rejects, or add adjustment (slots, shims).', s.parts || []);
  }

  // ---------------------------------------------------------------- bolts
  report.bolts = [];
  for (const b of mech.bolts || []) {
    const R = safe(`Bolts ${b.id}`, () => bolt({ ...b, plate_material: b.plate_material || defMat, sf: b.sf ?? sfDefault }));
    if (!R) continue;
    report.bolts.push({ id: b.id, ...R });
    if (R.margin < 1) add('mech-bolt', 'error', `${cap(b.id)}: ${R.per_bolt_n} N per ${b.size} but the ${R.limited_by} only takes ${R.capacity_n} N. It fails.`, 'More or bigger bolts, a thicker boss, or a metal plate.', b.parts || []);
    else if (!R.ok) add('mech-bolt', 'warning', `${cap(b.id)}: margin ${R.margin}× on the ${R.limited_by} (want ≥ ${b.sf ?? sfDefault}×).`, R.limited_by === 'printed plate' ? 'Use washers, a larger boss or more bolts.' : 'Use a stronger class or a larger size.', b.parts || []);
  }

  // ---------------------------------------------------------------- beams
  report.beams = [];
  for (const bm0 of mech.beams || []) {
    const bm = { ...bm0 };
    if (bm.from_joint && !isNum(bm.moment_nmm) && !isNum(bm.tip_load_n)) {
      const j = report.arm?.joints.find((x) => x.id === bm.from_joint);
      if (j) bm.moment_nmm = j.load_nm * 1000;
      else { add('mech-input', 'warning', `Beam ${bm.id}: from_joint "${bm.from_joint}" is not an arm joint.`, 'Use a joint id from mechanics.arm.joints.'); continue; }
    }
    const R = safe(`Beam ${bm.id}`, () => beam({ ...bm, material: bm.material || defMat, sf: bm.sf ?? sfDefault }));
    if (!R) continue;
    report.beams.push({ id: bm.id, ...R });
    if (R.utilisation > (bm.sf ?? sfDefault)) add('mech-beam', 'error', `${cap(bm.id)}: bending stress ${R.stress_mpa} MPa is above the printed ${bm.material || defMat} strength. It breaks.`, 'Make it taller in the load direction (stress falls with height²), add walls or ribs, or print so layers run along the length.', bm.parts || []);
    else if (R.utilisation > 1) add('mech-beam', 'warning', `${cap(bm.id)}: bending stress ${R.stress_mpa} MPa is over the allowable ${R.allowable_mpa} MPa (SF ${bm.sf ?? sfDefault}).`, 'Taller section, more walls, or a stiffer material.', bm.parts || []);
    if (isNum(bm.max_deflection_mm) && R.deflection_mm > bm.max_deflection_mm) add('mech-deflection', 'warning', `${cap(bm.id)}: tip deflects about ${R.deflection_mm} mm (limit ${bm.max_deflection_mm} mm).`, 'Stiffness grows with height³: a taller section helps most.', bm.parts || []);
  }

  // ---------------------------------------------------------------- gears
  report.gears = [];
  for (const g of mech.gears || []) {
    const R = safe(`Gear ${g.id}`, () => gear({ ...g, material: g.material || defMat, nozzle, sf: g.sf ?? sfDefault }));
    if (!R) continue;
    report.gears.push({ id: g.id, ...R });
    for (const p of R.problems) add('mech-gear', p.level, `${cap(g.id)}: ${p.text}`, 'See the gear calculator output for sizes.', g.parts || []);
  }

  // ---------------------------------------------------------- drone, rover
  if (mech.drone) {
    const R = safe('Drone', () => drone(mech.drone));
    if (R) { report.drone = R; for (const p of R.problems) add('mech-drone', p.level, p.text, 'Re-run wiremap mech after changing the build.'); }
    const dr = mech.drone;
    const motorIds = Array.isArray(dr.motor_parts) ? dr.motor_parts : null;
    const motorPos = motorIds ? motorIds.map((id) => (project.parts || []).find((p) => p.id === id)?.position).filter(Array.isArray).map((p) => [p[0], p[2]])
      : Array.isArray(dr.motor_positions) ? dr.motor_positions : null;
    if (motorPos && motorPos.length >= 3) {
      const items = (project.parts || []).map((p) => ({ id: p.id, mass_g: partMass(p, library), position: p.position }));
      for (const pr of project.prints || []) if (isNum(pr.mass_g)) items.push({ id: pr.id, mass_g: pr.mass_g, position: pr.position });
      const C = centreOfMass(items);
      if (C.cg) {
        const B = safe('Drone balance', () => droneBalance({ cg: [C.cg[0], C.cg[2]], motors: motorPos, auw_g: dr.auw_g ?? C.mass_g, thrust_g: dr.thrust_g }));
        if (B) {
          report.drone = { ...(report.drone || {}), balance: B, cg: C.cg, cg_missing: C.missing };
          if (isNum(B.worst_throttle) && B.worst_throttle > 0.8) add('mech-cg', 'error', `The centre of mass sits ${B.offset_mm} mm off the motor centre, so one motor must hover at ${Math.round(B.worst_throttle * 100)} % throttle with nothing left to steer.`, 'Move the battery or heavy parts toward the frame centre until the CG is within 5 % of the arm length.');
          else if (B.imbalance > 0.1) add('mech-cg', 'warning', `The centre of mass sits ${B.offset_mm} mm off the motor centre: the nearest motor works ${Math.round(B.imbalance * 100)} % harder and the drone drifts.`, 'Shift the battery to bring the CG over the frame centre (use the battery strap position).');
          if (C.missing.length) add('mech-cg', 'info', `No mass for ${C.missing.slice(0, 6).join(', ')}${C.missing.length > 6 ? ' …' : ''}: the CG ignores them.`, 'Add mass_g to those parts.');
        }
      }
    }
  }
  if (mech.rc) {
    const rc = mech.rc;
    let stall = null, speed = null;
    if (rc.steering?.servo) {
      const info = partMechanical(project, library, rc.steering.servo);
      if (!info) add('mech-input', 'error', `RC steering servo "${rc.steering.servo}" is not in the project.`, 'Use a part id from the parts list.');
      else {
        stall = isNum(info.mech.stall_nm) ? info.mech.stall_nm : actuatorTorque(info.mech, rc.supply_v);
        speed = info.mech.speed_s_per_60 ?? null;
        if (info.mech.kind === 'continuous') add('mech-continuous-servo', 'error', `${info.name} is a continuous-rotation servo: it cannot hold a steering angle.`, 'Use a positional servo with enough torque.', [rc.steering.servo]);
      }
    }
    const R = safe('RC car', () => rcCar({ ...rc, safety_factor: rc.safety_factor ?? 1.5 }, { servoStallNm: stall, servoSpeed: speed }));
    if (R) {
      report.rc = R;
      for (const p of R.problems) add(p.rule, p.level, p.text, p.rule === 'mech-steering' ? 'Use a stronger servo, a shorter servo horn or a longer steering arm, or narrower tyres.' : 'Re-run wiremap check after changing the build.', rc.steering?.servo ? [rc.steering.servo] : []);
    }
    if (isNum(rc.cg_height_mm) && isNum(rc.track_mm)) {
      const T = safe('RC tipping', () => vehicleTipping({ cg_height_mm: rc.cg_height_mm, track_mm: rc.track_mm, friction: rc.steering?.friction ?? 0.9 }));
      if (T) {
        report.rc = { ...(report.rc || {}), tipping: T };
        if (T.rolls_before_sliding) add('mech-tipping', 'warning', `Static stability factor ${T.lateral_g}: the car rolls over before the tyres slide (tyre grip about ${rc.steering?.friction ?? 0.9} g).`, 'Lower the battery and electronics or widen the track.');
      }
    }
  }
  if (mech.rover) {
    const rv = { ...mech.rover };
    if (rv.motor && !isNum(rv.stall_nm)) {
      const info = partMechanical(project, library, rv.motor);
      const st = info ? (isNum(info.mech.stall_nm) ? info.mech.stall_nm : actuatorTorque(info.mech, rv.supply_v)) : null;
      if (isNum(st)) rv.stall_nm = st * (rv.gear_ratio || 1) * (rv.gear_efficiency ?? (rv.gear_ratio ? 0.85 : 1));
      if (info && isNum(info.mech.no_load_rpm) && !isNum(rv.no_load_rpm)) rv.no_load_rpm = info.mech.no_load_rpm / (rv.gear_ratio || 1);
    }
    const R = safe('Rover', () => rover({ ...rv, sf: rv.sf ?? sfDefault }));
    if (R) { report.rover = R; for (const p of R.problems) add('mech-rover', p.level, p.text, 'Re-run wiremap mech after changing the build.', rv.motor ? [rv.motor] : []); }
    if (R && isNum(rv.cg_height_mm) && isNum(rv.track_mm)) {
      const T = safe('Rover tipping', () => vehicleTipping({ cg_height_mm: rv.cg_height_mm, track_mm: rv.track_mm, slope_deg: rv.slope_deg ?? 10, friction: rv.friction ?? 0.6 }));
      if (T) {
        report.rover.tipping = T;
        const slope = rv.slope_deg ?? 10;
        if (T.tip_angle_deg <= slope) add('mech-tipping', 'error', `The rover tips sideways at ${T.tip_angle_deg}°, at or below the ${slope}° slope it must cross.`, 'Lower the CG (battery at the bottom) or widen the track.');
        else if (T.tip_angle_deg < slope + 15) add('mech-tipping', 'warning', `Side tip angle ${T.tip_angle_deg}° leaves only ${r1(T.tip_angle_deg - slope)}° over the ${slope}° slope.`, 'Lower the CG or widen the track.');
      }
    }
  }

  // ------------------------------------------------------------- assembly
  const asm = safe('Assembly', () => checkAssembly(project || {}, library));
  if (asm?.report) { report.assembly = asm.report; for (const p of asm.problems) add(p.rule, p.level, p.text, p.fix, p.parts); }
  if (meshes && Object.keys(meshes).length) {
    const dfm = safe('Print files', () => checkPrintsDFM(project || {}, meshes, { profile }));
    if (dfm) { report.dfm = dfm.report; for (const p of dfm.problems) add(p.rule, p.level, p.text, p.fix); }
  }

  // ---------------------------------------------------------------- prints
  for (const pr of project?.prints || []) {
    const minWall = pr.min_wall_mm ?? pr.settings?.min_wall_mm;
    if (isNum(minWall)) {
      if (minWall < nozzle) add('mech-wall', 'error', `${pr.name || pr.id}: ${minWall} mm walls are thinner than the ${nozzle} mm nozzle line. They will not print.`, `Make walls at least ${r2(2 * nozzle)} mm (two lines).`);
      else if (minWall < 2 * nozzle - 1e-9) add('mech-wall', 'warning', `${pr.name || pr.id}: ${minWall} mm walls are a single line: weak and leaky.`, `Use ≥ ${r2(2 * nozzle)} mm (two lines), ideally ${r2(3 * nozzle)} mm or more for load-bearing parts.`);
    }
    const mat = pr.material || defMat;
    if (pr.near_heat && MATERIALS[mat]?.hdt && MATERIALS[mat].hdt < 70) add('mech-heat', 'warning', `${pr.name || pr.id} is ${mat} next to a heat source; ${mat} softens near ${MATERIALS[mat].hdt} °C.`, 'Print it in PETG, ASA or PC, or add an air gap.');
  }

  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return { issues, report };
}

export const MECH_NOT_CHECKED = [
  'Suspension roll, tyre deflection and dynamic weight transfer (tipping uses a rigid-body static stability factor)',
  'Fatigue, creep and impact (PLA creeps under steady load; repeated loads break parts below their static strength)',
  'Printed strength varies with walls, infill, layer adhesion and moisture: every strength value is an estimate',
  'Vibration, resonance and control loop tuning (PID, flight controller)',
  'Friction, backlash and gear wear beyond the simple efficiency factors',
];
