// Fallback used only when /lib/check.js cannot be loaded or throws: builds the
// same result shape from the shared model and net code so the views still
// render. It performs only structural checks and says so in notChecked.
import { resolveProject } from '/lib/model.js';
import { buildNets, netRole, ROLE_COLORS } from '/lib/nets.js';

export function checkLite(project, library, reason = '') {
  const model = resolveProject(project, library);
  const nets = buildNets(model);
  const issues = model.problems.map((p, i) => ({
    id: `lite${i + 1}`, rule: p.rule, level: p.level, message: p.message, fix: undefined,
    parts: p.parts || [], wires: p.wires || [], pins: p.pins || [], nets: [],
  }));
  const netInfo = {};
  for (const net of nets.nets) netInfo[net.id] = { id: net.id, name: net.name, role: netRole(net, nets.pinOf), voltage: net.voltage };
  const pinInfo = {};
  for (const part of model.partList) {
    for (const pin of part.pins) {
      const net = nets.netOfPin.get(pin.key);
      pinInfo[pin.key] = { net: net ? net.id : null, role: net ? netInfo[net.id].role : null, connected: Boolean(net && net.wires.length) };
      if (pin.required && !(net && net.wires.length)) {
        issues.push({ id: `lite-req-${pin.key}`, rule: 'required-pin', level: 'warning', message: `${pin.key} (${pin.label}) must be connected`, parts: [part.id], wires: [], pins: [pin.key], nets: [] });
      }
    }
  }
  const loadCurrent = (net) => {
    let typ = 0; let peak = 0;
    for (const k of net.loads) { const p = nets.pinOf(k); typ += p.current || 0; peak += p.current_peak || p.current || 0; }
    return { typ, peak };
  };
  const wireInfo = {};
  for (const w of model.wires) {
    if (!w.valid) continue;
    const net = nets.netOfPin.get(w.fromKey);
    const role = netInfo[net.id].role;
    const c = role === 'power' || role === 'ground' ? loadCurrent(net) : { typ: 0, peak: 0 };
    wireInfo[w.id] = {
      role, color: ROLE_COLORS[role].hex, colorName: ROLE_COLORS[role].name, net: net.id,
      voltage: net.voltage, current: c.typ || null, currentPeak: c.peak || null, gauge: w.gauge || null,
    };
  }
  const rails = [];
  for (const net of nets.nets) {
    if (!net.sources.length || net.isGround) continue;
    const src = nets.pinOf(net.sources[0]);
    const c = loadCurrent(net);
    const loads = net.loads.map((k) => { const p = nets.pinOf(k); return { key: k, part: p.part, current: p.current || 0, peak: p.current_peak || p.current || 0 }; });
    const cap = typeof src.current_max === 'number' ? src.current_max : null;
    const pct = cap ? c.typ / cap : null;
    const pctPeak = cap ? c.peak / cap : null;
    let parent = null; let regulator = null;
    const part = model.parts.get(src.part);
    for (const reg of part.regulators || []) {
      if (reg.out === src.name) {
        regulator = part.id;
        const inNet = nets.netOfPin.get(`${part.id}.${reg.in}`);
        parent = inNet ? inNet.id : null;
      }
    }
    rails.push({
      net: net.id, name: net.name, source: src.key, sourcePart: src.part, voltage: net.voltage, capacity: cap,
      load: c.typ, loadPeak: c.peak, pct, pctPeak, status: pctPeak > 1 ? 'error' : pctPeak > 0.8 ? 'warn' : 'ok', loads, parent, regulator,
    });
  }
  const confidence = {};
  for (const part of model.partList) {
    confidence[part.id] = part.verify ? 'confirm' : (part.confidence || 'checked');
  }
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  return {
    ok: errors === 0, errors, warnings, infos: 0, lite: true,
    summary: `Structural check only${reason ? ` (${reason})` : ''}.`,
    issues, model, nets, wireInfo, netInfo, pinInfo, power: { rails }, confidence,
    notChecked: ['Full electrical rules (the checker module did not load)', 'Heat, EMI and mechanical load'],
  };
}
