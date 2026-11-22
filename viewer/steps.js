import { PHASES, PHASE_TITLES } from '/lib/model.js';
import { clear, h, icon } from './util.js';

function link(app, type, id, label, detail) {
  return h('li', null, h('button.btn.ghost.step-reference', {
    type: 'button',
    onclick: () => app.select({ type, id }),
    'data-guide-focus': `reference:${type}:${id}`,
  }, h('span', null, label), detail && h('span.step-reference-detail', null, detail)));
}

function buildChecklist(app, host, phases, current, expanded) {
  return h('details.build-checklist', { open: expanded },
    h('summary', { 'data-guide-focus': 'checklist' }, 'All build steps', icon('right', 14)),
    h('div.build-checklist-list', null, phases.flatMap(({ phase, steps }) => {
      if (!steps.length) return [];
      const blocked = app.isLocked(phase);
      const completed = steps.filter((step) => step.done).length;
      return h('section.build-checklist-phase', null,
        h('h3', null, PHASE_TITLES[phase], h('span', { title: blocked ? app.lockReason(phase) : null },
          blocked ? 'Blocked' : `${completed}/${steps.length} complete`)),
        h('ol', null, steps.map((step, index) => {
          const active = step === current;
          const symbol = step.done ? 'check' : blocked ? 'lock' : active ? 'right' : null;
          return h('li', null, h('button.build-checklist-step', {
            type: 'button',
            disabled: blocked,
            'aria-current': active ? 'step' : null,
            'data-guide-focus': `checklist:${step.id}`,
            onclick: (event) => {
              event.currentTarget.closest('details').open = false;
              if (phase === app.ui.phase) app.gotoStep(index);
              else app.gotoStep(index, phase, { keepView: false, showGuide: true });
              host.querySelector('.step-title')?.focus();
            },
          }, h('span.build-checklist-mark', { 'aria-hidden': 'true' }, symbol && icon(symbol, 14)),
          h('span.build-checklist-title', null, step.title || step.id,
            step.done && h('span.build-checklist-state', null, 'Complete'))));
        })));
    })));
}

export function renderStepPanel(app, host) {
  const { project } = app.data;
  const steps = (project.steps || []).filter(Boolean);
  const phase = app.ui.phase;
  const phases = PHASES.map((id) => ({ phase: id, steps: steps.filter((step) => (step.phase || 'wire') === id) }));
  const phaseSteps = phases.find((group) => group.phase === phase)?.steps || [];
  const current = app.currentStep();
  const next = app.nextUnfinishedStep();
  const resume = next && next !== current;
  const blocked = resume && app.isLocked(next.phase || 'wire');
  const done = steps.filter((step) => step.done).length;
  const previousBody = host.querySelector('.step-body');
  const expanded = host.querySelector('.build-checklist')?.open;
  const activeElement = document.activeElement;
  const focusKey = host.contains(activeElement) ? activeElement.dataset.guideFocus : null;
  const index = phaseSteps.indexOf(current);
  const progress = h('div.progress', { role: 'progressbar', 'aria-label': 'Build progress', 'aria-valuemin': 0,
    'aria-valuemax': steps.length || 1, 'aria-valuenow': done },
  h('div', { style: { width: `${steps.length ? 100 * done / steps.length : 0}%` } }));
  const top = h('div.step-top', null,
    h('div.step-guide-title', null, h('h2', null, 'Build guide'), h('span', null, `${done} of ${steps.length} complete`)), progress);

  const body = h('div.step-body', { 'data-step': current?.id });
  if (steps.length) body.append(buildChecklist(app, host, phases, current, expanded));
  if (current) {
    body.append(h('div.step-kicker', null, PHASE_TITLES[phase], phaseSteps.length > 1 ? h('span', null, `Step ${index + 1} of ${phaseSteps.length}`) : null),
      h('h3.step-title', { tabindex: -1 }, current.title), h('p.step-text', null, current.text));
    if (current.why) body.append(h('div.callout.why', null, icon('help'), current.why));
    for (const warning of current.warnings || []) body.append(h('div.callout.warning', null, icon('alert'), warning));
    const tools = [...(current.tools || []), ...(current.fasteners || []).map((id) => (project.fasteners || []).find((item) => item.id === id)?.name || id)];
    if (tools.length) body.append(h('h3', null, 'Tools and fasteners'), h('div.tags', null, tools.map((tool) => h('span.tag', null, tool))));
    const references = [
      ...(current.wires || []).map((id) => {
        const wire = app.describeWire(id);
        return link(app, 'wire', id, wire?.label || id, wire?.title);
      }),
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
      h('input.tick', { type: 'checkbox', 'data-guide-focus': 'done', checked: Boolean(current.done),
        onchange: (event) => app.setStepDone(current.id, event.target.checked) }), 'Mark step complete'),
    h('div.nav-row', null,
      h('button.btn', { disabled: !hasEarlier, 'data-guide-focus': 'back', onclick: () => app.nextStep(-1, { showGuide: true }) }, icon('left'), 'Back'),
      h('button.btn.primary', { disabled: !hasLater, 'data-guide-focus': 'next', onclick: () => app.nextStep(1, { showGuide: true }) }, 'Next', icon('right'))),
    (resume || current) && h('div.step-support', null,
      resume && h('button.btn.ghost', { 'data-guide-focus': 'resume', onclick: () => app.resumeBuild() },
        icon(blocked ? 'alert' : 'steps'), blocked ? 'Review blocking issues' : 'Resume build'),
      current && h('button.btn.ghost', { 'data-guide-focus': 'help', onclick: () => app.askWithNote({ kind: 'stuck', target: `step:${current.id}`,
        context: `I am stuck on “${current.title}” in the ${PHASE_TITLES[phase]} phase. ${current.text || ''}`, title: 'Get help with this step' }) }, icon('help'), 'I’m stuck')));
  const keepScroll = previousBody?.dataset.step === body.dataset.step || (expanded && focusKey?.startsWith('checklist:'));
  const scrollTop = keepScroll ? previousBody?.scrollTop || 0 : 0;
  clear(host).append(h('div.step-wrap', null, top, body, footer));
  body.scrollTop = scrollTop;
  if (focusKey) {
    const match = Array.from(host.querySelectorAll('[data-guide-focus]:not(:disabled)'))
      .find((element) => element.dataset.guideFocus === focusKey && (expanded || !element.closest('.build-checklist-list')));
    const target = match || host.querySelector('.step-title') || host.querySelector('.build-checklist summary');
    target?.focus({ preventScroll: match === target });
  }
}
