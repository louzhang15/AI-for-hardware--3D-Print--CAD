// @ts-check
// Wiremap project model: resolves library references, parameters and pin
// definitions into one flat, validated structure the checker and the views use.
// Pure ES module with no dependencies: runs in Node and in the browser.

export const PIN_KINDS = [
  'power_in', 'power_out', 'power_rail', 'ground', 'digital', 'pwm', 'analog',
  'i2c_sda', 'i2c_scl', 'uart_tx', 'uart_rx', 'spi', 'motor', 'passive', 'nc',
];

export const PHASES = ['define', 'parts', 'power', 'wire', 'firmware', 'print', 'assemble', 'test'];

export const PHASE_TITLES = {
  define: 'Define', parts: 'Parts', power: 'Power', wire: 'Wire',
  firmware: 'Firmware', print: 'Print', assemble: 'Assemble', test: 'Test',
};

const NUMERIC_PIN_FIELDS = [
  'voltage', 'voltage_max', 'voltage_min', 'vmin', 'vmax', 'vih', 'current',
  'current_peak', 'current_max', 'pullup',
];

/** Deep clone of plain JSON data. */
export function clone(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

/**
 * Resolve "$param" strings against a params object. Also supports simple
 * arithmetic like "$vout*1.05" so derived values stay tied to the parameter.
 */
export function resolveValue(v, params, where, problems) {
  if (typeof v !== 'string' || !v.startsWith('$')) return v;
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:\s*([*+\-/])\s*(-?[0-9.]+))?$/.exec(v);
  if (!m) {
    problems.push(`${where}: cannot parse value "${v}"`);
    return undefined;
  }
  const base = params[m[1]];
  if (typeof base !== 'number') {
    problems.push(`${where}: parameter "${m[1]}" is not set`);
    return undefined;
  }
  if (!m[2]) return base;
  const k = Number(m[3]);
  switch (m[2]) {
    case '*': return base * k;
    case '/': return base / k;
    case '+': return base + k;
    case '-': return base - k;
  }
  return undefined;
}

function resolveObject(obj, params, where, problems) {
  if (Array.isArray(obj)) return obj.map((x, i) => resolveObject(x, params, `${where}[${i}]`, problems));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveObject(v, params, `${where}.${k}`, problems);
    return out;
  }
  return resolveValue(obj, params, where, problems);
}

/**
 * Parse an endpoint "part.pin". Pin names may contain dots? No: we split on
 * the first dot only, so pin names may contain dots but part ids may not.
 */
export function parseEndpoint(ep) {
  if (typeof ep !== 'string') return null;
  const i = ep.indexOf('.');
  if (i <= 0 || i === ep.length - 1) return null;
  return { part: ep.slice(0, i), pin: ep.slice(i + 1) };
}

/**
 * Build a resolved model from a project and a library map {id: def}.
 * Returns { parts, partList, wires, problems } where problems are structural
 * errors (unknown library part, unknown pin, duplicate id). The checker turns
 * these into issues.
 *
 * @param {any} project
 * @param {Record<string, any>} library
 */
