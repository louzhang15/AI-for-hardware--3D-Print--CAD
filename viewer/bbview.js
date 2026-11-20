import { RAIL_NAMES, RAIL_Y, ROW_LETTERS, ROW_Y, holeName } from '/lib/breadboard.js';
import { clear, clamp, h, s } from './util.js';
import { activeFocus, emptyView, markFocus, selectable, svgCanvas, tool } from './svg-view.js';

const PITCH = 16;
const LEFT = 38;
const TOP = 82;
const BOARD_BOTTOM = 332;

export class BreadboardView {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.stepIndex = -1;
    this.tableOpen = false;
  }

  render() {
    const { bb, bbError } = this.app.data;
    clear(this.host);
    if (!bb?.boards?.length) {
      this.layout = null;
      this.host.append(emptyView('No breadboard layout', bbError || 'Set a breadboard model in the project file to generate a hole-by-hole layout.'));
      return;
    }
    this.layout = bb;
    if (this.tableOpen) {
      this.renderTable();
      return;
    }

    this.holes = new Map();
    this.jumpers = new Map();
    this.parts = new Map();
    const layoutWidth = Math.max(480, ...bb.boards.map((board) => LEFT * 2 + (board.x0 + board.columns) * PITCH));
    const offboard = [...new Set(bb.jumpers.flatMap((wire) => [wire.from, wire.to]).filter((end) => typeof end === 'string' && end.includes('.')))];
    const columns = Math.max(1, Math.floor((layoutWidth - 30) / 150));
    const height = BOARD_BOTTOM + 32 + Math.ceil(offboard.length / columns) * 42;
    const svg = svgCanvas('Breadboard hole layout', layoutWidth, height);
    svg.style.width = `${layoutWidth}px`;
    svg.append(s('rect', { width: layoutWidth, height, fill: 'var(--bg-2)' }));
    const addHole = (parent, name, x, y, color) => {
      const circle = s('circle', { class: 'bb-hole', cx: x, cy: y, r: 2.75, fill: color, 'data-hole': name }, s('title', null, name));
      this.holes.set(name, { circle, x, y });
      parent.append(circle);
    };

    for (const [index, board] of bb.boards.entries()) {
      const offset = LEFT + board.x0 * PITCH;
      const boardWidth = (board.columns - 1) * PITCH;
      svg.append(s('text', { x: offset, y: 16, class: 'bb-label' }, `${board.id} · ${board.model}${board.split ? ' · split rails' : ''}`));
      svg.append(s('rect', { x: offset - 22, y: TOP - 64, width: boardWidth + 44, height: 298, rx: 9, fill: '#e0e6ee', stroke: '#9caaba' }));
      svg.append(s('rect', { x: offset - 10, y: TOP + 4.7 * PITCH, width: boardWidth + 20, height: 1.6 * PITCH, fill: '#c6cdd7', rx: 3 }));
      const rows = [...ROW_LETTERS, ...RAIL_NAMES];
      for (const row of rows) {
        const rail = RAIL_NAMES.includes(row);
        const y = TOP + (rail ? RAIL_Y[row] : ROW_Y[row]) * PITCH;
        const railColor = row.endsWith('+') ? '#cf3f49' : '#3163b3';
        const middle = Math.floor(board.columns / 2);
        if (rail) {
          const segments = board.split ? [[0, middle - 1], [middle, board.columns - 1]] : [[0, board.columns - 1]];
          for (const [start, end] of segments) svg.append(s('line', { x1: offset + start * PITCH - 4, y1: y + 6, x2: offset + end * PITCH + 4, y2: y + 6,
            stroke: railColor, 'stroke-width': 1.25 }));
          const label = bb.rails?.[row]?.label;
          if (label) svg.append(s('text', { x: offset + 20, y: y - 5, fill: railColor, 'font-size': 8.5 }, label));
        }
        svg.append(s('text', { x: offset - 14, y: y + 3, fill: rail ? railColor : '#536072', 'font-size': 8, 'text-anchor': 'middle' }, rail ? row.slice(-1) : row));
        for (let col = 1; col <= board.columns; col++) {
          const x = offset + (col - 1) * PITCH;
          if (row === 'a' && (col === 1 || col === board.columns || col % 5 === 0)) {
            svg.append(s('text', { x, y: y - 10, fill: '#536072', 'font-size': 8, 'text-anchor': 'middle' }, col));
          }
          addHole(svg, holeName(row, col, index + 1), x, y, rail ? railColor : '#485665');
        }
      }
    }

    for (const [index, key] of offboard.entries()) {
      const x = LEFT + (index % columns) * 150;
      const y = BOARD_BOTTOM + Math.floor(index / columns) * 42;
      const pin = s('g', { class: 'sk-pin' }, s('rect', { x: x - 8, y: y + 5, width: 143, height: 20, rx: 4, fill: 'var(--panel-2)' }),
        s('text', { x, y: y + 19, class: 'bb-label' }, key.length > 23 ? `${key.slice(0, 22)}…` : key));
      addHole(pin, key, x, y, 'var(--accent)');
      selectable(this.app, pin, 'pin', key, this.app.pinText(key), () => this.app.pinTooltipHtml(key));
      svg.append(pin);
    }

    for (const [id, part] of Object.entries(bb.placements || {})) {
      const holes = Object.values(part.holes).map((name) => this.holes.get(name)).filter(Boolean);
      if (!holes.length) continue;
      const minX = Math.min(...holes.map((hole) => hole.x)) - 6;
      const minY = Math.min(...holes.map((hole) => hole.y)) - 6;
      const size = Math.max(...holes.map((hole) => hole.x)) - minX + 6;
      const partGroup = s('g', { class: 'sk-part', 'data-part': id },
        s('rect', { x: minX, y: minY, width: size, height: Math.max(...holes.map((hole) => hole.y)) - minY + 6, rx: 4, fill: '#293d54', opacity: .85 }),
        size > 30 ? s('text', { x: minX + size / 2, y: minY + 9, fill: '#fff', 'font-size': 8, 'text-anchor': 'middle' }, id) : null);
      for (const [pin, hole] of Object.entries(part.holes)) {
        const point = this.holes.get(hole);
        if (point) partGroup.append(s('circle', { cx: point.x, cy: point.y, r: 2, fill: '#f4d888' }, s('title', null, `${id}.${pin} · ${hole}`)));
      }
      selectable(this.app, partGroup, 'part', id, `Part ${id}`);
      svg.append(partGroup);
      this.parts.set(id, partGroup);
    }

    for (const [index, wire] of bb.jumpers.entries()) {
      const start = this.holes.get(wire.from);
      const end = this.holes.get(wire.to);
      if (!start || !end) continue;
      const lift = 20 + (index % 6) * 8;
      const d = `M${start.x},${start.y} C${start.x + lift},${start.y - lift} ${end.x - lift},${end.y - lift} ${end.x},${end.y}`;
      const color = wire.color === 'black' ? '#3b4654' : wire.color || '#4f83c6';
      const group = s('g', { 'data-jumper': wire.id }, s('path', { class: 'sk-wire', d, stroke: color, 'stroke-width': 2.4 }),
        s('circle', { cx: start.x, cy: start.y, r: 3.5, fill: color }), s('circle', { cx: end.x, cy: end.y, r: 3.5, fill: color }));
      if (wire.wire) {
        group.append(s('path', { class: 'sk-wire-hit', d }));
        selectable(this.app, group, 'wire', wire.wire, `${wire.from} → ${wire.to}`, () => this.app.wireTooltipHtml(wire.wire));
      } else group.append(s('title', null, `${wire.from} → ${wire.to}`));
      svg.append(group);
      this.jumpers.set(wire.id, group);
    }

    const viewport = h('div.bb-viewport.diagram-scroll', null, svg);
    this.guide = h('div.bb-guide');
    this.host.append(h('div.bb-wrap', null, this.guide, viewport));
    this.renderGuide();
    this.applyFocus(this.app.focus);
  }

  renderGuide() {
    const steps = this.layout.steps || [];
    this.stepIndex = clamp(this.stepIndex, -1, steps.length - 1);
    const step = steps[this.stepIndex];
    clear(this.guide).append(
      tool('Previous', 'left', () => this.move(-1)),
      h('div.bb-guide-text', null, h('strong', null, step ? `${this.stepIndex + 1}/${steps.length} · ${step.title}` : 'Breadboard overview'),
        h('div.small.muted', null, step?.text || `${this.layout.errors || 0} errors and ${this.layout.warnings || 0} warnings. Select Next to follow the board layout.`)),
      tool('Next', 'right', () => this.move(1)));
    const buttons = this.guide.querySelectorAll('button');
    buttons[0].disabled = this.stepIndex < 0;
    buttons[1].disabled = this.stepIndex >= steps.length - 1;
  }

  move(direction) {
    this.stepIndex += direction;
    this.renderGuide();
    this.applyFocus(this.app.focus);
    const hole = (this.layout.steps[this.stepIndex]?.holes || []).map((id) => this.holes.get(id)).find(Boolean);
    if (hole) hole.circle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  applyFocus(focus) {
    if (!this.layout || this.tableOpen) return;
    const step = this.layout.steps?.[this.stepIndex];
    const holes = new Set(step?.holes || []);
    for (const [id, { circle }] of this.holes) circle.classList.toggle('bb-hole-active', holes.has(id));
    const relevant = new Set([...focus.wires].flatMap((wire) => this.layout.wireJumpers?.[wire] || []));
    const dim = activeFocus(focus) || Boolean(step);
    for (const [id, element] of this.jumpers) {
      const lit = step ? step.jumper === id : relevant.has(id);
      markFocus(element, dim && !lit, lit);
    }
    for (const [id, element] of this.parts) {
      const lit = step ? step.part === id : focus.parts.has(id);
      markFocus(element, dim && !lit, lit);
    }
  }

  renderTable() {
    const rows = this.layout.table || [];
    const table = h('table.bb-table', null,
      h('thead', null, h('tr', null, ['Part or jumper', 'Pin / colour', 'Hole or endpoints', 'Net', 'Length'].map((label) => h('th', { scope: 'col' }, label)))),
      h('tbody', null, rows.map((row) => h('tr', null,
        h('td', null, row.part || row.id), h('td', null, row.label || row.pin || row.color),
        h('td.hole', null, row.hole || `${row.from} → ${row.to}`), h('td', null, row.net), h('td', null, row.len_mm == null ? '' : `${row.len_mm} mm`)))));
    this.host.append(h('div.bb-table-wrap', null, h('h2', null, 'Breadboard connections'), table));
  }

  tools() {
    if (!this.layout) return null;
    return [tool(this.tableOpen ? 'Diagram' : 'Hole table', 'steps', () => { this.tableOpen = !this.tableOpen; this.render(); this.app.renderCenterBar(); }),
      this.tableOpen && tool('Print', 'print', () => window.print())];
  }
}
