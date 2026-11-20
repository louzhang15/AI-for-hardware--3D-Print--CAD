import { PHASES, PHASE_TITLES } from '/lib/model.js';
import { clear, h, icon } from './util.js';

function link(app, type, id, label) {
  return h('li', null, h('button.btn.ghost.small.step-reference', {
    onclick: () => app.select({ type, id }),
    title: label,
  }, label));
}

export function renderStepPanel(app, host) {
  const { project } = app.data;
  const steps = (project.steps || []).filter(Boolean);
  const phase = app.ui.phase;
  const phaseSteps = steps.filter((step) => (step.phase || 'wire') === phase);
  const current = app.currentStep();
  const done = steps.filter((step) => step.done).length;
  const index = phaseSteps.indexOf(current);
  const progress = h('div.progress', { role: 'progressbar', 'aria-label': 'Build progress', 'aria-valuemin': 0,
    'aria-valuemax': steps.length || 1, 'aria-valuenow': done },
  h('div', { style: { width: `${steps.length ? 100 * done / steps.length : 0}%` } }));
  const top = h('div.step-top', null,
    h('div.step-guide-title', null, h('h2', null, 'Build guide'), h('span', null, `${done} of ${steps.length} complete`)), progress);

  const body = h('div.step-body');
  if (current) {
    body.append(h('div.step-kicker', null, PHASE_TITLES[phase], phaseSteps.length > 1 ? h('span', null, `Step ${index + 1} of ${phaseSteps.length}`) : null),
      h('h3.step-title', null, current.title), h('p.step-text', null, current.text));
    if (phaseSteps.length > 1) body.append(h('div.step-dots', { 'aria-label': `Steps in ${PHASE_TITLES[phase]}` }, phaseSteps.map((step, stepIndex) =>
      h(`button.step-dot${step.done ? '.done' : ''}${step === current ? '.active' : ''}`, {
        title: step.title, 'aria-label': step.title, 'aria-current': step === current ? 'step' : null,
        onclick: () => app.gotoStep(stepIndex),
      }, step.done ? icon('check', 13) : stepIndex + 1))));
    if (current.why) body.append(h('div.callout.why', null, icon('help'), current.why));
    for (const warning of current.warnings || []) body.append(h('div.callout.warning', null, icon('alert'), warning));
    const tools = [...(current.tools || []), ...(current.fasteners || []).map((id) => (project.fasteners || []).find((item) => item.id === id)?.name || id)];
    if (tools.length) body.append(h('h3', null, 'Tools and fasteners'), h('div.tags', null, tools.map((tool) => h('span.tag', null, tool))));
    const references = [
      ...(current.wires || []).map((id) => { const wire = app.describeWire(id); return link(app, 'wire', id, wire ? `${wire.label} · ${wire.from} → ${wire.to}` : id); }),
      ...(current.parts || []).map((id) => link(app, 'part', id, app.part(id)?.name || id)),
      ...(current.prints || []).map((id) => link(app, 'print', id, (project.prints || []).find((part) => part.id === id)?.name || id)),
    ];
    if (references.length) body.append(h('h3', null, 'Parts and connections'), h('ul.step-list', null, references));
  } else {
    body.append(h('p.phase-empty', null, 'No guided steps are recorded for this phase.'));
  }

  const phaseIndex = PHASES.indexOf(phase);
  const hasEarlier = index > 0 || steps.some((step) => PHASES.indexOf(step.phase || 'wire') < phaseIndex);
  const hasLater = index + 1 < phaseSteps.length || steps.some((step) => PHASES.indexOf(step.phase || 'wire') > phaseIndex);
  const footer = h('div.step-foot', null,
    current && h(`label.done-row${current.done ? '.is-done' : ''}`, null,
      h('input.tick', { type: 'checkbox', checked: Boolean(current.done), onchange: (event) => app.setStepDone(current.id, event.target.checked) }), 'Mark step complete'),
    h('div.nav-row', null,
      h('button.btn', { disabled: !hasEarlier, onclick: () => app.nextStep(-1) }, icon('left'), 'Back'),
      h('button.btn.primary', { disabled: !hasLater, onclick: () => app.nextStep(1) }, 'Next', icon('right'))),
    current && h('button.btn.ghost', { onclick: () => app.askWithNote({ kind: 'stuck', target: `step:${current.id}`,
      context: `I am stuck on “${current.title}” in the ${PHASE_TITLES[phase]} phase. ${current.text || ''}`, title: 'Get help with this step' }) }, icon('help'), 'I’m stuck'));
  clear(host).append(h('div.step-wrap', null, top, body, footer));
}
