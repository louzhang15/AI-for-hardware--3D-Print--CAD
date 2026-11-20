// Wiremap viewer: app shell, data loading, selection/focus model, live updates.
import { h, clear, icon, api, postJSON, store, toast, copyText, prefersReducedMotion, fmtV, fmtA, plural, fmtAgo, splitKey, esc } from './util.js';
import { PHASES, PHASE_TITLES } from '/lib/model.js';
import { ROLE_COLORS, ROLE_LABELS } from '/lib/nets.js';
import { renderLeftPanel, renderPartSheet } from './panels.js';
import { renderStepPanel } from './steps.js';
import { SketchView, sketchThumb } from './sketch.js';
import { BreadboardView } from './bbview.js';
import { PowerTreeView } from './power.js';

// ------------------------------------------------------------------ error banner

const banner = document.getElementById('banner');
export function showBanner(message, detail = '', kind = 'error') {
  clear(banner);
  banner.className = kind === 'warn' ? 'warn' : '';
  banner.append(h('div', null, message));
  if (detail) banner.append(h('details', null, h('summary', null, 'Details'), h('pre', { style: { whiteSpace: 'pre-wrap', margin: '6px 0 0' } }, detail)));
  banner.append(h('button.close', { 'aria-label': 'Dismiss', onclick: () => { banner.hidden = true; } }, icon('x')));
  banner.hidden = false;
}
function hideBanner() { banner.hidden = true; }
window.addEventListener('error', (e) => {
  if (!e.error) return; // resource errors
  showBanner(`Something in the viewer broke: ${e.message}`, e.error && e.error.stack ? e.error.stack : '');
});
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason;
  showBanner(`Something in the viewer broke: ${err && err.message ? err.message : err}`, err && err.stack ? err.stack : '');
});

// ------------------------------------------------------------------ optional shared modules

let checkProjectFn = null;
let checkLoadError = '';
let layoutBreadboardFn = null;
async function loadModules() {
  try { ({ checkProject: checkProjectFn } = await import('/lib/check.js')); }
  catch (e) { checkLoadError = e.message || String(e); }
  try { ({ layoutBreadboard: layoutBreadboardFn } = await import('/lib/breadboard.js')); }
  catch { layoutBreadboardFn = null; }
}

// ------------------------------------------------------------------ phases

const RULE_PHASE = {
  schema: 'parts', 'unknown-library-part': 'parts', mains: 'parts', 'confirm-on-board': 'parts', 'unused-part': 'parts',
  'over-voltage': 'power', 'under-voltage': 'power', overload: 'power', 'missing-bms': 'power', 'missing-fuse': 'power',
  'missing-switch': 'power', 'fuse-rating': 'power', 'regulator-dropout': 'power', 'regulator-heat': 'power',
  'supplies-fighting': 'power', 'power-to-ground': 'power', short: 'power', unpowered: 'power',
};
export const phaseOfIssue = (i) => (PHASES.includes(i.phase) ? i.phase : RULE_PHASE[i.rule] || 'wire');

export const VIEWS = [
  { id: 'sketch', label: 'Sketch', icon: 'chip' },
  { id: 'breadboard', label: 'Breadboard', icon: 'fit' },
  { id: '3d', label: '3D', icon: 'explode' },
  { id: 'power', label: 'Power tree', icon: 'bolt' },
  { id: 'assembly', label: 'Assembly', icon: 'print' },
];
const PHASE_VIEW = { define: 'sketch', parts: '3d', power: 'power', wire: 'sketch', firmware: 'sketch', print: 'assembly', assemble: 'assembly', test: 'sketch' };
const PHASE_LEFT = { define: 'requirements', parts: 'parts', power: 'power' };

// ------------------------------------------------------------------ app object

const app = {
  root: document.getElementById('app'),
  library: {},
  printers: {},
  route: { page: 'home' },
  data: null, // { name, project, check, bb, bbError, mtime }
  ui: {
    theme: document.documentElement.dataset.theme || 'light',
    reduceMotion: store.get('reduceMotion', false),
    view: 'sketch', left: 'parts', phase: 'define', stepIdx: {},
  },
  selection: null, // { type: 'wire'|'pin'|'part'|'issue'|'rail'|'net', id, issue? }
  focus: emptyFocus(),
  views: {},
  els: {},
  get motion() { return !(this.ui.reduceMotion || prefersReducedMotion()); },
};
window.wiremap = app; // handy for debugging in the console

function emptyFocus() { return { parts: new Set(), wires: new Set(), pins: new Set(), nets: new Set(), prints: new Set(), kind: null }; }

// ------------------------------------------------------------------ naming helpers (used by every view)

