// Mechanics view: joint torque against servo capacity, an elevation drawing of
// the arm at its hardest pose, printed fits as drawing callouts, bolts, beams,
// gears, stack-ups and drive sizing. Everything comes from lib/mech.js through
// the checker result (app.data.check.mechanics); nothing here calculates.
import { h, s, clear } from './util.js';
import { forwardKinematics } from '/lib/mech.js';

const fmt = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(d)).toString() : '–');

/** ok | warn | bad from a capacity margin and the wanted safety factor. */
export function marginState(margin, sf = 2) {
  if (margin === null || margin === undefined) return 'none';
  if (margin < 1) return 'bad';
  if (margin < sf) return 'warn';
  return 'ok';
}
const STATE_WORD = { ok: 'Enough margin', warn: 'Below the safety factor', bad: 'Not enough: it fails', none: 'No data' };

/**
 * A ruler-style gauge: the scale runs to the capacity, the fill is the load,
 * the tick is the safe limit (capacity ÷ safety factor).
 */
export function gauge({ load, capacity, sf = 2, unit = '', label = '', note = '', margin }) {
  const m = typeof margin === 'number' ? margin : capacity ? capacity / Math.max(load, 1e-9) : null;
  const state = m !== null ? marginState(m, sf) : 'none';
  const pct = capacity ? Math.min(1, load / capacity) : 0;
  const safe = 1 / sf;
  const ticks = [];
  for (let i = 1; i < 10; i++) ticks.push(h('i', { style: { left: `${i * 10}%` }, class: i === 5 ? 'major' : null }));
  return h(`div.mx-gauge.${state}`, { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(capacity || 0), 'aria-valuenow': String(load), 'aria-label': `${label}: ${fmt(load)} of ${fmt(capacity)} ${unit}` },
    h('div.mx-gauge-head', null,
      h('span.mx-gauge-name', null, label),
      h('span.mx-gauge-val', null, h('b', null, fmt(load)), capacity ? ` of ${fmt(capacity)} ${unit}` : ` ${unit}`)),
    h('div.mx-scale', null,
      h('div.mx-ticks', null, ticks),
      h('div.mx-fill', { style: { width: `${pct * 100}%` } }),
      capacity ? h('div.mx-safe', { style: { left: `${safe * 100}%` }, title: `Safe limit: capacity ÷ ${sf}` }) : null),
    h('div.mx-gauge-foot', null,
      h('span', null, m !== null ? `${(Math.floor(m * 100) / 100).toFixed(2)}× margin. ${STATE_WORD[state]}` : STATE_WORD.none),
      note ? h('span.mx-note', null, note) : null));
}

/** Drawing-style callout for a fit: Ø3.40 to model, fits a Ø3 pin, sliding. */
export function fitCallout(f) {
  if (f.kind === 'iso') {
    const lo = f.clearance.min, hi = f.clearance.max;
    return h('div.mx-fit', null,
      h('div.mx-fit-dim', null, h('span.mx-dia', null, 'Ø'), fmt(f.nominal, 3), h('span.mx-tol', null, h('sup', null, `${f.fit.split('/')[0]}`), h('sub', null, f.fit.split('/')[1]))),
      h('div.mx-fit-text', null,
        h('b', null, f.id),
        h('span', null, `${f.type[0].toUpperCase()}${f.type.slice(1)} fit, gap ${fmt(lo, 3)} to ${fmt(hi, 3)} mm. Hole ${fmt(f.hole.min, 3)}–${fmt(f.hole.max, 3)}, shaft ${fmt(f.shaft.min, 3)}–${fmt(f.shaft.max, 3)}`)));
  }
  const off = typeof f.designed === 'number' ? f.designed - f.recommended : 0;
  const state = typeof f.designed !== 'number' ? 'none' : Math.abs(off) <= 0.05 ? 'ok' : Math.abs(off) > 0.2 ? 'bad' : 'warn';
  const prefix = f.feature === 'slot' ? '' : 'Ø';
  return h(`div.mx-fit.${state}`, null,
    h('div.mx-fit-dim', null, prefix ? h('span.mx-dia', null, prefix) : null, fmt(f.recommended, 2)),
    h('div.mx-fit-text', null,
      h('b', null, f.id),
      h('span', null, `Model the ${f.feature} at ${fmt(f.recommended, 2)} mm for a ${fmt(f.nominal, 2)} mm part, ${f.fit} fit (${fmt(f.clearance_per_side, 2)} mm per side).`),
      typeof f.designed === 'number' ? h('span.mx-fit-state', null, state === 'ok' ? `Your model: ${f.designed} mm. Matches.` : `Your model: ${f.designed} mm. Change it to ${fmt(f.recommended, 2)} mm.`) : null));
}

