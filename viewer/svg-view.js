import { h, icon, s } from './util.js';

export function svgCanvas(label, width, height) {
  return s('svg', { class: 'diagram-svg', xmlns: 'http://www.w3.org/2000/svg', viewBox: `0 0 ${width} ${height}`, 'aria-label': label });
}

export function tool(label, glyph, action) {
  return h('button.btn.small', { type: 'button', title: label, 'aria-label': label, onclick: action }, icon(glyph, 14), h('span', null, label));
}

export function selectable(app, el, type, id, label, tooltip) {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', label);
  el.append(s('title', null, label));
  const activate = (event) => {
    event.preventDefault();
    event.stopPropagation();
    app.select({ type, id });
  };
  el.addEventListener('click', activate);
  el.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') activate(event); });
  if (['wire', 'part', 'pin', 'print'].includes(type)) el.addEventListener('contextmenu', (event) => {
    event.stopPropagation();
    app.contextMenu(event, { type, id });
  });
  if (tooltip) {
    el.addEventListener('pointermove', (event) => app.tooltip.show(event.clientX, event.clientY, tooltip()));
    el.addEventListener('pointerleave', () => app.tooltip.hide());
  }
  return el;
}

export function activeFocus(focus) {
  return ['parts', 'pins', 'wires', 'nets', 'prints'].some((key) => focus[key]?.size);
}

export function markFocus(el, dim, lit) {
  el.classList.toggle('dimmed', Boolean(dim));
  el.classList.toggle('lit', Boolean(lit));
}

export function emptyView(title, text) {
  return h('div.bb-empty', null, h('h3', null, title), h('p', null, text));
}
