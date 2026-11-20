import { CATEGORY_LABEL, clear, download, h, partColor, s, splitKey } from './util.js';
import { activeFocus, emptyView, markFocus, selectable, svgCanvas, tool } from './svg-view.js';

const CARD_W = 186;
const COL_GAP = 76;
const MARGIN = 52;
const TOP = 103;
const ROW = 20;
const SIGNAL = 'signal';
const COLUMNS = [
  { label: 'Power', types: ['power', 'battery', 'protection'] },
  { label: 'Control', types: ['controller', 'driver', 'module', 'passive'] },
  { label: 'Loads & sensors', types: ['actuator', 'sensor'] },
];
let nextGrid = 0;

const palette = {
  paper: 'var(--sketch-paper, #f7f8fa)',
  grid: 'var(--sketch-grid, #dfe5ee)',
  ink: 'var(--sketch-ink, #18263e)',
  sub: 'var(--sketch-sub, #51647e)',
  card: 'var(--sketch-card, #fff)',
  border: 'var(--sketch-border, #cbd5e2)',
};

function trunc(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function cardTitle(part) {
  const name = part.label || part.name || part.id;
  const short = name.replace(/\s+\([^)]*\)\s*$/, '') || name;
  if (short.length <= 23) return { name, lines: [short] };
  const space = short.lastIndexOf(' ', 23);
  const end = space > 8 ? space : 23;
  return { name, lines: [short.slice(0, end), trunc(short.slice(end).trim(), 23)] };
}

function connectionKind(role) {
  return role === 'power' || role === 'ground' ? role : SIGNAL;
}

function wireColor(color) {
  const key = color?.toLowerCase();
  if (key === '#d8dce2') return 'var(--sketch-signal, #5d718d)';
  if (key === '#4a4f57') return 'var(--sketch-ground, #54616f)';
  if (key === '#f5c518') return 'var(--sketch-yellow, #a7790c)';
  if (key === '#f08c2e') return 'var(--sketch-orange, #c66b18)';
  return color || 'var(--sketch-signal, #5d718d)';
}

function route(from, to, index, width, height) {
  // Adjacent columns can share a gutter. Edges spanning a card use an
  // outside lane so the visible wire never passes behind an unrelated pin.
  const direction = from.right ? 1 : -1;
  const toDirection = to.right ? 1 : -1;
  const spread = (index % 7) * 6;
  const ax = from.x + direction * (16 + spread);
  const bx = to.x + toDirection * (16 + spread);
  const sameSide = from.x === to.x;
  const adjacent = Math.abs(from.x - to.x) === COL_GAP && direction === Math.sign(to.x - from.x) && toDirection === -direction;
  if (sameSide || adjacent) {
    const middle = sameSide ? ax : (from.x + to.x) / 2 + (index % 7 - 3) * 6;
    if (from.y === to.y && sameSide) {
      return `M${from.x},${from.y} C${ax},${from.y - 21} ${ax},${from.y + 21} ${to.x},${to.y}`;
    }
    return `M${from.x},${from.y} C${middle},${from.y} ${middle},${from.y} ${middle},${(from.y + to.y) / 2}
      S${middle},${to.y} ${to.x},${to.y}`;
  }
  const lane = from.y + to.y > height ? height - 14 - spread : TOP - 12 - spread;
  // Keep control points inside the exterior margin, including outer columns.
  const a = Math.max(7, Math.min(width - 7, ax));
  const b = Math.max(7, Math.min(width - 7, bx));
  return `M${from.x},${from.y} Q${a},${from.y} ${a},${from.y + Math.sign(lane - from.y) * 12}
    L${a},${lane} H${b} L${b},${to.y + Math.sign(lane - to.y) * 12} Q${b},${to.y} ${to.x},${to.y}`;
}

