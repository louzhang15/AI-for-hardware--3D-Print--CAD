// Node helper: write 3MF files (zip, STORE method, own CRC32) from STL-style meshes,
// with simple shelf packing onto the printer bed.
import { writeFileSync } from 'node:fs';
import { computeBBox } from './stl.js';

// ---------------------------------------------------------------------------
// CRC32 + ZIP (STORE)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** files: [{ name, data: Buffer|string }] → Buffer of a ZIP archive (no compression). */
export function writeZip(files, when = new Date()) {
  const { time, date } = dosTime(when);
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // UTF-8 names
    lh.writeUInt16LE(0, 8);         // STORE
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // version made by
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------------------
// Packing

/**
 * Shelf packing of footprints on a bed.
 * items: [{ name, size: [x, y] }]; bed: [X, Y]; margin: edge margin; gap: between parts.
 * → { placed: [{ index, x, y }] (min corner on the bed), overflow: [index] }
 */
export function shelfPack(items, bed, { margin = 5, gap = 5, keepouts = [] } = {}) {
  const order = items.map((it, i) => ({ i, w: it.size[0], d: it.size[1] })).sort((a, b) => b.d - a.d || b.w - a.w);
  const [right, top] = bed.map((dim) => dim - margin);
  const obstacles = [...keepouts].sort((a, b) => a[0] - b[0]);
  const placed = [], overflow = [];
  let x = margin, y = margin, rowDepth = 0;
  for (const { i, w, d } of order) {
    let fits = false;
    if (w > right - margin + 1e-9) { overflow.push(i); continue; }
    while (y + d <= top + 1e-9) {
      const crossing = obstacles.filter(([, oy, , h]) => y < oy + h && y + d > oy);
      let left = x;
      for (const [ox, , width] of crossing) {
        if (left < ox + width && left + w > ox) left = ox + width;
      }
      if (left + w <= right + 1e-9) {
        placed.push({ index: i, x: left, y });
        x = left + w + gap;
        rowDepth = Math.max(rowDepth, d);
        fits = true;
        break;
      }
      if (rowDepth) y += rowDepth + gap;
      else if (crossing.length) y = Math.min(...crossing.map(([, oy, , h]) => oy + h));
      else break;
      x = margin;
      rowDepth = 0;
    }
    if (!fits) overflow.push(i);
  }
  return { placed, overflow };
}

// ---------------------------------------------------------------------------
// 3MF

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (v) => { const r = Math.round(v * 1e5) / 1e5; return Object.is(r, -0) ? '0' : String(r); };

function indexMesh(positions) {
  const map = new Map(), verts = [], tris = [];
  for (let o = 0; o < positions.length; o += 9) {
    const t = [];
    for (let k = 0; k < 3; k++) {
      const x = positions[o + k * 3], y = positions[o + k * 3 + 1], z = positions[o + k * 3 + 2];
      const key = `${fmt(x)} ${fmt(y)} ${fmt(z)}`;
      let id = map.get(key);
      if (id === undefined) { id = verts.length; map.set(key, id); verts.push([x, y, z]); }
      t.push(id);
    }
    if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) tris.push(t);
  }
  return { verts, tris };
}

/**
 * Build the 3D/3dmodel.model XML.
 * objects: [{ name, mesh, transform?: [tx, ty, tz] }] — the mesh is shifted so its bbox min
 * sits at the origin, then the build item translates it to `transform`.
 */
export function modelXML(objects, { title = 'Wiremap plate' } = {}) {
  const res = [], items = [];
  objects.forEach((ob, n) => {
    const id = n + 1;
    const bb = ob.mesh.bbox || computeBBox(ob.mesh.positions);
    const { verts, tris } = indexMesh(ob.mesh.positions);
    const v = verts.map(([x, y, z]) => `<vertex x="${fmt(x - bb.min[0])}" y="${fmt(y - bb.min[1])}" z="${fmt(z - bb.min[2])}"/>`).join('');
    const t = tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
    res.push(`<object id="${id}" name="${xmlEsc(ob.name || `part ${id}`)}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`);
    const [tx, ty, tz] = ob.transform || [0, 0, 0];
    items.push(`<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${fmt(tx)} ${fmt(ty)} ${fmt(tz)}"/>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${xmlEsc(title)}</metadata>
<metadata name="Application">Wiremap</metadata>
<resources>
${res.join('\n')}
</resources>
<build>
${items.join('\n')}
</build>
</model>
`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>
`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>
`;

/** 3MF bytes for objects already positioned ({ name, mesh, transform }). */
export function build3MF(objects, opts = {}) {
  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: '3D/3dmodel.model', data: modelXML(objects, opts) },
  ]);
}

/**
 * Pack meshes onto plates of the given bed and return one 3MF per plate.
 * parts: [{ name, mesh }]; bed: [X, Y, Z?] (mm), with optional height limit.
 * → { plates: [{ bytes: Buffer, parts: [names], placements: [{ name, x, y }] }], tooBig: [names] }
 */
export function packPlates(parts, bed, { margin = 5, gap = 5, keepouts = [], title = 'Wiremap plate' } = {}) {
  const plates = [], tooBig = [];
  const [width, depth, height = Infinity] = bed;
  const limit = [width - 2 * margin, depth - 2 * margin, height];
  let remaining = [];
  for (const part of parts) {
    const bb = part.mesh.bbox || computeBBox(part.mesh.positions);
    if (bb.size.some((length, axis) => length > limit[axis] + 1e-9)) tooBig.push(part.name);
    else remaining.push({ ...part, bb });
  }
  while (remaining.length) {
    const { placed, overflow } = shelfPack(remaining.map((p) => ({ size: [p.bb.size[0], p.bb.size[1]] })), bed, { margin, gap, keepouts });
    if (!placed.length) { tooBig.push(...remaining.map((p) => p.name)); break; }
    const objs = placed.map(({ index, x, y }) => ({ name: remaining[index].name, mesh: remaining[index].mesh, transform: [x, y, 0] }));
    plates.push({
      bytes: build3MF(objs, { title: `${title} ${plates.length + 1}` }),
      parts: objs.map((o) => o.name),
      placements: objs.map((o) => ({ name: o.name, x: o.transform[0], y: o.transform[1] })),
    });
    remaining = overflow.map((index) => remaining[index]);
  }
  return { plates, tooBig };
}

export function save3MF(file, objects, opts) {
  writeFileSync(file, build3MF(objects, opts));
}
