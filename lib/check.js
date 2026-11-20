// @ts-check
// Wiremap electrical checker: plain deterministic rules, no AI, no physics
// simulation. Runs in Node (CLI, tests) and in the browser (viewer).
//
// "0 errors" means "no rule violations found", never "this design is safe":
// see NOT_CHECKED for what the rules cannot see.

import { resolveProject } from './model.js';
import { buildNets, netRole, ROLE_COLORS, COLOR_HEX, fmtV } from './nets.js';
import { ampacity } from './calc.js';

export const NOT_CHECKED = [
  'Heat: parts and regulators running hot over time (only a simple linear-regulator estimate is made)',
  'EMI, noise, ground bounce and long-wire signal integrity',
  'Mechanical load, vibration and strain on wires and connectors',
  'Firmware behaviour (a pin set to OUTPUT HIGH into another output, wrong PWM frequency)',
  'Inrush current, motor back-EMF spikes beyond the flyback rule, ESD',
  'Whether your exact board matches the library (sellers change pinouts: check parts marked "Confirm on your board")',
];

const SIGNAL_KINDS = new Set(['digital', 'pwm', 'analog', 'i2c_sda', 'i2c_scl', 'uart_tx', 'uart_rx', 'spi']);
const EPS = 1e-9;
const LITHIUM = new Set(['lipo', 'li-ion', 'liion', 'lifepo4', 'li-po', 'lithium']);

/** Copper resistance in ohm per metre for an AWG size at 20°C. */
export function awgOhmPerMetre(awg) {
  const dMm = 0.127 * Math.pow(92, (36 - awg) / 39);
  const areaM2 = Math.PI * Math.pow(dMm / 2000, 2);
  return 1.68e-8 / areaM2;
}

function round(x, n = 2) {
  return typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(n)) : x;
}

function ampsFor(gauge, insulation) {
  try {
    const a = ampacity(gauge, insulation || 'pvc');
    if (typeof a === 'number') return a;
    if (a && typeof a.value === 'number') return a.value;
  } catch { /* unknown gauge */ }
  return null;
}

/**
 * Run every rule on a project.
 * @param {any} project
 * @param {Record<string, any>} library
 */
