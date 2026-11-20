// Node helpers for STL meshes: parse (ASCII + binary), write binary STL,
// measure, and cut with a plane into two closed meshes with planar caps.
//
// Mesh shape used everywhere: { positions: Float32Array (9 floats per triangle),
//   triangles: number, bbox: { min: [x,y,z], max: [x,y,z], size: [x,y,z] } }
import { readFileSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Parse / write

export function computeBBox(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!positions.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  return { min, max, size: [0, 1, 2].map((a) => max[a] - min[a]) };
}

export function makeMesh(positions) {
  const p = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  return { positions: p, triangles: p.length / 9, bbox: computeBBox(p) };
}

function isBinary(buf) {
  if (buf.length < 84) return false;
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 === buf.length) return true;
  const head = buf.subarray(0, Math.min(buf.length, 512)).toString('latin1');
  return !(/^\s*solid/.test(head) && /facet|endsolid/.test(head));
}

/** Parse an STL (Buffer / Uint8Array). */
export function parseSTL(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
  if (isBinary(buf)) {
    const n = buf.readUInt32LE(80);
    if (84 + n * 50 > buf.length) throw new Error(`binary STL truncated: header says ${n} triangles, file has room for ${Math.floor((buf.length - 84) / 50)}`);
    const pos = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) pos[t * 9 + k] = buf.readFloatLE(o + k * 4);
    }
    return makeMesh(pos);
  }
  const text = buf.toString('utf8');
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const vals = [];
  let m;
  while ((m = re.exec(text))) vals.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (vals.length % 9 !== 0) throw new Error('ASCII STL: vertex count is not a multiple of 3');
  if (!vals.length) throw new Error('STL has no triangles');
  if (vals.some((v) => !Number.isFinite(v))) throw new Error('ASCII STL: bad number');
  return makeMesh(vals);
}

export function readSTL(file) {
  return parseSTL(readFileSync(file));
}

function triNormal(p, o) {
  const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
  const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** Binary STL bytes (Buffer). */
export function writeBinarySTL(mesh, header = 'Wiremap binary STL') {
  const n = mesh.positions.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write(header.slice(0, 79), 0, 'latin1');
  buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    const nn = triNormal(mesh.positions, t * 9);
    buf.writeFloatLE(nn[0], o); buf.writeFloatLE(nn[1], o + 4); buf.writeFloatLE(nn[2], o + 8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(mesh.positions[t * 9 + k], o + 12 + k * 4);
  }
  return buf;
}

export function saveSTL(file, mesh, header) {
  writeFileSync(file, writeBinarySTL(mesh, header));
}

/** Translate a mesh (returns a new mesh). */
export function translateMesh(mesh, [dx, dy, dz]) {
  const p = new Float32Array(mesh.positions.length);
  for (let i = 0; i < p.length; i += 3) { p[i] = mesh.positions[i] + dx; p[i + 1] = mesh.positions[i + 1] + dy; p[i + 2] = mesh.positions[i + 2] + dz; }
  return makeMesh(p);
}

/** Signed volume (mm³, positive for outward-facing closed meshes) and surface area (mm²). */
export function meshStats(mesh) {
  const p = mesh.positions;
  let vol = 0, area = 0;
  for (let o = 0; o < p.length; o += 9) {
    const ax = p[o], ay = p[o + 1], az = p[o + 2], bx = p[o + 3], by = p[o + 4], bz = p[o + 5], cx = p[o + 6], cy = p[o + 7], cz = p[o + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return { volume: vol, area };
}

/** Watertightness check: every edge used exactly once in each direction. */
export function checkClosed(mesh, decimals = 5) {
  const p = mesh.positions;
  const key = (o) => `${p[o].toFixed(decimals)},${p[o + 1].toFixed(decimals)},${p[o + 2].toFixed(decimals)}`;
  const edges = new Map();
  for (let o = 0; o < p.length; o += 9) {
    const k = [key(o), key(o + 3), key(o + 6)];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue; // degenerate
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const id = `${a}|${b}`;
      edges.set(id, (edges.get(id) || 0) + 1);
    }
  }
  let open = 0, bad = 0;
  for (const [id, c] of edges) {
    const [a, b] = id.split('|');
    const r = edges.get(`${b}|${a}`) || 0;
    if (r === 0) open++;
    else if (r !== c) bad++;
  }
  return { closed: open === 0 && bad === 0, openEdges: open, mismatched: bad };
}

// ---------------------------------------------------------------------------
// 2D polygon helpers (caps)

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]);
  return a / 2;
}