export function resolveProject(project, library) {
  /** @type {{level:string, rule:string, message:string, parts?:string[], wires?:string[], pins?:string[]}[]} */
  const problems = [];
  /** @type {Map<string, any>} */
  const parts = new Map();
  const seenIds = new Set();

  for (const [idx, p] of (project.parts || []).entries()) {
    if (!p || typeof p.id !== 'string' || !p.id) {
      problems.push({ level: 'error', rule: 'schema', message: `parts[${idx}] has no id` });
      continue;
    }
    if (p.id.includes('.')) {
      problems.push({ level: 'error', rule: 'schema', message: `Part id "${p.id}" must not contain a dot`, parts: [p.id] });
      continue;
    }
    if (seenIds.has(p.id)) {
      problems.push({ level: 'error', rule: 'schema', message: `Duplicate part id "${p.id}"`, parts: [p.id] });
      continue;
    }
    seenIds.add(p.id);

    let base = {};
    if (p.library) {
      const lib = library[p.library];
      if (!lib) {
        problems.push({ level: 'error', rule: 'unknown-library-part', message: `Part "${p.id}" uses library part "${p.library}", which does not exist`, parts: [p.id] });
        continue;
      }
      base = clone(lib);
    }
    // Merge: project-level fields override library fields (except pins, merged by name).
    const def = { ...base, ...clone(p) };
    def.libraryId = p.library || null;
    const params = { ...(base.params || {}), ...(p.params || {}) };
    def.params = params;

    // Pins: library list, then project overrides/additions by name.
    /** @type {any[]} */
    let pins = clone(base.pins || []);
    const projectPins = p.pins;
    if (Array.isArray(projectPins)) {
      // Full definition (no library) or explicit list: merge by name.
      for (const pp of projectPins) {
        const existing = pins.find((x) => x.name === pp.name);
        if (existing) Object.assign(existing, pp);
        else pins.push(clone(pp));
      }
    } else if (projectPins && typeof projectPins === 'object') {
      for (const [name, over] of Object.entries(projectPins)) {
        const existing = pins.find((x) => x.name === name);
        if (existing) Object.assign(existing, over);
        else pins.push({ name, ...clone(over) });
      }
    }

    const pinMap = new Map();
    for (const pin of pins) {
      if (!pin || typeof pin.name !== 'string') {
        problems.push({ level: 'error', rule: 'schema', message: `Part "${p.id}" has a pin without a name`, parts: [p.id] });
        continue;
      }
      if (pinMap.has(pin.name)) {
        problems.push({ level: 'error', rule: 'schema', message: `Part "${p.id}" defines pin "${pin.name}" twice`, parts: [p.id] });
        continue;
      }
      if (pin.kind && !PIN_KINDS.includes(pin.kind)) {
        problems.push({ level: 'error', rule: 'schema', message: `Pin ${p.id}.${pin.name} has unknown kind "${pin.kind}"`, parts: [p.id], pins: [`${p.id}.${pin.name}`] });
      }
      for (const f of NUMERIC_PIN_FIELDS) {
        if (pin[f] !== undefined) {
          const msgs = [];
          pin[f] = resolveValue(pin[f], params, `${p.id}.${pin.name}.${f}`, msgs);
          for (const m of msgs) problems.push({ level: 'error', rule: 'schema', message: m, parts: [p.id] });
        }
      }
      pin.key = `${p.id}.${pin.name}`;
      pin.part = p.id;
      pin.label = pin.label || pin.name;
      pinMap.set(pin.name, pin);
    }
    def.pins = pins.filter((x) => pinMap.get(x.name) === x);
    def.pinMap = pinMap;

    const msgs = [];
    def.regulators = resolveObject(def.regulators || [], params, `${p.id}.regulators`, msgs);
    def.battery = def.battery ? resolveObject(def.battery, params, `${p.id}.battery`, msgs) : undefined;
    for (const m of msgs) problems.push({ level: 'error', rule: 'schema', message: m, parts: [p.id] });

    for (const reg of def.regulators) {
      for (const f of ['in', 'out', 'gnd']) {
        if (reg[f] && !pinMap.has(reg[f])) {
          problems.push({ level: 'error', rule: 'schema', message: `Part "${p.id}" regulator refers to unknown pin "${reg[f]}"`, parts: [p.id] });
        }
      }
    }
    def.internal = (def.internal || []).filter((group) => {
      const ok = Array.isArray(group) && group.every((n) => pinMap.has(n));
      if (!ok) problems.push({ level: 'error', rule: 'schema', message: `Part "${p.id}" has an internal connection with an unknown pin: ${JSON.stringify(group)}`, parts: [p.id] });
      return ok;
    });
    def.position = Array.isArray(p.position) ? p.position : null;
    def.rotation = Array.isArray(p.rotation) ? p.rotation : [0, 0, 0];
    def.size = def.size || [40, 10, 20];
    def.verify = Boolean(p.verify || base.verify || p.inferred);
    parts.set(p.id, def);
  }

  // Wires
  const wires = [];
  const wireIds = new Set();
  for (const [idx, w] of (project.wires || []).entries()) {
    const id = w && typeof w.id === 'string' && w.id ? w.id : `wire${idx + 1}`;
    if (wireIds.has(id)) {
      problems.push({ level: 'error', rule: 'schema', message: `Duplicate wire id "${id}"`, wires: [id] });
      continue;
    }
    wireIds.add(id);
    const a = parseEndpoint(w && w.from);
    const b = parseEndpoint(w && w.to);
    let ok = true;
    for (const [end, ep, raw] of [['from', a, w && w.from], ['to', b, w && w.to]]) {
      if (!ep) {
        problems.push({ level: 'error', rule: 'schema', message: `Wire "${id}" ${end} "${raw}" must look like "part.pin"`, wires: [id] });
        ok = false;
        continue;
      }
      const part = parts.get(ep.part);
      if (!part) {
        problems.push({ level: 'error', rule: 'unknown-endpoint', message: `Wire "${id}" ${end} refers to unknown part "${ep.part}"`, wires: [id] });
        ok = false;
      } else if (!part.pinMap.has(ep.pin)) {
        const names = part.pins.map((x) => x.name).join(', ');
        problems.push({ level: 'error', rule: 'unknown-endpoint', message: `Wire "${id}" ${end} refers to pin "${ep.pin}", which part "${ep.part}" does not have (pins: ${names})`, wires: [id], parts: [ep.part] });
        ok = false;
      }
    }
    if (ok && w.from === w.to) {
      problems.push({ level: 'warning', rule: 'schema', message: `Wire "${id}" connects ${w.from} to itself`, wires: [id] });
    }
    wires.push({ ...clone(w), id, valid: ok, fromKey: ok ? w.from : null, toKey: ok ? w.to : null });
  }

  return { parts, partList: [...parts.values()], wires, problems, project };
}

/** Look up a pin by "part.pin" key. */
export function getPin(model, key) {
  const ep = parseEndpoint(key);
  if (!ep) return undefined;
  const part = model.parts.get(ep.part);
  return part ? part.pinMap.get(ep.pin) : undefined;
}
