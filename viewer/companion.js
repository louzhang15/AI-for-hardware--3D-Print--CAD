// Voice companion: a small workshop assistant panel with clear states
// (ready, listening, thinking, speaking). It reads the current step aloud,
// answers "where does SDA go", moves between steps, and forwards anything
// else to the user's AI through the inbox. Uses the browser's own speech
// APIs; no network service and no API key.
import { h, icon, splitKey } from './util.js';
import { connectionRows, sayConnection, tagName, silkscreen } from './pinout.js';

const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const STATES = { idle: 'Ready', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking…' };
const Recognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

/** Find a pin or part named in free text. Exported for tests. */
export function interpret(app, text) {
  const q = String(text || '').toLowerCase().replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return { kind: 'none' };
  if (/^(next|done|next step|go on|continue)\b/.test(q)) return { kind: 'next' };
  if (/^(back|previous|go back|last step)\b/.test(q)) return { kind: 'back' };
  if (/\b(repeat|again|read( (the|this))? step|what now|what do i do)\b/.test(q)) return { kind: 'read' };
  if (/\b(stop|quiet|silence)\b/.test(q)) return { kind: 'stop' };
  if (/\b(check|errors?|status|is it safe)\b/.test(q)) return { kind: 'check' };
  const wires = app.data.check.model.wires.filter((w) => w.valid);
  const step = app.currentStep();
  const stepWires = new Set(step?.wires || []);
  const rows = connectionRows(app, [...wires.filter((w) => stepWires.has(w.id)), ...wires.filter((w) => !stepWires.has(w.id))].map((w) => w.id));
  const ask = q.replace(/\s+(go|goes|connect|connects|connected|plug|plugs|plugged)(\s+(to|into|in))?$/, '');
  const m = /^(?:where (?:does|do|is|should)|what (?:does|is)|which wire (?:goes to|is)|connect|plug)\s+(?:the\s+)?(.*?)\s*(?:pin\s+)?([a-z0-9+_/-]+)$/.exec(ask);
  if (m) {
    const token = m[2];
    const partHint = m[1].replace(/\b(the|my|on|of|pin|from)\b/g, '').trim();
    const norm = (v) => String(v || '').toLowerCase();
    const match = (e) => (norm(e.label) === token || norm(e.name) === token || norm(e.label).split(/[\s/()]+/).includes(token)) &&
      (!partHint || norm(e.partName).includes(partHint) || norm(e.fullName).includes(partHint) || norm(e.part).includes(partHint));
    const hits = rows.filter((r) => match(r.from) || match(r.to))
      .map((r) => (match(r.from) ? r : { ...r, from: r.to, to: r.from }));
    if (hits.length) return { kind: 'pin', rows: hits.slice(0, 3) };
  }
  const showQ = /^(?:show|find|where is|zoom to|focus(?: on)?)\s+(?:me\s+)?(?:the\s+)?(.+)$/.exec(q);
  if (showQ) {
    const name = showQ[1];
    const part = app.data.check.model.partList.find((p) => [p.id, p.name, tagName(app, p)].some((s) => String(s || '').toLowerCase().includes(name)));
    if (part) return { kind: 'part', part };
  }
  return { kind: 'ask', text };
}

export function createCompanion(app) {
  let state = 'idle';
  let rec = null;
  let open = false;
  const status = h('span.cmp-status', null, STATES.idle);
  const said = h('p.cmp-said', { 'aria-live': 'polite' }, 'Ask me where a wire goes, or press Read step.');
  const orb = h('button.cmp-orb', { type: 'button', 'aria-label': 'Workshop assistant', title: 'Workshop assistant (V to talk)', onclick: () => toggle() },
    h('span.cmp-ring'), h('span.cmp-ring.r2'), h('span.cmp-core'));
  const input = h('input.cmp-input', { type: 'text', placeholder: 'Type: where does SDA go?', 'aria-label': 'Ask the assistant',
    onkeydown: (e) => { if (e.key === 'Enter' && input.value.trim()) { handle(input.value); input.value = ''; } } });
  const mic = h('button.btn.small.cmp-mic', { type: 'button', disabled: !Recognition, title: Recognition ? 'Talk (V)' : 'Voice input needs Chrome or Edge',
    onclick: () => listen() }, icon('mic', 14), h('span', null, 'Talk'));
  const readBtn = h('button.btn.small', { type: 'button', onclick: () => readStep() }, icon('play', 14), h('span', null, 'Read step'));
  const stopBtn = h('button.btn.small.ghost', { type: 'button', onclick: () => stop() }, icon('x', 14), h('span', null, 'Stop'));
  const panel = h('div.cmp-panel', { hidden: true },
    h('div.cmp-head', null, h('strong', null, 'Workshop assistant'), status),
    said, h('div.cmp-actions', null, mic, readBtn, stopBtn), input);
  const root = h('div.companion', { 'data-state': 'idle' }, panel, orb);

  function setState(s) { state = s; root.dataset.state = s; status.textContent = STATES[s]; }
  function toggle(force) {
    open = force ?? !open;
    panel.hidden = !open;
    root.classList.toggle('open', open);
  }
  function say(text) {
    said.textContent = text;
    if (!('speechSynthesis' in window)) { setState('idle'); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.onstart = () => setState('speaking');
    u.onend = () => setState('idle');
    u.onerror = () => setState('idle');
    window.speechSynthesis.speak(u);
  }
  function stop() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    if (rec) { try { rec.abort(); } catch { /* ignore */ } rec = null; }
    setState('idle');
  }
  function readStep() {
    const step = app.currentStep();
    if (!step) { say('There is no step in this phase.'); return; }
    const rows = connectionRows(app, step.wires || []);
    const parts = [step.title + '.', step.text || ''];
    for (const r of rows) parts.push(`Wire ${r.n}. ${sayConnection(r)}`);
    for (const w of step.warnings || []) parts.push(`Warning: ${w}`);
    say(parts.filter(Boolean).join(' '));
  }
  function listen() {
    if (!Recognition) return;
    stop();
    rec = new Recognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setState('listening');
    rec.onerror = (e) => { setState('idle'); said.textContent = e.error === 'not-allowed' ? 'Microphone blocked. Allow it in the browser, or type below.' : 'Did not catch that. Try again or type.'; };
    rec.onend = () => { if (state === 'listening') setState('idle'); };
    rec.onresult = (e) => handle(e.results[0][0].transcript);
    rec.start();
  }
  async function handle(text) {
    toggle(true);
    setState('thinking');
    said.textContent = `“${text}”`;
    const r = interpret(app, text);
    if (r.kind === 'next') { app.nextStep(1); setTimeout(readStep, 150); }
    else if (r.kind === 'back') { app.nextStep(-1); setTimeout(readStep, 150); }
    else if (r.kind === 'read') readStep();
    else if (r.kind === 'stop') stop();
    else if (r.kind === 'check') {
      const c = app.data.check;
      say(c.errors ? `${c.errors} error${c.errors === 1 ? '' : 's'} found. The first one: ${c.issues[0].message}` : `No rule violations found, with ${c.warnings} warning${c.warnings === 1 ? '' : 's'}. Heat, noise and mechanical load are not checked.`);
    } else if (r.kind === 'pin') {
      app.select({ type: 'wire', id: r.rows[0].id }, { sheet: false });
      say(r.rows.map((row) => `${row.from.fullName} pin ${row.from.label} goes to ${row.to.fullName} pin ${row.to.label}, with ${article(row.colorName)} ${row.colorName} wire.`).join(' '));
    } else if (r.kind === 'part') {
      app.select({ type: 'part', id: r.part.id }, { sheet: false });
      const used = r.part.pins.filter((p) => app.data.check.pinInfo?.[p.key]?.connected).map((p) => silkscreen(p));
      say(`Here is ${tagName(app, r.part)}. ${used.length ? `Its wired pins are ${used.slice(0, 8).join(', ')}.` : 'Nothing is wired to it yet.'}`);
    } else if (r.kind === 'ask') {
      const step = app.currentStep();
      say('That needs your AI. Sending the question to Claude Code or Codex.');
      app.inbox({ kind: 'ask', target: step ? `step:${step.id}` : 'project', text, title: 'Question from the workshop assistant' });
    } else setState('idle');
  }

  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'v' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) return;
    if (!root.isConnected) return;
    toggle(true);
    if (Recognition) listen(); else input.focus();
  });
  return { root, readStep, handle, stop, splitKey };
}