export function shortName(def) {
  if (!def) return '?';
  let n = String(def.label || def.name || def.id || '');
  n = n.split(/\s+\(|,/)[0].trim();
  if (n.length > 30) n = n.slice(0, 28).trim() + '…';
  return n || def.id;
}
app.shortName = shortName;
app.part = (id) => app.data && app.data.check.model.parts.get(id);
app.pin = (key) => {
  const { part, pin } = splitKey(key);
  const p = app.part(part);
  return p ? p.pinMap.get(pin) : undefined;
};
app.pinText = (key, withPart = true) => {
  const { part, pin } = splitKey(key);
  const def = app.part(part);
  const p = def && def.pinMap.get(pin);
  if (!p) return key;
  const label = p.label && p.label !== p.name ? `${p.label} (${p.name})` : p.name;
  return withPart ? `${shortName(def)} ${label}` : label;
};
app.wire = (id) => app.data && app.data.check.model.wires.find((w) => w.id === id);
app.wireInfo = (id) => (app.data && app.data.check.wireInfo[id]) || {};
app.roleColor = (role) => (ROLE_COLORS[role] || ROLE_COLORS.digital).hex;
app.roleLabel = (role) => ROLE_LABELS[role] || role || 'Signal';

/** Plain-language description of a wire: title, sentence, detail facts. */
app.describeWire = (id) => {
  const w = app.wire(id);
  if (!w) return null;
  const info = app.wireInfo(id);
  const role = info.role || 'digital';
  const from = w.fromKey || w.from;
  const to = w.toKey || w.to;
  let plain = w.purpose || '';
  if (!plain) {
    const target = app.part(splitKey(to).part);
    if (role === 'power') plain = `Carries ${info.voltage ? fmtV(info.voltage) + ' ' : ''}power to ${shortName(target)}.`;
    else if (role === 'ground') plain = `Ground return for ${shortName(target)}.`;
    else plain = `${app.roleLabel(role)} signal to ${shortName(target)}.`;
  }
  const facts = [];
  if (info.voltage != null) facts.push(['Voltage', fmtV(info.voltage)]);
  facts.push(['Signal', app.roleLabel(role)]);
  if (info.current) facts.push(['Current', `${fmtA(info.current)}${info.currentPeak && info.currentPeak !== info.current ? `, peak ${fmtA(info.currentPeak)}` : ''}`]);
  if (w.gauge || info.gauge) facts.push(['Gauge', `${w.gauge || info.gauge} AWG`]);
  if (w.length_mm) facts.push(['Length', `${w.length_mm} mm`]);
  facts.push(['Colour', w.color || info.colorName || ROLE_COLORS[role]?.name]);
  return { w, info, role, from, to, title: `${app.pinText(from)} → ${app.pinText(to)}`, label: w.label || app.roleLabel(role), plain, facts, color: info.color || app.roleColor(role) };
};

// ------------------------------------------------------------------ check + breadboard

function runCheck(project) {
  if (checkProjectFn) {
    try {
      return checkProjectFn(project, app.library);
    } catch (e) {
      console.warn('checkProject failed', e);
      showBanner(`The checker crashed on this project: ${e.message}. Showing a structural check only.`, e.stack, 'warn');
    }
  }
  return null;
}

async function checkFallback(project, reason) {
  const { checkLite } = await import('./check-lite.js');
  return checkLite(project, app.library, reason);
}

function computeBreadboard(project) {
  if (!project.breadboard) return { bb: null, bbError: null };
  if (project.breadboard.layout && project.breadboard.layout.placements) return { bb: project.breadboard.layout, bbError: null };
  if (!layoutBreadboardFn) return { bb: null, bbError: 'The breadboard layout engine (lib/breadboard.js) is not available.' };
  try {
    const opts = {};
    if (project.breadboard.model) opts.model = project.breadboard.model;
    if (project.breadboard.rails) opts.rails = project.breadboard.rails;
    return { bb: layoutBreadboardFn(project, app.library, opts), bbError: null };
  } catch (e) {
    console.warn('layoutBreadboard failed', e);
    return { bb: null, bbError: `The breadboard layout failed: ${e.message}` };
  }
}

async function loadProjectData(name) {
  let text;
  try {
    text = await api(`/api/project/${encodeURIComponent(name)}`);
  } catch (e) {
    throw Object.assign(new Error(`Could not load project "${name}": ${e.message}`), { user: true });
  }
  let project;
  try {
    project = JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error(`projects/${name}.json is not valid JSON, so it can't be drawn yet.`), { user: true, detail: e.message });
  }
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw Object.assign(new Error(`projects/${name}.json must contain a JSON object.`), { user: true });
  }
  let check = runCheck(project);
  if (!check) check = await checkFallback(project, checkLoadError ? 'checker module missing' : 'checker crashed');
  const { bb, bbError } = computeBreadboard(project);
  return { name, project, check, bb, bbError };
}

// ------------------------------------------------------------------ focus & selection

/** Expand a selection into the set of things to light up. */
function computeFocus() {
  const f = emptyFocus();
  const d = app.data;
  if (!d) return f;
  const { check } = d;
  const addWire = (id) => {
    const w = app.wire(id);
    if (!w) return;
    f.wires.add(id);
    if (w.fromKey) { f.pins.add(w.fromKey); f.parts.add(splitKey(w.fromKey).part); }
    if (w.toKey) { f.pins.add(w.toKey); f.parts.add(splitKey(w.toKey).part); }
  };
  const addNet = (netId) => {
    const net = check.nets.nets.find((n) => n.id === netId);
    if (!net) return;
    f.nets.add(netId);
    for (const k of net.pins) { if (check.pinInfo?.[k]?.connected !== false || net.wires.length) f.pins.add(k); }
    for (const w of net.wires) addWire(w);
  };
  const sel = app.selection;
  if (sel) {
    f.kind = sel.type;
    if (sel.type === 'wire') addWire(sel.id);
    else if (sel.type === 'pin') {
      const net = check.nets.netOfPin.get(sel.id);
      f.pins.add(sel.id);
      f.parts.add(splitKey(sel.id).part);
      if (net && net.wires.length) addNet(net.id);
    } else if (sel.type === 'net') addNet(sel.id);
    else if (sel.type === 'part') {
      f.parts.add(sel.id);
      for (const w of check.model.wires) if (w.valid && (splitKey(w.fromKey).part === sel.id || splitKey(w.toKey).part === sel.id)) addWire(w.id);
    } else if (sel.type === 'rail') {
      const rail = (check.power?.rails || []).find((r) => r.net === sel.id);
      addNet(sel.id);
      if (rail) { f.parts.add(rail.sourcePart); for (const l of rail.loads) f.parts.add(l.part); }
    } else if (sel.type === 'issue' && sel.issue) {
      const i = sel.issue;
      for (const p of i.parts || []) f.parts.add(p);
      for (const w of i.wires || []) addWire(w);
      for (const k of i.pins || []) { f.pins.add(k); f.parts.add(splitKey(k).part); }
      for (const n of i.nets || []) addNet(n);
    } else if (sel.type === 'print') f.prints.add(sel.id);
    return f;
  }
  const step = currentStep();
  if (step) {
    f.kind = 'step';
    for (const p of step.parts || []) f.parts.add(p);
    for (const w of step.wires || []) addWire(w);
    for (const p of step.prints || []) f.prints.add(p);
  }
  return f;
}

app.select = (sel, opts = {}) => {
  if (sel && opts.sheet !== false) setNarrowPanel('center');
  app.selection = sel && sel.type ? sel : null;
  app.focus = computeFocus();
  applyFocusEverywhere();
  if (sel && sel.type === 'part' && opts.sheet !== false && app.ui.view !== '3d') app.openPart(sel.id);
  renderInfoCard();
  if (app.els.left) renderLeft(); // keep panel highlights in sync
};
app.clearSelection = () => {
  app.selection = null;
  closeSheet();
  app.focus = computeFocus();
  applyFocusEverywhere();
  renderInfoCard();
  renderLeft();
};

function applyFocusEverywhere() {
  for (const v of Object.values(app.views)) {
    try { v.applyFocus && v.applyFocus(app.focus); } catch (e) { console.warn(e); }
  }
}

// ------------------------------------------------------------------ steps

export function stepsForPhase(phase) {
  const steps = (app.data && app.data.project.steps) || [];
  return steps.filter((s) => s && (s.phase || 'wire') === phase);
}
function currentStep() {
  const list = stepsForPhase(app.ui.phase);
  if (!list.length) return null;
  const i = Math.min(app.ui.stepIdx[app.ui.phase] || 0, list.length - 1);
  return list[i];
}
app.currentStep = currentStep;

