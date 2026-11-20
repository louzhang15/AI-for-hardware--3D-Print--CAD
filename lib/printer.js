// Wiremap printer helpers: build-volume fit, split planning, material checks.
// Pure ES module, no Node built-ins (browser-safe).
//
// Printer volumes are [X, Y, Z] with Z = height (the printer's own axes).
// Part sizes are any three box dimensions [a, b, c]; every orientation is tried.

const EPS = 1e-9;

/**
 * Build volume for a nozzle choice. H2D-style profiles store
 * `nozzles: { left, right, both, total }`; others only `volume`.
 * nozzle: 'left' | 'right' | 'both' | 'total' | 'single' | undefined.
 * 'single' (or undefined) = the largest single-nozzle volume (profile.volume).
 */
export function nozzleVolume(profile, nozzle) {
  if (!profile || !Array.isArray(profile.volume)) throw new Error('nozzleVolume: profile with a volume [x, y, z] is required');
  if (!nozzle || nozzle === 'single' || !profile.nozzles) {
    if (nozzle && !['single', 'left', 'right'].includes(nozzle) && !profile.nozzles) {
      throw new Error(`nozzleVolume: ${profile.id || 'this printer'} has a single nozzle (no "${nozzle}" volume)`);
    }
    return [...profile.volume];
  }
  const v = profile.nozzles[nozzle];
  if (!v) throw new Error(`nozzleVolume: unknown nozzle "${nozzle}" for ${profile.id} (have: ${Object.keys(profile.nozzles).join(', ')}, single)`);
  return [...v];
}

/** Usable volume after the per-side margin on X and Y (Z keeps its full height). */
export function usableVolume(profile, { margin, nozzle } = {}) {
  const vol = nozzleVolume(profile, nozzle);
  const m = margin ?? profile.margin_mm ?? 5;
  if (!(m >= 0)) throw new Error('margin must be >= 0');
  return [vol[0] - 2 * m, vol[1] - 2 * m, vol[2]];
}

function checkSize(size) {
  if (!Array.isArray(size) || size.length !== 3 || size.some((x) => !(typeof x === 'number' && x > 0 && Number.isFinite(x)))) {
    throw new Error(`size must be [a, b, c] in mm, all > 0 (got ${JSON.stringify(size)})`);
  }
}

const PERMS = [[0, 1, 2], [1, 0, 2], [0, 2, 1], [2, 0, 1], [1, 2, 0], [2, 1, 0]];
const r2 = (x) => Math.round(x * 100) / 100;

/** Smallest rotation angle (deg) at which an a × b rectangle fits inside X × Y, or null. */
export function diagonalFit(a, b, X, Y, stepDeg = 0.25) {
  for (let deg = stepDeg; deg < 90; deg += stepDeg) {
    const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const w = a * c + b * s, h = a * s + b * c;
    if (w <= X + EPS && h <= Y + EPS) return Math.round(deg * 100) / 100;
  }
  return null;
}

/**
 * fitPart(size, profile, { margin, nozzle, allowDiagonal=true })
 * → { fits, orientation: [x, y, z] dims as placed on the bed (z up), axes: which
 *     input index lies along X/Y/Z, rotationDeg (about Z, 0 unless diagonal),
 *     usable: [X, Y, Z], spare: [x, y, z] mm left over, options: all fitting
 *     orientations, suggestion: text, split?: suggestSplit result when it does not fit,
 *     warnings: [], label: 'calculated' }
 * Preferred orientation: lowest height (largest face on the bed), then most spare room.
 */
