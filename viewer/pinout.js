// Pinout view and pin-to-pin wiring helpers for beginners.
// Every board is drawn with every pin's exact silkscreen name. Wired pins are
// coloured by role and tagged with where their wire goes ("→ PCA9685 SDA").
import { h, s, clear, splitKey, partColor } from './util.js';
import { activeFocus, selectable, emptyView } from './svg-view.js';
import { ROLE_COLORS } from '/lib/nets.js';

const ORD = (n) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};

/** Which edge a pin sits on and its count along that edge, from footprint `pos`. */
export function pinLocation(part, pin) {
  if (!part || !Array.isArray(pin?.pos) || !Array.isArray(part.size)) return null;
  const [w, , d] = part.size;
  const edgeOf = (p) => {
    const [u, v] = p.pos;
    const dist = { left: u, right: w - u, top: v, bottom: d - v };
    return Object.entries(dist).sort((a, b) => a[1] - b[1])[0][0];
  };
  const placed = part.pins.filter((p) => Array.isArray(p.pos));
  // All pins in one spot (barrel jack, servo lead): no useful position hint.
  if (new Set(placed.map((p) => p.pos.join(','))).size < 2) return null;
  const edge = edgeOf(pin);
  const along = (p) => (edge === 'left' || edge === 'right' ? p.pos[1] : p.pos[0]);
  // Pins on the same edge line (same row or column, within 1.5 mm).
  const line = placed.filter((p) => edgeOf(p) === edge &&
    Math.abs((edge === 'left' || edge === 'right' ? p.pos[0] - pin.pos[0] : p.pos[1] - pin.pos[1])) < 1.5)
    .sort((a, b) => along(a) - along(b));
  const index = line.findIndex((p) => p.name === pin.name) + 1;
  const from = edge === 'left' || edge === 'right' ? 'top' : 'left';
  const rowName = edge === 'top' || edge === 'bottom' ? `${edge} row` : `${edge} side`;
  return { edge, index, count: line.length, text: `${rowName}, ${ORD(index)} of ${line.length} pins from the ${from} (as drawn in Pinout)` };
}

/** Short tag for a part: its model number ("PCA9685", "Base SG90"), else a trimmed name. */
export function tagName(app, def) {
  if (!def) return '?';
  if (def.tag) return def.tag;
  const words = String(def.name || def.id).split(/[\s(),/]+/).filter(Boolean);
  const model = words.find((w) => /[A-Za-z]/.test(w) && /\d/.test(w) && w.length >= 4);
  if (model) {
    const i = words.indexOf(model);
    return def.category === 'actuator' && i > 0 && !/\d/.test(words[0]) ? `${words[0]} ${model}` : model;
  }
  const n = app.shortName(def);
  return n.length > 22 ? `${n.slice(0, 21)}…` : n;
}

/** Exact pin name a beginner should look for on the board. */
export function silkscreen(pin) {
  if (!pin) return '?';
  return pin.label || pin.name;
}

