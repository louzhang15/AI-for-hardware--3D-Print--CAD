import { clear, download, partColor, s } from './util.js';
import { activeFocus, emptyView, markFocus, selectable, svgCanvas, tool } from './svg-view.js';

const WIDTH = 228;
const GAP = 94;
const ROW = 19;

function drawSketch(check, app) {
  const { partList, wires } = check.model;
  const connected = wires.filter((wire) => wire.valid);
  const slots = new Map();
  const wireElements = new Map();
  const partElements = new Map();
  const pinElements = new Map();
  const top = 44 + connected.length * 8;
  const cards = partList.map((part, index) => {
    const x = GAP + index * (WIDTH + GAP);
    const split = Math.ceil(part.pins.length / 2);
    const sides = [[], []];
    for (const [i, pin] of part.pins.entries()) {
      const right = Array.isArray(pin.pos) ? Number(pin.pos[0] >= part.size[0] / 2) : Number(i >= split);
      sides[right].push(pin);
    }
    const height = 54 + Math.max(...sides.map((pins) => pins.length), 1) * ROW;
    for (const [right, pins] of sides.entries()) for (const [i, pin] of pins.entries()) {
      slots.set(pin.key, { x: x + (right ? WIDTH : 0), y: top + 42 + i * ROW, right });
    }
    return { part, x, height };
  });
  const width = Math.max(420, GAP + partList.length * (WIDTH + GAP));
  const height = top + Math.max(...cards.map((card) => card.height), 160) + 44;
  const svg = svgCanvas('Circuit sketch', width, height);
  svg.append(s('rect', { width, height, fill: 'var(--bg-2, #171b21)' }));

  function route(from, to, index) {
    const offset = 20 + index % 9 * 5;
    const ax = from.x + (from.right ? offset : -offset);
    const bx = to.x + (to.right ? offset : -offset);
    const y = 28 + index * 8;
    return `M${from.x},${from.y} H${ax} V${y} H${bx} V${to.y} H${to.x}`;
  }

  for (const [index, wire] of connected.entries()) {
    const from = slots.get(wire.fromKey);
    const to = slots.get(wire.toKey);
    if (!from || !to) continue;
    const info = check.wireInfo[wire.id] || {};
    const d = route(from, to, index);
    const color = info.color || '#6684ac';
    const group = s('g', { 'data-wire': wire.id },
      info.role === 'ground' ? s('path', { class: 'sk-wire', d, fill: 'none', stroke: '#9ca6b3', 'stroke-width': 4 }) : null,
      s('path', { class: 'sk-wire', d, fill: 'none', stroke: color, 'stroke-width': info.role === 'power' ? 3.5 : 2.5 }),
      s('path', { class: 'sk-wire-hit', d }));
    if (app) selectable(app, group, 'wire', wire.id, `${wire.label || wire.id} · ${wire.fromKey} → ${wire.toKey}`, () => app.wireTooltipHtml(wire.id));
    svg.append(group);
    wireElements.set(wire.id, group);
  }

  for (const { part, x, height: cardHeight } of cards) {
    const name = part.label || part.name || part.id;
    const group = s('g', { class: 'sk-part', 'data-part': part.id },
      s('rect', { x, y: top, width: WIDTH, height: cardHeight, rx: 10, fill: partColor(part), stroke: '#8193a9', 'stroke-opacity': .65 }),
      s('text', { x: x + WIDTH / 2, y: top + 19, fill: '#fff', 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700 }, name.length > 31 ? `${name.slice(0, 30)}…` : name));
    if (app) selectable(app, group, 'part', part.id, name);
    svg.append(group);
    partElements.set(part.id, group);
    for (const pin of part.pins) {
      const pos = slots.get(pin.key);
      const info = check.pinInfo?.[pin.key] || {};
      const label = pin.label || pin.name;
      const pinGroup = s('g', { class: 'sk-pin', 'data-pin': pin.key },
        s('rect', { x: pos.x + (pos.right ? -102 : -7), y: pos.y - 9, width: 109, height: 18, fill: 'transparent' }),
        s('circle', { class: 'pin-dot', cx: pos.x, cy: pos.y, r: 4, fill: info.connected ? '#f8f9fa' : '#64738b', stroke: '#19222d', 'stroke-width': 1.4 }),
        s('text', { x: pos.x + (pos.right ? -9 : 9), y: pos.y + 3.5, 'text-anchor': pos.right ? 'end' : 'start',
          fill: '#fff', opacity: info.connected ? 1 : .65, 'font-size': 10.5 }, label.length > 17 ? `${label.slice(0, 16)}…` : label));
      if (app) selectable(app, pinGroup, 'pin', pin.key, `${name} · ${label}`, () => app.pinTooltipHtml(pin.key));
      svg.append(pinGroup);
      pinElements.set(pin.key, { el: pinGroup, part: part.id });
    }
  }

  return { svg, width, wireElements, partElements, pinElements };
}

export function sketchThumb(check) {
  return drawSketch(check, null).svg;
}

export class SketchView {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.scale = 1;
  }

  render() {
    const check = this.app.data.check;
    clear(this.host);
    if (!check.model.partList.length) {
      this.drawing = null;
      this.host.append(emptyView('No parts to draw', 'Add parts and wire connections to the project file.'));
      return;
    }
    this.drawing = drawSketch(check, this.app);
    this.drawing.svg.addEventListener('click', () => this.app.clearSelection());
    this.host.classList.add('diagram-scroll');
    this.host.append(this.drawing.svg);
    this.setScale(this.scale);
  }

  setScale(scale) {
    this.scale = scale;
    if (this.drawing) this.drawing.svg.style.width = scale === 0 ? '100%' : `${this.drawing.width * scale}px`;
  }

  applyFocus(focus) {
    if (!this.drawing) return;
    const dim = activeFocus(focus);
    for (const [id, el] of this.drawing.wireElements) markFocus(el, dim && !focus.wires.has(id), focus.wires.has(id));
    for (const [id, el] of this.drawing.partElements) markFocus(el, dim && !focus.parts.has(id), focus.parts.has(id));
    for (const [id, { el, part }] of this.drawing.pinElements) {
      const lit = focus.pins.has(id) || (!focus.pins.size && focus.parts.has(part));
      markFocus(el, dim && !lit, lit);
    }
  }

  tools() {
    return [tool('Fit', 'fit', () => this.setScale(0)), tool('Actual size', 'plus', () => this.setScale(1)), tool('SVG', 'download', () => this.saveSvg())];
  }

  saveSvg() {
    if (!this.drawing) return;
    const svg = this.drawing.svg.cloneNode(true);
    svg.removeAttribute('style');
    svg.setAttribute('width', this.drawing.width);
    svg.setAttribute('height', this.drawing.svg.viewBox.baseVal.height);
    for (const el of svg.querySelectorAll('.sk-wire-hit')) el.remove();
    for (const el of svg.querySelectorAll('.dimmed, .lit')) el.classList.remove('dimmed', 'lit');
    download(`${this.app.data.name}-sketch.svg`, new XMLSerializer().serializeToString(svg), 'image/svg+xml');
  }
}
