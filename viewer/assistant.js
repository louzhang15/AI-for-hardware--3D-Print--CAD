// Assistant brain: turns a plain request ("how do I connect the motor to the
// ESP32", "my servo jitters", "go to power", "what is GND") into an action on
// the viewer plus a beginner-friendly answer. Deterministic: it only uses the
// project file and the checker result. Anything it cannot answer goes to the
// user's AI through the inbox.
import { connectionRows, tagName, silkscreen } from './pinout.js';

/** Plain-language meaning of pin names and words a first-timer meets. */
export const GLOSSARY = [
  [/^(gnd|ground|-|bat-|out-|in-|gnd\d*|gnd_\w+)$/i, 'GND means ground. It is the return path for current, like the minus side of a battery. Every part in one build must share it, usually with black wires.'],
  [/^(vcc|vdd)$/i, 'VCC is the power input for the chip\'s logic. Feed it the voltage the board asks for, usually 3.3 V or 5 V.'],
  [/^(vin)$/i, 'VIN is a power input that goes through the board\'s own regulator. On an ESP32 DevKit feed it about 5 V.'],
  [/^(3v3|3\.3v)$/i, '3V3 is a 3.3 volt pin. On a dev board it is an output that can power small sensors, never motors or servos.'],
  [/^(5v|vbus)$/i, '5V or VBUS is a 5 volt pin, often straight from USB. It can power small 5 V modules.'],
  [/^(v\+|vm|vmot|\+|bat\+|out\+|in\+)$/i, 'V+ (or VM) is the motor or servo power. It comes from a separate supply that can give enough current.'],
  [/^(sda)$/i, 'SDA is the I2C data line. SDA connects only to SDA, usually with a blue wire.'],
  [/^(scl)$/i, 'SCL is the I2C clock line. SCL connects only to SCL, usually with a yellow wire.'],
  [/^(pwm\d*|signal|sig)$/i, 'A PWM or signal pin sends pulses that tell a servo where to move or a motor how fast to spin. It carries almost no current.'],
  [/^(tx\d*|txd)$/i, 'TX means transmit. It goes to the RX pin of the other board.'],
  [/^(rx\d*|rxd)$/i, 'RX means receive. It goes to the TX pin of the other board.'],
  [/^(gpio\d+|d\d+|gp\d+|io\d+)$/i, 'A GPIO pin is a general input or output pin the code controls. On an ESP32 it handles 3.3 V only.'],
  [/^(en|enable|stby|standby|oe)$/i, 'EN, STBY or OE turn a chip on or off. Leaving them unconnected can make a board do nothing.'],
  [/^(i2c)$/i, 'I2C is a two-wire bus (SDA and SCL) that lets one controller talk to many sensors and drivers.'],
  [/^(breadboard)$/i, 'A breadboard is a board with holes joined in strips of five, so you can connect parts without soldering.'],
];

export function explainTerm(term) {
  const t = String(term || '').trim();
  const hit = GLOSSARY.find(([re]) => re.test(t));
  return hit ? hit[1] : null;
}

const STOP = new Set(['the', 'and', 'with', 'from', 'into', 'board', 'module', 'my', 'a', 'an', 'to', 'of', 'for', 'how', 'do', 'i', 'it', 'is', 'this', 'that', 'pin', 'pins', 'wire', 'wires', 'connect', 'connected', 'supply', 'v', 'dc']);
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9+]+/).filter((w) => w && !STOP.has(w));
const CATEGORY_WORDS = { actuator: ['motor', 'motors', 'servo', 'servos'], controller: ['controller', 'micro', 'microcontroller', 'brain'],
  driver: ['driver'], power: ['power', 'supply', 'psu', 'adapter'], battery: ['battery', 'lipo', 'pack'], sensor: ['sensor'] };

