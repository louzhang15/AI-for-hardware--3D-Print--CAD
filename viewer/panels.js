// Project sidebar and the part side sheet.
import { h, clear, icon, fmtV, fmtA, fmtMoney, plural, partColor, CATEGORY_LABEL, splitKey } from './util.js';
import { renderCorrections } from './corrections.js';

const CONF = {
  verified: { label: 'Verified', tip: 'Pinout and limits come from the datasheet and a reviewed library entry.' },
  checked: { label: 'Checked', tip: 'Checked against seller pages; small variants may differ.' },
  confirm: { label: 'Confirm on your board', tip: 'Inferred or uncertain: compare the silkscreen on your board before wiring.' },
};
export function confidenceBadge(level) {
  const c = CONF[level] || CONF.checked;
  return h(`span.badge.${CONF[level] ? level : 'checked'}`, { title: c.tip }, c.label);
}

export function renderLeftPanel(app, el) {
  const d = app.data;
  const c = d.check;
  const scrollKey = `scroll:${app.ui.left}`;
  const prevBody = el.querySelector('.side-body');
  if (prevBody) el.dataset[scrollKey.replace(/\W/g, '')] = String(prevBody.scrollTop);
  clear(el);
  const counts = { error: c.errors, warning: c.warnings };
  const tab = (id, label, extra) => h(`button.tab${app.ui.left === id ? '.active' : ''}`, { role: 'tab', 'aria-selected': String(app.ui.left === id), onclick: () => app.setLeftPanel(id) }, label, extra);
  const issueCount = counts.error ? h('span.count.error', null, String(counts.error)) : counts.warning ? h('span.count.warn', null, String(counts.warning)) : null;
  el.append(h('div.tabs', { role: 'tablist' },
    tab('parts', 'Parts', h('span.count', null, String(c.model.partList.length))),
    tab('power', 'Power'),
    tab('issues', 'Issues', issueCount),
    tab('requirements', 'Requirements'),
    tab('corrections', 'Corrections')));
  const body = h('div.side-body.scroll');
  el.append(body);
  if (app.ui.left === 'power') renderPower(app, body);
  else if (app.ui.left === 'issues') renderIssues(app, body);
  else if (app.ui.left === 'requirements') renderRequirements(app, body);
  else if (app.ui.left === 'corrections') renderCorrections(app, body);
  else renderParts(app, body);
  const saved = Number(el.dataset[`scroll${app.ui.left}`] || 0);
  if (saved) body.scrollTop = saved;
  body.addEventListener('scroll', () => { el.dataset[`scroll${app.ui.left}`] = String(body.scrollTop); }, { passive: true });
}

const REQUIREMENTS = [
  ['size', 'Size'], ['payload', 'Payload'], ['runtime', 'Runtime'],
  ['budget', 'Budget'], ['power', 'Power source'], ['on_hand', 'Parts on hand'],
];