app.gotoStep = (idx, phase = app.ui.phase) => {
  const list = stepsForPhase(phase);
  if (phase !== app.ui.phase) app.setPhase(phase, { keepView: true });
  app.ui.stepIdx[phase] = Math.max(0, Math.min(idx, list.length - 1));
  saveUi();
  app.selection = null;
  closeSheet();
  app.focus = computeFocus();
  applyFocusEverywhere();
  renderInfoCard();
  renderRight();
  const step = currentStep();
  for (const v of Object.values(app.views)) { try { v.onStep && v.onStep(step); } catch (e) { console.warn(e); } }
};

app.nextStep = (dir = 1) => {
  const list = stepsForPhase(app.ui.phase);
  const i = app.ui.stepIdx[app.ui.phase] || 0;
  const j = i + dir;
  if (j >= 0 && j < list.length) return app.gotoStep(j);
  // move across phases
  let pi = PHASES.indexOf(app.ui.phase) + dir;
  while (pi >= 0 && pi < PHASES.length) {
    const ph = PHASES[pi];
    const l = stepsForPhase(ph);
    if (l.length) {
      if (isLocked(ph)) { toast(lockReason(ph), 'error'); return; }
      return app.gotoStep(dir > 0 ? 0 : l.length - 1, ph);
    }
    pi += dir;
  }
};

app.setStepDone = async (id, done) => {
  const step = (app.data.project.steps || []).find((s) => s.id === id);
  if (!step) return;
  step.done = done;
  renderRight();
  renderTop();
  try {
    await postJSON(`/api/project/${encodeURIComponent(app.data.name)}/state`, { steps: { [id]: { done } } });
  } catch (e) {
    toast(`Could not save: ${e.message}`, 'error');
  }
};

app.setHave = async (partId, have) => {
  const p = (app.data.project.parts || []).find((x) => x.id === partId);
  if (p) p.have = have;
  const def = app.part(partId);
  if (def) def.have = have;
  renderLeft();
  try { await postJSON(`/api/project/${encodeURIComponent(app.data.name)}/state`, { have: { [partId]: have } }); }
  catch (e) { toast(`Could not save: ${e.message}`, 'error'); }
};

app.saveRequirements = async (changes) => {
  const { name } = app.data;
  await postJSON(`/api/project/${encodeURIComponent(name)}/state`, { requirements: changes });
  if (app.data?.name !== name) return;
  const project = app.data.project;
  const requirements = { ...project.meta?.requirements };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete requirements[key];
    else requirements[key] = value;
  }
  project.meta = { ...project.meta, requirements };
  renderLeft();
  toast('Requirements saved', 'ok');
};

app.savePositions = async (positions) => {
  for (const [id, pos] of Object.entries(positions)) {
    const p = (app.data.project.parts || []).find((x) => x.id === id) || (app.data.project.prints || []).find((x) => x.id === id);
    if (p) p.position = pos;
    const def = app.part(id);
    if (def) def.position = pos;
  }
  try {
    await postJSON(`/api/project/${encodeURIComponent(app.data.name)}/state`, { positions });
    toast('Position saved to the project file', 'ok');
  } catch (e) { toast(`Could not save the position: ${e.message}`, 'error'); }
};

app.setProjectPhase = async (phase) => {
  try {
    await postJSON(`/api/project/${encodeURIComponent(app.data.name)}/state`, { phase });
    app.data.project.meta = app.data.project.meta || {};
    app.data.project.meta.phase = phase;
    renderTop();
    toast(`Project moved to the ${PHASE_TITLES[phase]} phase`, 'ok');
  } catch (e) { toast(`Could not save: ${e.message}`, 'error'); }
};

// ------------------------------------------------------------------ phase locking

function phaseErrors() {
  const out = {};
  for (const i of app.data.check.issues) if (i.level === 'error') { const p = phaseOfIssue(i); out[p] = (out[p] || 0) + 1; }
  return out;
}
function firstErrorPhase() {
  const errs = phaseErrors();
  return PHASES.find((p) => errs[p]);
}
export function isLocked(phase) {
  const fe = firstErrorPhase();
  return Boolean(fe) && PHASES.indexOf(phase) > PHASES.indexOf(fe);
}
export function lockReason(phase) {
  const fe = firstErrorPhase();
  const n = phaseErrors()[fe] || 0;
  return `${PHASE_TITLES[phase]} is locked: fix ${plural(n, 'error')} in ${PHASE_TITLES[fe]} first. Building on top of an open error can damage parts.`;
}
app.isLocked = isLocked;
app.lockReason = lockReason;

app.setPhase = (phase, opts = {}) => {
  if (isLocked(phase) && !opts.force) {
    toast(lockReason(phase), 'error');
    const el = app.els.top && app.els.top.querySelector(`[data-phase="${phase}"]`);
    if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
    return;
  }
  app.ui.phase = phase;
  if (!opts.keepView) {
    let v = PHASE_VIEW[phase];
    if (v === 'assembly' && !hasAssembly()) v = '3d';
    if (v) app.ui.view = v;
    if (PHASE_LEFT[phase]) app.ui.left = PHASE_LEFT[phase];
  }
  saveUi();
  app.selection = null;
  closeSheet();
  app.focus = computeFocus();
  renderProjectShell();
};

function hasAssembly() {
  const prints = (app.data && app.data.project.prints) || [];
  return prints.some((p) => Array.isArray(p.position));
}
app.hasAssembly = hasAssembly;

// ------------------------------------------------------------------ inbox (ask the AI)

app.inbox = async ({ kind, target, text, title }) => {
  const labels = { explain: 'Explain', fix: 'Fix this', swap: 'Swap part', stuck: "I'm stuck", ask: 'Ask' };
  try {
    const res = await postJSON('/api/inbox', { kind, target, text: String(text).slice(0, 3900), project: app.data ? app.data.name : null });
    openModal({
      title: `${labels[kind] || 'Request'} sent to your AI`,
      body: [
        h('p', null, 'The request is in ', h('span.mono', null, '.wiremap/inbox.jsonl'), '. Your AI picks it up between steps, or paste this into Claude Code or Codex now:'),
        promptBox(res.prompt),
        title ? h('p.small.muted', null, `About: ${title}`) : null,
      ],
      actions: [h('button.btn.primary', { onclick: async () => { if (await copyText(res.prompt)) toast('Prompt copied', 'ok'); closeModal(); } }, icon('copy'), 'Copy and close')],
    });
  } catch (e) {
    toast(`Could not send the request: ${e.message}`, 'error');
  }
};

export function promptBox(text) {
  const box = h('div.prompt-box', null, text);
  box.append(h('button.btn.small.icon-only.copy', { title: 'Copy', 'aria-label': 'Copy prompt', onclick: async (e) => { e.stopPropagation(); if (await copyText(text)) toast('Copied', 'ok'); } }, icon('copy', 14)));
  return box;
}