export function fitPart(size, profile, { margin, nozzle, allowDiagonal = true, keepouts } = {}) {
  checkSize(size);
  const usable = usableVolume(profile, { margin, nozzle });
  const m = margin ?? profile.margin_mm ?? 5;
  const options = [];
  for (const p of PERMS) {
    const d = p.map((i) => size[i]);
    if (d[0] <= usable[0] + EPS && d[1] <= usable[1] + EPS && d[2] <= usable[2] + EPS) {
      options.push({ orientation: d, axes: p, rotationDeg: 0, spare: d.map((x, i) => r2(usable[i] - x)) });
    }
  }
  if (!options.length && allowDiagonal) {
    for (const p of PERMS) {
      const d = p.map((i) => size[i]);
      if (d[2] > usable[2] + EPS) continue;
      const deg = diagonalFit(d[0], d[1], usable[0], usable[1]);
      if (deg !== null) {
        const t = deg * Math.PI / 180;
        const w = d[0] * Math.cos(t) + d[1] * Math.sin(t), h = d[0] * Math.sin(t) + d[1] * Math.cos(t);
        options.push({ orientation: d, axes: p, rotationDeg: deg, spare: [r2(usable[0] - w), r2(usable[1] - h), r2(usable[2] - d[2])] });
      }
    }
  }
  // Dedupe identical placements (cubes etc.) and rank.
  const seen = new Set();
  const uniq = options.filter((o) => { const k = o.orientation.join('x') + '@' + o.rotationDeg; if (seen.has(k)) return false; seen.add(k); return true; });
  uniq.sort((a, b) => (a.rotationDeg === 0 ? 0 : 1) - (b.rotationDeg === 0 ? 0 : 1) || a.orientation[2] - b.orientation[2] || (b.spare[0] + b.spare[1]) - (a.spare[0] + a.spare[1]));
  const vol = nozzleVolume(profile, nozzle);
  const out = {
    fits: uniq.length > 0, size: [...size], printer: profile.id, nozzle: nozzle || (profile.nozzles ? 'single' : undefined),
    volume: vol, margin: m, usable, orientation: null, axes: null, rotationDeg: 0, spare: null,
    options: uniq, suggestion: '', warnings: [], label: 'calculated',
  };
  if (out.fits) {
    const best = uniq[0];
    Object.assign(out, { orientation: best.orientation, axes: best.axes, rotationDeg: best.rotationDeg, spare: best.spare });
    const [x, y, z] = best.orientation;
    out.suggestion = best.rotationDeg
      ? `Fits only on the diagonal: lay it ${x} × ${y} mm on the bed, ${z} mm tall, rotated ${best.rotationDeg}° about Z. Little room for a brim.`
      : `Fits: ${x} × ${y} mm on the bed, ${z} mm tall (${best.spare[0]} / ${best.spare[1]} / ${best.spare[2]} mm to spare in X / Y / Z).`;
    if (best.orientation[2] > 3 * Math.min(best.orientation[0], best.orientation[1]) && profile.enclosed === false) {
      out.warnings.push('Tall and thin on a bed-slinger: risk of wobble. Add a brim or print lying down if it fits.');
    }
    const ko = keepouts ?? profile.keepout;
    if (Array.isArray(ko)) {
      for (const k of ko) {
        if (!k.rect) continue;
        const [, , kw, kh] = k.rect;
        if (x > usable[0] + m - kw && y > usable[1] + m - kh) out.warnings.push(`Footprint reaches the reserved ${k.corner || ''} area (${kw} × ${kh} mm): ${k.note || 'keep it clear'}`.trim());
      }
    }
    if (profile.nozzles && (!nozzle || nozzle === 'single')) out.warnings.push('Checked against one nozzle. Printing with both nozzles (two materials/colours) leaves less width; check with nozzle "both".');
  } else {
    out.split = suggestSplit(size, profile, { margin, nozzle });
    const s = out.split;
    out.suggestion = `Does not fit ${profile.name || profile.id} (${usable.join(' × ')} mm usable). Split into ${s.pieces} pieces: ${s.cuts.map((c) => `${c.axis} at ${c.at.join(', ')} mm`).join('; ')}.`;
  }
  return out;
}

const AXES = ['x', 'y', 'z'];

/** Is v inside any keep-out range [a, b] (expanded by pad)? */
function inKeepout(v, ranges, pad) {
  return ranges.some(([a, b]) => v > Math.min(a, b) - pad && v < Math.max(a, b) + pad);
}

/**
 * Plane positions along one axis of length L into n pieces of at most `max` each,
 * evenly spaced, nudged out of keep-out ranges. Returns null if impossible.
 */
function planesForAxis(L, n, max, ranges, pad) {
  const at = [];
  let prev = 0;
  for (let k = 1; k < n; k++) {
    const ideal = prev + (L - prev) / (n - k + 1);
    const lo = Math.max(prev + 1, L - (n - k) * max); // remaining pieces must still fit
    const hi = Math.min(prev + max, L - 1);
    if (lo > hi + EPS) return null;
    let best = null;
    // Search outward from the ideal position in 0.5 mm steps.
    const steps = Math.ceil(Math.max(hi - lo, 1) / 0.5) + 2;
    for (let s = 0; s <= steps; s++) {
      for (const sign of s ? [1, -1] : [1]) {
        const v = Math.round((ideal + sign * s * 0.5) * 2) / 2;
        if (v < lo - EPS || v > hi + EPS) continue;
        if (inKeepout(v, ranges, pad)) continue;
        best = v; break;
      }
      if (best !== null) break;
    }
    if (best === null) return null;
    at.push(best);
    prev = best;
  }
  if (L - prev > max + EPS) return null;
  return at;
}