/** Parts named in free text, in the order they appear. Ties (four servos) keep all matches. */
export function findParts(app, text) {
  const q = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9+ ]/g, ' ')} `;
  const found = [];
  for (const part of app.data.check.model.partList) {
    const keys = new Set([part.id.toLowerCase(), tagName(app, part).toLowerCase(), ...words(part.name), ...words(part.libraryId),
      ...(CATEGORY_WORDS[part.category] || [])]);
    if (/motor/i.test(part.name || '') || /motor/i.test(part.libraryId || '')) keys.add('motor');
    let best = null;
    for (const k of keys) {
      if (k.length < 3) continue;
      const i = q.indexOf(` ${k} `) >= 0 ? q.indexOf(` ${k} `) : q.indexOf(` ${k}s `);
      if (i < 0) continue;
      const specific = !Object.values(CATEGORY_WORDS).flat().includes(k);
      // "motor" means the motors, not the "motor supply".
      const ownCategory = (CATEGORY_WORDS[part.category] || []).includes(k) || (k.startsWith('motor') && part.category === 'actuator');
      const score = k.length + (specific ? 10 : 0) + (ownCategory ? 5 : 0);
      if (!best || score > best.score) best = { part, index: i, score, key: k };
    }
    if (best) found.push(best);
  }
  // Keep the most specific match for each place in the sentence.
  found.sort((a, b) => a.index - b.index || b.score - a.score);
  const groups = [];
  for (const f of found) {
    const g = groups.find((x) => Math.abs(x.index - f.index) < 2 || x.key === f.key);
    if (!g) groups.push({ index: f.index, key: f.key, score: f.score, parts: [f.part] });
    else if (f.score > g.score) Object.assign(g, { score: f.score, key: f.key, parts: [f.part] });
    else if (f.score === g.score) g.parts.push(f.part);
  }
  // "left motor": the specific word wins over the generic "motor" right after it.
  const generic = new Set(Object.values(CATEGORY_WORDS).flat());
  return groups.filter((g) => !(generic.has(g.key) || generic.has(g.key.replace(/s$/, ''))) ||
    !groups.some((o) => o !== g && !generic.has(o.key) && Math.abs(o.index - g.index) < 16 &&
      o.parts.every((p) => (CATEGORY_WORDS[p.category] || []).includes(g.key) || (g.key.startsWith('motor') && p.category === 'actuator'))));
}

/** Wires along the shortest chain of parts from A to B (directly, or through a driver). */
export function pathWires(app, fromIds, toIds) {
  const wires = app.data.check.model.wires.filter((w) => w.valid);
  const adj = new Map();
  for (const w of wires) {
    const a = w.fromKey.split('.')[0]; const b = w.toKey.split('.')[0];
    if (a === b) continue;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!adj.has(x)) adj.set(x, new Map());
      if (!adj.get(x).has(y)) adj.get(x).set(y, []);
      adj.get(x).get(y).push(w.id);
    }
  }
  const targets = new Set(toIds);
  const prev = new Map(fromIds.map((id) => [id, null]));
  const queue = [...fromIds];
  let hit = null;
  while (queue.length && !hit) {
    const cur = queue.shift();
    for (const next of (adj.get(cur) || new Map()).keys()) {
      if (prev.has(next)) continue;
      // Do not route through supplies: "motor to ESP32" should go through the driver, not the ground rail.
      const cat = app.part(next)?.category;
      prev.set(next, cur);
      if (targets.has(next)) { hit = next; break; }
      if (!['power', 'battery', 'protection', 'passive'].includes(cat)) queue.push(next);
    }
  }
  if (!hit) return { chain: [], wires: [] };
  const chain = [hit];
  while (prev.get(chain[0])) chain.unshift(prev.get(chain[0]));
  const ids = [];
  for (let i = 0; i + 1 < chain.length; i++) ids.push(...adj.get(chain[i]).get(chain[i + 1]));
  // Also the power and ground wires of the end parts: a beginner needs those too.
  for (const end of [chain[0], chain[chain.length - 1]]) {
    const part = app.part(end);
    // Power for the device being connected (servo, motor, sensor); the controller's own USB power is a separate step.
    if (!part || ['controller', 'power', 'battery', 'protection', 'passive'].includes(part.category)) continue;
    const keys = new Set((part?.pins || []).filter((p) => ['power_in', 'power_out', 'power_rail', 'ground'].includes(p.kind)).map((p) => p.key));
    for (const w of wires) if (keys.has(w.fromKey) || keys.has(w.toKey)) ids.push(w.id);
  }
  return { chain, wires: [...new Set(ids)] };
}

const SYMPTOMS = [
  { re: /\b(resets?|resetting|reboot\w*|restart(s|ing)|brown ?outs?|browns? out|keeps? (turning|shutting) off|crash(es|ing)?)\b/, kind: 'power' },
  { re: /\b(jitter\w*|shak(es|ing|y)|twitch\w*|buzz(es|ing)?|stutter\w*|flicker\w*)\b/, kind: 'power' },
  { re: /\b(hot|too warm|smok\w*|burn(s|ing|t|ed)?|smell\w*|melt\w*)\b/, kind: 'heat' },
  { re: /\b(i2c (device )?not found|not found on i2c|no i2c device|i2c scanner finds nothing|wrong address)\b/, kind: 'i2c' },
  { re: /\b(not (moving|spinning|working|turning|responding|starting|doing anything)|(doesn'?t|does not|won'?t|will not|can'?t|cannot) (move|spin|work|turn|respond|start|power on|turn on)|dead|nothing happens|no (power|light|response))\b/, kind: 'dead' },
];

/** Deterministic first-pass troubleshooting from the checker result. */
export function troubleshoot(app, text, partIds) {
  // Questions about a pin or a connection are not complaints ("what is the reset pin").
  if (/^(what|where|which|how do i (connect|wire|hook)|explain|show|go to|open)\b/.test(text)) return null;
  const kind = SYMPTOMS.find((s) => s.re.test(text))?.kind;
  if (!kind) return null;
  const check = app.data.check;
  const touches = (i) => !partIds.length || i.parts.some((p) => partIds.includes(p));
  const lines = [];
  const focusWires = new Set(); const focusParts = new Set(partIds);
  const issues = check.issues.filter((i) => i.level !== 'info' && touches(i));
  if (kind === 'heat') lines.push('Unplug the power now. Let it cool before touching anything.');
  if (kind === 'power' || kind === 'heat' || kind === 'dead') {
    const rails = check.power.rails.filter((r) => !partIds.length || partIds.includes(r.sourcePart) || r.loads.some((l) => partIds.includes(l.part)));
    for (const r of rails) {
      if (r.capacity && r.pctPeak > 0.8) {
        lines.push(`The ${r.name.split(' (')[0]} supply can give ${r.capacity} A, but the parts on it can pull ${r.loadPeak} A when moving. When they all move, the voltage drops and boards reset or servos twitch.`);
        r.loads.forEach((l) => focusParts.add(l.part)); focusParts.add(r.sourcePart);
      }
    }
  }
  for (const i of issues.filter((x) => ['power', 'heat', 'dead'].includes(kind) || /i2c|pullup|bus/.test(x.rule)).slice(0, 3)) {
    lines.push(i.message);
    i.wires.forEach((w) => focusWires.add(w)); i.parts.forEach((p) => focusParts.add(p));
  }
  if (kind === 'i2c') {
    for (const w of check.model.wires) if (/i2c/.test(check.wireInfo[w.id]?.role || '')) focusWires.add(w.id);
    lines.push('Check that SDA goes to SDA and SCL to SCL, that the sensor has power and GND, and that the address in your code matches the board.');
  }
  if (kind === 'dead') {
    for (const id of partIds) {
      const part = app.part(id);
      for (const pin of part.pins.filter((p) => ['power_in', 'ground'].includes(p.kind))) {
        if (!check.pinInfo[pin.key]?.connected) lines.push(`${tagName(app, part)} pin ${silkscreen(pin)} is not connected. ${explainTerm(pin.name) || ''}`);
      }
      for (const w of check.model.wires) if (w.valid && (w.fromKey.startsWith(`${id}.`) || w.toKey.startsWith(`${id}.`))) focusWires.add(w.id);
    }
    for (const id of partIds) {
      const part = app.part(id);
      // What feeds this part: the neighbours and the pins it uses on them.
      const touching = check.model.wires.filter((w) => w.valid && (w.fromKey.startsWith(`${id}.`) || w.toKey.startsWith(`${id}.`)));
      const byNeighbour = new Map();
      for (const w of touching) {
        const other = w.fromKey.startsWith(`${id}.`) ? w.toKey : w.fromKey;
        const [nid, pinName] = other.split('.');
        if (!byNeighbour.has(nid)) byNeighbour.set(nid, []);
        byNeighbour.get(nid).push(silkscreen(app.part(nid)?.pinMap.get(pinName)));
      }
      for (const [nid, pins] of byNeighbour) {
        const n = app.part(nid);
        if (['driver', 'controller'].includes(n?.category)) {
          lines.push(`The ${tagName(app, part)} is driven by ${tagName(app, n)} pins ${[...new Set(pins)].join(', ')}.`);
          for (const pin of n.pins.filter((p) => p.required)) {
            const ok = check.pinInfo[pin.key]?.connected;
            lines.push(`${tagName(app, n)} pin ${silkscreen(pin)} is ${ok ? 'connected' : 'NOT connected'}. ${explainTerm(pin.name) || ''}`.trim());
            focusParts.add(nid);
          }
          for (const pin of n.pins.filter((p) => p.kind === 'power_in')) {
            const net = check.nets.netOfPin.get(pin.key);
            const v = net?.voltage;
            lines.push(v ? `Measure ${tagName(app, n)} pin ${silkscreen(pin)} to GND with a multimeter: it should read about ${Number(v.toFixed(2))} V.` : `${tagName(app, n)} pin ${silkscreen(pin)} has no supply wired.`);
          }
        }
      }
    }
    lines.push('With the power off, wiggle each wire on these pins. A loose jumper is the most common cause. Then check your code drives the right pins (pins.h).');
  }
  if (kind === 'power') lines.push('Fixes that usually work: a bigger supply for the motors, a 470 µF capacitor across the servo power, and short thick power wires. Keep all grounds joined.');
  if (!lines.length) lines.push('The checker finds no rule problem near these parts. Check for loose jumpers and measure the supply voltage with a multimeter.');
  return { lines: [...new Set(lines)], wires: [...focusWires], parts: [...focusParts] };
}

const VIEWS = { pinout: 'pinout', pins: 'pinout', sketch: 'sketch', diagram: 'sketch', breadboard: 'breadboard', '3d': '3d', 'power tree': 'power', assembly: 'assembly', motion: 'preview', preview: 'preview' };
const PHASE_WORDS = { define: 'define', plan: 'define', parts: 'parts', shopping: 'parts', buy: 'parts', power: 'power', wire: 'wire', wiring: 'wire', firmware: 'firmware', code: 'firmware', print: 'print', printing: 'print', assemble: 'assemble', assembly: 'assemble', test: 'test', testing: 'test' };
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, first: 1, second: 2, third: 3, fourth: 4, fifth: 5 };

/** Decide what a request means. Returns {kind, ...}. */
export function interpret(app, text) {
  const q = String(text || '').toLowerCase().replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return { kind: 'none' };
  if (/^(next|next step|go on|continue)$/.test(q)) return { kind: 'next' };
  if (/^(done|finished|i did it|did it|ok done|step done)$/.test(q)) return { kind: 'done' };
  if (/^(back|previous|go back|last step|previous step)$/.test(q)) return { kind: 'back' };
  if (/^(stop|quiet|silence|shut up)$/.test(q)) return { kind: 'stop' };
  if (/^(repeat|again|say (that|it) again|read( (the|this))? step|what now|what do i do( now| next)?|guide me|start|help|help me( start)?|where do i start)$/.test(q)) return { kind: 'read' };
  if (/^(check|is it (safe|ok|right)|any (errors|problems)|did i do it right)/.test(q)) return { kind: 'check' };

  // Projects: "open the rover project", "what projects do I have"
  if (/\b(projects|my builds)\b/.test(q) && /(what|which|list|show|my)/.test(q)) return { kind: 'projects' };
  const proj = /^(?:open|switch to|go to|load|work on)\s+(?:the\s+|my\s+)?(.+?)\s+(?:project|build)$/.exec(q);
  if (proj) return { kind: 'project', name: proj[1] };

  // Navigation: "go to power", "open pinout", "go to step 3"
  const nav = /^(?:go to|goto|open|switch to|load|work on|take me to|show me|show)\s+(?:the\s+)?(.+?)(?:\s+(?:tab|view|section|page|phase))?$/.exec(q);
  if (nav) {
    const target = nav[1];
    const step = /^step\s+(\d+|[a-z]+)$/.exec(target);
    if (step) return { kind: 'step', n: Number(step[1]) || NUM[step[1]] || 1 };
    if (VIEWS[target]) return { kind: 'view', view: VIEWS[target] };
    if (PHASE_WORDS[target]) return { kind: 'phase', phase: PHASE_WORDS[target] };
    if (/^(open|switch to|load|work on)\b/.test(q) && !findParts(app, target).length) return { kind: 'project', name: target, soft: true };
  }

  // Meaning of a term: "what is GND", "what does VIN mean"
  const term = /^(?:what(?:'s| is| does| are)|explain|meaning of)\s+(?:a\s+|an\s+|the\s+)?([a-z0-9+_.-]+)(?:\s+(?:mean|pin|do|for))?$/.exec(q);
  if (term && explainTerm(term[1])) return { kind: 'explain', text: explainTerm(term[1]), term: term[1] };

  if (/\b(solidworks|sldprt|sldasm|feature tree|rebuild|sketch|extrude|fillet|mate|my model|this part|my part)\b/.test(q)) return { kind: 'ask', text };
  const parts = findParts(app, q);
  const fix = troubleshoot(app, q, parts.flatMap((g) => g.parts.map((p) => p.id)));
  if (fix) return { kind: 'trouble', ...fix, groups: parts };

  // Two parts named with a connect verb: how they connect.
  if (parts.length >= 2 && /\b(connect\w*|wire|wiring|hook\w*|attach\w*|plug\w*|link\w*|join\w*|goes? to)\b/.test(q)) {
    const [a, b] = parts;
    const path = pathWires(app, a.parts.map((p) => p.id), b.parts.map((p) => p.id));
    return { kind: 'connect', from: a, to: b, ...path };
  }

  // A pin named: "where does SDA go", "esp32 d21"
  const all = connectionRows(app, app.data.check.model.wires.map((w) => w.id));
  const ask = q.replace(/\s+(go|goes|connect|connects|connected|plug|plugs|plugged)(\s+(to|into|in))?$/, '');
  const pm = /(?:^|\s)(?:pin\s+)?([a-z0-9+_/-]+)$/.exec(ask);
  if (pm && /(where|which|what|connect|plug|pin)/.test(q)) {
    const token = pm[1];
    const partIds = parts.flatMap((g) => g.parts.map((p) => p.id));
    const norm = (v) => String(v || '').toLowerCase();
    const match = (e) => (norm(e.label) === token || norm(e.name) === token || norm(e.label).split(/[\s/()]+/).includes(token)) && (!partIds.length || partIds.includes(e.part));
    const hits = all.filter((r) => match(r.from) || match(r.to)).map((r) => (match(r.from) ? r : { ...r, from: r.to, to: r.from }));
    if (hits.length) return { kind: 'pin', rows: hits.slice(0, 4) };
    if (explainTerm(token)) return { kind: 'explain', text: explainTerm(token), term: token };
  }

  // One part named in a short command: show it. Longer questions go to the AI.
  if (parts.length === 1 && (/^(show|find|where is|where's|zoom|focus|highlight|locate)\b/.test(q) || q.split(' ').length <= 3)) return { kind: 'part', group: parts[0] };
  return { kind: 'ask', text };
}

/** Example requests for the current step, shown as one-tap chips. */
export function suggestions(app) {
  const step = app.currentStep();
  const out = [];
  const rows = connectionRows(app, step?.wires || []);
  const ends = [...new Set(rows.flatMap((r) => [r.from.partName, r.to.partName]))];
  if (step) out.push('What do I do now?');
  if (ends.length >= 2) out.push(`How do I connect the ${ends[0]} to the ${ends[1]}?`);
  if (rows[0]) out.push(`Where does ${rows[0].to.label} go?`);
  if (rows[0]) out.push(`What is ${rows[0].from.label}?`);
  out.push('Is it safe?', 'My servo jitters', 'Go to pinout', 'What projects do I have?');
  return [...new Set(out)].slice(0, 7);
}
