// @ts-check
// Net extraction: joins pins through wires and through connections inside a
// part (internal groups such as the two GND pins of a dev board). Also keeps
// the pin graph so the checker can reason about current through each wire.

class UnionFind {
  constructor() { this.parent = new Map(); }
  add(x) { if (!this.parent.has(x)) this.parent.set(x, x); }
  find(x) {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    let c = x;
    while (this.parent.get(c) !== r) { const n = this.parent.get(c); this.parent.set(c, r); c = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

/**
 * @param {ReturnType<import('./model.js').resolveProject>} model
 */
export function buildNets(model) {
  const uf = new UnionFind();
  /** Pin graph edges: {a, b, kind: 'wire'|'internal', wire?, part?, series?} */
  const edges = [];
  for (const part of model.partList) {
    for (const pin of part.pins) uf.add(pin.key);
    for (const group of part.internal) {
      for (let i = 1; i < group.length; i++) {
        const a = `${part.id}.${group[0]}`;
        const b = `${part.id}.${group[i]}`;
        uf.union(a, b);
        edges.push({ a, b, kind: 'internal', part: part.id, series: part.protection || null });
      }
    }
  }
  for (const w of model.wires) {
    if (!w.valid) continue;
    uf.union(w.fromKey, w.toKey);
    edges.push({ a: w.fromKey, b: w.toKey, kind: 'wire', wire: w.id });
  }

  /** @type {Map<string, {id:string, pins:string[], wires:string[], name:string}>} */
  const byRoot = new Map();
  for (const part of model.partList) {
    for (const pin of part.pins) {
      const r = uf.find(pin.key);
      if (!byRoot.has(r)) byRoot.set(r, { id: '', pins: [], wires: [], name: '' });
      byRoot.get(r).pins.push(pin.key);
    }
  }
  for (const w of model.wires) {
    if (!w.valid) continue;
    byRoot.get(uf.find(w.fromKey)).wires.push(w.id);
  }

  const nets = [];
  const netOfPin = new Map();
  let n = 0;
  for (const net of byRoot.values()) {
    net.id = `N${++n}`;
    nets.push(net);
    for (const k of net.pins) netOfPin.set(k, net);
  }

  // Adjacency for graph reasoning
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push(e);
    adj.get(e.b).push(e);
  }

  const pinOf = (key) => {
    const i = key.indexOf('.');
    const part = model.parts.get(key.slice(0, i));
    return part ? part.pinMap.get(key.slice(i + 1)) : undefined;
  };

  // Classify and name nets
  for (const net of nets) {
    const pins = net.pins.map(pinOf).filter(Boolean);
    net.sources = pins.filter((p) => p.kind === 'power_out' && typeof p.voltage === 'number' && p.voltage > 0).map((p) => p.key);
    net.grounds = pins.filter((p) => p.kind === 'ground').map((p) => p.key);
    net.loads = pins.filter((p) => p.kind === 'power_in').map((p) => p.key);
    net.isGround = net.grounds.length > 0 && net.sources.length === 0;
    net.isPower = net.sources.length > 0 || (net.loads.length > 0 && net.grounds.length === 0 && pins.every((p) => ['power_in', 'power_out', 'power_rail', 'passive'].includes(p.kind)));
    const kinds = new Set(pins.map((p) => p.kind));
    net.kinds = [...kinds];
    net.voltage = net.sources.length ? Math.max(...net.sources.map((k) => pinOf(k).voltage)) : null;
    net.connected = net.wires.length > 0;
    net.name = nameNet(net, pins);
  }

  return { nets, netOfPin, edges, adj, pinOf };
}

function nameNet(net, pins) {
  if (net.isGround) return 'GND';
  if (net.sources.length) {
    const v = net.voltage;
    return `${fmtV(v)} (${net.sources[0]})`;
  }
  const signal = pins.find((p) => ['i2c_sda', 'i2c_scl', 'uart_tx', 'uart_rx', 'pwm', 'digital', 'analog', 'spi', 'motor'].includes(p.kind));
  if (signal) return pins.map((p) => p.key).slice(0, 3).join(' – ');
  return pins.map((p) => p.key).slice(0, 2).join(' – ');
}

export function fmtV(v) {
  if (typeof v !== 'number') return '?V';
  return `${Number(v.toFixed(2))}V`;
}

/** Role of a net or wire for colors and filters. */
export function netRole(net, pinOf) {
  if (net.isGround || net.grounds.length) return 'ground';
  if (net.sources.length || net.loads.length) return 'power';
  const kinds = new Set(net.pins.map((k) => pinOf(k)?.kind));
  if (kinds.has('i2c_sda')) return 'i2c_sda';
  if (kinds.has('i2c_scl')) return 'i2c_scl';
  if (kinds.has('uart_tx') || kinds.has('uart_rx')) return 'uart';
  if (kinds.has('pwm')) return 'pwm';
  if (kinds.has('motor')) return 'motor';
  if (kinds.has('spi')) return 'spi';
  if (kinds.has('analog')) return 'analog';
  if (kinds.has('power_rail')) return 'power';
  return 'digital';
}

/** Fixed wire colors (match common jumper colors). */
export const ROLE_COLORS = {
  power: { name: 'red', hex: '#e5484d' },
  ground: { name: 'black', hex: '#4a4f57' },
  i2c_sda: { name: 'blue', hex: '#3e8ef7' },
  i2c_scl: { name: 'yellow', hex: '#f5c518' },
  pwm: { name: 'orange', hex: '#f08c2e' },
  uart: { name: 'green', hex: '#30a46c' },
  motor: { name: 'purple', hex: '#9b6ef3' },
  spi: { name: 'brown', hex: '#a0703c' },
  analog: { name: 'white', hex: '#d8dce2' },
  digital: { name: 'white', hex: '#d8dce2' },
};

export const ROLE_LABELS = {
  power: 'Power', ground: 'Ground', i2c_sda: 'I2C data', i2c_scl: 'I2C clock', pwm: 'PWM',
  uart: 'UART', motor: 'Motor', spi: 'SPI', analog: 'Analog', digital: 'Digital',
};

/** Colors a jumper can be named; used to warn when a wire color hides its role. */
export const COLOR_HEX = {
  red: '#e5484d', black: '#4a4f57', gray: '#8b929c', grey: '#8b929c', blue: '#3e8ef7', yellow: '#f5c518',
  orange: '#f08c2e', green: '#30a46c', purple: '#9b6ef3', brown: '#a0703c', white: '#d8dce2', pink: '#ec6cb9',
};
