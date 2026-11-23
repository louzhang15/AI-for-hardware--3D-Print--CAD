// Pin and wire editing from the viewer: move a wire end to another pin, add a
// wire from a pin, delete or recolour a wire. Every candidate pin is checked
// in the browser first (lib/edit.js + lib/check.js), so the list shows which
// pins add a problem before anything is written. The server writes the file
// and keeps an undo stack (.wiremap/history/<project>.jsonl).
import { h, clear, icon, postJSON, toast } from './util.js';
import { applyWireEdit, pinOptions } from '/lib/edit.js';
import { checkProject } from '/lib/check.js';
import { ROLE_COLORS } from '/lib/nets.js';

const ANY = '__any__';
const WIRE_COLORS = ['red', 'black', 'blue', 'yellow', 'orange', 'green', 'purple', 'brown', 'white'];
const COLOR_HEX = Object.fromEntries(Object.values(ROLE_COLORS).map((c) => [c.name, c.hex]));
COLOR_HEX.green = COLOR_HEX.green || '#30a46c';
COLOR_HEX.brown = COLOR_HEX.brown || '#a0703c';

const route = (app, tail = '') => `/api/project/${encodeURIComponent(app.data.name)}/wire${tail}`;

/** Toast with an Undo button that pops the server's undo stack. */
function undoToast(app, message) {
  document.getElementById('pe-toast')?.remove();
  const el = h('div#pe-toast.pe-toast', { role: 'status', 'aria-live': 'polite' },
    h('span', null, message),
    h('button.btn.small', { type: 'button', onclick: async () => {
      el.remove();
      try { await postJSON(route(app, '/undo'), {}); toast('Undone', 'ok'); }
      catch (e) { toast(`Undo failed: ${e.message.replace(/^\d+: /, '')}`, 'error'); }
    } }, 'Undo'));
  document.body.append(el);
  setTimeout(() => el.remove(), 9000);
}

async function send(app, op, done) {
  try {
    await postJSON(route(app), op);
    app.closeModal();
    undoToast(app, done);
  } catch (e) {
    toast(`Not saved: ${e.message.replace(/^\d+: /, '')}`, 'error');
  }
}

/** Options for a new wire from `fromKey` to every pin of `part`. */
export function addOptions(project, library, fromKey, part) {
  const fast = { mechanics: false };
  const base = checkProject(project, library, fast);
  // Same rule, level, wires and parts = the same problem, even if its text names a moved pin.
  const key = (i) => `${i.rule}|${i.level}|${[...(i.wires || [])].sort()}|${[...(i.parts || [])].sort()}`;
  const before = new Set(base.issues.filter((i) => i.level !== 'info').map(key));
  const parts = part ? [base.model.parts.get(part)].filter(Boolean) : base.model.partList;
  const out = [];
  for (const pd of parts) {
    for (const pin of pd.pins) {
      const ep = `${pd.id}.${pin.name}`;
      if (ep === fromKey) continue;
      let res, wire;
      try {
        const r = applyWireEdit(project, library, { op: 'add', from: fromKey, to: ep });
        wire = r.wire;
        res = checkProject(r.project, library, fast);
      } catch { continue; }
      const added = res.issues.filter((i) => i.level !== 'info' && !before.has(key(i)));
      const errors = added.filter((i) => i.level === 'error').length;
      const role = res.wireInfo?.[wire.id]?.role || null;
      out.push({ endpoint: ep, part: pd.id, pin: pin.name, label: pin.label || pin.name, kind: pin.kind,
        used: Boolean(base.pinInfo?.[ep]?.connected), role, color: role ? ROLE_COLORS[role]?.name : undefined,
        errors, warnings: added.length - errors, problems: added.slice(0, 3).map((i) => ({ level: i.level, message: i.message })) });
    }
  }
  out.sort((a, b) => a.errors - b.errors || a.warnings - b.warnings || Number(a.used) - Number(b.used) || a.endpoint.localeCompare(b.endpoint));
  return out;
}

