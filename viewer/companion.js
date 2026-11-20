// "Ask Wiremap": a beginner-friendly workshop assistant. Say or type a plain
// request ("how do I connect the motor to the ESP32", "my servo jitters",
// "go to power", "what is GND") and it zooms the 3D view to the exact pins,
// explains in plain words, and reads steps aloud. It runs locally from the
// project file and checker; questions it can't answer go to Claude Code or
// Codex through the inbox. No API keys, no network service.
import { h, icon, store, api } from './util.js';
import { connectionRows, connectionList, sayConnection, tagName, silkscreen } from './pinout.js';
import { interpret, suggestions, explainTerm } from './assistant.js';

const STATES = { idle: 'Ready', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const SAFETY = 'Unplug all power before you plug in or move any wire.';

export function createCompanion(app) {
  let state = 'idle';
  let rec = null;
  let voiceOut = store.get('wiremap.voice', true) !== false;
  const status = h('span.cmp-status', null, STATES.idle);
  const log = h('div.cmp-log', { 'aria-live': 'polite' });
  const chips = h('div.cmp-chips');
  const input = h('input.cmp-input', { type: 'text', placeholder: 'Ask anything, e.g. how do I connect the servo?', 'aria-label': 'Ask Wiremap',
    onkeydown: (e) => { if (e.key === 'Enter' && input.value.trim()) { handle(input.value); input.value = ''; } } });
  const mic = h('button.btn.small.cmp-mic', { type: 'button', disabled: !Recognition,
    title: Recognition ? 'Talk (or press V)' : 'Voice needs Chrome or Edge. You can type instead.', onclick: () => listen() }, icon('mic', 14), h('span', null, 'Talk'));
  const voiceBtn = h('button.btn.small.ghost', { type: 'button', 'aria-pressed': String(voiceOut), title: 'Read answers aloud',
    onclick: () => { voiceOut = !voiceOut; store.set('wiremap.voice', voiceOut); voiceBtn.setAttribute('aria-pressed', String(voiceOut)); voiceBtn.lastChild.textContent = voiceOut ? 'Voice on' : 'Voice off'; if (!voiceOut) stopSpeaking(); } },
  icon('play', 14), h('span', null, voiceOut ? 'Voice on' : 'Voice off'));
  const panel = h('div.cmp-panel', { hidden: true, role: 'dialog', 'aria-label': 'Ask Wiremap' },
    h('div.cmp-head', null, h('strong', null, 'Ask Wiremap'), status,
      h('button.cmp-close', { type: 'button', 'aria-label': 'Close', onclick: () => toggle(false) }, icon('x', 14))),
    log, chips,
    h('div.cmp-row', null, input, mic),
    h('div.cmp-actions', null,
      h('button.btn.small', { type: 'button', onclick: () => run({ kind: 'read' }, 'What do I do now?') }, icon('steps', 14), h('span', null, 'What do I do now?')),
      voiceBtn));
  const orb = h('button.cmp-orb', { type: 'button', 'aria-label': 'Ask Wiremap', title: 'Ask Wiremap (press V to talk)', onclick: () => toggle() },
    h('span.cmp-ring'), h('span.cmp-ring.r2'), h('span.cmp-core'));
  const pill = h('button.cmp-pill', { type: 'button', onclick: () => toggle(true) }, 'Ask Wiremap');
  const root = h('div.companion', { 'data-state': 'idle' }, panel, h('div.cmp-launch', null, pill, orb));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); toggle(false); orb.focus(); } });

  // Room the panel takes over the 3D view: on the right on wide screens, at the bottom on phones.
  const insetFor = (open) => {
    if (!open) return { right: 0, bottom: 0 };
    return window.innerWidth < 700 ? { right: 0, bottom: panel.offsetHeight + 20 } : { right: panel.offsetWidth + 24, bottom: 0 };
  };
  const setState = (s) => { state = s; root.dataset.state = s; status.textContent = STATES[s]; };
  function toggle(force) {
    const open = force ?? panel.hidden;
    panel.hidden = !open;
    root.classList.toggle('open', open);
    app.views['3d']?.setInset?.(insetFor(open));
    if (open) { renderChips(); if (!log.childElementCount) greet(); setTimeout(() => input.focus(), 0); }
  }
  function greet() {
    add('bot', 'Hi! I can show you exactly where each wire goes and help when something does not work. Tap a question below, type, or press Talk.');
  }
  function renderChips() {
    chips.replaceChildren(...suggestions(app).map((q) => h('button.cmp-chip', { type: 'button', onclick: () => handle(q) }, q)));
  }
  function add(who, text, extra) {
    const msg = h(`div.cmp-msg.${who}`, null, h('p', null, text), extra || null);
    log.append(msg);
    while (log.childElementCount > 12) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    return msg;
  }
  function stopSpeaking() { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); if (state === 'speaking') setState('idle'); }
  function speak(text) {
    if (!voiceOut || !('speechSynthesis' in window)) { setState('idle'); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.onstart = () => setState('speaking');
    u.onend = u.onerror = () => setState('idle');
    window.speechSynthesis.speak(u);
  }
  /** Answer in the log and out loud. */
  function answer(text, extra, spoken) { add('bot', text, extra); speak(spoken || text); }

  /** Zoom the 3D view to these wires and parts and light the exact pins. */
  async function show(wires, parts = []) {
    if (app.ui.view !== '3d') await app.switchView('3d');
    app.select({ type: 'wires', id: 'assistant', ids: wires, parts }, { sheet: false });
    setTimeout(() => { const v = app.views['3d']; v?.setInset?.(insetFor(!panel.hidden)); v?.fitFocus?.(); }, 350);
  }
  function wireCards(ids) { return connectionList(app, ids); }
  const stepOfWire = (id) => (app.data.project.steps || []).find((s) => (s.wires || []).includes(id));
  const askAI = (text, context) => h('button.btn.small.cmp-ai', { type: 'button', onclick: () => {
    const step = app.currentStep();
    app.inbox({ kind: 'ask', target: step ? `step:${step.id}` : 'project', text: `${text}\n\n${context || ''}`.trim(), title: 'Question from Ask Wiremap' });
  } }, icon('help', 14), 'Ask my AI (Claude Code or Codex)');

  async function run(r, text) {
    switch (r.kind) {
      case 'next': app.nextStep(1); return run({ kind: 'read' });
      case 'back': app.nextStep(-1); return run({ kind: 'read' });
      case 'done': {
        const step = app.currentStep();
        if (step) await app.setStepDone(step.id, true);
        answer('Nice work. Step marked done.');
        app.nextStep(1);
        return setTimeout(() => run({ kind: 'read' }), 200);
      }
      case 'stop': stopSpeaking(); return setState('idle');
      case 'read': {
        const step = app.currentStep();
        if (!step) return answer('This section has no steps. Try "go to wiring".');
        const rows = connectionRows(app, step.wires || []);
        if (rows.length) show(step.wires, step.parts || []);
        const intro = `${step.title}. ${step.text || ''}`;
        const extra = h('div', null, rows.length ? wireCards(step.wires) : null,
          (step.warnings || []).map((w) => h('div.cmp-warn', null, icon('alert', 13), w)),
          rows.length ? h('div.cmp-tip', null, SAFETY, ' Say "done" when finished.') : null);
        add('bot', intro, extra);
        return speak([intro, ...rows.map((x) => `Wire ${x.n}. ${sayConnection(x)}`), ...(step.warnings || []).map((w) => `Careful: ${w}`)].join(' '));
      }
      case 'check': {
        const c = app.data.check;
        if (c.errors) {
          const first = c.issues.find((i) => i.level === 'error');
          show(first.wires, first.parts);
          return answer(`Stop: ${c.errors} problem${c.errors === 1 ? '' : 's'} could damage parts. The first: ${first.message}`, first.fix ? h('div.cmp-tip', null, `Fix: ${first.fix}`) : null);
        }
        return answer(`No rule problems found${c.warnings ? `, with ${c.warnings} warning${c.warnings === 1 ? '' : 's'} to read` : ''}. Wiremap cannot check heat, noise or loose wires, so test one part at a time.`);
      }
      case 'step': {
        const all = (app.data.project.steps || []).filter(Boolean);
        const step = all[r.n - 1];
        if (!step) return answer(`This project has ${all.length} steps. Say a number from 1 to ${all.length}.`);
        const phase = step.phase || 'wire';
        app.gotoStep(all.filter((x) => (x.phase || 'wire') === phase).indexOf(step), phase);
        return run({ kind: 'read' });
      }
      case 'view': await app.switchView(r.view); return answer(`Here is the ${r.view === 'preview' ? 'motion preview' : r.view} view.`);
      case 'phase': app.setPhase(r.phase); return answer(`Opened ${r.phase}.`);
      case 'explain': return answer(r.text);
      case 'trouble': {
        show(r.wires, r.parts);
        const extra = h('div', null, r.wires.length ? wireCards(r.wires.slice(0, 6)) : null, askAI(text, r.lines.join('\n')));
        return answer(r.lines.join(' '), extra, r.lines.join(' '));
      }
      case 'connect': {
        const a = tagName(app, app.part(r.chain[0]) || r.from.parts[0]); const b = tagName(app, app.part(r.chain[r.chain.length - 1]) || r.to.parts[0]);
        const many = [r.from, r.to].filter((g) => g.parts.length > 1).map((g) => `There are ${g.parts.length} ${g.key}s; showing the ${tagName(app, app.part(g === r.from ? r.chain[0] : r.chain[r.chain.length - 1]))}. Name one (for example "${tagName(app, g.parts[1])}") to see another.`);
        if (!r.wires.length) return answer(`The ${a} and the ${b} are not wired together in this project yet.`, askAI(text));
        show(r.wires, r.chain);
        const via = r.chain.slice(1, -1).map((id) => tagName(app, app.part(id)));
        const step = stepOfWire(r.wires[0]);
        const rows = connectionRows(app, r.wires);
        const intro = `The ${a} connects to the ${b}${via.length ? ` through the ${via.join(' and ')}` : ''} with ${rows.length} wire${rows.length === 1 ? '' : 's'}, including power and ground. They are lit up in 3D.${step ? ` This is the step "${step.title}".` : ''}${many.length ? ` ${many.join(' ')}` : ''}`;
        const extra = h('div', null, wireCards(r.wires), h('div.cmp-tip', null, SAFETY),
          step ? h('button.btn.small', { type: 'button', onclick: () => { app.setPhase(step.phase || 'wire'); const list = (app.data.project.steps || []).filter((s) => (s.phase || 'wire') === (step.phase || 'wire')); app.gotoStep(list.indexOf(step)); } }, 'Go to that step') : null);
        add('bot', intro, extra);
        return speak([intro, ...rows.map((x) => `Wire ${x.n}. ${sayConnection(x)}`), SAFETY].join(' '));
      }
      case 'pin': {
        show(r.rows.map((x) => x.id), []);
        const lines = r.rows.map((x) => `${x.from.fullName} pin ${x.from.label} goes to ${x.to.fullName} pin ${x.to.label} (${x.colorName} wire).`);
        const meaning = explainTerm(r.rows[0].from.name) || explainTerm(r.rows[0].from.label);
        return answer(`${lines.join(' ')}${meaning ? ` ${meaning}` : ''}`, wireCards(r.rows.map((x) => x.id)));
      }
      case 'part': {
        const part = r.group.parts[0];
        const ids = app.data.check.model.wires.filter((w) => w.valid && (w.fromKey.startsWith(`${part.id}.`) || w.toKey.startsWith(`${part.id}.`))).map((w) => w.id);
        show(ids, r.group.parts.map((p) => p.id));
        const used = part.pins.filter((p) => app.data.check.pinInfo?.[p.key]?.connected).map((p) => silkscreen(p));
        const more = r.group.parts.length > 1 ? ` There are ${r.group.parts.length} of these; they are all lit.` : '';
        return answer(`This is the ${tagName(app, part)}. ${part.description || ''}${more} ${used.length ? `Its wired pins: ${used.slice(0, 10).join(', ')}.` : 'Nothing is wired to it yet.'}`);
      }
      case 'projects':
      case 'project': {
        let list = [];
        try { list = JSON.parse(await api('/api/projects')); } catch { /* offline */ }
        list = Array.isArray(list) ? list : (list.projects || []);
        const label = (p) => p.meta?.name || p.name;
        const open = (p) => { location.hash = `#/p/${encodeURIComponent(p.name)}`; };
        if (r.kind === 'project') {
          const want = r.name.toLowerCase();
          const hit = list.find((p) => p.name.toLowerCase() === want) || list.find((p) => `${label(p)} ${p.name}`.toLowerCase().includes(want));
          if (hit) { answer(`Opening ${label(hit)}.`); return open(hit); }
          if (r.soft) return answer(`There is no view, phase or project called "${r.name}".`, h('div.cmp-chips', null, list.map((p) => h('button.cmp-chip', { type: 'button', onclick: () => open(p) }, label(p)))));
        }
        if (!list.length) return answer('No projects found. Ask your AI: "Use wiremap to start a new project".');
        return answer(`You have ${list.length} project${list.length === 1 ? '' : 's'}. Pick one:`,
          h('div.cmp-chips', null, list.map((p) => h('button.cmp-chip', { type: 'button', onclick: () => open(p) }, label(p)))));
      }
      case 'ask': return answer('I can\'t answer that from the project file alone. Send it to your AI?', askAI(text));
      default: return setState('idle');
    }
  }

  async function handle(text) {
    toggle(true);
    add('you', text);
    setState('thinking');
    try { await run(interpret(app, text), text); }
    catch (e) { console.error(e); answer('Something went wrong showing that. Try asking another way.'); }
    renderChips();
  }

  function listen() {
    if (!Recognition) return;
    stopSpeaking();
    rec = new Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.onstart = () => setState('listening');
    rec.onerror = (e) => { setState('idle'); add('bot', e.error === 'not-allowed' ? 'The microphone is blocked. Allow it in the browser bar, or type your question.' : 'I did not catch that. Try again, or type it.'); };
    rec.onend = () => { if (state === 'listening') setState('idle'); };
    rec.onresult = (e) => handle(e.results[0][0].transcript);
    rec.start();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'v' || e.metaKey || e.ctrlKey || e.altKey || !root.isConnected) return;
    if (/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) return;
    toggle(true);
    if (Recognition) listen(); else input.focus();
  });
  // First visit: open once so beginners find it.
  if (store.get('wiremap.askSeen', false) !== true) { store.set('wiremap.askSeen', true); setTimeout(() => toggle(true), 600); }
  return { root, handle, toggle };
}