/** Ask what is wrong (stuck) or confirm a request, then send. */
app.askWithNote = ({ kind, target, context, title, placeholder }) => {
  const ta = h('textarea', { rows: 4, placeholder: placeholder || 'Describe what you see (optional)…' });
  openModal({
    title: title || 'Ask your AI',
    body: [h('p', null, context), ta],
    actions: [
      h('button.btn.ghost', { onclick: closeModal }, 'Cancel'),
      h('button.btn.primary', { onclick: () => { const note = ta.value.trim(); closeModal(); app.inbox({ kind, target, text: `${context}${note ? `\nUser says: ${note}` : ''}`, title }); } }, 'Send to AI'),
    ],
  });
  setTimeout(() => ta.focus(), 30);
};

// ------------------------------------------------------------------ modal, context menu, tooltip

let modalEl = null;
function openModal({ title, body, actions }) {
  closeModal();
  modalEl = h('div.modal-back', { onclick: (e) => { if (e.target === modalEl) closeModal(); } },
    h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', null, title), body, h('div.actions', null, actions)));
  document.body.append(modalEl);
}
function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }
app.openModal = openModal;
app.closeModal = closeModal;

let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
/** target: {type: 'wire'|'part'|'pin'|'print', id} */
app.contextMenu = (evt, target) => {
  evt.preventDefault();
  closeMenu();
  const d = app.data;
  if (!d || !target) return;
  let head = target.id;
  let context = '';
  if (target.type === 'wire') {
    const dw = app.describeWire(target.id);
    if (!dw) return;
    head = `${dw.label}: ${dw.title}`;
    context = `Wire ${target.id} (${dw.title}), ${dw.label}${dw.info.voltage != null ? `, ${fmtV(dw.info.voltage)}` : ''}. Purpose: ${dw.plain}`;
  } else if (target.type === 'part') {
    const def = app.part(target.id);
    head = def ? `${def.name || def.id}` : target.id;
    context = `Part ${target.id} (${def ? def.name : ''}).`;
  } else if (target.type === 'pin') {
    head = app.pinText(target.id);
    const pin = app.pin(target.id);
    context = `Pin ${target.id} (${head})${pin && pin.kind ? `, kind ${pin.kind}` : ''}.`;
  } else if (target.type === 'print') {
    const p = (d.project.prints || []).find((x) => x.id === target.id);
    head = p ? p.name : target.id;
    context = `Printed part ${target.id} (${head}).`;
  }
  const t = `${target.type}:${target.id}`;
  const issues = d.check.issues.filter((i) => (target.type === 'wire' && i.wires.includes(target.id)) || (target.type === 'part' && i.parts.includes(target.id)) || (target.type === 'pin' && i.pins.includes(target.id)));
  const issueText = issues.length ? ` Open checker issues: ${issues.map((i) => i.message).join(' | ')}` : '';
  const items = [
    ['explain', 'Explain', 'help', () => app.inbox({ kind: 'explain', target: t, text: `Explain in plain language what this is for and how to connect it. ${context}`, title: head })],
    ['fix', 'Fix this', 'spark', () => app.askWithNote({ kind: 'fix', target: t, context: `Please fix: ${context}${issueText}`, title: `Fix: ${head}`, placeholder: 'What should change? (optional)' })],
  ];
  if (target.type === 'part' || target.type === 'pin') {
    const pid = target.type === 'pin' ? splitKey(target.id).part : target.id;
    items.push(['swap', 'Swap part', 'external', () => app.askWithNote({ kind: 'swap', target: `part:${pid}`, context: `Suggest a replacement for part ${pid} (${app.part(pid)?.name || ''}) that keeps the wiring valid.`, title: `Swap ${shortName(app.part(pid))}`, placeholder: 'Why swap? e.g. cheaper, in stock, smaller (optional)' })]);
  }
  if (target.type === 'part') items.push(['sheet', 'Show pins and details', 'chip', () => app.select({ type: 'part', id: target.id })]);
  menuEl = h('div.ctx-menu', { role: 'menu' }, h('div.head', null, head), items.map(([k, label, ic, fn]) => h('button', { role: 'menuitem', onclick: () => { closeMenu(); fn(); } }, icon(ic, 15), label)));
  document.body.append(menuEl);
  const r = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.min(evt.clientX, innerWidth - r.width - 8)}px`;
  menuEl.style.top = `${Math.min(evt.clientY, innerHeight - r.height - 8)}px`;
  menuEl.querySelector('button').focus();
};
document.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });

const tip = h('div#tooltip', { role: 'tooltip' });
document.body.append(tip);
app.tooltip = {
  show(x, y, content) {
    clear(tip);
    if (typeof content === 'string') tip.innerHTML = content; else tip.append(content);
    tip.classList.add('show');
    const r = tip.getBoundingClientRect();
    let tx = x + 14; let ty = y + 16;
    if (tx + r.width > innerWidth - 8) tx = x - r.width - 14;
    if (ty + r.height > innerHeight - 8) ty = y - r.height - 12;
    tip.style.left = `${Math.max(8, tx)}px`;
    tip.style.top = `${Math.max(8, ty)}px`;
  },
  hide() { tip.classList.remove('show'); },
};
app.wireTooltipHtml = (id) => {
  const dw = app.describeWire(id);
  if (!dw) return '';
  return `<div class="t-title"><span class="wire-swatch" style="background:${dw.color}"></span>${esc(dw.label)}</div>
    <div class="t-sub">${esc(dw.title)}</div>
    <div class="t-meta">${dw.info.voltage != null ? esc(fmtV(dw.info.voltage)) + ' · ' : ''}${esc(app.roleLabel(dw.role))}${dw.info.current ? ' · ' + esc(fmtA(dw.info.current)) : ''}</div>
    <div class="t-meta">${esc(dw.plain)}</div>`;
};
app.pinTooltipHtml = (key) => {
  const pin = app.pin(key);
  if (!pin) return esc(key);
  const pi = app.data.check.pinInfo?.[key] || {};
  const net = pi.net ? app.data.check.netInfo?.[pi.net] : null;
  const role = pi.role || 'digital';
  return `<div class="t-title"><span class="swatch" style="background:${pi.connected ? app.roleColor(role) : 'transparent'};border:1px solid ${app.roleColor(role)}"></span>${esc(app.pinText(key))}</div>
    <div class="t-meta">${esc(pin.kind || 'pin')}${pin.voltage != null ? ' · ' + esc(fmtV(pin.voltage)) : ''}${pi.connected ? ` · ${esc(net ? net.name : '')}` : ' · not connected'}</div>`;
};

// ------------------------------------------------------------------ part sheet & info card

function closeSheet() { if (app.els.sheet) { app.els.sheet.remove(); app.els.sheet = null; } }
app.closeSheet = closeSheet;
app.openPart = (id) => {
  closeSheet();
  if (!app.els.stage) return;
  const sheet = renderPartSheet(app, id, () => { closeSheet(); app.clearSelection(); });
  if (!sheet) return;
  app.els.sheet = sheet;
  app.els.stage.append(sheet);
};

function renderInfoCard() {
  if (app.els.info) { app.els.info.remove(); app.els.info = null; }
  if (app.ui.view === '3d') return;
  const sel = app.selection;
  if (!sel || !app.els.stage || (sel.type !== 'wire' && sel.type !== 'pin')) return;
  let card;
  const close = h('button.btn.ghost.small.icon-only.close', { 'aria-label': 'Close', onclick: () => app.clearSelection() }, icon('x', 14));
  if (sel.type === 'wire') {
    const dw = app.describeWire(sel.id);
    if (!dw) return;
    card = h('div.info-card', null, close,
      h('h3', null, h('span.wire-swatch', { style: { background: dw.color } }), dw.label),
      h('div.path-line', null, h('span.endpoint', null, app.pinText(dw.from)), h('span.arrow', null, '→'), h('span.endpoint', null, app.pinText(dw.to))),
      h('p.lead', null, dw.plain),
      h('dl.kv', null, dw.facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      wireIssues(sel.id),
      h('div.actions', null,
        h('button.btn.small', { onclick: () => app.inbox({ kind: 'explain', target: `wire:${sel.id}`, text: `Explain wire ${sel.id}: ${dw.title} (${dw.label}). ${dw.plain}`, title: dw.title }) }, icon('help', 14), 'Explain'),
        h('button.btn.small', { onclick: () => app.askWithNote({ kind: 'fix', target: `wire:${sel.id}`, context: `Please fix wire ${sel.id}: ${dw.title} (${dw.label}).`, title: `Fix ${dw.label}` }) }, icon('spark', 14), 'Fix this')));
  } else {
    const pin = app.pin(sel.id);
    if (!pin) return;
    const pi = app.data.check.pinInfo?.[sel.id] || {};
    const net = app.data.check.nets.netOfPin.get(sel.id);
    const others = net ? net.pins.filter((k) => k !== sel.id && (app.data.check.pinInfo?.[k]?.connected ?? true)) : [];
    const role = pi.role || 'digital';
    const facts = [['Kind', pin.kind || '–']];
    if (pin.voltage != null) facts.push(['Voltage', fmtV(pin.voltage)]);
    if (pin.vmax != null) facts.push(['Max input', fmtV(pin.vmax)]);
    if (pin.current) facts.push(['Draw', `${fmtA(pin.current)}${pin.current_peak ? `, peak ${fmtA(pin.current_peak)}` : ''}`]);
    if (pin.current_max) facts.push(['Can supply', fmtA(pin.current_max)]);
    card = h('div.info-card', null, close,
      h('h3', null, h('span.swatch', { style: { background: app.roleColor(role) } }), app.pinText(sel.id)),
      h('p.lead', null, net && net.wires.length ? `Connected to ${plural(others.length, 'other pin')} on the ${app.data.check.netInfo?.[net.id]?.name || net.name} net.` : 'Not connected to anything.'),
      h('dl.kv', null, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      others.length ? h('div.tags', { style: { marginTop: '8px' } }, others.slice(0, 12).map((k) => h('button.chip', { onclick: () => app.select({ type: 'pin', id: k }) }, app.pinText(k)))) : null);
  }
  app.els.info = card;
  app.els.stage.append(card);
}

function wireIssues(wireId) {
  const list = app.data.check.issues.filter((i) => i.wires.includes(wireId) && i.level !== 'info');
  if (!list.length) return null;
  return list.slice(0, 2).map((i) => h(`div.callout.${i.level === 'error' ? 'error' : 'warning'}`, null, icon('alert', 15), h('div', null, i.message)));
}

// ------------------------------------------------------------------ rendering: home

async function renderHome() {
  destroyViews();
  app.data = null;
  document.title = 'Wiremap';
  const root = clear(app.root);
  const list = h('section.home-projects', { 'aria-label': 'Saved projects' }, h('p.home-empty', { role: 'status' }, 'Loading projects…'));
  root.append(h('div.home.home-page', null,
    h('header.home-header', null, h('div.home-header-inner', null,
      h('div.home-wordmark', null, logo(30), 'Wiremap'), themeButtons())),
    h('main.home-main', null,
      h('div.home-intro', null,
        h('div', null, h('h1', null, 'Build workspace'),
          h('p', null, 'Open a project to review its wiring, check the parts, or pick up a build.')),
        h('button.btn.primary.home-start', { type: 'button', onclick: openNewProject }, icon('plus', 18), 'Start a project')),
      list,
      startBox())));
  let data;
  try {
    data = JSON.parse(await api('/api/projects'));
  } catch (e) {
    list.replaceChildren(h('p.home-empty', { role: 'alert' }, `Could not list projects. ${e.message}`));
    return;
  }
  if (!data.projects.length) {
    list.replaceChildren(h('div.home-empty', null, h('h2', null, 'No saved projects'),
      h('p', null, 'Start with a template or ask your AI to save a project in ', h('code', null, `${data.projectsDir}/`), '.')));
    return;
  }
  list.replaceChildren(...data.projects.map(projectCard));
}

async function openNewProject(event) {
  const button = event.currentTarget;
  button.disabled = true;
  let templates;
  try { ({ templates } = JSON.parse(await api('/api/templates'))); }
  catch (error) { toast(`Could not load templates: ${error.message}`, 'error'); return; }
  finally { button.disabled = false; }
  if (app.route.page !== 'home') return;
  if (!templates.length) { toast('No local templates are available.'); return; }
  const templateTitles = { blank: 'Blank project', 'robot-arm': '4-servo robot arm', rover: 'Two-motor rover' };
  const template = h('select.input', { 'aria-label': 'Template' }, templates.map((name) => h('option', { value: name },
    Object.hasOwn(templateTitles, name) ? templateTitles[name] : name.replaceAll('-', ' '))));
  const name = h('input.input', { required: true, maxlength: 80, type: 'text', placeholder: 'My robot arm' });
  const error = h('p.form-error', { role: 'alert', hidden: true });
  const create = h('button.btn.primary', { form: 'new-project-form', type: 'submit' }, 'Create project');
  const form = h('form#new-project-form.intake-form', { onsubmit: async (event) => {
    event.preventDefault();
    create.disabled = true;
    error.hidden = true;
    try {
      const project = await postJSON('/api/projects', { name: name.value, template: template.value });
      if (form.isConnected) location.hash = `#/p/${encodeURIComponent(project.name)}`;
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      create.disabled = false;
    }
  } }, h('label.intake-field', null, 'Template', template), h('label.intake-field', null, 'Project name', name), error);
  openModal({ title: 'New project from template', body: form, actions: [h('button.btn.ghost', { onclick: closeModal }, 'Cancel'), create] });
  name.focus();
}