/**
 * Open the pin picker.
 *   mode 'move': { wireId, end: 'from'|'to' }   move one end of a wire
 *   mode 'add':  { fromKey }                     new wire from this pin
 */
export function openPinPicker(app, { mode = 'move', wireId, end, fromKey } = {}) {
  const project = app.data.project;
  const library = app.library;
  const parts = app.data.check.model.partList;
  const wire = mode === 'move' ? project.wires.find((w) => w.id === wireId) : null;
  if (mode === 'move' && !wire) return;
  const current = mode === 'move' ? wire[end] : fromKey;
  const fixed = mode === 'move' ? wire[end === 'from' ? 'to' : 'from'] : fromKey;
  const startPart = mode === 'move' ? current.split('.')[0] : (parts.find((p) => !fromKey.startsWith(`${p.id}.`))?.id || parts[0]?.id);

  const sel = h('select.pe-part', { 'aria-label': 'Part' },
    parts.map((p) => h('option', { value: p.id, selected: p.id === startPart }, app.shortName(p))),
    h('option', { value: ANY }, 'Any part (slower)'));
  const filter = h('input.pe-filter', { type: 'search', placeholder: 'Filter pins, e.g. GPIO or SDA', 'aria-label': 'Filter pins' });
  const list = h('div.pe-list', { role: 'listbox', 'aria-label': 'Pins, safest first' });
  const status = h('p.pe-status', { 'aria-live': 'polite' });
  let rows = [];
  let armed = null;

  const verdict = (o) => {
    if (!o.errors && !o.warnings) return h('span.pe-ok', null, icon('check', 13), 'No new problems');
    const p = o.problems[0];
    return h(`span.pe-bad.${o.errors ? 'error' : 'warn'}`, null, icon('alert', 13), p ? p.message : `${o.errors} errors`);
  };

  const apply = (o) => {
    if (o.errors && armed !== o.endpoint) {
      armed = o.endpoint;
      draw();
      const el = list.querySelector('.pe-row.armed');
      el?.scrollIntoView({ block: 'nearest' });
      el?.focus({ preventScroll: true });
      status.textContent = `${o.endpoint} adds ${o.errors} error${o.errors === 1 ? '' : 's'}. Click it again to use it anyway.`;
      return;
    }
    const color = o.color && WIRE_COLORS.includes(o.color) ? o.color : undefined;
    if (mode === 'move') send(app, { op: 'move', id: wireId, end, to: o.endpoint, color }, `${wireId} now goes to ${app.pinText(o.endpoint)}.`);
    else send(app, { op: 'add', from: fromKey, to: o.endpoint, color }, `New wire: ${app.pinText(fromKey)} to ${app.pinText(o.endpoint)}.`);
  };

  function draw() {
    const q = filter.value.trim().toLowerCase();
    const shown = rows.filter((o) => !q || `${o.endpoint} ${o.label} ${o.kind}`.toLowerCase().includes(q));
    clear(list);
    if (!shown.length) { list.append(h('p.pe-empty', null, rows.length ? 'No pin matches the filter.' : 'No pins on this part.')); return; }
    for (const o of shown) {
      const swatch = o.color ? COLOR_HEX[o.color] : 'transparent';
      list.append(h(`button.pe-row${o.errors ? '.has-error' : ''}${armed === o.endpoint ? '.armed' : ''}`, {
        type: 'button', role: 'option', 'aria-selected': 'false', onclick: () => apply(o),
        title: o.problems.map((p) => p.message).join('\n') || 'No new problems',
      },
      h('span.pe-sw', { style: { background: swatch }, title: o.role || 'no role' }),
      h('span.pe-name', null,
        h('b', null, sel.value === ANY ? `${app.shortName(app.part(o.part))} ${o.label}` : o.label),
        o.label !== o.pin ? h('span.pe-pin', null, o.pin) : null,
        h('span.pe-kind', null, (o.kind || '').replace(/_/g, ' ')),
        o.used ? h('span.pe-used', null, 'in use') : null),
      verdict(o)));
    }
  }

  function compute() {
    status.textContent = 'Checking every pin…';
    clear(list).append(h('div.pe-loading', null, h('span.pe-spin'), 'Running the checker on each pin'));
    armed = null;
    setTimeout(() => {
      const t0 = performance.now();
      const part = sel.value === ANY ? undefined : sel.value;
      try {
        rows = mode === 'move' ? pinOptions(project, library, { id: wireId, end, part }) : addOptions(project, library, fromKey, part);
      } catch (e) { rows = []; status.textContent = `Could not check: ${e.message}`; draw(); return; }
      const safe = rows.filter((o) => !o.errors && !o.warnings).length;
      status.textContent = `${rows.length} pins checked in ${Math.round(performance.now() - t0)} ms. ${safe} add no new problem. Safest first.`;
      draw();
      list.querySelector('.pe-row')?.focus();
    }, 20);
  }
  sel.addEventListener('change', compute);
  filter.addEventListener('input', draw);
  list.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const items = [...list.querySelectorAll('.pe-row')];
    const i = items.indexOf(document.activeElement);
    const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { e.preventDefault(); next.focus(); }
  });

  const title = mode === 'move' ? `Move the ${end === 'from' ? 'start' : 'end'} of ${wire.label || wireId}` : `Connect ${app.pinText(fromKey)} to…`;
  app.openModal({
    title,
    body: [
      h('p.pe-sub', null, mode === 'move'
        ? ['Now: ', h('b', null, app.pinText(current)), '. The other end stays on ', h('b', null, app.pinText(fixed)), '.']
        : ['Pick the pin the new wire goes to. Each pin is checked before you choose.']),
      h('div.pe-controls', null, h('label', null, 'Part', sel), h('label', null, 'Filter', filter)),
      status, list,
    ],
    actions: [h('button.btn.ghost', { type: 'button', onclick: () => app.closeModal() }, 'Cancel')],
  });
  document.querySelector('.modal')?.classList.add('pe-modal');
  compute();
}