export function pointInPolygon(pt, poly) {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function pointInTri(p, a, b, c) {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
}

function segIntersect(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Merge holes into an outer polygon with bridge edges (Eberly's method).
 * outer: CCW array of {x, y, i}; holes: arrays (any orientation). Returns one ring of vertex objects.
 */
function bridgeHoles(outer, holes) {
  let ring = outer.slice();
  const hs = holes.map((h) => (polygonArea(h.map((v) => [v.x, v.y])) > 0 ? h.slice().reverse() : h.slice())); // holes CW
  hs.sort((a, b) => Math.max(...b.map((v) => v.x)) - Math.max(...a.map((v) => v.x)));
  for (const hole of hs) {
    // Rightmost hole vertex.
    let mi = 0;
    for (let i = 1; i < hole.length; i++) if (hole[i].x > hole[mi].x || (hole[i].x === hole[mi].x && hole[i].y < hole[mi].y)) mi = i;
    const M = hole[mi];
    // Candidate ring vertices sorted by distance; take the first whose bridge crosses no edge.
    const order = ring.map((v, i) => ({ i, d: (v.x - M.x) ** 2 + (v.y - M.y) ** 2, right: v.x >= M.x }))
      .sort((a, b) => (b.right - a.right) || (a.d - b.d));
    let bi = -1;
    const allEdges = [];
    for (let i = 0; i < ring.length; i++) allEdges.push([ring[i], ring[(i + 1) % ring.length]]);
    for (const h of hs) for (let i = 0; i < h.length; i++) allEdges.push([h[i], h[(i + 1) % h.length]]);
    for (const c of order) {
      const V = ring[c.i];
      const pm = [M.x, M.y], pv = [V.x, V.y];
      let blocked = false;
      for (const [a, b] of allEdges) {
        if (a === V || b === V || a === M || b === M) continue;
        if (segIntersect(pm, pv, [a.x, a.y], [b.x, b.y])) { blocked = true; break; }
      }
      if (!blocked) {
        // The bridge must leave V into the polygon interior: check V's wedge.
        const prev = ring[(c.i - 1 + ring.length) % ring.length], next = ring[(c.i + 1) % ring.length];
        const reflex = cross([prev.x, prev.y], [V.x, V.y], [next.x, next.y]) < 0;
        const leftOfIn = cross([prev.x, prev.y], [V.x, V.y], pm) >= 0;
        const leftOfOut = cross([V.x, V.y], [next.x, next.y], pm) >= 0;
        const inside = reflex ? (leftOfIn || leftOfOut) : (leftOfIn && leftOfOut);
        if (!inside) continue;
        bi = c.i; break;
      }
    }
    if (bi < 0) bi = order[0].i;
    const holeSeq = [];
    for (let k = 0; k <= hole.length; k++) holeSeq.push(hole[(mi + k) % hole.length]);
    ring = [...ring.slice(0, bi + 1), ...holeSeq, ring[bi], ...ring.slice(bi + 1)];
  }
  return ring;
}

/**
 * Ear-clip a simple ring (CCW) of {x, y, i}. Returns triangles as index triples (the `i` fields), CCW.
 */
function earClip(ring) {
  const tris = [];
  let pts = ring.slice();
  // Drop consecutive duplicates.
  pts = pts.filter((v, k) => { const n = pts[(k + 1) % pts.length]; return !(n !== v && n.x === v.x && n.y === v.y && n.i === v.i); });
  let guard = 0;
  while (pts.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let k = 0; k < pts.length; k++) {
      const a = pts[(k - 1 + pts.length) % pts.length], b = pts[k], c = pts[(k + 1) % pts.length];
      const A = [a.x, a.y], B = [b.x, b.y], C = [c.x, c.y];
      const cr = cross(A, B, C);
      // Reflex or collinear vertex: not an ear. Collinear points are kept (never dropped),
      // so the cap shares every vertex with the cut walls and stays watertight.
      if (cr <= 1e-12) continue;
      let ok = true;
      for (const v of pts) {
        if (v === a || v === b || v === c) continue;
        if ((v.x === A[0] && v.y === A[1]) || (v.x === B[0] && v.y === B[1]) || (v.x === C[0] && v.y === C[1])) continue;
        if (pointInTri([v.x, v.y], A, B, C)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push([a.i, b.i, c.i]);
      pts.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Numerically stuck: clip the most convex vertex anyway so the cap stays closed.
      let bk = 0, bc = -Infinity;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[(k - 1 + pts.length) % pts.length], b = pts[k], c = pts[(k + 1) % pts.length];
        const cr = cross([a.x, a.y], [b.x, b.y], [c.x, c.y]);
        if (cr > bc) { bc = cr; bk = k; }
      }
      const a = pts[(bk - 1 + pts.length) % pts.length], b = pts[bk], c = pts[(bk + 1) % pts.length];
      if (bc > 0) tris.push([a.i, b.i, c.i]);
      pts.splice(bk, 1);
    }
  }
  if (pts.length === 3 && cross([pts[0].x, pts[0].y], [pts[1].x, pts[1].y], [pts[2].x, pts[2].y]) > 1e-12) tris.push([pts[0].i, pts[1].i, pts[2].i]);
  return tris;
}

/**
 * Triangulate polygons with holes given as loops of 2D points (any orientation; nesting
 * decided by containment, even depth = outer, odd = hole).
 * loops: [[[x,y],...], ...] → { triangles: [[loopIdx, ptIdx] x3 ...] as flat refs, regions }
 * Returns triangles as arrays of {loop, idx} references, CCW in 2D.
 */
export function triangulateLoops(loops) {
  const areas = loops.map((l) => polygonArea(l));
  const depth = loops.map((l, i) => {
    let d = 0;
    const probe = l[0];
    for (let j = 0; j < loops.length; j++) {
      if (j === i || Math.abs(areas[j]) <= Math.abs(areas[i])) continue;
      if (pointInPolygon(probe, loops[j])) d++;
    }
    return d;
  });
  const regions = [];
  for (let i = 0; i < loops.length; i++) {
    if (depth[i] % 2 !== 0) continue;
    const holes = [];
    for (let j = 0; j < loops.length; j++) {
      if (depth[j] !== depth[i] + 1) continue;
      if (Math.abs(areas[j]) >= Math.abs(areas[i])) continue;
      if (pointInPolygon(loops[j][0], loops[i])) holes.push(j);
    }
    regions.push({ outer: i, holes });
  }
  const tris = [];
  for (const r of regions) {
    const mk = (li) => loops[li].map((p, k) => ({ x: p[0], y: p[1], i: [li, k] }));
    let outer = mk(r.outer);
    if (areas[r.outer] < 0) outer.reverse();
    const ring = bridgeHoles(outer, r.holes.map(mk));
    for (const t of earClip(ring)) tris.push(t);
  }
  return { triangles: tris, regions, depth };
}

// ---------------------------------------------------------------------------
// Plane cut

const UV = { 0: [1, 2], 1: [2, 0], 2: [0, 1] }; // (u, v) so that u × v = +axis

/**
 * planeCut(mesh, axis, offset) → { below, above, caps: { loops2d, axis, offset, uv }, offset }
 *   axis: 'x' | 'y' | 'z' (or 0/1/2); offset in mesh coordinates (absolute).
 *   below: the part with coordinate < offset, capped with a face pointing +axis.
 *   above: the part with coordinate > offset, capped with a face pointing −axis.
 * If the plane passes exactly through vertices, it is nudged by up to 1e-3 mm
 * (reported as `offset`) so no vertex lies on it.
 */
export function planeCut(mesh, axis, offset) {
  const ax = typeof axis === 'number' ? axis : { x: 0, y: 1, z: 2 }[String(axis).toLowerCase()];
  if (ax === undefined) throw new Error(`planeCut: axis must be x, y or z (got ${axis})`);
  const p = mesh.positions;
  const bb = mesh.bbox || computeBBox(p);
  if (!(offset > bb.min[ax] && offset < bb.max[ax])) throw new Error(`planeCut: ${'xyz'[ax]} = ${offset} is outside the part (${bb.min[ax]} .. ${bb.max[ax]})`);
  // Nudge off vertices.
  let off = offset;
  const hits = (o) => { for (let i = ax; i < p.length; i += 3) if (Math.abs(p[i] - o) < 1e-5) return true; return false; };
  for (let k = 1; hits(off) && k < 50; k++) off = offset + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2e-5;
  if (hits(off)) throw new Error('planeCut: could not move the plane off the mesh vertices');

  const below = [], above = [];
  const vkey = (x, y, z) => `${x},${y},${z}`;
  // Intersection points keyed by the (sorted) edge so neighbouring triangles share them exactly.
  const ipts = new Map();
  const segs = [];
  const inter = (a, b) => {
    const ka = vkey(a[0], a[1], a[2]), kb = vkey(b[0], b[1], b[2]);
    const [P, Q] = ka < kb ? [a, b] : [b, a];
    const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    let r = ipts.get(key);
    if (!r) {
      const t = (off - P[ax]) / (Q[ax] - P[ax]);
      const pt = [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t, P[2] + (Q[2] - P[2]) * t];
      pt[ax] = off;
      r = { key, pt };
      ipts.set(key, r);
    }
    return r;
  };
  const pushPoly = (arr, poly) => { for (let k = 1; k + 1 < poly.length; k++) arr.push(...poly[0], ...poly[k], ...poly[k + 1]); };

  for (let o = 0; o < p.length; o += 9) {
    const v = [[p[o], p[o + 1], p[o + 2]], [p[o + 3], p[o + 4], p[o + 5]], [p[o + 6], p[o + 7], p[o + 8]]];
    const s = v.map((q) => q[ax] < off);
    if (s[0] && s[1] && s[2]) { below.push(...v[0], ...v[1], ...v[2]); continue; }
    if (!s[0] && !s[1] && !s[2]) { above.push(...v[0], ...v[1], ...v[2]); continue; }
    const pb = [], pa = [], cut = [];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3], sa = s[e], sb = s[(e + 1) % 3];
      (sa ? pb : pa).push(a);
      if (sa !== sb) {
        const ip = inter(a, b);
        pb.push(ip.pt); pa.push(ip.pt); cut.push(ip);
      }
    }
    pushPoly(below, pb); pushPoly(above, pa);
    if (cut.length === 2) segs.push([cut[0], cut[1]]);
  }

  // Chain segments into loops.
  const adj = new Map();
  for (const [a, b] of segs) {
    if (a.key === b.key) continue;
    if (!adj.has(a.key)) adj.set(a.key, { pt: a.pt, nb: [] });
    if (!adj.has(b.key)) adj.set(b.key, { pt: b.pt, nb: [] });
    adj.get(a.key).nb.push(b.key);
    adj.get(b.key).nb.push(a.key);
  }
  const used = new Set();
  const loops3 = [];
  let openChains = 0;
  for (const [start] of adj) {
    if (used.has(start)) continue;
    const loop = [start];
    used.add(start);
    let prev = null, cur = start;
    for (;;) {
      const nb = adj.get(cur).nb.filter((n) => n !== prev);
      const next = nb.find((n) => !used.has(n)) ?? nb.find((n) => n === start);
      if (next === undefined) { openChains++; break; }
      if (next === start) break;
      used.add(next);
      loop.push(next);
      prev = cur; cur = next;
    }
    if (loop.length >= 3) loops3.push(loop.map((k) => adj.get(k).pt));
  }
  const [u, w] = UV[ax];
  const loops2d = loops3.map((l) => l.map((q) => [q[u], q[w]]));
  const { triangles } = triangulateLoops(loops2d);
  for (const t of triangles) {
    const q = t.map(([li, k]) => loops3[li][k]);
    below.push(...q[0], ...q[1], ...q[2]);           // CCW in (u, v) => normal +axis (outward for the lower piece)
    above.push(...q[0], ...q[2], ...q[1]);           // reversed => normal −axis
  }
  const res = {
    below: makeMesh(below), above: makeMesh(above), offset: off, axis: 'xyz'[ax],
    caps: { loops2d, uv: ['xyz'[u], 'xyz'[w]], triangles: triangles.length },
    warnings: [],
  };
  if (openChains) res.warnings.push(`${openChains} open cut chain(s): the input mesh is not watertight, caps may be incomplete.`);
  return res;
}