function logo(size = 28) {
  const span = h('span', { style: { display: 'inline-flex' }, 'aria-hidden': 'true' });
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2454ca"/><path d="M8 22h6l4-12h6M8 13h3m10 6h3" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="22" r="2" fill="#fff"/><circle cx="24" cy="10" r="2" fill="#fff"/></svg>`;
  return span;
}

function projectCard(p) {
  const title = p.meta?.name || p.name;
  const phase = PHASE_TITLES[p.phase] || p.phase;
  const thumb = h('div.home-thumb', { 'aria-hidden': 'true' });
  const previewText = h('span', null, p.error ? 'Preview unavailable' : 'Loading preview…');
  const preview = h('span.home-preview-empty', null, icon('chip', 24), previewText);
  thumb.append(preview);
  const status = h(`span.home-check.${p.error ? 'error' : 'neutral'}`, null, p.error ? 'Invalid JSON' : 'Checking…');
  const card = h('a.home-card', { href: `#/p/${encodeURIComponent(p.name)}`, 'aria-label': `Open ${title}` },
    thumb,
    h('div.home-card-body', null,
      h('div.home-card-head', null, h('h2', null, title), status),
      h('p.home-description', null, p.error || p.meta?.description || `projects/${p.name}.json`),
      p.counts ? h('div.home-card-data', null, plural(p.counts.parts, 'part'), h('span', null, plural(p.counts.wires, 'wire')),
        p.counts.steps ? h('span', null, `${p.counts.stepsDone}/${p.counts.steps} steps done`) : null) : null,
      h('div.home-card-footer', null,
        h('span.home-card-phase', null, phase, h('span.home-card-date', null, ` · ${fmtAgo(p.mtime)}`)),
        h('span.home-card-open', { 'aria-hidden': 'true' }, 'Open project', icon('right', 16)))));
  if (!p.error) {
    loadProjectData(p.name).then((d) => {
      const c = d.check;
      const state = c.errors ? 'error' : c.warnings ? 'warn' : c.lite ? 'neutral' : 'ok';
      status.className = `home-check ${state}`;
      status.textContent = c.errors ? plural(c.errors, 'error') : c.warnings ? plural(c.warnings, 'warning') : c.lite ? 'Structural check' : '0 checker errors';
      if (c.model.partList.length) thumb.replaceChildren(sketchThumb(c));
      else previewText.textContent = 'No circuit to preview';
    }).catch((e) => {
      status.className = 'home-check error';
      status.textContent = 'Could not check';
      status.title = e.message;
      previewText.textContent = 'Preview unavailable';
    });
  }
  return card;
}

