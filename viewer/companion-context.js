const id = (name) => document.getElementById(name);

export function setupCompanionContext(request) {
  const params = new URLSearchParams(location.search);
  const linkedProject = params.get('project');
  const target = params.get('target');
  const select = id('project-picker');
  const status = id('context-status');
  const panel = id('project-context');
  const preview = id('project-preview');
  const solidworks = id('solidworks');
  let project = null;
  let model = '';
  let loading = false;

  function tell(message) {
    status.textContent = message;
    status.hidden = !message;
  }

  async function showProject(name) {
    if (loading) return;
    panel.hidden = false;
    panel.open = true;
    loading = true;
    project = null;
    preview.textContent = '';
    select.disabled = true;
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
      preview.textContent = JSON.stringify(context, null, 2);
    } catch (error) { tell(error.message); }
    finally { select.disabled = false; loading = false; }
  }

  id('attach-project').addEventListener('click', () => showProject(select.value || linkedProject));
  select.addEventListener('change', () => showProject(select.value));
  id('remove-project').addEventListener('click', () => {
    if (loading) return;
    project = null;
    panel.hidden = true;
    select.value = '';
    preview.textContent = '';
    id('attach-project').focus();
  });
  if (linkedProject) {
    void showProject(linkedProject);
    if (target?.startsWith('wire:')) id('question').value = 'Help me troubleshoot this connection.';
    if (target?.startsWith('pin:')) id('question').value = 'Help me identify and troubleshoot this pin.';
  }

  solidworks.addEventListener('click', async () => {
    solidworks.disabled = true;
    try {
      const data = await request('/api/companion/solidworks');
      if (data.status !== 'active') return tell(data.message || 'Open or activate a SolidWorks document and try again.');
      tell('');
      model = JSON.stringify({ version: data.revision, document: data.document, selectionCount: data.selectionCount,
        selection: data.selection?.slice(0, 8) }, null, 2).slice(0, 3000);
      id('solidworks-preview').textContent = model;
      id('solidworks-context').hidden = false;
      id('solidworks-context').open = true;
    } catch (error) { tell(error.message); }
    finally { solidworks.disabled = false; }
  });
  id('remove-solidworks').addEventListener('click', () => {
    model = '';
    id('solidworks-context').hidden = true;
    id('solidworks-preview').textContent = '';
    solidworks.focus();
  });

  return { isLoading: () => loading, payload: () => ({ ...project, solidworks: model || undefined }) };
}
