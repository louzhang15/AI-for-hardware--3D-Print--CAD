import { api, clear, h, icon, postJSON, toast } from './util.js';

function endpoint(project) {
  return `/api/project/${encodeURIComponent(project)}/feedback`;
}

function recordCorrection(app, project) {
  const original = h('textarea', { required: true, maxlength: 4000, rows: 3 });
  const correction = h('textarea', { required: true, maxlength: 4000, rows: 3 });
  const evidence = h('textarea', { maxlength: 4000, rows: 2, placeholder: 'Datasheet, measurement, or explanation' });
  const error = h('p.form-error', { role: 'alert', hidden: true });
  const record = h('button.btn.primary', { form: 'correction-form', type: 'submit' }, 'Record correction');
  const form = h('form#correction-form.intake-form', { onsubmit: async (event) => {
    event.preventDefault();
    record.disabled = true;
    error.hidden = true;
    try {
      await postJSON(endpoint(project), { original: original.value, correction: correction.value, evidence: evidence.value });
      if (!form.isConnected) return;
      app.closeModal();
      app.renderLeft();
      toast('Correction recorded for review', 'ok');
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      record.disabled = false;
    }
  } },
    h('label.intake-field', null, 'Original AI suggestion', original),
    h('label.intake-field', null, 'Correction', correction),
    h('label.intake-field', null, 'Evidence (optional)', evidence), error);
  app.openModal({ title: 'Record an AI correction', body: form, actions: [h('button.btn.ghost', { onclick: app.closeModal }, 'Cancel'), record] });
  original.focus();
}

function correctionCard(app, entry, project) {
  const approved = entry.status === 'approved';
  const dismissed = entry.status === 'dismissed';
  const workspace = approved && entry.scope === 'workspace';
  const label = workspace ? 'Approved for workspace' : approved ? 'Approved for project' : dismissed ? 'Dismissed' : 'Pending review';
  const own = entry.project === project;
  const actions = h('div.correction-actions');
  const action = (name, status, scope) => h('button.btn.small', { onclick: async () => {
    const buttons = Array.from(actions.querySelectorAll('button'));
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await postJSON(`${endpoint(project)}/${encodeURIComponent(entry.id)}/review`, { status, scope });
      if (!actions.isConnected) return;
      app.renderLeft();
      toast('Correction review saved', 'ok');
    } catch (error) {
      toast(`Could not save review: ${error.message}`, 'error');
      buttons.forEach((button) => { button.disabled = false; });
    }
  } }, name);
  if (own) actions.append(...[
    approved && !workspace ? null : action(workspace ? 'Limit to this project' : 'Approve for this project', 'approved', 'project'),
    workspace ? null : action('Approve for all workspace projects', 'approved', 'workspace'),
    dismissed ? null : action('Dismiss', 'dismissed', entry.scope || 'project'),
  ].filter(Boolean));
  return h('article.correction-card', null,
    h('div.correction-meta', null, h(`span.pill.${approved ? 'ok' : dismissed ? 'neutral' : 'warn'}`, null, label),
      !own && h('span.small.muted', null, `From ${entry.project}`)),
    h('dl', null,
      h('dt', null, 'Original suggestion'), h('dd', null, entry.original),
      h('dt', null, 'Correction'), h('dd', null, entry.correction),
      entry.evidence && [h('dt', null, 'Evidence'), h('dd', null, entry.evidence)]),
    actions.childElementCount ? actions : null);
}

export async function renderCorrections(app, body) {
  const project = app.data.name;
  const list = h('div.correction-list', { 'aria-live': 'polite' }, h('p.small.muted', null, 'Loading corrections…'));
  body.append(h('section', null,
    h('div.section-title', null, 'AI corrections', h('span.grow'), h('button.btn.small', { onclick: () => recordCorrection(app, project) }, icon('plus', 14), 'New correction')),
    h('p.small.muted', null, 'Approve corrections for future Wiremap sessions in this project, or explicitly share them across the workspace.'), list));
  try {
    const { records } = JSON.parse(await api(endpoint(project)));
    clear(list).append(...(records.length ? records.map((entry) => correctionCard(app, entry, project)) : [h('p.small.muted', null, 'No corrections recorded.')]));
  } catch (error) {
    clear(list).append(h('p.callout.error', { role: 'alert' }, `Could not load corrections: ${error.message}`));
  }
}