function startBox() {
  const prompt = 'Use Wiremap to plan a 4-servo ESP32 robot arm. I have a breadboard and a Bambu A1 mini. Ask me about my parts and CAD tools before choosing a design.';
  return h('details.home-ai', null,
    h('summary', null, icon('help', 18), 'Start from an idea with Claude Code or Codex', icon('right', 16)),
    h('div.home-ai-body', null,
      h('p', null, 'Open your project folder in Claude Code or Codex. Describe your build and ask it to save a Wiremap project. The design will appear here when it is saved.'),
      promptBox(prompt)));
}

// ------------------------------------------------------------------ rendering: project

function themeButtons() {
  const dark = app.ui.theme !== 'light';
  return h('div.top-actions', null,
    h('button.btn.ghost.icon-only', { title: dark ? 'Light theme' : 'Dark theme', 'aria-label': 'Toggle theme', onclick: toggleTheme }, icon(dark ? 'sun' : 'moon')),
    h(`button.btn.ghost.icon-only${app.ui.reduceMotion ? '.on' : ''}`, { title: app.ui.reduceMotion ? 'Animations are off (click to turn on)' : 'Reduce motion', 'aria-label': 'Reduce motion', 'aria-pressed': String(app.ui.reduceMotion), onclick: toggleMotion }, icon(app.ui.reduceMotion ? 'still' : 'motion')));
}
function toggleTheme() {
  app.ui.theme = app.ui.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = app.ui.theme;
  store.set('theme', app.ui.theme);
  for (const v of Object.values(app.views)) { try { v.onTheme && v.onTheme(); } catch (e) { console.warn(e); } }
  if (app.route.page === 'home') renderHome(); else renderTop();
}
function toggleMotion() {
  app.ui.reduceMotion = !app.ui.reduceMotion;
  if (app.ui.reduceMotion) document.documentElement.dataset.motion = 'reduce'; else delete document.documentElement.dataset.motion;
  store.set('reduceMotion', app.ui.reduceMotion);
  toast(app.ui.reduceMotion ? 'Animations off' : 'Animations on');
  if (app.route.page === 'home') renderHome(); else renderTop();
}

function saveUi() {
  if (!app.data) return;
  store.set(`ui:${app.data.name}`, { view: app.ui.view, left: app.ui.left, phase: app.ui.phase, stepIdx: app.ui.stepIdx });
}