/**
 * suggestSplit(size, profile, { margin, nozzle, keepouts: { x: [[a,b],...], y, z }, pad=3 })
 * Axis names refer to the input size indices (x = size[0], y = size[1], z = size[2]);
 * positions are mm from the part's minimum on that axis. keepouts are ranges to avoid
 * (mounting holes, bosses) expanded by `pad` mm.
 * → { pieces, perAxis: {x,y,z}, cuts: [{ axis, at: [] }], orientation (printed dims of the
 *     largest piece), pieceSize, layout (which part axis lies along printer X/Y/Z), warnings, label }
 */
export function suggestSplit(size, profile, { margin, nozzle, keepouts = {}, pad = 3 } = {}) {
  checkSize(size);
  const usable = usableVolume(profile, { margin, nozzle });
  let best = null;
  for (const p of PERMS) {
    // p[i] = which part axis lies along printer axis i.
    const n = [1, 1, 1];
    const caps = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      caps[p[i]] = usable[i];
      n[p[i]] = Math.max(1, Math.ceil(size[p[i]] / usable[i] - 1e-9));
    }
    let cuts = [], ok = true;
    for (let a = 0; a < 3 && ok; a++) {
      let k = n[a], at = null;
      while (k <= n[a] + 6) {
        at = planesForAxis(size[a], k, caps[a], keepouts[AXES[a]] || [], pad);
        if (at) break;
        k++;
      }
      if (!at) { ok = false; break; }
      n[a] = k;
      if (at.length) cuts.push({ axis: AXES[a], at });
    }
    if (!ok) continue;
    const pieces = n[0] * n[1] * n[2];
    // Prefer fewest pieces, then no cut along the printed height, then lowest height.
    const heightAxis = p[2];
    const score = [pieces, n[heightAxis] > 1 ? 1 : 0, size[heightAxis]];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
      best = { score, n, cuts, p };
    }
  }
  if (!best) throw new Error('suggestSplit: no split found (keep-outs block every plane?)');
  const pieceSize = size.map((L, a) => {
    const at = best.cuts.find((c) => c.axis === AXES[a])?.at || [];
    const edges = [0, ...at, L];
    let mx = 0;
    for (let i = 1; i < edges.length; i++) mx = Math.max(mx, edges[i] - edges[i - 1]);
    return r2(mx);
  });
  const out = {
    pieces: best.n[0] * best.n[1] * best.n[2],
    perAxis: { x: best.n[0], y: best.n[1], z: best.n[2] },
    cuts: best.cuts,
    pieceSize,
    layout: { printerX: AXES[best.p[0]], printerY: AXES[best.p[1]], printerZ: AXES[best.p[2]] },
    orientation: best.p.map((a) => pieceSize[a]),
    usable,
    warnings: [],
    label: 'calculated',
  };
  if (out.pieces === 1) out.warnings.push('Part already fits; no split needed.');
  out.warnings.push('Planes are evenly spaced starting points: move them onto flat faces, away from mounting holes and load paths, and add joints (pins, dovetail or bolted flange).');
  return out;
}

/**
 * materialCheck(material, profile) → { status: 'ok'|'warn'|'no'|'unknown', material, printer, reason }
 */
export function materialCheck(material, profile) {
  if (!material) throw new Error('materialCheck: material is required');
  const mat = String(material).toUpperCase().trim();
  const m = profile?.materials || {};
  const eq = (x) => String(x).toUpperCase() === mat;
  const base = { material: mat, printer: profile?.id, label: 'calculated' };
  if ((m.no || []).some(eq)) {
    return { ...base, status: 'no', reason: `${mat} is not supported on ${profile.name || profile.id}${profile.heated_bed?.max_temp ? ` (bed max ${profile.heated_bed.max_temp} °C${profile.enclosed ? '' : ', open frame'})` : ''}.` };
  }
  const warnKey = Object.keys(m.warn || {}).find(eq);
  if (warnKey) return { ...base, status: 'warn', reason: m.warn[warnKey] };
  if ((m.ok || []).some(eq)) return { ...base, status: 'ok', reason: `${mat} is fine on ${profile.name || profile.id}.` };
  if (['ABS', 'ASA', 'PC', 'PA', 'NYLON'].includes(mat) && profile && profile.enclosed === false) {
    return { ...base, status: 'warn', reason: `Open-frame printer: ${mat} warps and gives off fumes without an enclosure.` };
  }
  return { ...base, status: 'unknown', reason: `${mat} is not listed for ${profile?.name || profile?.id || 'this printer'}: check the filament maker's guidance.` };
}