/** Side elevation of the arm at the shoulder's worst pose, with dimensions and loads. */
export function armElevation(arm, chainDef) {
  const chain = (chainDef || []).map((j) => ({ ...j, type: j.type || 'pitch', link_mm: Number(j.link_mm) || 0 }));
  const shoulder = arm.joints.find((j) => j.type === 'pitch');
  const pose = (shoulder?.worst_pose || chain.map(() => 0)).map((a, i) => (chain[i]?.type === 'yaw' ? 0 : a));
  const fk = forwardKinematics(chain, pose);
  const pts = fk.points.map((p) => ({ r: Math.hypot(p.x, p.y) * (p.x < -1e-6 ? -1 : 1), z: p.z }));
  const W = 560, H = 280, pad = 34;
  const minR = Math.min(0, ...pts.map((p) => p.r)), maxR = Math.max(...pts.map((p) => p.r), 40);
  const minZ = Math.min(0, ...pts.map((p) => p.z)), maxZ = Math.max(...pts.map((p) => p.z), 40);
  const k = Math.min((W - 2 * pad - 40) / (maxR - minR || 1), (H - 2 * pad - 30) / (maxZ - minZ || 1));
  const X = (r) => pad + 20 + (r - minR) * k;
  const Y = (z) => H - pad - 18 - (z - minZ) * k;
  const g = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'mx-elev', role: 'img', 'aria-label': `Arm at its hardest pose for the shoulder: reach ${fmt(arm.reach_mm, 0)} mm` });
  // ground and base
  g.append(s('line', { x1: pad, y1: Y(0), x2: W - pad, y2: Y(0), class: 'mx-ground' }));
  g.append(s('rect', { x: X(0) - 16, y: Y(pts[1]?.z ?? 0), width: 32, height: Math.max(4, Y(0) - Y(pts[1]?.z ?? 0)), rx: 3, class: 'mx-base' }));
  // links
  for (let i = 1; i < pts.length - 1; i++) {
    g.append(s('line', { x1: X(pts[i].r), y1: Y(pts[i].z), x2: X(pts[i + 1].r), y2: Y(pts[i + 1].z), class: `mx-link${chain[i]?.type === 'gripper' ? ' grip' : ''}` }));
    // dimension label at mid link
    const mx = (X(pts[i].r) + X(pts[i + 1].r)) / 2, my = (Y(pts[i].z) + Y(pts[i + 1].z)) / 2;
    g.append(s('text', { x: mx, y: my + 20, class: 'mx-dim-t muted', 'text-anchor': 'middle' }, `${fmt(chain[i]?.link_mm, 0)} mm`));
  }
  // joints coloured by margin
  arm.joints.forEach((j, i) => {
    if (i === 0 || !pts[i]) return;
    const st = j.type === 'gripper' ? 'none' : marginState(j.margin, arm.sf);
    g.append(s('circle', { cx: X(pts[i].r), cy: Y(pts[i].z), r: 7.5, class: `mx-joint ${st}` }));
    if (j.type !== 'gripper') g.append(s('text', { x: X(pts[i].r), y: Y(pts[i].z) - 14, class: 'mx-joint-t', 'text-anchor': 'middle' }, `${j.id[0].toUpperCase()}${j.id.slice(1)} ${fmt(j.load_kgcm, 2)}/${fmt(j.stall_kgcm, 1)}`));
  });
  // payload arrow
  const tip = pts[pts.length - 1];
  g.append(s('line', { x1: X(tip.r), y1: Y(tip.z) + 4, x2: X(tip.r), y2: Y(tip.z) + 30, class: 'mx-load' }));
  g.append(s('path', { d: `M${X(tip.r) - 5} ${Y(tip.z) + 24} L${X(tip.r)} ${Y(tip.z) + 32} L${X(tip.r) + 5} ${Y(tip.z) + 24}`, class: 'mx-load-head' }));
  g.append(s('text', { x: X(tip.r) + 8, y: Y(tip.z) + 28, class: 'mx-dim-t' }, `${fmt(arm.payload_g, 0)} g`));
  // reach dimension along the ground
  const yd = H - 14;
  g.append(s('line', { x1: X(0), y1: yd, x2: X(tip.r), y2: yd, class: 'mx-dimline' }));
  g.append(s('line', { x1: X(0), y1: yd - 5, x2: X(0), y2: yd + 5, class: 'mx-dimline' }));
  g.append(s('line', { x1: X(tip.r), y1: yd - 5, x2: X(tip.r), y2: yd + 5, class: 'mx-dimline' }));
  g.append(s('text', { x: (X(0) + X(tip.r)) / 2, y: yd - 5, class: 'mx-dim-t', 'text-anchor': 'middle' }, `${fmt(Math.abs(tip.r), 0)} mm out`));
  return g;
}

