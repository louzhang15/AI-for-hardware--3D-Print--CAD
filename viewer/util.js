// Small DOM and formatting helpers shared by every view.

export const SVGNS = 'http://www.w3.org/2000/svg';

/** Create an HTML element: h('div.card#id', {onclick}, ...children) */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

/** Create an SVG element. */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  applyAttrs(el, attrs, true);
  append(el, children);
  return el;
}

function applyAttrs(el, attrs, svg = false) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class' || k === 'className') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (!svg && (k === 'value' || k === 'checked' || k === 'disabled')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export function fmtV(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
  return `${Number(v.toFixed(2))} V`;
}
export function fmtA(a) {
  if (typeof a !== 'number' || !Number.isFinite(a)) return '–';
  if (Math.abs(a) < 1) return `${Math.round(a * 1000)} mA`;
  return `${Number(a.toFixed(2))} A`;
}
export function fmtMoney(n, cur = 'USD') {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD', maximumFractionDigits: 2 }).format(n); }
  catch { return `${n.toFixed(2)} ${cur}`; }
}
export function fmtAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
export const plural = (n, word, pl = `${word}s`) => `${n} ${n === 1 ? word : pl}`;

export const store = {
  get(key, def) {
    try { const v = localStorage.getItem(`wiremap:${key}`); return v === null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) {
    try { localStorage.setItem(`wiremap:${key}`, JSON.stringify(val)); } catch { /* private mode */ }
  },
};

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

let toastTimer = null;
export function toast(msg, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) { el = h('div#toast', { role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch { /* plain */ }
    throw new Error(`${res.status}: ${msg}`);
  }
  return text;
}

export const postJSON = async (path, body) => JSON.parse(await api(path, { method: 'POST', body: JSON.stringify(body) }));

/** Download a blob or string as a file. */
export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Parse "part.pin". */
export function splitKey(key) {
  const i = String(key).indexOf('.');
  return i < 0 ? { part: key, pin: '' } : { part: key.slice(0, i), pin: key.slice(i + 1) };
}

/** Return black or white text for a background hex colour. */
export function inkFor(hex) {
  const c = parseHex(hex);
  if (!c) return '#fff';
  const lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  return lum > 0.6 ? '#14171c' : '#ffffff';
}
export function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let x = m[1];
  if (x.length === 3) x = x.split('').map((c) => c + c).join('');
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
export function shade(hex, k) {
  const c = parseHex(hex);
  if (!c) return hex;
  const f = (v) => clamp(Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k), 0, 255).toString(16).padStart(2, '0');
  return `#${f(c[0])}${f(c[1])}${f(c[2])}`;
}

/** Default board colour by category when a part has none. */
export const CATEGORY_COLORS = {
  controller: '#1d3557', driver: '#1f4fa8', actuator: '#2b2d31', sensor: '#5b3f8c', power: '#3d4451',
  battery: '#3a5a40', protection: '#7a4b12', passive: '#6b5a3e', module: '#2f5d62',
};
export const partColor = (def) => def.color || CATEGORY_COLORS[def.category] || '#3a4250';

export const CATEGORY_LABEL = {
  controller: 'Controller', driver: 'Driver', actuator: 'Actuator', sensor: 'Sensor', power: 'Power supply',
  battery: 'Battery', protection: 'Protection', passive: 'Passive', module: 'Module',
};

/**
 * Positions for parts without one: a tidy row layout on the desk (y = 0).
 * Returns Map(partId -> [x, y, z]); keeps given positions.
 */
export function layoutPositions(partList) {
  const out = new Map();
  const missing = [];
  let maxX = -Infinity;
  let minZ = Infinity;
  for (const p of partList) {
    if (Array.isArray(p.position) && p.position.length === 3 && p.position.every(Number.isFinite)) {
      out.set(p.id, p.position);
      maxX = Math.max(maxX, p.position[0] + p.size[0] / 2);
      minZ = Math.min(minZ, p.position[2]);
    } else missing.push(p);
  }
  const order = ['power', 'battery', 'protection', 'controller', 'driver', 'module', 'sensor', 'passive', 'actuator'];
  missing.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
  let x = Number.isFinite(maxX) ? maxX + 60 : -((missing.length - 1) * 90) / 2;
  const z0 = Number.isFinite(minZ) ? minZ : 0;
  let col = 0;
  let rowZ = z0;
  for (const p of missing) {
    out.set(p.id, [x + p.size[0] / 2, 0, rowZ]);
    x += p.size[0] + 50;
    if (++col >= 5) { col = 0; rowZ += 110; x = Number.isFinite(maxX) ? maxX + 60 : -((missing.length - 1) * 90) / 2; }
  }
  return out;
}

/** Rotate a footprint point (u,v) of a part with size [sx,_,sz] by ry degrees (quantised to 90). */
export function footprintToTop(def, u, v, ryDeg) {
  const sx = def.size[0];
  const sz = def.size[2];
  let x = u - sx / 2;
  let z = v - sz / 2;
  const r = ((Math.round((ryDeg || 0) / 90) % 4) + 4) % 4;
  // three.js rotation about +Y by +90° maps (x, z) -> (z, -x) in the top view.
  for (let i = 0; i < r; i++) { const t = x; x = z; z = -t; }
  return [x, z];
}

/** Small event emitter. */
export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(ev, fn) { if (!this.handlers.has(ev)) this.handlers.set(ev, new Set()); this.handlers.get(ev).add(fn); return () => this.handlers.get(ev).delete(fn); }
  emit(ev, ...args) { for (const fn of this.handlers.get(ev) || []) fn(...args); }
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Inline SVG icons (stroke = currentColor). */
const ICONS = {
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-6"/><path d="M4 17h16"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  ruler: '<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="M7 8v3M11 8v4M15 8v3M19 8v2"/>',
  pin: '<path d="M12 17v5"/><path d="M8 3h8l-1 6 3 3v2H6v-2l3-3-1-6z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  motion: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  still: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  panelR: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17v.5"/>',
  explode: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/><rect x="10" y="10" width="4" height="4"/>',
  xray: '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 4a8 8 0 0 1 0 16" fill="currentColor" opacity=".25"/>',
  focus: '<circle cx="12" cy="12" r="3"/><path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  print: '<path d="M7 9V3h10v6M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="7"/>',
  steps: '<path d="M4 6h16M4 12h10M4 18h6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
};
export function icon(name, size = 16) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}