function renderTop() {
  const d = app.data;
  if (!d || !app.els.top) return;
  const restorePhaseFocus = app.els.top.contains(document.activeElement) && document.activeElement.matches('.phase');
  const phaseScroll = app.els.top.querySelector('.stepper')?.scrollLeft || 0;
  const top = clear(app.els.top);
  const meta = d.project.meta || {};
  const c = d.check;
  const steps = d.project.steps || [];
  const projPhase = PHASES.includes(meta.phase) ? meta.phase : 'define';
  const errs = phaseErrors();
  const stepper = h('nav.stepper', { 'aria-label': 'Build phases' });
  PHASES.forEach((ph, i) => {
    const list = steps.filter((s) => (s.phase || 'wire') === ph);
    const done = list.length > 0 && list.every((s) => s.done);
    const locked = isLocked(ph);
    const cls = ['phase', done ? 'done' : '', ph === projPhase ? 'current' : '', ph === app.ui.phase ? 'viewing' : '', locked ? 'locked' : '', errs[ph] ? 'has-error' : ''].filter(Boolean).join('.');
    const title = locked ? lockReason(ph) : `${PHASE_TITLES[ph]}${list.length ? ` · ${list.filter((s) => s.done).length}/${list.length} steps done` : ''}${ph === projPhase ? ' · current phase' : ''}${errs[ph] ? ` · ${plural(errs[ph], 'error')}` : ''}`;
    stepper.append(h(`button.${cls}`, { 'data-phase': ph, title, 'aria-current': ph === app.ui.phase ? 'step' : null, onclick: () => app.setPhase(ph) },
      h('span.num', { 'aria-hidden': 'true' }, locked ? icon('lock', 12) : done ? icon('check', 13) : String(i + 1).padStart(2, '0')),
      h('span.name', null, PHASE_TITLES[ph])));
  });
  const pillCls = c.errors ? 'error' : c.warnings ? 'warn' : 'ok';
  const pillText = c.errors ? plural(c.errors, 'checker error') : c.warnings ? plural(c.warnings, 'warning') : c.lite ? 'Structural check' : '0 checker errors';
  const projectTitle = meta.name || d.name;
  top.append(h('div.project-bar', null,
    h('a.project-back', { href: '#/', 'aria-label': 'All projects' }, logo(30), h('span', null, 'Projects')),
    h('div.brand-title', { title: `projects/${d.name}.json` }, h('h1', null, projectTitle),
      h('div.sub', null, `${plural(c.model.partList.length, 'part')} · ${plural((d.project.wires || []).length, 'connection')}`)),
    h(`button.check-status.${pillCls}`, { title: c.summary || 'Open the issues list', onclick: () => {
      app.setLeftPanel('issues');
      setNarrowPanel('left');
      app.els.left.querySelector('[aria-selected="true"]')?.focus();
    } }, icon(c.errors || c.warnings ? 'alert' : 'check', 15), pillText),
    themeButtons()), stepper);
  stepper.scrollLeft = phaseScroll;
  const active = stepper.querySelector('[aria-current="step"]');
  if (active && active.offsetLeft + active.offsetWidth > stepper.scrollLeft + stepper.clientWidth) {
    stepper.scrollLeft = active.offsetLeft + active.offsetWidth - stepper.clientWidth + 12;
  } else if (active && active.offsetLeft < stepper.scrollLeft) stepper.scrollLeft = active.offsetLeft;
  if (restorePhaseFocus) active?.focus({ preventScroll: true });
}

function setNarrowPanel(panel) {
  const ws = app.els.ws;
  if (!ws || !matchMedia('(max-width: 1050px)').matches) return;
  ws.dataset.panel = panel;
  for (const button of app.els.dock.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.panel === panel));
  }
}

function renderLeft() {
  if (!app.els.left || !app.data) return;
  renderLeftPanel(app, app.els.left);
}
function renderRight() {
  if (!app.els.right || !app.data) return;
  renderStepPanel(app, app.els.right);
}
app.renderLeft = renderLeft;
app.renderRight = renderRight;
app.setLeftPanel = (panel) => {
  app.ui.left = panel;
  saveUi();
  renderLeft();
};

function renderCenterBar() {
  const focused = app.els.centerBar.contains(document.activeElement) && document.activeElement.matches('[role="tab"]');
  const scrollLeft = app.els.centerBar.querySelector('.view-tabs')?.scrollLeft || 0;
  const bar = clear(app.els.centerBar);
  const views = VIEWS.filter((v) => v.id !== 'assembly' || hasAssembly());
  const tabs = h('div.view-tabs', { role: 'tablist', 'aria-label': 'Diagram views', onkeydown: (event) => {
    const index = views.findIndex((v) => v.id === app.ui.view);
    const nav = { ArrowLeft: (index + views.length - 1) % views.length, ArrowRight: (index + 1) % views.length, Home: 0, End: views.length - 1 };
    if (!Object.hasOwn(nav, event.key)) return;
    event.preventDefault();
    switchView(views[nav[event.key]].id);
  } });
  for (const v of views) {
    const selected = app.ui.view === v.id;
    tabs.append(h(`button.view-tab${selected ? '.active' : ''}`, { role: 'tab', 'aria-selected': String(selected), tabindex: selected ? 0 : -1,
      onclick: () => switchView(v.id) }, icon(v.icon, 14), h('span.lbl', null, v.label)));
  }
  bar.append(tabs);
  const view = app.views[app.ui.view];
  if (view && view.tools) {
    const t = view.tools();
    if (t) bar.append(h('div.view-tools', null, t));
  }
  tabs.scrollLeft = scrollLeft;
  const active = tabs.querySelector('.active');
  if (active && focused) {
    active.focus({ preventScroll: true });
    const viewport = tabs.getBoundingClientRect();
    const target = active.getBoundingClientRect();
    if (target.right > viewport.right) tabs.scrollLeft += target.right - viewport.right;
    else if (target.left < viewport.left) tabs.scrollLeft -= viewport.left - target.left;
  }
}
app.renderCenterBar = renderCenterBar;

function switchView(id) {
  if (id === app.ui.view) return;
  if (id === '3d') closeSheet();
  app.ui.view = id;
  saveUi();
  mountView();
  renderCenterBar();
  renderInfoCard();
}

app.switchView = switchView;

async function ensureView(id) {
  if (app.views[id]) return app.views[id];
  const host = h('div.view', { 'data-view': id });
  let view;
  if (id === 'sketch') view = new SketchView(app, host);
  else if (id === 'breadboard') view = new BreadboardView(app, host);
  else if (id === 'power') view = new PowerTreeView(app, host);
  else if (id === '3d' || id === 'assembly') {
    try {
      const { Scene3DView } = await import('./scene3d.js');
      view = new Scene3DView(app, host, { mode: id === 'assembly' ? 'assembly' : 'circuit' });
    } catch (e) {
      console.error(e);
      host.append(h('div.bb-empty', null, h('h3', null, 'The 3D view could not start'), h('p', null, e.message)));
      view = { host, render() {}, destroy() {} };
    }
  }
  view.host = host;
  app.views[id] = view;
  return view;
}

let mountToken = 0;
async function mountView() {
  const token = ++mountToken;
  const id = app.ui.view;
  const view = await ensureView(id);
  if (token !== mountToken || !app.els.stage) return;
  for (const [k, v] of Object.entries(app.views)) {
    if (k !== id && v.host.parentNode) { v.host.remove(); v.onHide && v.onHide(); }
  }
  if (!view.host.parentNode) app.els.stage.prepend(view.host);
  try {
    if (view.dirty !== false || !view.rendered) { view.render(); view.rendered = true; view.dirty = false; }
    view.onShow && view.onShow();
    view.applyFocus && view.applyFocus(app.focus);
  } catch (e) {
    console.error(e);
    showBanner(`The ${id} view failed to draw: ${e.message}`, e.stack);
  }
  renderCenterBar();
}

function destroyViews() {
  for (const v of Object.values(app.views)) { try { v.destroy && v.destroy(); } catch { /* ignore */ } }
  app.views = {};
  app.els = {};
}