/** Numbered pin-to-pin instructions for a list of wire ids. */
export function connectionRows(app, wireIds) {
  const rows = [];
  for (const id of wireIds) {
    const w = app.wire(id);
    if (!w || !w.valid) continue;
    const info = app.wireInfo(id);
    const role = info.role || 'digital';
    const roleColor = ROLE_COLORS[role] || ROLE_COLORS.digital;
    const end = (key) => {
      const { part } = splitKey(key);
      const def = app.part(part);
      const pin = app.pin(key);
      return {
        key, part, partName: tagName(app, def), fullName: String(def?.name || def?.id || part).split(/\s+[/(]|,/)[0].trim(), label: silkscreen(pin), name: pin?.name,
        where: pinLocation(def, pin)?.text || null,
      };
    };
    rows.push({
      id, n: rows.length + 1, role, roleLabel: app.roleLabel(role),
      colorName: (w.color || roleColor.name).toLowerCase(), hex: info.color || roleColor.hex,
      from: end(w.fromKey), to: end(w.toKey), purpose: w.purpose || w.label || '',
      voltage: info.voltage, current: info.currentPeak || info.current || null,
    });
  }
  return rows;
}

/** One sentence a person can follow (and the voice panel can read aloud). */
export function sayConnection(r) {
  return `Take ${/^[aeiou]/i.test(r.colorName) ? 'an' : 'a'} ${r.colorName} wire. Plug one end into ${r.from.fullName || r.from.partName} pin ${r.from.label}. Plug the other end into ${r.to.fullName || r.to.partName} pin ${r.to.label}.`;
}

/** HTML list of connections for the step card. */
export function connectionList(app, wireIds) {
  const rows = connectionRows(app, wireIds);
  if (!rows.length) return null;
  const pinChip = (end) => h('span.pin-chip', { title: end.where || '' },
    h('span.pin-chip-part', null, end.partName), h('b.pin-chip-name', null, end.label));
  return h('ol.wire-howto', null, rows.map((r) => h('li.wire-howto-row', {
    onclick: () => app.select({ type: 'wire', id: r.id }),
    onkeydown: (e) => { if (e.key === 'Enter') app.select({ type: 'wire', id: r.id }); },
    tabindex: 0, role: 'button', 'aria-label': sayConnection(r),
  },
  h('span.wire-swatch', { style: { background: r.hex }, title: `${r.colorName} wire (${r.roleLabel})` }),
  h('div.wire-howto-body', null,
    h('div.wire-howto-line', null, pinChip(r.from), h('span.wire-arrow', { 'aria-hidden': 'true' }, '→'), pinChip(r.to)),
    h('div.wire-howto-meta', null, [`${r.colorName} wire`, r.roleLabel, r.voltage ? `${Number(r.voltage.toFixed(2))} V` : '', r.purpose && r.purpose !== r.roleLabel ? r.purpose : ''].filter(Boolean).join(' · ')),
    (r.from.where || r.to.where) && h('div.wire-howto-where', null,
      r.from.where && h('div', null, `${r.from.partName} ${r.from.label}: ${r.from.where}`),
      r.to.where && h('div', null, `${r.to.partName} ${r.to.label}: ${r.to.where}`))))));
}

// ------------------------------------------------------------------ Pinout view

const MIN_PITCH_PX = 17;

export class PinoutView {
  constructor(app, host) { this.app = app; this.host = host; this.showAll = false; }

  wiresByPin() {
    const map = new Map();
    for (const w of this.app.data.check.model.wires) {
      if (!w.valid) continue;
      for (const [a, b] of [[w.fromKey, w.toKey], [w.toKey, w.fromKey]]) {
        if (!map.has(a)) map.set(a, []);
        map.get(a).push({ wire: w.id, other: b });
      }
    }
    return map;
  }

  render() {
    const { partList } = this.app.data.check.model;
    this.byPin = this.wiresByPin();
    this.pinEls = new Map();
    this.cards = new Map();
    if (!partList.length) { clear(this.host).append(emptyView('No parts yet', 'Parts appear here once the project lists them.')); return; }
    const intro = h('div.pinout-intro', null,
      h('strong', null, 'Every pin, with the exact name printed on the board.'),
      ' Coloured pins have a wire; the tag says where it goes. Click a pin to light up its wire everywhere.');
    const grid = h('div.pinout-grid');
    const focus = this.app.focus;
    const order = [...partList].sort((a, b) => Number(focus?.parts?.has(b.id)) - Number(focus?.parts?.has(a.id)));
    for (const part of order) grid.append(this.card(part));
    const allRows = connectionRows(this.app, this.app.data.check.model.wires.map((w) => w.id));
    const table = h('section.pinout-table', null, h('h3', null, `All ${allRows.length} connections, pin to pin`),
      h('table', null,
        h('thead', null, h('tr', null, ['#', 'Wire', 'From (part · pin)', '', 'To (part · pin)', 'What it does'].map((t) => h('th', null, t)))),
        h('tbody', null, allRows.map((r) => {
          const tr = h('tr', { tabindex: 0, onclick: () => this.app.select({ type: 'wire', id: r.id }), onkeydown: (e) => { if (e.key === 'Enter') this.app.select({ type: 'wire', id: r.id }); } },
            h('td', null, String(r.n)),
            h('td', null, h('span.wire-swatch', { style: { background: r.hex } }), ` ${r.colorName}`),
            h('td', null, `${r.from.partName} · `, h('b.mono', null, r.from.label)),
            h('td', { 'aria-hidden': 'true' }, '→'),
            h('td', null, `${r.to.partName} · `, h('b.mono', null, r.to.label)),
            h('td.muted', null, r.purpose || r.roleLabel));
          tr.dataset.wire = r.id;
          return tr;
        }))));
    this.table = table;
    clear(this.host).append(h('div.pinout-wrap', null, intro, grid, table));
    this.applyFocus(this.app.focus);
  }

  card(part) {
    const [w, , d] = Array.isArray(part.size) ? part.size : [40, 10, 20];
    const pins = part.pins.filter((p) => Array.isArray(p.pos) && p.kind !== 'nc');
    // Scale so neighbouring pins are at least MIN_PITCH_PX apart, and the board is readable.
    let pitch = Infinity;
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
      const dd = Math.hypot(pins[i].pos[0] - pins[j].pos[0], pins[i].pos[1] - pins[j].pos[1]);
      if (dd > 0.3) pitch = Math.min(pitch, dd);
    }
    const scale = Math.min(14, Math.max(4, Number.isFinite(pitch) ? MIN_PITCH_PX / pitch : 4, 150 / Math.max(w, d)));
    const edges = pins.map((p) => pinLocation(part, p)?.edge || 'top');
    const textOf = (p) => {
      const dest = (this.byPin.get(p.key) || []).map((l) => `${tagName(this.app, this.app.part(splitKey(l.other).part))} ${silkscreen(this.app.pin(l.other))}`);
      return `${silkscreen(p)}${dest.length ? `  → ${dest.join(', ')}` : ''}`;
    };
    const room = (e) => {
      const list = pins.filter((_, i) => edges[i] === e);
      return list.length ? 22 + 7.1 * Math.max(...list.map((p) => textOf(p).length)) : 24;
    };
    const padL = room('left'); const padR = room('right'); const padT = room('top'); const padB = room('bottom');
    const W = padL + w * scale + padR; const H = padT + d * scale + padB;
    const svg = s('svg', { class: 'pinout-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${part.name || part.id} pinout` });
    const color = partColor(part);
    svg.append(s('rect', { x: padL, y: padT, width: w * scale, height: d * scale, rx: 6, fill: color, class: 'pinout-board' }),
      s('text', { x: padL + (w * scale) / 2, y: padT + (d * scale) / 2, class: 'pinout-board-name', 'text-anchor': 'middle', 'dominant-baseline': 'middle' },
        (part.name || part.id).replace(/\s*\(.*\)$/, '').slice(0, Math.max(6, Math.floor((w * scale) / 8)))));
    const pinGroups = new Map();
    for (const [i, pin] of pins.entries()) {
      const edge = edges[i];
      const x = padL + pin.pos[0] * scale; const y = padT + pin.pos[1] * scale;
      const links = this.byPin.get(pin.key) || [];
      const role = this.app.data.check.pinInfo?.[pin.key]?.role;
      const hex = links.length ? (ROLE_COLORS[role] || ROLE_COLORS.digital).hex : '#9aa3ae';
      const dest = links.map((l) => { const other = this.app.pin(l.other); return `${tagName(this.app, this.app.part(splitKey(l.other).part))} ${silkscreen(other)}`; });
      const text = `${silkscreen(pin)}${dest.length ? `  → ${dest.join(', ')}` : ''}`;
      const g = s('g', { class: `pinout-pin${links.length ? ' wired' : ' unused'}` });
      g.append(s('circle', { cx: x, cy: y, r: 4.2, fill: hex, stroke: '#0b1220', 'stroke-width': 1 }));
      const off = 9;
      let tx = x; let ty = y; let anchor = 'start'; let rot = '';
      if (edge === 'left') { tx = padL - off; anchor = 'end'; }
      else if (edge === 'right') { tx = padL + w * scale + off; }
      else if (edge === 'top') { ty = padT - off; rot = `rotate(-90 ${tx} ${ty})`; }
      else { ty = padT + d * scale + off; rot = `rotate(90 ${tx} ${ty})`; }
      // Leader line from the pin to the board edge, so the label is unambiguous.
      g.append(s('line', { x1: x, y1: y, x2: edge === 'left' ? padL - 3 : edge === 'right' ? padL + w * scale + 3 : x,
        y2: edge === 'top' ? padT - 3 : edge === 'bottom' ? padT + d * scale + 3 : y, class: 'pinout-leader', stroke: hex }));
      const label = s('text', { x: tx, y: ty, 'text-anchor': anchor, 'dominant-baseline': 'middle', transform: rot || null, class: 'pinout-label' });
      label.append(s('tspan', { class: 'pinout-name' }, silkscreen(pin)));
      if (dest.length) label.append(s('tspan', { class: 'pinout-dest', fill: hex }, `  → ${dest.join(', ')}`));
      g.append(label);
      selectable(this.app, g, 'pin', pin.key, text, () => this.app.pinTooltipHtml ? this.app.pinTooltipHtml(pin.key) : text);
      svg.append(g);
      this.pinEls.set(pin.key, g);
      pinGroups.set(pin.key, g);
    }
    const noPos = part.pins.filter((p) => !Array.isArray(p.pos) && p.kind !== 'nc');
    const wiredCount = part.pins.filter((p) => this.byPin.has(p.key)).length;
    const card = h('article.pinout-card', { 'data-part': part.id },
      h('header', null, h('h3', null, part.name || part.id), h('span.muted', null, `${part.id} · ${wiredCount} of ${part.pins.length} pins used`)),
      h('div.pinout-scroll', null, svg),
      noPos.length ? h('p.small.muted', null, `Pins without a drawn position: ${noPos.map((p) => silkscreen(p)).join(', ')}`) : null,
      (part.notes || []).length ? h('details.small', null, h('summary', null, 'Board notes'), h('ul', null, part.notes.map((n) => h('li', null, n)))) : null);
    this.cards.set(part.id, card);
    return card;
  }

  applyFocus(focus) {
    if (!this.pinEls) return;
    const dim = activeFocus(focus);
    for (const [key, el] of this.pinEls) {
      const lit = focus.pins.has(key);
      el.classList.toggle('dimmed', dim && !lit && !focus.parts.has(splitKey(key).part));
      el.classList.toggle('lit', lit);
    }
    for (const [id, card] of this.cards) card.classList.toggle('dimmed', dim && !focus.parts.has(id));
    for (const tr of this.table?.querySelectorAll('tr[data-wire]') || []) tr.classList.toggle('lit', focus.wires.has(tr.dataset.wire));
    const first = [...this.cards].find(([id]) => focus.parts?.has(id));
    if (first && focus.kind !== 'step') first[1].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  tools() { return null; }
  onShow() {}
  onHide() { this.app.tooltip?.hide(); }
  destroy() {}
}
