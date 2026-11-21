const id = (name) => document.getElementById(name);

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function facts(entries) {
  const list = element('dl', undefined, 'context-facts');
  for (const [name, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    list.append(element('dt', name), element('dd', String(value)));
  }
  return list;
}

function evidenceDetails(data) {
  const details = element('details', undefined, 'context-source');
  details.append(element('summary', 'View attached data'));
  const source = element('pre', JSON.stringify(data, null, 2));
  source.tabIndex = 0;
  source.setAttribute('aria-label', 'Attached data');
  details.append(source);
  return details;
}

function endpoint(pin) {
  if (!pin) return '';
  const mark = pin.marking || pin.name || pin.id;
  const alias = pin.name && pin.name !== mark ? ` (${pin.name})` : '';
  return [pin.part, mark ? mark + alias : ''].filter(Boolean).join(' · ');
}

function projectSummary(context) {
  const wire = context.target?.startsWith('wire:') ? context.connections?.[0] : null;
  const markings = [wire?.from?.marking, wire?.to?.marking].filter(Boolean);
  if (markings.length === 2) return `Project · ${markings.join(' ↔ ')}`;
  if (context.pin?.marking) return `Project · ${context.pin.marking}`;
  return `Project · ${context.name || context.project}`;
}

function showProjectPreview(container, context) {
  const info = element('div', undefined, 'context-overview');
  info.append(element('strong', context.name || context.project, 'context-title'));
  const { parts, wires, errors, warnings } = context.counts || {};
  const summary = [Number.isInteger(parts) ? `${parts} parts` : '',
    Number.isInteger(wires) ? `${wires} wires` : '',
    Number.isInteger(errors) ? `${errors} errors` : '',
    Number.isInteger(warnings) ? `${warnings} warnings` : ''].filter(Boolean).join(' · ');
  if (summary) info.append(element('p', summary, 'context-caption'));
  if (context.pin) info.append(facts([['Selected pin', endpoint(context.pin)]]));
  const wire = context.connections?.[0];
  if (context.target?.startsWith('wire:')) {
    if (wire) info.append(facts([['From', endpoint(wire.from)], ['To', endpoint(wire.to)]]));
    else info.append(element('p', 'The selected wire is unavailable in the saved project.', 'context-caption'));
  }
  container.replaceChildren(info, evidenceDetails(context));
}

function showSolidWorksPreview(container, data) {
  const info = element('div', undefined, 'context-overview');
  const activeDoc = data.document || {};
  info.append(element('strong', activeDoc.title || 'Active SolidWorks document', 'context-title'));
  info.append(facts([['Type', activeDoc.type], ['Configuration', activeDoc.configuration],
    ['Active sketch', activeDoc.activeSketch], ['Selections', data.selectionCount]]));
  if (data.selection.length) {
    const labels = data.selection.map((item) => item.name || item.type).filter(Boolean);
    if (labels.length) info.append(element('p', labels.join(' · '), 'context-caption'));
  }
  container.replaceChildren(info, evidenceDetails(data));
}

export function setupCompanionContext(request, { onChange = () => {} } = {}) {
  const params = new URLSearchParams(location.search);
  const linkedProject = params.get('project');
  const target = params.get('target');
  const select = id('project-picker');
  const status = id('context-status');
  const panel = id('project-context');
  const projectLabel = panel.querySelector('summary');
  const preview = id('project-preview');
  const attachProject = id('attach-project');
  const removeProject = id('remove-project');
  const solidworks = id('solidworks');
  const removeSolidWorks = id('remove-solidworks');
  const solidWorksPreview = id('solidworks-preview');
  const solidWorksContext = id('solidworks-context');
  const solidWorksLabel = solidWorksContext.querySelector('summary');
  let project = null;
  let model = '';
  let loadingProject = false;
  let loadingModel = false;
  let locked = false;

  function syncControls() {
    attachProject.disabled = select.disabled = removeProject.disabled = locked || loadingProject;
    solidworks.disabled = removeSolidWorks.disabled = locked || loadingModel;
  }

  function notify() { queueMicrotask(onChange); }

  function tell(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  async function showProject(name, { expand = true } = {}) {
    if (locked || loadingProject) return;
    panel.hidden = false;
    panel.open = expand;
    loadingProject = true;
    project = null;
    projectLabel.textContent = 'Project context';
    preview.replaceChildren();
    syncControls();
    notify();
    try {
      tell('');
      if (select.options.length < 2) {
        const { projects } = await request('/api/projects');
        select.replaceChildren(new Option('Choose a project', ''), ...projects.map((entry) =>
          new Option(entry.meta?.name || entry.name, entry.name)));
      }
      select.value = name || '';
      if (!select.value) return;
      const query = new URLSearchParams({ project: select.value });
      if (select.value === linkedProject && target) query.set('target', target);
      const { context, digest } = await request(`/api/companion/context?${query}`);
      project = { project: select.value, target: query.get('target') || undefined, contextDigest: digest };
      projectLabel.textContent = projectSummary(context);
      showProjectPreview(preview, context);
    } catch (error) { tell(error.message); }
    finally { loadingProject = false; syncControls(); notify(); }
  }

  attachProject.addEventListener('click', () => showProject(select.value || linkedProject));
  select.addEventListener('change', () => showProject(select.value));
  removeProject.addEventListener('click', () => {
    if (locked || loadingProject) return;
    project = null;
    panel.hidden = true;
    select.value = '';
    preview.replaceChildren();
    id('open-evidence').focus();
    notify();
  });
  if (linkedProject) {
    void showProject(linkedProject, { expand: false });
    if (target?.startsWith('wire:')) id('question').value = 'Help me troubleshoot this connection.';
    if (target?.startsWith('pin:')) id('question').value = 'Help me identify and troubleshoot this pin.';
  }

  solidworks.addEventListener('click', async () => {
    if (locked || loadingModel) return;
    loadingModel = true;
    syncControls();
    notify();
    try {
      const data = await request('/api/companion/solidworks');
      if (data.status !== 'active') return tell(data.message || 'Open or activate a SolidWorks document and try again.');
      tell('');
      const snapshot = { version: data.revision, document: data.document, selectionCount: data.selectionCount,
        selection: data.selection?.slice(0, 8) || [] };
      const text = JSON.stringify(snapshot);
      if (text.length > 3000) throw new Error('This SolidWorks snapshot is too large to attach.');
      showSolidWorksPreview(solidWorksPreview, snapshot);
      solidWorksLabel.textContent = snapshot.document?.title
        ? `SolidWorks · ${snapshot.document.title}` : 'SolidWorks session';
      model = text;
      solidWorksContext.hidden = false;
      solidWorksContext.open = true;
    } catch (error) { tell(error.message); }
    finally { loadingModel = false; syncControls(); notify(); }
  });
  removeSolidWorks.addEventListener('click', () => {
    if (locked || loadingModel) return;
    model = '';
    solidWorksContext.hidden = true;
    solidWorksPreview.replaceChildren();
    id('open-evidence').focus();
    notify();
  });

  return {
    isLoading: () => loadingProject || loadingModel,
    setLocked(value) { locked = value; syncControls(); },
    payload: () => ({ ...project, solidworks: model || undefined }),
  };
}
