import { s } from './util.js';

const margin = 6;
const height = 21;
const gap = 9;

function overlaps(a, b) {
  return a.x < b.x + b.width + 3 && a.x + a.width + 3 > b.x
    && a.y < b.y + height + 3 && a.y + height + 3 > b.y;
}

export function placeSceneLabels(entries, width, screenHeight, limit = 12) {
  const placed = [];
  for (const entry of entries) {
    const { anchor, size, direction } = entry;
    const [x, y] = anchor;
    const right = [x + gap, y - height / 2];
    const left = [x - size - gap, y - height / 2];
    const above = [x - size / 2, y - height - gap];
    const below = [x - size / 2, y + gap];
    const horizontal = direction?.[0] < 0 ? [left, right] : [right, left];
    const vertical = direction?.[1] > 0 ? [below, above] : [above, below];
    const verticalFirst = !direction || Math.abs(direction[1]) > Math.abs(direction[0]);
    const slots = verticalFirst ? [...vertical, ...horizontal] : [...horizontal, ...vertical];
    for (const [slotX, slotY] of slots) {
      const box = { x: slotX, y: slotY, width: size };
      if (box.x < margin || box.y < margin || box.x + size + margin > width || box.y + height + margin > screenHeight) continue;
      if (placed.some((existing) => overlaps(existing, box))) continue;
      if (entries.some(({ anchor: [px, py] }) => px >= box.x && px <= box.x + size && py >= box.y && py <= box.y + height)) continue;
      placed.push({ ...entry, ...box });
      break;
    }
    if (placed.length >= limit) break;
  }
  return placed;
}

export function createSceneLabels() {
  const layer = s('svg', { class: 'scene-labels', 'aria-hidden': 'true' });
  const measure = document.createElement('canvas').getContext('2d');
  const widths = new Map();
  if (measure) measure.font = '600 12px Consolas, monospace';

  function labelWidth(text) {
    if (!widths.has(text)) widths.set(text, Math.ceil(measure?.measureText(text).width ?? text.length * 8) + 14);
    return widths.get(text);
  }

  function render(entries, width, screenHeight) {
    const input = entries.map((label) => ({ ...label, size: labelWidth(label.text) }));
    const placed = placeSceneLabels(input, width, screenHeight);
    layer.replaceChildren(...placed.map(({ anchor: [originX, originY], x, y, width: size, text, kind, estimated, active }) => {
      const lineEndX = Math.max(x, Math.min(x + size, originX));
      const lineEndY = Math.max(y, Math.min(y + height, originY));
      return s('g', { class: `scene-label scene-label-${kind}${active ? ' active' : ''}${estimated ? ' estimated' : ''}` },
        s('line', { x1: originX, y1: originY, x2: lineEndX, y2: lineEndY }),
        s('rect', { x, y, width: size, height, rx: 4 }),
        s('text', { x: x + 7, y: y + height / 2, 'dominant-baseline': 'central' }, text));
    }));
  }

  return { layer, render };
}