export function checkProject(project, library) {
  const issues = [];
  const add = (issue) => {
    const parts = [...new Set(issue.parts || [])];
    const wires = [...new Set(issue.wires || [])];
    const pins = [...new Set(issue.pins || [])];
    const nets = [...new Set(issue.nets || [])];
    const id = `${issue.rule}:${[...parts, ...wires, ...pins].join(',')}`;
    if (issues.some((i) => i.id === id && i.message === issue.message)) return;
    issues.push({ id, rule: issue.rule, level: issue.level, message: issue.message, fix: issue.fix, parts, wires, pins, nets });
  };

  const model = resolveProject(project || {}, library || {});
  for (const p of model.problems) add({ ...p, parts: p.parts || [], wires: p.wires || [], pins: p.pins || [] });

  const N = buildNets(model);
  const { nets, netOfPin, adj, pinOf } = N;
  const partOf = (key) => model.parts.get(key.slice(0, key.indexOf('.')));
  const netPins = (net) => net.pins.map(pinOf).filter(Boolean);

  // ---------------------------------------------------------------- mains
  for (const part of model.partList) {
    const hv = part.pins.find((p) => p.kind === 'power_out' && typeof p.voltage === 'number' && Math.max(p.voltage, p.voltage_max || 0) > 60);
    if (part.mains || hv) {
      add({
        rule: 'mains', level: 'error', parts: [part.id],
        message: `${part.id} is a mains or high-voltage part (${hv ? fmtV(Math.max(hv.voltage, hv.voltage_max || 0)) : 'mains'}). Wiremap does not cover mains or anything above 60 V DC: stop here and use a certified, enclosed power supply instead.`,
        fix: 'Replace it with a certified low-voltage DC adapter. Mains wiring needs a qualified person.',
      });
    }
  }

  // ---------------------------------------------- effective voltages (refs)
  const netVoltage = (key) => {
    const net = netOfPin.get(key);
    return net && typeof net.voltage === 'number' ? net.voltage : null;
  };
  /** Effective electrical values per pin key. */
  const eff = new Map();
  for (const part of model.partList) {
    for (const pin of part.pins) {
      const e = { voltage: pin.voltage, vmax: pin.vmax, pullup: pin.pullup };
      const refV = (name) => {
        const ref = part.pinMap.get(name);
        if (!ref) return null;
        if (ref.kind === 'power_out' && typeof ref.voltage === 'number') return ref.voltage;
        return netVoltage(ref.key);
      };
      if (pin.voltage_ref) {
        const v = refV(pin.voltage_ref);
        if (v !== null) e.voltage = v; else if (e.voltage === undefined) e.voltage = undefined;
      }
      if (pin.vmax_ref) {
        const v = refV(pin.vmax_ref);
        if (v !== null) e.vmax = v + (pin.vmax_offset || 0);
      }
      if (pin.pullup_ref) {
        const v = refV(pin.pullup_ref);
        if (v !== null) e.pullup = v;
      }
      eff.set(pin.key, e);
    }
  }

  // ------------------------------------------------ regulators and liveness
  /** regulator by output pin key */
  const regByOut = new Map();
  /** regulators by input pin key */
  const regsByIn = new Map();
  for (const part of model.partList) {
    for (const reg of part.regulators || []) {
      const r = { ...reg, part: part.id, inKey: `${part.id}.${reg.in}`, outKey: `${part.id}.${reg.out}` };
      regByOut.set(r.outKey, r);
      if (!regsByIn.has(r.inKey)) regsByIn.set(r.inKey, []);
      regsByIn.get(r.inKey).push(r);
    }
  }
  // A source is live if it is a primary source, or a regulator whose input is live.
  const live = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const net of nets) {
      for (const s of net.sources) {
        if (live.has(s)) continue;
        const reg = regByOut.get(s);
        const ok = !reg || (netOfPin.get(reg.inKey)?.sources || []).some((x) => live.has(x) && x !== s);
        if (ok) { live.add(s); changed = true; }
      }
    }
  }

  // --------------------------------------------------- shorts and fighting
  for (const net of nets) {
    if (net.sources.length && net.grounds.length) {
      add({
        rule: 'short', level: 'error', nets: [net.id], wires: net.wires,
        pins: [...net.sources, ...net.grounds], parts: [...net.sources, ...net.grounds].map((k) => k.split('.')[0]),
        message: `Short circuit: ${net.sources.join(', ')} is connected straight to ground (${net.grounds.slice(0, 3).join(', ')}).`,
        fix: 'Remove the wire that joins the supply output to GND. Supply + must only reach power inputs.',
      });
    }
    if (net.sources.length > 1) {
      // Pins of one part joined inside it (e.g. Uno 5V and IOREF) are one source.
      const nonDiode = [];
      for (const k of net.sources) {
        if (pinOf(k).diode) continue;
        const joinedInside = (x) => {
          const part = partOf(x);
          if (!part || part.id !== k.split('.')[0] || pinOf(x).voltage !== pinOf(k).voltage) return false;
          const [a, b] = [x.split('.').slice(1).join('.'), k.split('.').slice(1).join('.')];
          return (part.internal || []).some((g) => g.includes(a) && g.includes(b));
        };
        if (!nonDiode.some(joinedInside)) nonDiode.push(k);
      }
      if (nonDiode.length > 1) {
        add({
          rule: 'supplies-fighting', level: 'error', nets: [net.id], wires: net.wires, pins: nonDiode,
          parts: nonDiode.map((k) => k.split('.')[0]),
          message: `Two supplies drive the same rail: ${nonDiode.map((k) => `${k} (${fmtV(pinOf(k).voltage)})`).join(' and ')}. They will fight and push current into each other.`,
          fix: 'Feed each rail from one supply only. Join only the grounds, or use a diode/ideal-diode OR circuit.',
        });
      }
    }
    if (!net.sources.length && net.grounds.length && net.loads.length) {
      add({
        rule: 'power-to-ground', level: 'warning', nets: [net.id], wires: net.wires, pins: net.loads,
        parts: net.loads.map((k) => k.split('.')[0]),
        message: `Power input ${net.loads.join(', ')} is wired to ground. The part can never be powered this way, and it shorts whatever supply feeds it later.`,
        fix: 'Connect the power input to a supply output, and only GND pins to ground.',
      });
    }
  }

  // ------------------------------------------- over / under voltage (power)
  for (const net of nets) {
    if (!net.sources.length) continue;
    const srcs = net.sources.map(pinOf);
    const vMax = Math.max(...srcs.map((s) => Math.max(s.voltage, s.voltage_max ?? s.voltage)));
    const vNom = Math.min(...srcs.map((s) => s.voltage));
    const vLow = Math.min(...srcs.map((s) => s.voltage_min ?? s.voltage));
    for (const pin of netPins(net)) {
      if (!['power_in', 'power_rail'].includes(pin.kind)) continue;
      const vmax = eff.get(pin.key)?.vmax;
      if (typeof vmax === 'number' && vMax > vmax + EPS) {
        const full = vMax > vNom + EPS ? ` (${fmtV(vMax)} when full)` : '';
        add({
          rule: 'over-voltage', level: 'error', nets: [net.id], wires: net.wires, pins: [pin.key, ...net.sources],
          parts: [pin.part, ...net.sources.map((k) => k.split('.')[0])],
          message: `Over-voltage: ${pin.key} accepts at most ${fmtV(vmax)} but its rail is ${fmtV(vNom)}${full} from ${net.sources[0]}.`,
          fix: `Add a regulator (buck converter set to a voltage inside ${pin.vmin ?? '?'}–${vmax} V) between the supply and ${pin.key}, or use a lower-voltage supply.`,
        });
      }
      if (typeof pin.vmin === 'number') {
        if (vNom < pin.vmin - EPS) {
          add({
            rule: 'under-voltage', level: 'warning', nets: [net.id], pins: [pin.key], parts: [pin.part],
            message: `Under-voltage: ${pin.key} needs at least ${fmtV(pin.vmin)} but gets ${fmtV(vNom)}. Expect brownouts and resets.`,
            fix: `Use a supply of at least ${fmtV(pin.vmin)} for ${pin.key}.`,
          });
        } else if (vLow < pin.vmin - EPS) {
          add({
            rule: 'under-voltage', level: 'warning', nets: [net.id], pins: [pin.key], parts: [pin.part],
            message: `${srcs.some((x) => partOf(x.key)?.battery) ? 'Low battery' : 'Supply sag'}: ${pin.key} needs at least ${fmtV(pin.vmin)}, but the supply can drop to ${fmtV(vLow)}${srcs.some((x) => partOf(x.key)?.battery) ? ' when nearly empty' : ''}.`,
            fix: 'Stop and recharge before the battery reaches that voltage, or add a regulator with enough headroom.',
          });
        }
      }
    }
  }

  // ------------------------------------------------------------ regulators
  for (const regs of regsByIn.values()) {
    for (const reg of regs) {
      const inNet = netOfPin.get(reg.inKey);
      if (!inNet || !inNet.sources.length) continue;
      const srcs = inNet.sources.map(pinOf);
      const vIn = Math.min(...srcs.map((s) => s.voltage));
      const vInLow = Math.min(...srcs.map((s) => s.voltage_min ?? s.voltage));
      const vInHigh = Math.max(...srcs.map((s) => s.voltage_max ?? s.voltage));
      if (typeof reg.vout === 'number' && typeof reg.dropout === 'number' && vInLow < reg.vout + reg.dropout - EPS) {
        add({
          rule: 'regulator-dropout', level: 'warning', parts: [reg.part], pins: [reg.inKey],
          message: `${reg.part}'s ${reg.out} regulator needs about ${fmtV(reg.vout + reg.dropout)} in to hold ${fmtV(reg.vout)}, but its input ${vInLow < vIn ? 'drops to' : 'is'} ${fmtV(vInLow)}.`,
          fix: 'Raise the input voltage or use a low-dropout regulator.',
        });
      }
      if (typeof reg.vin_max === 'number' && vInHigh > reg.vin_max + EPS) {
        add({
          rule: 'over-voltage', level: 'error', parts: [reg.part], pins: [reg.inKey],
          message: `${reg.part}'s regulator input is rated ${fmtV(reg.vin_max)} max, but gets ${fmtV(vInHigh)}.`,
          fix: 'Use a lower input voltage or a regulator rated for it.',
        });
      }
      if (typeof reg.vout === 'number' && reg.type === 'buck' && vIn <= reg.vout + EPS) {
        add({
          rule: 'regulator-dropout', level: 'warning', parts: [reg.part], pins: [reg.inKey],
          message: `${reg.part} is a step-down (buck) converter set to ${fmtV(reg.vout)}, but its input is only ${fmtV(vIn)}. It cannot step up.`,
          fix: 'Use a higher input voltage, a lower output setting, or a boost converter.',
        });
      }
    }
  }

  // ---------------------------------------------------- power budget (KCL)
  // Motor current flows from the driver's motor supply pin through its outputs.
  /** extra load per driver power_in pin key: {typ, peak} */
  const motorLoad = new Map();
  for (const drv of model.partList) {
    const outs = drv.pins.filter((p) => p.kind === 'motor' && p.dir === 'out');
    if (!outs.length) continue;
    const ins = drv.pins.filter((p) => p.kind === 'power_in');
    const byRef = outs.map((o) => o.voltage_ref).find((r) => r && drv.pinMap.get(r)?.kind === 'power_in');
    const supply = byRef ? drv.pinMap.get(byRef) : ins.sort((a, b) => (b.vmax ?? 0) - (a.vmax ?? 0))[0];
    const motors = new Map(); // actuator part id -> {typ, peak, channels:[driver pins]}
    for (const o of outs) {
      const net = netOfPin.get(o.key);
      for (const q of net ? netPins(net) : []) {
        if (q.kind !== 'motor' || q.part === drv.id) continue;
        const act = model.parts.get(q.part);
        if (act.category !== 'actuator') continue;
        const m = motors.get(act.id) || { typ: 0, peak: 0, channels: [], pins: [] };
        for (const mp of act.pins.filter((x) => x.kind === 'motor')) {
          m.typ = Math.max(m.typ, mp.current || 0);
          m.peak = Math.max(m.peak, mp.current_peak ?? mp.current ?? 0);
        }
        m.channels.push(o); m.pins.push(q.key);
        motors.set(act.id, m);
      }
    }
    let typ = 0; let peak = 0;
    for (const [actId, m] of motors) {
      // A motor only draws current when both terminals are connected, to different nets.
      const terms = model.parts.get(actId).pins.filter((x) => x.kind === 'motor');
      const termNets = new Set(terms.map((x) => netOfPin.get(x.key)));
      if (terms.length < 2 || termNets.size < 2 || terms.some((x) => !netOfPin.get(x.key)?.connected)) continue;
      typ += m.typ; peak += m.peak;
      const chMax = Math.min(...m.channels.map((c) => c.current_max ?? Infinity));
      const chPeak = Math.min(...m.channels.map((c) => c.current_peak ?? c.current_max ?? Infinity));
      if (m.typ > chMax + EPS) {
        add({ rule: 'driver-overload', level: 'error', parts: [drv.id, actId], pins: m.pins,
          message: `${actId} draws ${round(m.typ)} A but each ${drv.id} channel is rated ${chMax} A continuous. The driver will overheat or shut down.`,
          fix: 'Use a driver rated for the motor current, or a smaller motor.' });
      } else if (m.peak > chPeak + EPS) {
        add({ rule: 'driver-overload', level: 'warning', parts: [drv.id, actId], pins: m.pins,
          message: `${actId} can stall at ${round(m.peak)} A, above the ${chPeak} A peak rating of ${drv.id}'s channel. A stall can trip or damage the driver.`,
          fix: 'Avoid stalls (limit switches, current limiting), or use a bigger driver.' });
      }
      // Motor voltage = the driver's motor supply voltage
      const vm = supply ? netOfPin.get(supply.key) : null;
      const act = model.parts.get(actId);
      const vmaxM = Math.min(...act.pins.filter((x) => x.kind === 'motor' && typeof x.vmax === 'number').map((x) => x.vmax));
      const vSup = vm && vm.sources.length ? Math.max(...vm.sources.map((k) => pinOf(k).voltage_max ?? pinOf(k).voltage)) : null;
      if (vSup !== null && Number.isFinite(vmaxM) && vSup > vmaxM + EPS) {
        add({ rule: 'over-voltage', level: 'warning', parts: [actId, drv.id], pins: m.pins,
          message: `${actId} is rated ${fmtV(vmaxM)} but ${drv.id} drives it from a ${fmtV(vSup)} supply. It will run hot and wear out fast at full PWM.`,
          fix: `Limit the PWM duty cycle in firmware to about ${Math.round((vmaxM / vSup) * 100)}%, or power the motors from a lower voltage.` });
      }
    }
    if (supply && (typ || peak)) motorLoad.set(supply.key, { typ, peak });
  }

  /** load(pinKey) for power_in pins = own draw + what its regulators pass on */
  const pinLoadCache = new Map();
  const netLoadCache = new Map();
  const visiting = new Set();
  function netLoad(net) {
    if (netLoadCache.has(net.id)) return netLoadCache.get(net.id);
    if (visiting.has(net.id)) return { typ: 0, peak: 0, loads: [] };
    visiting.add(net.id);
    let typ = 0; let peak = 0; const loads = [];
    for (const key of net.loads) {
      const l = pinLoad(key);
      typ += l.typ; peak += l.peak;
      loads.push({ key, part: key.split('.')[0], current: round(l.typ, 3), peak: round(l.peak, 3) });
    }
    visiting.delete(net.id);
    const res = { typ, peak, loads };
    netLoadCache.set(net.id, res);
    return res;
  }
  function pinLoad(key) {
    if (pinLoadCache.has(key)) return pinLoadCache.get(key);
    const pin = pinOf(key);
    let typ = pin.current || 0;
    let peak = pin.current_peak ?? pin.current ?? 0;
    const ml = motorLoad.get(key);
    if (ml) { typ += ml.typ; peak += ml.peak; }
    for (const reg of regsByIn.get(key) || []) {
      const outNet = netOfPin.get(reg.outKey);
      if (!outNet) continue;
      // Only count the output if this regulator is the rail's source.
      const out = netLoad(outNet);
      const inNet = netOfPin.get(key);
      const vIn = inNet && typeof inNet.voltage === 'number' ? inNet.voltage : null;
      const vInLow = inNet && inNet.sources.length ? Math.min(...inNet.sources.map((s) => pinOf(s).voltage_min ?? pinOf(s).voltage)) : vIn;
      if (reg.type === 'buck' && vIn && typeof reg.vout === 'number') {
        const eta = reg.efficiency || 0.85;
        typ += (reg.vout * out.typ) / (eta * vIn);
        peak += (reg.vout * out.peak) / (eta * (vInLow || vIn));
      } else if (reg.type === 'boost' && vIn && typeof reg.vout === 'number') {
        const eta = reg.efficiency || 0.85;
        typ += (reg.vout * out.typ) / (eta * vIn);
        peak += (reg.vout * out.peak) / (eta * (vInLow || vIn));
      } else {
        typ += out.typ + (reg.iq || 0);
        peak += out.peak + (reg.iq || 0);
      }
    }
    const res = { typ, peak };
    pinLoadCache.set(key, res);
    return res;
  }

  const rails = [];
  for (const net of nets) {
    if (!net.sources.length) continue;
    const src = net.sources[0];
    const srcPin = pinOf(src);
    const reg = regByOut.get(src);
    let capacity = typeof srcPin.current_max === 'number' ? srcPin.current_max : null;
    if (reg && typeof reg.current_max === 'number') capacity = capacity === null ? reg.current_max : Math.min(capacity, reg.current_max);
    const { typ, peak, loads } = netLoad(net);
    const pct = capacity ? typ / capacity : null;
    const pctPeak = capacity ? peak / capacity : null;
    let status = 'ok';
    if (capacity && net.sources.length === 1) {
      if (typ > capacity + EPS) {
        status = 'error';
        add({
          rule: 'overload', level: 'error', nets: [net.id], pins: [src, ...loads.map((l) => l.key)], parts: [src.split('.')[0], ...loads.map((l) => l.part)],
          message: `Overloaded supply: ${src} can give ${round(capacity)} A, but the loads on this ${fmtV(net.voltage)} rail draw ${round(typ)} A typical.`,
          fix: `Use a supply rated for at least ${round(typ * 1.25, 1)} A (25% headroom), or move loads to another supply.`,
        });
      } else if (peak > capacity + EPS) {
        status = 'warn';
        add({
          rule: 'overload', level: 'warning', nets: [net.id], pins: [src, ...loads.map((l) => l.key)], parts: [src.split('.')[0], ...loads.map((l) => l.part)],
          message: `Peak overload: ${src} can give ${round(capacity)} A, but at peak (e.g. motors stalling) the loads draw ${round(peak)} A. The voltage will sag and boards may reset.`,
          fix: `Use a supply rated for ${round(peak, 1)} A peak, or make sure the loads never peak together (move motors one at a time).`,
        });
      } else if (typ > 0.8 * capacity + EPS) {
        status = 'warn';
        add({
          rule: 'overload', level: 'warning', nets: [net.id], pins: [src], parts: [src.split('.')[0]],
          message: `Supply near its limit: ${src} runs at ${Math.round((typ / capacity) * 100)}% of its ${round(capacity)} A rating (keep it under 80%).`,
          fix: 'Use a bigger supply to keep 20% headroom.',
        });
      }
    }
    rails.push({
      net: net.id, name: net.name, source: src, sourcePart: src.split('.')[0], voltage: net.voltage,
      capacity, load: round(typ, 3), loadPeak: round(peak, 3), pct: pct === null ? null : round(pct, 3),
      pctPeak: pctPeak === null ? null : round(pctPeak, 3), status, loads,
      parent: reg ? (netOfPin.get(reg.inKey)?.id ?? null) : null, regulator: reg ? reg.part : null,
      live: live.has(src),
    });
  }

  // Linear regulator heat
  for (const r of rails) {
    const reg = r.regulator ? regByOut.get(r.source) : null;
    if (!reg || reg.type !== 'linear') continue;
    const inNet = netOfPin.get(reg.inKey);
    if (!inNet || typeof inNet.voltage !== 'number') continue;
    // Current through the regulator: the rail's loads plus the part's own draw on its input pin.
    const iOut = r.load;
    const own = pinOf(reg.inKey).current || 0;
    const p = (inNet.voltage - reg.vout) * (iOut + own);
    if (p > 1.0) {
      add({
        rule: 'regulator-heat', level: 'warning', parts: [reg.part],
        message: `${reg.part}'s linear regulator burns about ${round(p, 1)} W ((${fmtV(inNet.voltage)} − ${fmtV(reg.vout)}) × ${round(iOut + own)} A). Small regulators overheat above ~1 W.`,
        fix: 'Feed it a lower voltage (e.g. a 5 V buck first) or use a buck converter for this rail.',
      });
    }
  }

  // Unpowered parts
  for (const part of model.partList) {
    const ins = part.pins.filter((p) => p.kind === 'power_in');
    if (!ins.length) continue;
    const used = part.pins.some((p) => netOfPin.get(p.key)?.wires.length);
    if (!used) continue;
    const powered = ins.some((p) => (netOfPin.get(p.key)?.sources || []).some((s) => live.has(s) || part.category === 'controller'));
    if (powered) continue;
    if (part.category === 'controller') {
      add({
        rule: 'unpowered', level: 'info', parts: [part.id],
        message: `${part.id} has no supply wired to ${ins.map((p) => p.name).join('/')}: it runs only while USB is plugged in.`,
      });
    } else {
      const anySource = ins.some((p) => (netOfPin.get(p.key)?.sources || []).length);
      add({
        rule: 'unpowered', level: 'warning', parts: [part.id], pins: ins.map((p) => p.key),
        message: anySource
          ? `${part.id} is only fed from a regulator that has no input power yet (${ins.map((p) => p.name).join('/')}).`
          : `${part.id} has no power: nothing supplies ${ins.map((p) => p.name).join('/')}.`,
        fix: `Wire ${part.id}.${ins[0].name} to a supply of the right voltage.`,
      });
    }
  }

  // ------------------------------------------------------------- signals
  for (const net of nets) {
    const pins = netPins(net);
    const sig = pins.filter((p) => SIGNAL_KINDS.has(p.kind));
    if (!sig.length) continue;
    const parts = [...new Set(pins.map((p) => p.part))];
    const isPowerNet = net.sources.length > 0;
    const isGroundNet = net.grounds.length > 0;

    // Outputs straight into a supply or ground
    for (const p of sig) {
      if (p.dir === 'out' && !p.open_drain && (isPowerNet || isGroundNet)) {
        add({
          rule: 'output-shorted', level: 'error', nets: [net.id], wires: net.wires, pins: [p.key], parts: [p.part],
          message: `${p.key} is an output wired straight to ${isGroundNet ? 'ground' : 'a supply'}. When it drives the other way it shorts and can burn the pin.`,
          fix: 'Remove that wire; outputs go to inputs only.',
        });
      } else if (p.dir === 'io' && (isPowerNet || isGroundNet) && p.kind !== 'analog') {
        add({
          rule: 'output-shorted', level: 'warning', nets: [net.id], wires: net.wires, pins: [p.key], parts: [p.part],
          message: `${p.key} is tied directly to ${isGroundNet ? 'GND' : 'a supply'}. If the firmware ever sets it as an output it will short; put a 1 kΩ resistor in series.`,
          fix: 'Add a series resistor or use a pull-up/pull-down instead of a direct wire.',
        });
      }
    }
    // Signal pins used as a power source
    if (!isPowerNet && net.loads.length) {
      const drivers = sig.filter((p) => p.dir === 'out' || p.dir === 'io');
      if (drivers.length) {
        add({
          rule: 'signal-as-power', level: 'error', nets: [net.id], wires: net.wires, pins: [...drivers.map((d) => d.key), ...net.loads],
          parts: [...drivers.map((d) => d.part), ...net.loads.map((k) => k.split('.')[0])],
          message: `${drivers[0].key} (a signal pin) is wired to the power input ${net.loads[0]}. A signal pin can only give a few mA and will be damaged.`,
          fix: `Power ${net.loads[0]} from a supply rail, and use ${drivers[0].key} only for the control signal.`,
        });
      }
    }
    if (isPowerNet || isGroundNet) continue;

    // Bus mixups
    const kinds = new Set(sig.map((p) => p.kind));
    if (kinds.has('i2c_sda') && kinds.has('i2c_scl')) {
      add({
        rule: 'bus-mixup', level: 'error', nets: [net.id], wires: net.wires, pins: sig.map((p) => p.key), parts,
        message: `I2C SDA and SCL are joined on one wire (${sig.filter((p) => p.kind.startsWith('i2c')).map((p) => p.key).join(', ')}). Data and clock must stay separate.`,
        fix: 'SDA goes only to SDA, SCL only to SCL.',
      });
    }
    const tx = sig.filter((p) => p.kind === 'uart_tx');
    const rx = sig.filter((p) => p.kind === 'uart_rx');
    if (tx.length > 1) {
      add({
        rule: 'bus-mixup', level: 'warning', nets: [net.id], wires: net.wires, pins: tx.map((p) => p.key), parts,
        message: `UART TX is wired to TX (${tx.map((p) => p.key).join(' – ')}). TX must cross over to RX.`,
        fix: 'Wire TX → RX and RX → TX.',
      });
    } else if (rx.length > 1 && !tx.length) {
      add({
        rule: 'bus-mixup', level: 'warning', nets: [net.id], wires: net.wires, pins: rx.map((p) => p.key), parts,
        message: `UART RX is wired to RX (${rx.map((p) => p.key).join(' – ')}). Nothing will be received; TX must cross over to RX.`,
        fix: 'Wire TX → RX and RX → TX.',
      });
    }

    // Push-pull outputs fighting
    const pushPull = sig.filter((p) => p.dir === 'out' && !p.open_drain);
    if (pushPull.length > 1 && new Set(pushPull.map((p) => p.part)).size > 1) {
      add({
        rule: 'outputs-fight', level: 'error', nets: [net.id], wires: net.wires, pins: pushPull.map((p) => p.key), parts,
        message: `Two outputs drive the same wire (${pushPull.map((p) => p.key).join(', ')}). When one goes high and the other low they short.`,
        fix: 'Connect each output to an input, not to another output.',
      });
    }

    // Logic levels
    const isI2C = kinds.has('i2c_sda') || kinds.has('i2c_scl');
    if (isI2C) {
      const pulls = pins.map((p) => ({ p, v: eff.get(p.key)?.pullup })).filter((x) => typeof x.v === 'number');
      if (!pulls.some((x) => !x.p.pullup_weak)) {
        add({
          rule: 'i2c-pullup', level: 'warning', nets: [net.id], wires: net.wires, parts,
          message: `The I2C line ${net.name} has no real pull-up resistor on any board${pulls.length ? ' (only weak internal pull-ups, about 45 kΩ, too weak for I2C)' : ''}. I2C needs one, typically 4.7 kΩ to the logic voltage.`,
          fix: 'Add a 4.7 kΩ resistor from this line to 3.3 V (or the lowest logic voltage on the bus).',
        });
      }
      for (const { p: pu, v } of pulls) {
        for (const q of pins) {
          const vmax = eff.get(q.key)?.vmax;
          if (q.key === pu.key || typeof vmax !== 'number' || v <= vmax + EPS) continue;
          add({
            rule: 'logic-level', level: pu.pullup_weak ? 'warning' : 'error', nets: [net.id], wires: net.wires, pins: [pu.key, q.key], parts: [pu.part, q.part],
            message: `${pu.part} pulls the I2C line up to ${fmtV(v)}${pu.pullup_weak ? ' (weak internal pull-up)' : ''}, but ${q.key} accepts at most ${fmtV(vmax)}.`,
            fix: 'Use a bidirectional I2C level shifter (e.g. BSS138 board), or pull the bus up to the lower voltage only.',
          });
        }
      }
    } else {
      const drivers = sig.filter((p) => (p.dir === 'out' || p.dir === 'io') && !p.open_drain);
      for (const d of drivers) {
        const vd = eff.get(d.key)?.voltage;
        if (typeof vd !== 'number') continue;
        for (const r of sig) {
          if (r.key === d.key || r.part === d.part) continue;
          if (!(r.dir === 'in' || r.dir === 'io')) continue;
          const er = eff.get(r.key);
          if (typeof er?.vmax === 'number' && vd > er.vmax + EPS) {
            add({
              rule: 'logic-level', level: 'error', nets: [net.id], wires: net.wires, pins: [d.key, r.key], parts: [d.part, r.part],
              message: `Logic level mismatch: ${d.key} outputs ${fmtV(vd)} into ${r.key}, which accepts at most ${fmtV(er.vmax)}.`,
              fix: `Shift the level down: a voltage divider (1 kΩ from ${d.key}, 2.2 kΩ to GND gives ${fmtV(vd * 2.2 / 3.2)}) or a level-shifter board.`,
            });
          } else if (typeof r.vih === 'number' && vd < r.vih - EPS) {
            add({
              rule: 'logic-level', level: 'warning', nets: [net.id], wires: net.wires, pins: [d.key, r.key], parts: [d.part, r.part],
              message: `${d.key} drives only ${fmtV(vd)}, but ${r.key} needs ${fmtV(r.vih)} to read HIGH. It may not respond reliably.`,
              fix: 'Use a level shifter to raise the signal.',
            });
          }
        }
      }
    }
  }

  // Resistor networks between a driver and an input (voltage dividers,
  // series resistors). Nets split at resistors, so look across them.
  const ohmsOf = (part) => {
    const v = part.params?.ohms ?? part.ohms;
    return typeof v === 'number' && v > 0 ? v : null;
  };
  const isResistor = (part) => ohmsOf(part) !== null && part.pins.length === 2;
  const otherEnd = (pinKey) => {
    const part = partOf(pinKey);
    const other = part.pins.find((p) => p.key !== pinKey);
    return other ? netOfPin.get(other.key) : null;
  };
  for (const net of nets) {
    if (net.sources.length || net.grounds.length) continue;
    const pins = netPins(net);
    const receivers = pins.filter((p) => SIGNAL_KINDS.has(p.kind) && (p.dir === 'in' || p.dir === 'io') && typeof eff.get(p.key)?.vmax === 'number');
    if (!receivers.length) continue;
    const resPins = pins.filter((p) => isResistor(model.parts.get(p.part)));
    if (!resPins.length) continue;
    // Upper resistors lead to a net with a driver; lower ones lead to ground.
    let gUp = 0; let vUpNum = 0; let gDown = 0; const upParts = []; const downParts = [];
    for (const rp of resPins) {
      const part = model.parts.get(rp.part);
      const far = otherEnd(rp.key);
      if (!far) continue;
      const g = 1 / ohmsOf(part);
      if (far.grounds.length) { gDown += g; downParts.push(part.id); continue; }
      const farDrivers = netPins(far).filter((p) => SIGNAL_KINDS.has(p.kind) && (p.dir === 'out' || p.dir === 'io') && typeof eff.get(p.key)?.voltage === 'number');
      const vFar = far.sources.length ? far.voltage : farDrivers.length ? Math.max(...farDrivers.map((p) => eff.get(p.key).voltage)) : null;
      if (typeof vFar === 'number') { gUp += g; vUpNum += g * vFar; upParts.push(part.id); }
    }
    if (!gUp) continue;
    const vOut = vUpNum / (gUp + gDown);
    for (const r of receivers) {
      const vmax = eff.get(r.key).vmax;
      if (vOut > vmax + EPS) {
        add({
          rule: 'logic-level', level: 'error', nets: [net.id], pins: [r.key], parts: [r.part, ...upParts, ...downParts],
          message: gDown
            ? `Divider too weak: the resistors give ${fmtV(vOut)} at ${r.key}, which accepts at most ${fmtV(vmax)}.`
            : `A series resistor alone does not lower the voltage: ${r.key} still sees ${fmtV(vOut)} (max ${fmtV(vmax)}) and relies on its internal clamp diodes.`,
          fix: 'Use a divider to ground: Vout = Vin × R2 / (R1 + R2). From 5 V, 1 kΩ + 2.2 kΩ gives 3.44 V (`wiremap calc divider`).',
        });
      }
    }
  }

  // Motors: never from a GPIO; need a flyback path
  for (const part of model.partList) {
    if (part.category !== 'actuator') continue;
    const motorPins = part.pins.filter((p) => p.kind === 'motor');
    if (!motorPins.length) continue;
    let protectedByDriver = false;
    for (const mp of motorPins) {
      const net = netOfPin.get(mp.key);
      if (!net || !net.wires.length) continue;
      for (const other of netPins(net)) {
        if (other.part === part.id) continue;
        const op = model.parts.get(other.part);
        if (SIGNAL_KINDS.has(other.kind)) {
          add({
            rule: 'motor-on-gpio', level: 'error', nets: [net.id], wires: net.wires, pins: [mp.key, other.key], parts: [part.id, other.part],
            message: `Motor ${part.id} is wired straight to the signal pin ${other.key}. A signal pin gives about ${other.current_max ? Math.round(other.current_max * 1000) : 20} mA; a motor needs hundreds of mA and its spikes will kill the pin.`,
            fix: 'Drive the motor through a motor driver (TB6612FNG, L298N, L293D) or a transistor with a flyback diode.',
          });
        }
        if (op.flyback || /diode/i.test(op.libraryId || op.id)) protectedByDriver = true;
      }
    }
    const wired = motorPins.some((mp) => netOfPin.get(mp.key)?.wires.length);
    if (wired && !protectedByDriver) {
      add({
        rule: 'flyback', level: 'warning', parts: [part.id], pins: motorPins.map((p) => p.key),
        message: `Motor ${part.id} has no flyback path: its driver doesn't declare built-in diodes and there's no diode across it. Switching it off makes a voltage spike.`,
        fix: 'Use a driver with built-in flyback diodes, or put a Schottky diode (1N5819) across the motor, cathode to +.',
      });
    }
  }

  // Servos and motors must never be powered from a controller's pins or regulator.
  for (const part of model.partList) {
    if (part.category !== 'actuator') continue;
    for (const pin of part.pins.filter((p) => p.kind === 'power_in')) {
      const net = netOfPin.get(pin.key);
      const feeder = (net?.sources || []).map(partOf).find((p) => p?.category === 'controller');
      const viaVin = !feeder && net && netPins(net).find((q) => q.kind === 'power_in' && partOf(q.key)?.category === 'controller');
      const ctrl = feeder || (viaVin ? partOf(viaVin.key) : null);
      if (!ctrl) continue;
      add({
        rule: 'actuator-on-board-power', level: 'error', nets: [net.id], wires: net.wires, pins: [pin.key], parts: [part.id, ctrl.id],
        message: `${part.id} takes its power from ${ctrl.id}'s supply pins. Servos and motors pull current spikes that reset the board or burn its regulator and USB port.`,
        fix: `Power ${part.id} from its own supply (for example a 5 to 6 V adapter), and join only the grounds to ${ctrl.id}.`,
      });
    }
  }

  // ------------------------------------------------------- common ground
  const groundNetsOf = (partId) => {
    const part = model.parts.get(partId);
    return new Set(part.pins.filter((p) => p.kind === 'ground').map((p) => netOfPin.get(p.key)?.id));
  };
  const gndPairsDone = new Set();
  for (const net of nets) {
    if (net.isGround || !net.wires.length) continue;
    const pins = netPins(net);
    const isSignal = pins.some((p) => SIGNAL_KINDS.has(p.kind));
    const isPower = net.sources.length > 0;
    if (!isSignal && !isPower) continue;
    const parts = [...new Set(pins.map((p) => p.part))].filter((id) => model.parts.get(id).pins.some((p) => p.kind === 'ground'));
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i]; const b = parts[j];
        const ga = groundNetsOf(a); const gb = groundNetsOf(b);
        if ([...ga].some((g) => gb.has(g))) continue;
        const pairKey = [a, b].sort().join('|') + (isSignal ? '|signal' : '|power');
        if (gndPairsDone.has(pairKey)) continue;
        gndPairsDone.add(pairKey);
        add({
          rule: 'common-ground', level: isSignal ? 'error' : 'warning', nets: [net.id], parts: [a, b], wires: net.wires,
          message: isSignal
            ? `No common ground: ${a} and ${b} share the signal ${net.name} but their GNDs are not connected. The signal has no reference and parts can be damaged.`
            : `No return path: ${a} and ${b} share a power rail but their GNDs are not connected, so current can't flow back.`,
          fix: `Run a ground wire from ${a}.GND to ${b}.GND (join all grounds, even when the supplies are separate).`,
        });
      }
    }
  }

  // ------------------------------------------- current per wire (KCL cuts)
  // Injection at each pin: positive = current entering the net at that pin.
  const injection = new Map();
  const inj = (key, typ, peak) => {
    const cur = injection.get(key) || { typ: 0, peak: 0 };
    cur.typ += typ; cur.peak += peak;
    injection.set(key, cur);
  };
  for (const net of nets) {
    if (!net.sources.length || net.sources.length > 1) continue;
    const l = netLoad(net);
    inj(net.sources[0], l.typ, l.peak);
    for (const key of net.loads) { const pl = pinLoad(key); inj(key, -pl.typ, -pl.peak); }
  }
  // Ground returns: every part returns (drawn - delivered) through its ground pins.
  for (const part of model.partList) {
    const gpins = part.pins.filter((p) => p.kind === 'ground');
    if (!gpins.length) continue;
    let typ = 0; let peak = 0;
    for (const p of part.pins) {
      if (p.kind === 'power_in') {
        const net = netOfPin.get(p.key);
        if (net && net.sources.length === 1) { const pl = pinLoad(p.key); typ += pl.typ; peak += pl.peak; }
      } else if (p.kind === 'power_out') {
        const net = netOfPin.get(p.key);
        if (net && net.sources.length === 1 && net.sources[0] === p.key) { const l = netLoad(net); typ -= l.typ; peak -= l.peak; }
      }
    }
    if (Math.abs(typ) < EPS && Math.abs(peak) < EPS) continue;
    const wiredG = gpins.find((p) => (adj.get(p.key) || []).some((e) => e.kind === 'wire')) || gpins[0];
    inj(wiredG.key, typ, peak);
  }

  function cutCurrent(edge, net) {
    // BFS from edge.a without using this edge
    const seen = new Set([edge.a]);
    const stack = [edge.a];
    while (stack.length) {
      const k = stack.pop();
      for (const e of adj.get(k) || []) {
        if (e === edge) continue;
        const o = e.a === k ? e.b : e.a;
        if (!seen.has(o)) { seen.add(o); stack.push(o); }
      }
    }
    if (seen.has(edge.b)) {
      // Parallel paths: conservative estimate = all current entering the net.
      let typ = 0; let peak = 0;
      for (const k of net.pins) { const i = injection.get(k); if (i && i.typ > 0) typ += i.typ; if (i && i.peak > 0) peak += i.peak; }
      return { typ, peak, parallel: true };
    }
    let typ = 0; let peak = 0;
    for (const k of seen) { const i = injection.get(k); if (i) { typ += i.typ; peak += i.peak; } }
    return { typ: Math.abs(typ), peak: Math.abs(peak), parallel: false };
  }

  const wireInfo = {};
  const edgeOfWire = new Map();
  for (const list of adj.values()) for (const e of list) if (e.kind === 'wire') edgeOfWire.set(e.wire, e);
  for (const w of model.wires) {
    if (!w.valid) continue;
    const net = netOfPin.get(w.fromKey);
    const role = netRole(net, pinOf);
    const color = ROLE_COLORS[role];
    const info = { role, color: color.hex, colorName: color.name, net: net.id, voltage: net.voltage, current: null, currentPeak: null, gauge: w.gauge ?? null, parallel: false };
    if (role === 'power' || role === 'ground') {
      const c = cutCurrent(edgeOfWire.get(w.id), net);
      info.current = round(c.typ, 3); info.currentPeak = round(c.peak, 3); info.parallel = c.parallel;
    }
    wireInfo[w.id] = info;

    // Wire gauge
    const iPeak = info.currentPeak || 0; const iTyp = info.current || 0;
    if (iPeak > 0) {
      if (typeof w.gauge !== 'number') {
        if (iPeak >= 1) {
          add({
            rule: 'wire-gauge', level: 'warning', wires: [w.id], parts: [w.fromKey.split('.')[0], w.toKey.split('.')[0]],
            message: `Wire ${w.id} (${w.from} → ${w.to}) carries up to ${round(iPeak)} A but has no gauge set. Thin jumper wire (26–28 AWG) is not made for that.`,
            fix: `Set "gauge" on ${w.id} and use wire rated for at least ${round(iPeak, 1)} A (run \`wiremap calc wire\`).`,
          });
        }
      } else {
        const amps = ampsFor(w.gauge, w.insulation);
        if (amps !== null && iPeak > amps + EPS) {
          add({
            rule: 'wire-gauge', level: 'warning', wires: [w.id], parts: [w.fromKey.split('.')[0], w.toKey.split('.')[0]],
            message: `Wire too thin: ${w.id} is ${w.gauge} AWG (${w.insulation || 'pvc'}, about ${amps} A) but carries ${iTyp > amps ? round(iTyp) + ' A' : 'up to ' + round(iPeak) + ' A at peak'}.`,
            fix: 'Use a thicker wire (lower AWG number) for this run.',
          });
        }
        if (typeof w.length_mm === 'number' && typeof net.voltage === 'number' && net.voltage > 0 && iPeak > 0) {
          const drop = iPeak * awgOhmPerMetre(w.gauge) * (w.length_mm / 1000);
          if (drop > 0.05 * net.voltage) {
            add({
              rule: 'wire-drop', level: 'warning', wires: [w.id],
              message: `Voltage drop: ${w.id} (${w.length_mm} mm of ${w.gauge} AWG) loses about ${round(drop)} V at ${round(iPeak)} A — more than 5% of ${fmtV(net.voltage)}.`,
              fix: 'Shorten the wire or use a thicker gauge.',
            });
          }
        }
      }
    }

    // Wire color vs role
    if (typeof w.color === 'string') {
      const c = w.color.toLowerCase();
      if (COLOR_HEX[c]) {
        const bad = (role === 'ground' && c === 'red') || (role === 'power' && ['black', 'gray', 'grey'].includes(c)) ||
          (role !== 'ground' && role !== 'power' && ['red', 'black'].includes(c));
        if (bad) {
          add({
            rule: 'wire-color', level: 'warning', wires: [w.id],
            message: `Wire ${w.id} is ${c} but carries ${role === 'ground' ? 'ground' : role === 'power' ? 'power' : 'a signal'}. Red and black are for power and ground only, or you will swap them later.`,
            fix: `Use a ${color.name} wire for ${w.id}.`,
          });
        }
      }
    }
  }

  // Fuses and switches: rating vs current through them
  for (const part of model.partList) {
    if (!['fuse', 'switch'].includes(part.protection)) continue;
    const rating = typeof part.rating_a === 'number' ? part.rating_a : (typeof part.params?.rating_a === 'number' ? part.params.rating_a : null);
    const e = (adj.get(`${part.id}.${part.internal[0]?.[0]}`) || []).find((x) => x.kind === 'internal' && x.part === part.id);
    if (!e || rating === null) continue;
    const net = netOfPin.get(e.a);
    const c = cutCurrent(e, net);
    if (c.typ > rating + EPS) {
      add({
        rule: 'fuse-rating', level: 'error', parts: [part.id],
        message: `${part.id} is rated ${rating} A but the loads behind it draw ${round(c.typ)} A typical: it will blow${part.protection === 'switch' ? ' / overheat' : ''}.`,
        fix: 'Use a higher-rated part, but never above what the wires can carry.',
      });
    } else if (part.protection === 'fuse' && c.peak > rating * 1.0 + EPS) {
      add({
        rule: 'fuse-rating', level: 'warning', parts: [part.id],
        message: `${part.id} (${rating} A) is below the peak current of ${round(c.peak)} A. Short peaks are usually fine for a slow-blow fuse, but a stall will blow it.`,
        fix: 'Use a slow-blow fuse or size it at ~125% of the continuous current.',
      });
    }
    if (part.protection === 'fuse') {
      for (const wid of net.wires) {
        const w = model.wires.find((x) => x.id === wid);
        const amps = typeof w?.gauge === 'number' ? ampsFor(w.gauge, w.insulation) : null;
        if (amps !== null && rating > amps + EPS) {
          add({
            rule: 'fuse-rating', level: 'warning', parts: [part.id], wires: [wid],
            message: `${part.id} (${rating} A) is bigger than wire ${wid} can carry (${w.gauge} AWG ≈ ${amps} A): the wire would burn before the fuse blows.`,
            fix: 'Use a smaller fuse or a thicker wire.',
          });
        }
      }
    }
  }

  // ------------------------------------------------- protection (batteries)
  const runtime = [];
  for (const part of model.partList) {
    if (!part.battery) continue;
    const plus = part.pins.find((p) => p.kind === 'power_out');
    if (!plus) continue;
    const net = netOfPin.get(plus.key);
    if (!net || !net.wires.length) continue;
    const chem = String(part.battery.chemistry || '').toLowerCase();
    const lithium = LITHIUM.has(chem);
    const reach = (...blockedKinds) => {
      const seen = new Set([plus.key]);
      const stack = [plus.key];
      const hits = [];
      while (stack.length) {
        const k = stack.pop();
        for (const e of adj.get(k) || []) {
          if (e.kind === 'internal' && blockedKinds.includes(e.series)) continue;
          const o = e.a === k ? e.b : e.a;
          if (seen.has(o)) continue;
          seen.add(o); stack.push(o);
          const p = pinOf(o);
          if (p && p.kind === 'power_in' && !model.parts.get(p.part).protection) hits.push(o);
        }
      }
      return hits;
    };
    const unfused = reach('fuse');
    if (unfused.length) {
      add({
        rule: 'missing-fuse', level: lithium ? 'error' : 'warning', parts: [part.id, ...unfused.map((k) => k.split('.')[0])], pins: [plus.key, ...unfused],
        message: `${part.id} (${lithium ? 'lithium, ' : ''}${part.battery.chemistry || 'battery'}) reaches ${unfused[0]} without a fuse. ${lithium ? 'A short on a lithium pack can start a fire.' : 'A short can melt wires.'}`,
        fix: 'Put an inline fuse right at the battery + lead, sized ~125% of the normal current (`wiremap calc fuse`).',
      });
    }
    const unswitched = reach('switch');
    if (unswitched.length) {
      add({
        rule: 'missing-switch', level: 'warning', parts: [part.id], pins: [plus.key],
        message: `${part.id} has no power switch: the only way to turn the build off is unplugging the battery.`,
        fix: 'Add a power switch rated for the full current after the fuse.',
      });
    }
    if (lithium && !part.battery.bms) {
      const unprotected = reach('bms', 'low-voltage-cutoff');
      if (unprotected.length) {
        add({
          rule: 'missing-bms', level: 'error',
          parts: [part.id, ...unprotected.map((key) => pinOf(key).part)],
          pins: [plus.key, ...unprotected],
          message: `${part.id} supplies ${unprotected[0]} without a BMS or low-voltage cutoff in the load path.`,
          fix: 'Use a pack with verified built-in protection, or route every load through a verified BMS or low-voltage cutoff rated for the pack and load. Follow the pack maker’s charging instructions.',
        });
      }
    }
    const l = netLoad(net);
    const cap = part.battery.capacity_ah;
    if (typeof cap === 'number' && l.typ > 0) {
      runtime.push({ battery: part.id, avg: round(l.typ, 3), hours: round((cap * 0.8) / l.typ, 2), formula: 'usable Ah (80% of rated) ÷ average A' });
    }
  }

  // ------------------------------------------------------- required pins
  for (const part of model.partList) {
    const used = part.pins.some((p) => netOfPin.get(p.key)?.wires.length);
    if (!used) {
      if (part.category && part.category !== 'passive') {
        add({ rule: 'unused-part', level: 'info', parts: [part.id], message: `${part.id} is in the parts list but nothing is wired to it yet.` });
      }
      continue;
    }
    for (const pin of part.pins) {
      if (pin.required && !netOfPin.get(pin.key)?.wires.length) {
        add({
          rule: 'required-pin', level: 'warning', parts: [part.id], pins: [pin.key],
          message: `${pin.key}${pin.label !== pin.name ? ` (${pin.label})` : ''} must be connected but is left floating.${pin.note ? ' ' + pin.note : ''}`,
          fix: pin.fix || `Wire ${pin.key} as the part's notes describe (often to the logic supply).`,
        });
      }
    }
    const gnds = part.pins.filter((p) => p.kind === 'ground');
    if (gnds.length && !gnds.some((g) => netOfPin.get(g.key)?.wires.length)) {
      add({
        rule: 'required-pin', level: 'warning', parts: [part.id], pins: gnds.map((g) => g.key),
        message: `${part.id} is wired up but none of its GND pins is connected.`,
        fix: `Connect ${gnds[0].key} to the common ground.`,
      });
    }
  }

  // --------------------------------------------------------- confidence
  const confidence = {};
  for (const part of model.partList) {
    const c = part.verify || part.inferred ? 'confirm' : (part.confidence || (part.libraryId ? 'checked' : 'confirm'));
    confidence[part.id] = c;
    if (c === 'confirm') {
      add({
        rule: 'confirm-on-board', level: 'info', parts: [part.id],
        message: `${part.id}${part.inferred ? ' was inferred from your code' : ''}: confirm its pinout and voltages on your actual board before wiring${part.notes && part.notes[0] ? ` (${part.notes[0]})` : ''}.`,
      });
    }
  }

  // ------------------------------------------------------------- results
  const netInfo = {};
  for (const net of nets) netInfo[net.id] = { id: net.id, name: net.name, role: netRole(net, pinOf), voltage: net.voltage };
  const pinInfo = {};
  for (const net of nets) {
    const role = netInfo[net.id].role;
    for (const k of net.pins) pinInfo[k] = { net: net.id, role, connected: net.wires.length > 0 };
  }

  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  const infos = issues.filter((i) => i.level === 'info').length;
  const summary = errors
    ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}: fix the errors before building.`
    : `No rule violations found (${warnings} warning${warnings === 1 ? '' : 's'}). This is not a guarantee: see what isn't checked.`;

  return {
    ok: errors === 0, errors, warnings, infos, summary, issues, model, nets: N,
    wireInfo, netInfo, pinInfo, power: { rails, runtime }, confidence, notChecked: NOT_CHECKED,
  };
}