function drawSketch(check, app, showUnused = false) {
  const { partList, wires } = check.model;
  const connected = wires.filter((wire) => wire.valid);
  const neighbors = new Map();
  const appendNeighbor = (key, id) => {
    if (!neighbors.has(key)) neighbors.set(key, []);
    neighbors.get(key).push(id);
  };
  for (const wire of connected) {
    appendNeighbor(wire.fromKey, splitKey(wire.toKey).part);
    appendNeighbor(wire.toKey, splitKey(wire.fromKey).part);
  }

  const columns = COLUMNS.map(({ label, types }) => ({
    label,
    parts: partList.filter((part) => types.includes(part.category) ||
      (label === 'Control' && !COLUMNS.some((column) => column.types.includes(part.category)))),
  })).filter((column) => column.parts.length);
  const columnByPart = new Map(columns.flatMap((column, index) => column.parts.map((part) => [part.id, index])));
  const slots = new Map();
  const wireElements = new Map();
  const partElements = new Map();
  const pinElements = new Map();
  const cards = [];
  const columnX = (index) => MARGIN + index * (CARD_W + COL_GAP);
  let end = TOP + 96;

  for (const [index, column] of columns.entries()) {
    const x = columnX(index);
    let y = TOP;
    for (const part of column.parts) {
      const sides = [[], []];
      for (const pin of part.pins) {
        const links = neighbors.get(pin.key);
        if (!showUnused && !links) continue;
        const direction = links?.reduce((sum, other) => sum + Math.sign(columnByPart.get(other) - index), 0) || 0;
        const right = direction ? direction > 0 : links ? index > 0 : sides[0].length > sides[1].length;
        sides[Number(right)].push(pin);
      }
      const rows = Math.max(sides[0].length, sides[1].length);
      const { name, lines } = cardTitle(part);
      const extra = lines.length > 1 ? 15 : 0;
      const h = (rows ? 53 + rows * ROW : 52) + extra;
      for (const [right, pins] of sides.entries()) for (const [i, pin] of pins.entries()) {
        slots.set(pin.key, { x: x + (right ? CARD_W : 0), y: y + extra + 58 + i * ROW, right });
      }
      cards.push({ part, name, lines, extra, x, y, h, pins: sides.flat() });
      y += h + 22;
    }
    end = Math.max(end, y - 22);
  }

  const width = 2 * MARGIN + columns.length * CARD_W + Math.max(0, columns.length - 1) * COL_GAP;
  const height = end + 58;
  const svg = svgCanvas('Circuit sketch', width, height);
  svg.classList.add('sketch-diagram');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('font-family', 'system-ui, sans-serif');
  const gridId = `sketch-grid-${nextGrid++}`;
  svg.append(
    s('defs', null, s('pattern', { id: gridId, width: 16, height: 16, patternUnits: 'userSpaceOnUse' },
      s('circle', { cx: 1, cy: 1, r: .8, fill: palette.grid }))),
    s('rect', { width, height, fill: palette.paper }),
    s('rect', { width, height, fill: `url(#${gridId})` }));

  for (const [index, { label }] of columns.entries()) {
    const x = columnX(index);
    svg.append(
      s('text', { x, y: 33, fill: palette.sub, 'font-size': 12, 'font-weight': 650, 'letter-spacing': '.03em' }, label),
      s('path', { d: `M${x},43 h${CARD_W}`, stroke: palette.border }));
  }

  for (const [index, wire] of connected.entries()) {
    const from = slots.get(wire.fromKey);
    const to = slots.get(wire.toKey);
    if (!from || !to) continue;
    const info = check.wireInfo[wire.id] || {};
    const d = route(from, to, index, width, height);
    const color = wireColor(info.color);
    const group = s('g', { 'data-wire': wire.id, 'data-wire-kind': connectionKind(info.role) },
      s('path', { d, fill: 'none', stroke: palette.paper, 'stroke-width': 4.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'sk-wire-keyline' }),
      s('path', { class: 'sk-wire', d, fill: 'none', stroke: color, 'stroke-width': info.role === 'power' ? 2.7 : 2.05,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': info.role === 'ground' ? '4.5 3' : undefined }),
      app ? s('path', { class: 'sk-wire-hit', d }) : null);
    if (app) selectable(app, group, 'wire', wire.id, `${wire.label || wire.id} · ${wire.fromKey} → ${wire.toKey}`, () => app.wireTooltipHtml(wire.id));
    svg.append(group);
    wireElements.set(wire.id, group);
  }

  for (const { part, name, lines, extra, x, y, h: cardHeight, pins } of cards) {
    const group = s('g', { class: 'sk-part', 'data-part': part.id },
      s('rect', { x: x + 1, y: y + 2, width: CARD_W, height: cardHeight, rx: 8, fill: '#23395a', opacity: .07 }),
      s('rect', { x, y, width: CARD_W, height: cardHeight, rx: 8, fill: palette.card, stroke: palette.border, class: 'sk-card-body' }),
      s('rect', { x: x + 13, y: y + 13, width: 7, height: 7, rx: 1.8, fill: partColor(part) }),
      s('text', { x: x + 25, y: y + 20, fill: palette.sub, 'font-size': 10, 'font-weight': 560 }, CATEGORY_LABEL[part.category] || 'Component'),
      lines.map((line, index) => s('text', {
        x: x + 13, y: y + 38 + index * 15, fill: palette.ink, 'font-size': 13.5, 'font-weight': 680,
      }, line)),
      pins.length ? s('path', { d: `M${x + 12},${y + 45 + extra} h${CARD_W - 24}`, stroke: palette.border, opacity: .7 }) : null);
    if (app) selectable(app, group, 'part', part.id, name);
    else group.append(s('title', null, name));
    svg.append(group);
    partElements.set(part.id, group);
    for (const pin of pins) {
      const pos = slots.get(pin.key);
      const label = pin.label || pin.name;
      const shortLabel = label.replace(/\s+\((?:red|black|brown|orange|yellow|blue|white|green|purple)\)$/i, '');
      const attached = neighbors.has(pin.key);
      const pinGroup = s('g', { class: 'sk-pin', 'data-pin': pin.key },
        s('rect', { x: pos.x + (pos.right ? -88 : -5), y: pos.y - 9, width: 93, height: 18, fill: 'transparent' }),
        s('circle', { class: 'pin-dot', cx: pos.x, cy: pos.y, r: 3.8, fill: palette.card, stroke: attached ? palette.sub : palette.border, 'stroke-width': 1.35 }),
        s('text', { x: pos.x + (pos.right ? -9 : 9), y: pos.y + 3.7, 'text-anchor': pos.right ? 'end' : 'start',
          fill: attached ? palette.ink : palette.sub, 'font-size': 10.5, 'font-weight': attached ? 560 : 400 }, trunc(shortLabel, 14)));
      if (app) selectable(app, pinGroup, 'pin', pin.key, `${name} · ${label}`, () => app.pinTooltipHtml(pin.key));
      svg.append(pinGroup);
      pinElements.set(pin.key, { el: pinGroup, part: part.id });
    }
  }

  return { svg, width, height, wireElements, partElements, pinElements };
}

export function sketchThumb(check) {
  return drawSketch(check, null).svg;
}

export class SketchView {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.scale = null;
    this.connection = 'all';
    this.showUnused = false;
    this.resize = new ResizeObserver(() => this.resizeToViewport());
  }

  render() {
    const check = this.app.data.check;
    const oldScroll = this.scroller && [this.scroller.scrollLeft, this.scroller.scrollTop];
    this.resize.disconnect();
    clear(this.host);
    this.host.classList.add('sketch-view');
    if (!check.model.partList.length) {
      this.drawing = null;
      this.host.append(emptyView('No parts to draw', 'Add parts and wire connections to the project file.'));
      return;
    }
    this.drawing = drawSketch(check, this.app, this.showUnused);
    const options = [['all', 'All wires'], ['power', 'Power'], ['ground', 'Ground'], [SIGNAL, 'Signals']];
    const filter = h('select', { 'aria-label': 'Filter wires', onchange: (event) => {
      this.connection = event.target.value;
      this.applyFilter();
    } }, options.map(([value, label]) => h('option', { value, selected: value === this.connection }, label)));
    this.count = h('span.sketch-count', { role: 'status' });
    const unused = h('input', { type: 'checkbox', checked: this.showUnused, onchange: (event) => {
      this.showUnused = event.target.checked;
      this.render();
      this.host.querySelector('.sketch-unused input')?.focus();
      this.applyFocus(this.app.focus);
    } });
    this.drawing.svg.addEventListener('click', () => this.app.clearSelection());
    this.scroller = h('div.sketch-viewport', { tabindex: '0', role: 'region', 'aria-label': 'Scrollable circuit diagram' }, this.drawing.svg);
    this.host.append(
      h('div.sketch-controls', null, h('label.sketch-filter', null, 'Show', filter), this.count,
        h('label.sketch-unused', null, unused, 'Unused pins')),
      this.scroller);
    this.resize.observe(this.scroller);
    this.resizeToViewport();
    this.applyFilter();
    if (oldScroll) this.scroller.scrollTo(...oldScroll);
  }

  setScale(scale) {
    this.scale = scale;
    this.resizeToViewport();
    if (scale === 0) this.scroller?.scrollTo(0, 0);
  }

  resizeToViewport() {
    if (!this.drawing || !this.scroller) return;
    const { svg, width, height } = this.drawing;
    const { clientWidth, clientHeight } = this.scroller;
    if (!clientWidth || !clientHeight) return;
    const fit = Math.min(1, clientWidth / width, clientHeight / height);
    // In a narrow mobile viewport keep labels readable on the first visit.
    // Fit still zooms out for a whole-diagram overview on demand.
    const readable = Math.min(1, 480 / width);
    const scale = this.scale === 1 ? 1
      : this.scale === null && clientWidth < 500 ? Math.max(fit, readable) : fit;
    svg.style.width = `${width * scale}px`;
  }

  applyFilter() {
    let total = 0;
    for (const el of this.drawing.wireElements.values()) {
      const visible = this.connection === 'all' || el.dataset.wireKind === this.connection;
      el.style.display = visible ? '' : 'none';
      if (visible) total++;
    }
    const all = this.drawing.wireElements.size;
    this.count.textContent = this.connection === 'all' ? `${all} ${all === 1 ? 'wire' : 'wires'}` : `${total} of ${all} wires`;
  }

  applyFocus(focus) {
    if (!this.drawing || !focus) return;
    const dim = activeFocus(focus);
    for (const [id, el] of this.drawing.wireElements) markFocus(el, dim && !focus.wires.has(id), focus.wires.has(id));
    for (const [id, el] of this.drawing.partElements) markFocus(el, dim && !focus.parts.has(id), focus.parts.has(id));
    for (const [id, { el, part }] of this.drawing.pinElements) {
      const lit = focus.pins.has(id) || (!focus.pins.size && focus.parts.has(part));
      markFocus(el, dim && !lit, lit);
    }
  }

  tools() {
    return [tool('Fit', 'fit', () => this.setScale(0)), tool('Actual size', 'plus', () => this.setScale(1), '1:1'), tool('SVG', 'download', () => this.saveSvg())];
  }

  destroy() { this.resize.disconnect(); }

  saveSvg() {
    if (!this.drawing) return;
    const svg = this.drawing.svg.cloneNode(true);
    svg.removeAttribute('style');
    svg.removeAttribute('xmlns');
    for (const el of svg.querySelectorAll('.sk-wire-hit')) el.remove();
    for (const el of svg.querySelectorAll('[data-wire], .dimmed, .lit')) {
      el.classList.remove('dimmed', 'lit');
      el.removeAttribute('style');
    }
    for (const el of svg.querySelectorAll('[tabindex], [fill^="var("], [stroke^="var("]')) {
      // Keep the export portable across SVG editors without page styles.
      el.removeAttribute('tabindex');
      el.removeAttribute('role');
      for (const attr of ['fill', 'stroke']) {
        const fallback = el.getAttribute(attr)?.match(/^var\(--[\w-]+, (.+)\)$/)?.[1];
        if (fallback) el.setAttribute(attr, fallback);
      }
    }
    download(`${this.app.data.name}-sketch.svg`, new XMLSerializer().serializeToString(svg), 'image/svg+xml');
  }
}