function requirementText(value, delimiter = ', ') {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(delimiter);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function renderRequirements(app, body) {
  const requirements = app.data.project.meta?.requirements || {};
  body.append(h('section.requirements-card', null,
    h('h2', null, 'Project requirements'),
    h('dl', null, REQUIREMENTS.map(([key, label]) => [
      h('dt', null, label), h('dd', null, requirementText(requirements[key]) || '—'),
    ])),
    h('button.btn.small', { onclick: () => editRequirements(app, requirements) }, 'Edit requirements')));
}

function editRequirements(app, requirements) {
  const fields = REQUIREMENTS.map(([key, label]) => {
    const value = requirementText(requirements[key], '\n');
    const input = key === 'on_hand'
      ? h('textarea', { rows: 4, placeholder: 'One item per line' })
      : h('input.input', { type: 'text', maxlength: Math.max(500, value.length) });
    input.value = value;
    return { key, label, input, value };
  });
  const error = h('p.form-error', { role: 'alert', hidden: true });
  const save = h('button.btn.primary', { form: 'requirements-form', type: 'submit' }, 'Save requirements');
  const form = h('form#requirements-form.intake-form', { onsubmit: async (event) => {
    event.preventDefault();
    save.disabled = true;
    error.hidden = true;
    const edited = fields.filter(({ input, value }) => input.value !== value);
    const changes = Object.fromEntries(edited.map(({ key, input }) => {
      const value = input.value.trim();
      return [key, !value ? null : key === 'on_hand' ? value.split('\n').map((item) => item.trim()).filter(Boolean) : value];
    }));
    try {
      if (edited.length) await app.saveRequirements(changes);
      if (form.isConnected) app.closeModal();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      save.disabled = false;
    }
  } }, fields.map(({ label, input }) => h('label.intake-field', null, label, input)), error);
  app.openModal({ title: 'Edit project requirements', body: form, actions: [
    h('button.btn.ghost', { onclick: app.closeModal }, 'Cancel'), save,
  ] });
  fields[0].input.focus();
}

// ------------------------------------------------------------------ parts / BOM

function purchaseHref(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  return value.trim();
}

const PURCHASE_TIERS = { budget: 'Budget', recommended: 'Recommended', 'already-have': 'Already have' };

function renderParts(app, body) {
  const d = app.data;
  const c = d.check;
  const focus = app.focus;
  const projectParts = new Map((d.project.parts || []).map((p) => [p.id, p]));
  const totals = new Map();
  let unknown = 0;
  const list = h('div.bom');
  for (const def of c.model.partList) {
    const raw = projectParts.get(def.id) || {};
    const bom = raw.bom || def.bom || {};
    const qty = raw.qty || def.qty || 1;
    const price = Number.isFinite(bom.price) && bom.price >= 0 ? bom.price * qty : null;
    const currency = typeof bom.currency === 'string' && bom.currency.trim() ? bom.currency.trim().toUpperCase() : 'USD';
    const link = purchaseHref(bom.link);
    if (price == null) unknown++;
    else {
      const subtotal = totals.get(currency) || { total: 0, have: 0 };
      subtotal.total += price;
      if (raw.have) subtotal.have += price;
      totals.set(currency, subtotal);
    }
    const conf = c.confidence?.[def.id] || (def.verify ? 'confirm' : def.confidence) || 'checked';
    const selected = app.selection && app.selection.type === 'part' && app.selection.id === def.id;
    const dim = focus.kind && focus.kind !== 'step' && focus.parts.size && !focus.parts.has(def.id);
    const tick = h('input.tick', { type: 'checkbox', checked: Boolean(raw.have), 'aria-label': `I already have ${def.name}`, onclick: (e) => e.stopPropagation(), onchange: (e) => app.setHave(def.id, e.target.checked) });
    list.append(h(`div.bom-row${selected ? '.selected' : ''}${dim ? '.dim' : ''}`, {
      onclick: () => app.select({ type: 'part', id: def.id }),
      oncontextmenu: (e) => app.contextMenu(e, { type: 'part', id: def.id }),
      'data-part': def.id,
    },
    h('span.swatch', { style: { background: partColor(def) } }),
    h('div', null,
      h('div.title', null, def.name || def.id),
      bom.why ? h('div.why', null, bom.why) : def.description ? h('div.why', null, def.description) : null,
      h('div.meta', null,
        h('span.badge.neutral', null, `${qty} ×`),
        h('span.small.muted', null, CATEGORY_LABEL[def.category] || def.category || 'Part'),
        confidenceBadge(conf),
        link ? h('a.small', { href: link, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, 'Buy') : null,
        bom.checked ? h('span.small.muted', null, `Price checked ${bom.checked}`) : null)),
    h('div.right', null,
      h('span.price', null, price == null ? '–' : fmtMoney(price, currency)),
      h('label.have', { onclick: (e) => e.stopPropagation() }, tick, 'Have'))));
  }
  body.append(h('div.section-title', null, 'Bill of materials', h('span.grow'), h('span.small', { style: { textTransform: 'none', letterSpacing: 0 } }, plural(c.model.partList.length, 'part'))));
  body.append(list);
  for (const [currency, { total, have }] of totals) {
    body.append(h('div.totals', null,
      h('span', null, `Total (${currency})`), h('span.big', null, fmtMoney(total, currency)),
      h('span.muted', null, 'Already have'), h('span.muted', null, fmtMoney(have, currency)),
      h('span', null, 'Still to buy'), h('b', null, fmtMoney(total - have, currency))));
  }
  if (unknown) body.append(h('p.small.muted', null, `${plural(unknown, 'part')} without a price`));

  const fasteners = d.project.fasteners || [];
  if (fasteners.length) {
    body.append(h('div.section-title', null, 'Fasteners'));
    body.append(h('div.tags', null, fasteners.map((f) => h('span.tag', null, `${f.qty || 1}× ${f.name || f.id}`))));
  }
  const prints = d.project.prints || [];
  if (prints.length) {
    body.append(h('div.section-title', null, 'Printed parts'));
    body.append(h('div.bom', null, prints.map((p) => h('div.bom-row', { onclick: () => app.select({ type: 'print', id: p.id }) },
      h('span.swatch', { style: { background: 'var(--accent)' } }),
      h('div', null, h('div.title', null, p.name || p.id), h('div.why', null, [p.material, p.size ? `${p.size.map((n) => Math.round(n)).join(' × ')} mm` : null, p.source].filter(Boolean).join(' · '))),
      h('div.right', null, h('span.badge.neutral', null, p.status || 'planned'))))));
  }
}

// ------------------------------------------------------------------ power

export function budgetBar(rail) {
  const cap = rail.capacity;
  const pct = rail.pct ?? (cap ? rail.load / cap : null);
  const pctPeak = rail.pctPeak ?? (cap ? rail.loadPeak / cap : null);
  const status = rail.status || 'ok';
  const scale = Math.max(1, pctPeak || 0, pct || 0);
  const bar = h(`div.budget.${status}`, { role: 'img', 'aria-label': `${fmtA(rail.load)} typical, ${fmtA(rail.loadPeak)} peak of ${cap ? fmtA(cap) : 'unknown capacity'}` });
  if (cap) {
    bar.append(h('div.peak', { style: { width: `${(Math.min(pctPeak || 0, scale) / scale) * 100}%` } }));
    bar.append(h('div.typ', { style: { width: `${(Math.min(pct || 0, scale) / scale) * 100}%` } }));
    bar.append(h('div.cap', { style: { left: `calc(${(1 / scale) * 100}% - 1px)` }, title: `Capacity ${fmtA(cap)}` }));
  }
  return h('div', null, bar, h('div.budget-legend', null,
    h('span', null, `${fmtA(rail.load)} typ · ${fmtA(rail.loadPeak)} peak`),
    h('span', null, cap ? `of ${fmtA(cap)} (${Math.round((pctPeak || 0) * 100)}% peak)` : 'capacity unknown')));
}

function renderPower(app, body) {
  const c = app.data.check;
  const rails = c.power?.rails || [];
  body.append(h('div.section-title', null, 'Rail budget', h('span.grow'), h('button.btn.ghost.small', { onclick: () => app.switchView('power') }, 'Power tree', icon('right', 13))));
  if (!rails.length) {
    body.append(h('p.muted', null, 'No power sources found yet. Power phase: add a supply or battery and wire it to your loads.'));
  }
  const ordered = orderRails(rails);
  for (const { rail, depth } of ordered) {
    const sel = app.selection && app.selection.type === 'rail' && app.selection.id === rail.net;
    const loadsByPart = new Map();
    for (const l of rail.loads || []) {
      const cur = loadsByPart.get(l.part) || { current: 0, peak: 0 };
      cur.current += l.current || 0; cur.peak += l.peak || 0;
      loadsByPart.set(l.part, cur);
    }
    body.append(h(`div.rail${sel ? '.selected' : ''}`, {
      style: { marginLeft: `${depth * 14}px`, ...(sel ? { borderColor: 'var(--accent)' } : {}) },
      onclick: () => app.select({ type: 'rail', id: rail.net }),
    },
    h('div.rail-head', null,
      h('span.v', null, fmtV(rail.voltage)),
      h('span.name', { title: rail.name }, `${depth ? '↳ ' : ''}from ${app.pinText(rail.source)}`),
      h(`span.pill.${rail.status === 'error' ? 'error' : rail.status === 'warn' ? 'warn' : 'ok'}`, { style: { height: '20px', fontSize: '11px' } }, rail.status === 'error' ? 'Over' : rail.status === 'warn' ? 'Tight' : 'OK'),
    ),
    budgetBar(rail),
    loadsByPart.size ? h('div.loads', null, [...loadsByPart].map(([pid, l]) => h('span.chip', { title: `${fmtA(l.current)} typ, ${fmtA(l.peak)} peak`, onclick: (e) => { e.stopPropagation(); app.select({ type: 'part', id: pid }); } }, app.shortName(app.part(pid)), h('span.muted', null, fmtA(l.peak))))) : null));
  }
  const runtime = c.power?.runtime || [];
  if (runtime.length) {
    body.append(h('div.section-title', null, 'Battery runtime'));
    for (const r of runtime) {
      body.append(h('div.rail', null,
        h('div.rail-head', null, h('span.v', null, typeof r.hours === 'number' ? `${r.hours >= 10 ? Math.round(r.hours) : r.hours.toFixed(1)} h` : '–'), h('span.name', null, app.shortName(app.part(r.battery)) || r.battery)),
        h('div.small.muted', null, `Average draw ${fmtA(r.avg)}${r.formula ? ` · ${r.formula}` : ''}`)));
    }
  } else if (rails.length) {
    body.append(h('p.small.muted', { style: { marginTop: '12px' } }, 'No battery in this build, so there is no runtime estimate.'));
  }
  body.append(h('p.small.muted', { style: { marginTop: '12px' } }, 'Solid bar: typical draw. Striped: peak (motors starting or stalling). The white mark is what the source can deliver.'));
}

function orderRails(rails) {
  const out = [];
  const byParent = new Map();
  for (const r of rails) {
    const k = r.parent && rails.some((x) => x.net === r.parent) ? r.parent : null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(r);
  }
  const walk = (parent, depth) => {
    for (const r of byParent.get(parent) || []) { out.push({ rail: r, depth }); if (depth < 6) walk(r.net, depth + 1); }
  };
  walk(null, 0);
  for (const r of rails) if (!out.some((o) => o.rail === r)) out.push({ rail: r, depth: 0 });
  return out;
}

// ------------------------------------------------------------------ issues

function renderIssues(app, body) {
  const c = app.data.check;
  const errors = c.issues.filter((i) => i.level === 'error');
  const warnings = c.issues.filter((i) => i.level === 'warning');
  const infos = c.issues.filter((i) => i.level === 'info');
  if (!errors.length && !warnings.length) {
    body.append(h('div.empty-ok', null, h('div.big-check', null, icon('check', 24)), h('b', null, 'No rule violations found'), h('p.small.muted', { style: { margin: '6px 0 0' } }, 'That is not a guarantee: see what isn’t checked below.')));
  } else if (c.summary) {
    body.append(h('p.small', { style: { margin: '0 2px 10px', color: 'var(--text-2)' } }, c.summary));
  }
  const group = (title, list) => {
    if (!list.length) return;
    body.append(h('div.section-title', null, `${title} (${list.length})`));
    for (const i of list) body.append(issueCard(app, i));
  };
  group('Errors', errors);
  group('Warnings', warnings);
  if (infos.length) {
    const det = h('details', null, h('summary.section-title', { style: { cursor: 'pointer', listStyle: 'revert' } }, `Notes (${infos.length})`));
    for (const i of infos) det.append(issueCard(app, i));
    body.append(det);
  }
  if (app.data.bb && Array.isArray(app.data.bb.issues)) {
    const bbIssues = app.data.bb.issues.filter((i) => i.level === 'error' || i.level === 'warning');
    if (bbIssues.length) {
      body.append(h('div.section-title', null, `Breadboard (${bbIssues.length})`));
      for (const i of bbIssues) body.append(issueCard(app, { id: `bb:${i.rule}:${i.message}`, ...i, pins: i.pins || [], nets: [] }, true));
    }
  }
  if (c.notChecked && c.notChecked.length) {
    body.append(h('div.section-title', null, 'Not checked'));
    body.append(h('ul.not-checked', null, c.notChecked.map((t) => h('li', null, t))));
  }
}

function issueCard(app, i, isBb = false) {
  const active = app.selection && app.selection.type === 'issue' && app.selection.id === i.id;
  const refs = [];
  for (const p of i.parts || []) refs.push(h('button.chip', { onclick: (e) => { e.stopPropagation(); app.select({ type: 'part', id: p }); } }, h('span.swatch', { style: { background: partColor(app.part(p) || {}) } }), app.shortName(app.part(p)) || p));
  for (const w of (i.wires || []).slice(0, 6)) {
    const info = app.wireInfo(w);
    refs.push(h('button.chip', { onclick: (e) => { e.stopPropagation(); app.select({ type: 'wire', id: w }); } }, h('span.wire-swatch', { style: { background: info.color || 'var(--muted)' } }), w));
  }
  const icn = i.level === 'error' ? 'alert' : i.level === 'warning' ? 'alert' : 'help';
  return h(`div.issue.${i.level}${active ? '.active' : ''}`, {
    onclick: () => {
      app.select({ type: 'issue', id: i.id, issue: i });
      if (isBb && app.ui.view !== 'breadboard') return;
    },
  },
  h('div.head', null, h('span.lvl', null, icon(icn, 15)), h('div.msg', null, i.message)),
  i.fix ? h('div.fix', null, i.fix) : null,
  refs.length ? h('div.refs', null, refs) : null,
  i.level !== 'info' ? h('div.actions', null,
    h('button.btn.small', {
      onclick: (e) => {
        e.stopPropagation();
        app.inbox({ kind: 'fix', target: `issue:${i.id}`.slice(0, 200), text: `Checker ${i.level} (${i.rule}): ${i.message}${i.fix ? ` Suggested fix: ${i.fix}` : ''}${(i.parts || []).length ? ` Parts: ${i.parts.join(', ')}.` : ''}${(i.wires || []).length ? ` Wires: ${i.wires.join(', ')}.` : ''}`, title: i.message });
      },
    }, icon('spark', 14), 'Ask AI to fix')) : null);
}

// ------------------------------------------------------------------ part sheet

export function renderPartSheet(app, id, onClose) {
  const def = app.part(id);
  if (!def) return null;
  const c = app.data.check;
  const raw = (app.data.project.parts || []).find((p) => p.id === id) || {};
  const conf = c.confidence?.[id] || (def.verify ? 'confirm' : def.confidence) || 'checked';
  const pins = def.pins || [];
  const usedPins = pins.filter((p) => c.pinInfo?.[p.key]?.connected);
  const draw = pins.filter((p) => p.kind === 'power_in' && c.pinInfo?.[p.key]?.connected);
  const typ = draw.reduce((a, p) => a + (p.current || 0), 0);
  const peak = draw.reduce((a, p) => a + (p.current_peak || p.current || 0), 0);
  const supply = pins.filter((p) => p.kind === 'power_out' && p.current_max);
  const rows = pins.map((p) => {
    const pi = c.pinInfo?.[p.key] || {};
    const net = c.nets.netOfPin.get(p.key);
    const others = net && pi.connected ? net.pins.filter((k) => k !== p.key && splitKey(k).part !== id && c.pinInfo?.[k]?.connected) : [];
    const role = pi.role || 'digital';
    const pc = c.confidence?.[p.key];
    return h(`tr${pi.connected ? '' : '.unused'}`, { onclick: () => app.select({ type: 'pin', id: p.key }, { sheet: false }), oncontextmenu: (e) => app.contextMenu(e, { type: 'pin', id: p.key }) },
      h('td', null, h('span.role-dot', { style: { background: pi.connected ? app.roleColor(role) : 'transparent', border: `1.5px solid ${app.roleColor(role)}` } }), h('b', null, p.label), p.label !== p.name ? h('div.small.muted', null, p.name) : null),
      h('td', null, (p.kind || '').replace('_', ' '), pc === 'confirm' ? h('div', null, confidenceBadge('confirm')) : null),
      h('td.nowrap', null, p.voltage != null ? fmtV(p.voltage) : p.vmax != null ? `≤ ${fmtV(p.vmax)}` : ''),
      h('td', null, others.length ? others.slice(0, 2).map((k) => h('div.small', null, app.pinText(k))) : pi.connected ? h('span.small.muted', null, 'internal') : h('span.small.muted', null, '–')));
  });
  const facts = [];
  if (def.category) facts.push(['Type', CATEGORY_LABEL[def.category] || def.category]);
  facts.push(['Size', `${def.size.map((n) => Number(n.toFixed(1))).join(' × ')} mm`]);
  if (typ || peak) facts.push(['Draws', `${fmtA(typ)} typical, ${fmtA(peak)} peak`]);
  for (const s of supply) facts.push([`${s.label} supplies`, `up to ${fmtA(s.current_max)} at ${fmtV(s.voltage)}`]);
  facts.push(['Pins used', `${usedPins.length} of ${pins.length}`]);
  if (raw.qty > 1) facts.push(['Quantity', String(raw.qty)]);
  const issues = c.issues.filter((i) => i.parts.includes(id) && i.level !== 'info');
  const bom = raw.bom || def.bom || {};
  const buyLink = purchaseHref(bom.link);
  const buyingOptions = Array.isArray(bom.options) ? bom.options.filter((option) => option && typeof option === 'object') : [];
  return h('div.sheet', { role: 'dialog', 'aria-label': `${def.name} details` },
    h('div.sheet-head', null,
      h('h2', null, def.name || id),
      h('div.meta', null, h('span.swatch', { style: { background: partColor(def), width: '12px', height: '12px' } }), h('span.mono.small.muted', null, id), confidenceBadge(conf), raw.have ? h('span.badge.verified', null, 'You have it') : null),
      h('button.btn.ghost.small.icon-only.close', { 'aria-label': 'Close', onclick: onClose }, icon('x', 15))),
    h('div.sheet-body', null,
      def.description ? h('p', { style: { margin: '0 0 8px', color: 'var(--text-2)' } }, def.description) : null,
      bom.why ? h('div.callout.why', null, icon('help', 15), h('div', null, h('b', null, 'Why this part: '), bom.why)) : null,
      conf === 'confirm' ? h('div.callout.warning', null, icon('alert', 15), h('div', null, h('b', null, 'Confirm on your board. '), 'Compare every pin label below with the silkscreen on the board you actually have before wiring.')) : null,
      issues.map((i) => h(`div.callout.${i.level === 'error' ? 'error' : 'warning'}`, null, icon('alert', 15), h('div', null, i.message))),
      h('dl.kv', null, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '12px 0 4px' } },
        def.datasheet ? h('a.btn.small', { href: def.datasheet, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 13), 'Datasheet') : null,
        buyLink ? h('a.btn.small', { href: buyLink, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 13), 'Where to buy') : null,
        h('button.btn.small', { onclick: () => app.inbox({ kind: 'explain', target: `part:${id}`, text: `Explain what part ${id} (${def.name}) does in this build and how it is wired.`, title: def.name }) }, icon('help', 13), 'Explain'),
        h('button.btn.small', { onclick: () => app.askWithNote({ kind: 'swap', target: `part:${id}`, context: `Suggest a replacement for part ${id} (${def.name}) that keeps the wiring valid.`, title: `Swap ${def.name}` }) }, icon('external', 13), 'Swap part')),
      buyingOptions.length ? [h('div.section-title', null, 'Buying options'), h('ul.not-checked', null, buyingOptions.map((option) => {
        const tier = Object.hasOwn(PURCHASE_TIERS, option.tier) ? PURCHASE_TIERS[option.tier] : null;
        const label = option.name || tier || 'Option';
        const link = purchaseHref(option.link);
        return h('li', null, option.name && tier ? `${tier} · ` : null,
          link ? h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, label) : h('b', null, label),
          Number.isFinite(option.price) ? ` · ${fmtMoney(option.price, option.currency || bom.currency || 'USD')}` : null,
          option.checked ? ` · Checked ${option.checked}` : null,
          option.why ? h('div.small.muted', null, option.why) : null);
      }))] : null,
      h('div.section-title', null, 'Pins', h('span.grow'), h('span.small', { style: { textTransform: 'none', letterSpacing: 0 } }, 'Grey = not used')),
      h('table.pin-table', null, h('thead', null, h('tr', null, h('th', null, 'Pin'), h('th', null, 'Kind'), h('th', null, 'Volts'), h('th', null, 'Goes to'))), h('tbody', null, rows)),
      (def.notes || []).length ? [h('div.section-title', null, 'Notes'), h('ul.not-checked', null, def.notes.map((n) => h('li', null, n)))] : null));
}
