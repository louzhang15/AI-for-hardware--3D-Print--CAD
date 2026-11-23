// "Why this part, not that one": every library candidate for a part's job,
// swapped into the project and re-checked (lib/select.js), with the verdict
// and the numbers behind it. Mounted by the Mechanics tab and the part sheet.
import { h } from './util.js';
import { compareRole } from '/lib/select.js';

const VERDICT_LABEL = { pick: 'Pick', works: 'Works', rejected: 'Rejected' };

function candidateRow(c, kind) {
  const facts = kind === 'actuator'
    ? [c.margin !== null ? `${c.margin.toFixed(2)}x torque margin` : 'no torque data', `${c.mass_g} g`, c.rail ? `supply peak ${c.rail.peak}${c.rail.capacity ? ` of ${c.rail.capacity}` : ''} A` : null]
    : [`${c.voltage} V`, c.capacity ? `${c.capacity} A` : null, c.runtime_h ? `about ${c.runtime_h} h` : null, c.heat_w ? `${c.heat_w} W heat` : null];
  return h(`li.alt-row.${c.verdict}`, null,
    h('span.alt-dot', { 'aria-hidden': 'true' }),
    h('div.alt-main', null,
      h('div.alt-head', null,
        h('b', null, c.name),
        c.current ? h('span.alt-tag', null, 'In your build') : null,
        h('span.alt-verdict', null, VERDICT_LABEL[c.verdict])),
      h('p.alt-facts', null, facts.filter(Boolean).join(', ')),
      h('ul.alt-why', null, c.reasons.map((r) => h('li', null, r)), c.requires.map((r) => h('li.alt-need', null, `Also needs ${r}.`)))));
}

/**
 * Section comparing alternatives for one project part, or null when the part
 * has no comparable job (only arm-joint actuators and power sources do).
 */
export function renderAlternatives(app, partId, { limit = 6 } = {}) {
  const project = app.data?.project;
  if (!project) return null;
  let r;
  try { r = compareRole(project, app.library || {}, partId); }
  catch (e) { return h('section.alt', null, h('p.alt-none', null, e.message)); }
  const title = r.kind === 'actuator'
    ? `Actuator for the ${r.joint} joint`
    : `Supply for ${r.rail.name}`;
  const sub = r.kind === 'actuator'
    ? `Each part swapped in and the whole arm re-checked, safety factor ${r.sf}x. Heavier parts also load the joints nearer the base.`
    : `${r.rail.typical} A typical, ${r.rail.peak} A peak across ${r.rail.loads.length} load${r.rail.loads.length === 1 ? '' : 's'}.`;
  return h('section.alt', { 'data-part': partId }, h('header.alt-top', null, h('h3', null, title), h('p', null, sub)),
    h('ul.alt-list', null, r.candidates.slice(0, limit).map((c) => candidateRow(c, r.kind))));
}