function renderProjectShell() {
  const d = app.data;
  if (!app.els.ws) {
    const root = clear(app.root);
    app.els.top = h('header.topbar');
    app.els.left = h('aside.side.left', { 'aria-label': 'Project panels' });
    app.els.right = h('aside.side.right', { 'aria-label': 'Build step' });
    app.els.centerBar = h('div.center-bar');
    app.els.stage = h('div.stage.grid-bg');
    app.els.center = h('section.center', { 'aria-label': 'Diagram workspace' }, app.els.centerBar, app.els.stage);
    app.els.ws = h('main.workspace', { 'data-panel': 'center' }, app.els.left, app.els.center, app.els.right);
    app.els.dock = h('nav.workspace-dock', { 'aria-label': 'Workspace panels' },
      ...[['left', 'panel', 'Project'], ['center', 'chip', 'Diagram'], ['right', 'steps', 'Build guide']].map(([panel, symbol, label]) =>
        h('button', { type: 'button', 'data-panel': panel, 'aria-pressed': String(panel === 'center'), onclick: () => setNarrowPanel(panel) }, icon(symbol, 17), label)));
    root.append(app.els.top, app.els.ws, app.els.dock);
  }
  if (app.ui.view === 'assembly' && !hasAssembly()) app.ui.view = '3d';
  document.title = `${(d.project.meta && d.project.meta.name) || d.name} · Wiremap`;
  renderTop();
  renderLeft();
  renderRight();
  for (const v of Object.values(app.views)) v.dirty = true;
  mountView();
  renderInfoCard();
}

async function openProject(name) {
  const same = app.data && app.data.name === name;
  if (!same) {
    destroyViews();
    app.selection = null;
    const saved = store.get(`ui:${name}`, null);
    app.ui.view = saved?.view || null;
    app.ui.left = saved?.left || 'parts';
    app.ui.phase = saved?.phase || null;
    app.ui.stepIdx = saved?.stepIdx || {};
  }
  try {
    app.data = await loadProjectData(name);
  } catch (e) {
    destroyViews();
    app.data = null;
    clear(app.root).append(h('div.home', null, h('div.home-inner', null,
      h('div.home-head', null, logo(36), h('div', { style: { flex: 1 } }, h('h1', null, name), h('div.tag-line', null, 'This project could not be shown.')), h('button.btn', { onclick: () => { location.hash = '#/'; } }, icon('home'), 'All projects')),
      h('div.callout.error', null, icon('alert'), h('div', null, h('b', null, e.message), e.detail ? h('div.mono.small', { style: { marginTop: '6px' } }, e.detail) : null, h('div.small', { style: { marginTop: '6px' } }, 'The page reloads by itself when the file is fixed.'))))));
    showBanner(e.message, e.detail || '');
    return;
  }
  hideBanner();
  const meta = app.data.project.meta || {};
  if (!app.ui.phase || !PHASES.includes(app.ui.phase)) app.ui.phase = PHASES.includes(meta.phase) ? meta.phase : 'define';
  if (isLocked(app.ui.phase)) app.ui.phase = firstErrorPhase();
  if (!app.ui.view) {
    app.ui.view = PHASE_VIEW[app.ui.phase] || 'sketch';
    if (PHASE_LEFT[app.ui.phase]) app.ui.left = PHASE_LEFT[app.ui.phase];
  }
  if (app.ui.view === 'breadboard' && !app.data.project.breadboard) app.ui.view = 'sketch';
  // keep selection only if it still exists
  if (app.selection) {
    const s = app.selection;
    const exists = s.type === 'wire' ? app.wire(s.id) : s.type === 'part' ? app.part(s.id) : s.type === 'pin' ? app.pin(s.id) : s.type === 'issue' ? app.data.check.issues.find((i) => i.id === s.id) : true;
    if (!exists) app.selection = null;
    else if (s.type === 'issue') s.issue = app.data.check.issues.find((i) => i.id === s.id);
  }
  app.focus = computeFocus();
  renderProjectShell();
  if (app.selection && app.selection.type === 'part' && app.els.sheet) app.openPart(app.selection.id);
}

async function reloadCurrent() {
  if (!app.data) return;
  const name = app.data.name;
  const hadSheet = Boolean(app.els.sheet);
  await openProject(name);
  if (hadSheet && app.selection && app.selection.type === 'part') app.openPart(app.selection.id);
}

// ------------------------------------------------------------------ keyboard

document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'Escape') {
    if (modalEl) return closeModal();
    if (menuEl) return closeMenu();
    if (app.data) app.clearSelection();
    return;
  }
  if (!app.data || modalEl || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('button, a, [role="button"], [role="tab"]')) return;
  const view = app.views[app.ui.view];
  if (view && view.key && view.key(e)) { e.preventDefault(); return; }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); app.nextStep(1); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); app.nextStep(-1); }
  else if (/^[1-5]$/.test(e.key)) {
    const avail = VIEWS.filter((v) => v.id !== 'assembly' || hasAssembly());
    const v = avail[Number(e.key) - 1];
    if (v) switchView(v.id);
  }
});

// ------------------------------------------------------------------ routing and live updates

function parseRoute() {
  const m = /^#\/p\/([^/?]+)/.exec(location.hash);
  if (m) {
    let name = m[1];
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    return { page: 'project', name };
  }
  return { page: 'home' };
}

async function route() {
  app.route = parseRoute();
  closeMenu();
  closeModal();
  app.tooltip.hide();
  if (app.route.page === 'project') await openProject(app.route.name);
  else await renderHome();
}

function connectEvents() {
  let es;
  let timer = null;
  try { es = new EventSource('/api/events'); } catch { return; }
  es.addEventListener('change', (ev) => {
    let name = ev.data;
    try { name = JSON.parse(ev.data); } catch { /* raw */ }
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (app.route.page === 'home') renderHome();
      else if (app.data && app.data.name === name) reloadCurrent().catch((e) => showBanner(e.message));
      else if (!app.data && app.route.page === 'project' && app.route.name === name) route();
    }, 120);
  });
}

async function boot() {
  await loadModules();
  try {
    app.library = JSON.parse(await api('/api/library'));
  } catch (e) {
    showBanner(`Could not load the part library: ${e.message}`, '', 'warn');
    app.library = {};
  }
  for (const [id, def] of Object.entries(app.library)) if (def && def.$error) { console.warn(`library/${id}.json: ${def.$error}`); delete app.library[id]; }
  if (checkLoadError) console.warn('lib/check.js failed to load:', checkLoadError);
  window.addEventListener('hashchange', route);
  connectEvents();
  await route();
}

boot().catch((e) => showBanner(`Wiremap failed to start: ${e.message}`, e.stack));

export default app;