function section(title, sub, ...body) {
  return h('section.mx-sec', null, h('header.mx-sec-head', null, h('h3', null, title), sub ? h('p', null, sub) : null), ...body);
}

/** Full mechanics report (used by the view and the overlay). */
export function renderMechanics(app, { compact = false } = {}) {
  const check = app.data?.check;
  const M = check?.mechanics;
  const project = app.data?.project || {};
  const wrap = h('div.mx');
  const issues = (check?.issues || []).filter((i) => i.rule.startsWith('mech'));
  if (!M || !project.mechanics) {
    wrap.append(h('div.mx-empty', null,
      h('h3', null, 'No mechanics in this project yet'),
      h('p', null, 'Ask your AI: "Use wiremap: add the mechanics for this build". It records link lengths, masses, fits, bolts and gears, and the checker then tests servo torque, tolerances and strength.'),
      h('p.small', null, 'One-off numbers work now too: wiremap calc iso-fit, fit, bolt, beam, gear, drone, rover.')));
    return wrap;
  }
  if (issues.length) {
    wrap.append(h('ul.mx-issues', null, issues.map((i) => h(`li.${i.level}`, null, h('b', null, i.level === 'error' ? 'Fix' : i.level === 'warning' ? 'Check' : 'Note'), h('span', null, i.message), i.fix && !compact ? h('span.mx-fix', null, i.fix) : null))));
  } else {
    wrap.append(h('p.mx-allclear', null, 'No mechanical rule violations found. Estimates only: print a test part and load it.'));
  }
  if (M.arm) {
    const A = M.arm;
    const gauges = A.joints.filter((j) => j.type !== 'gripper' && j.stall_nm).map((j) => gauge({ load: j.load_kgcm, capacity: j.stall_kgcm, margin: j.margin_exact, sf: A.sf, unit: 'kg·cm', label: `${j.id[0].toUpperCase()}${j.id.slice(1)} joint`, note: compact ? '' : `${fmt(j.static_nm, 3)} N·m holding + ${fmt(j.dynamic_nm, 3)} N·m accelerating, ${j.actuator || 'actuator'}` }));
    const facts = h('dl.mx-facts', null,
      h('dt', null, 'Reach'), h('dd', null, `${fmt(A.reach_mm, 0)} mm`),
      h('dt', null, 'Repeatability'), h('dd', null, `±${fmt(A.tip_error_mm, 1)} mm`),
      h('dt', null, 'Moving mass'), h('dd', null, `${fmt(A.total_mass_g, 0)} g`),
      h('dt', null, 'Base tipping moment'), h('dd', null, `${fmt(A.base_moment_nm, 3)} N·m${A.yaw_bearing ? ' on a bearing' : ''}`),
      A.grip ? [h('dt', null, 'Grip'), h('dd', null, `${fmt(A.grip.force_n, 1)} N, needs ${fmt(A.grip.needed_n, 2)} N`)] : null);
    const tipGauge = A.tipping ? gauge({ load: A.tipping.overturning_gmm / 1000, capacity: A.tipping.restoring_gmm / 1000, margin: A.tipping.ratio, sf: 1.5, unit: 'kg·mm', label: 'Base against tipping', note: compact ? '' : `${A.tipping.counterweight_g ? `add about ${fmt(A.tipping.counterweight_g, 0)} g ballast` : 'arm moment at full reach vs base weight × footprint'}` }) : null;
    wrap.append(section('Arm joints', `Worst case over the joint range, ${A.samples} poses checked, safety factor ${A.sf}.`,
      compact ? null : h('div.mx-elev-wrap', null, armElevation(A, project.mechanics.arm.joints)),
      h('div.mx-gauges', null, gauges, tipGauge), facts,
      A.targets?.length ? h('ul.mx-list', null, A.targets.map((t) => h(`li.${t.ok ? (t.manipulability < 0.05 ? 'warn' : 'ok') : 'bad'}`, null, h('b', null, t.name), h('span', null, t.ok ? `reached, joints ${t.angles.filter((_, i) => project.mechanics.arm.joints[i]?.type !== 'gripper').map((a) => `${fmt(a, 0)}°`).join(' / ')}` : `out of reach by ${fmt(t.error_mm, 0)} mm`)))) : null));
  }
  if (M.fits?.length) wrap.append(section('Fits and tolerances', 'Sizes to put in CAD for this printer. Print the tolerance coupon once and store your measured clearances.', h('div.mx-fits', null, M.fits.map(fitCallout))));
  if (M.bolts?.length) wrap.append(section('Bolts', null, h('div.mx-gauges', null, M.bolts.map((b) => gauge({ load: b.per_bolt_n, capacity: b.capacity_n, sf: 2, unit: 'N per bolt', label: `${b.id} (${b.limited_by})` })))));
  if (M.beams?.length) wrap.append(section('Printed links and brackets', null, h('div.mx-gauges', null, M.beams.map((b) => gauge({ load: b.stress_mpa, capacity: b.allowable_mpa * 2, sf: 2, unit: 'MPa', label: b.id, note: `tip deflection about ${fmt(b.deflection_mm, 2)} mm` })))));
  if (M.gears?.length) wrap.append(section('Gears', null, h('ul.mx-list', null, M.gears.map((g) => h(`li.${g.problems.some((p) => p.level === 'error') ? 'bad' : g.problems.length ? 'warn' : 'ok'}`, null, h('b', null, g.id), h('span', null, `${fmt(g.ratio, 2)}:1, centre distance ${fmt(g.centre_distance_mm, 2)} mm${g.root_stress_mpa ? `, tooth stress ${fmt(g.root_stress_mpa, 1)} of ${fmt(g.allowable_mpa, 1)} MPa allowed` : ''}`))))));
  if (M.stackups?.length) wrap.append(section('Stack-ups', 'Worst case adds every tolerance; RSS is what most builds see.', h('ul.mx-list', null, M.stackups.map((t) => h(`li.${t.ok ? 'ok' : t.ok_rss ? 'warn' : 'bad'}`, null, h('b', null, t.id), h('span', null, `gap ${fmt(t.worst.min, 3)} to ${fmt(t.worst.max, 3)} mm worst case, ${fmt(t.rss.min, 3)} to ${fmt(t.rss.max, 3)} mm RSS`))))));
  if (M.rc) {
    const C = M.rc;
    wrap.append(section('RC car', `Standstill steering torque with tyres scrubbing (upper bound), Ackermann geometry, gearing.`,
      C.servo_stall_nm ? h('div.mx-gauges', null, gauge({ load: C.servo_needed_kgcm, capacity: C.servo_stall_nm * 100 / 9.80665, margin: C.steer_margin_exact, sf: 1.5, unit: 'kg·cm', label: 'Steering servo', note: compact ? '' : `${fmt(C.steer_torque_wheel_nm, 3)} N·m per front wheel` })) : null,
      h('dl.mx-facts', null,
        h('dt', null, 'Turning radius'), h('dd', null, `${fmt(C.turn_radius_mm / 1000, 2)} m`),
        C.top_speed_m_s !== undefined ? [h('dt', null, 'Top speed'), h('dd', null, `about ${fmt(C.top_speed_m_s, 1)} m/s`)] : null,
        C.lock_to_lock_s !== undefined ? [h('dt', null, 'Lock to lock'), h('dd', null, `${fmt(C.lock_to_lock_s, 2)} s`)] : null,
        C.tipping ? [h('dt', null, 'Side tip angle'), h('dd', null, `${fmt(C.tipping.tip_angle_deg, 0)}°`)] : null)));
  }
  if (M.assembly) {
    const S = M.assembly;
    const rows = [
      ...S.interference.map((x) => h('li.bad', null, h('b', null, `${x.a} and ${x.b}`), h('span', null, `overlap ${fmt(x.depth_mm, 1)} mm`))),
      ...S.access.map((x) => h(`li.${x.clear ? 'ok' : 'bad'}`, null, h('b', null, x.id), h('span', null, x.clear ? 'screwdriver can reach it' : `blocked by ${x.blocked_by.join(', ')}`))),
      ...S.order.map((x) => h('li.bad', null, h('b', null, x.id), h('span', null, `installed before ${x.missing.join(', ')}`))),
    ];
    wrap.append(section('Assembly', 'Overlaps between placed parts and prints, screwdriver paths, and build order.',
      rows.length ? h('ul.mx-list', null, rows) : h('p.mx-p', null, 'No overlaps or blocked fasteners found among the placed parts and prints.')));
  }
  if (M.dfm) {
    wrap.append(section('Print files', 'Checked from the exported STL in print orientation.', h('ul.mx-list', null, Object.entries(M.dfm).map(([id, A]) => {
      const st = A.problems.some((p) => p.level === 'error') ? 'bad' : A.problems.length ? 'warn' : 'ok';
      return h(`li.${st}`, null, h('b', null, id), h('span', null, `${A.size.join(' × ')} mm, about ${fmt(A.printed_mass_g, 0)} g, ${fmt(A.overhang_pct, 0)} % overhang${A.problems.length ? `. ${A.problems[0].text}` : ''}`));
    }))));
  }
  // Why this part and not that one: candidates swapped in and re-checked.
  if (!compact && M.arm) {
    const joints = (project.mechanics.arm.joints || []).filter((j) => j.part && j.type !== 'gripper');
    if (joints.length) {
      const host = h('div.mx-alt-host');
      const pick = h('select.mx-alt-sel', { 'aria-label': 'Joint to compare', onchange: () => show(pick.value) },
        joints.map((j) => h('option', { value: j.part }, `${j.id[0].toUpperCase()}${j.id.slice(1)} joint`)));
      const show = async (partId) => {
        host.replaceChildren(h('p.mx-p', null, 'Swapping each candidate in and re-running the checks…'));
        try {
          const { renderAlternatives } = await import('./alternatives.js');
          host.replaceChildren(renderAlternatives(app, partId) || h('p.mx-p', null, 'No alternatives to compare.'));
        } catch (e) { host.replaceChildren(h('p.mx-p', null, `Could not compare: ${e.message}`)); }
      };
      wrap.append(section('Why this part', 'Each candidate is swapped into the joint and the torque, mass and supply checks run again.', pick, host));
      setTimeout(() => show(pick.value), 0);
    }
  }
  if (M.rover) {
    const R = M.rover;
    wrap.append(section('Drive', `${fmt(R.force_n, 2)} N to climb and accelerate, ${fmt(R.traction_n, 2)} N before the wheels slip.`,
      R.margin ? h('div.mx-gauges', null, gauge({ load: R.torque_per_wheel_kgcm, capacity: R.torque_per_wheel_kgcm * R.margin, sf: 2, unit: 'kg·cm per wheel', label: 'Wheel torque' })) : null,
      R.top_speed_m_s ? h('p.mx-p', null, `Top speed about ${fmt(R.top_speed_m_s, 2)} m/s.`) : null,
      R.tipping ? h('p.mx-p', null, `Tips sideways at ${fmt(R.tipping.tip_angle_deg, 0)}° (static stability factor ${fmt(R.tipping.lateral_g, 2)}).`) : null));
  }
  if (M.drone) {
    const D = M.drone;
    wrap.append(section('Flight', null, h('dl.mx-facts', null,
      h('dt', null, 'Thrust to weight'), h('dd', null, `${fmt(D.twr, 2)} : 1`),
      h('dt', null, 'Hover throttle'), h('dd', null, `${Math.round(D.hover_throttle * 100)} %`),
      D.flight_min ? [h('dt', null, 'Hover time'), h('dd', null, `about ${fmt(D.flight_min, 1)} min`)] : null,
      D.prop_gap_mm !== undefined ? [h('dt', null, 'Prop tip gap'), h('dd', null, `${fmt(D.prop_gap_mm, 1)} mm`)] : null,
      D.balance ? [h('dt', null, 'CG off centre'), h('dd', null, `${fmt(D.balance.offset_mm, 1)} mm, worst motor +${fmt(D.balance.imbalance * 100, 0)} %`)] : null)));
  }
  return wrap;
}

export class MechanicsView {
  constructor(app, host) { this.app = app; this.host = host; }
  render() {
    clear(this.host).append(h('div.mx-scroll', null, h('div.mx-page', null,
      h('header.mx-title', null, h('h2', null, 'Mechanics'), h('p', null, 'Torque, tolerances and strength, worked out from the numbers in your project.')),
      renderMechanics(this.app))));
  }
  destroy() { clear(this.host); }
}