/** Buttons for the wire info card: change either end, recolour, delete. */
export function wireEditActions(app, wireId) {
  const w = app.data.project.wires?.find((x) => x.id === wireId);
  if (!w) return null;
  const color = h('select.pe-color', { 'aria-label': 'Wire colour', onchange: (e) => send(app, { op: 'color', id: wireId, color: e.target.value }, `${wireId} is now ${e.target.value}.`) },
    WIRE_COLORS.map((c) => h('option', { value: c, selected: c === w.color }, c)),
    WIRE_COLORS.includes(w.color) ? null : h('option', { value: '', selected: true, disabled: true }, w.color || 'colour'));
  let armed = false;
  const del = h('button.btn.small.ghost.pe-del', { type: 'button', onclick: () => {
    if (!armed) { armed = true; del.textContent = 'Click again to delete'; del.classList.add('armed'); return; }
    send(app, { op: 'delete', id: wireId }, `${wireId} deleted.`);
  } }, icon('x', 14), 'Delete wire');
  return h('div.pe-actions', null,
    h('div.pe-ends', null,
      h('button.btn.small', { type: 'button', onclick: () => openPinPicker(app, { mode: 'move', wireId, end: 'from' }) }, icon('left', 14), 'Change start pin'),
      h('button.btn.small', { type: 'button', onclick: () => openPinPicker(app, { mode: 'move', wireId, end: 'to' }) }, 'Change end pin', icon('right', 14))),
    h('div.pe-ends', null, h('label.pe-color-l', null, h('span.pe-sw', { style: { background: COLOR_HEX[w.color] || 'transparent' } }), color), del));
}

/** Button for the pin info card: start a new wire from this pin. */
export function pinEditActions(app, pinKey) {
  return h('div.pe-actions', null,
    h('button.btn.small', { type: 'button', onclick: () => openPinPicker(app, { mode: 'add', fromKey: pinKey }) }, icon('plus', 14), 'Connect to…'));
}
