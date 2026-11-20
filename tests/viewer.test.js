import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startServer } from '../viewer/serve.mjs';

test('viewer serves its entry graph and preserves edits to the same project', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'wiremap-viewer-'));
  const projectsDir = join(workspace, 'projects');
  await mkdir(projectsDir);
  const projectFile = join(projectsDir, 'demo.json');
  await copyFile(new URL('./fixtures/viewer/demo.json', import.meta.url), projectFile);
  const server = await startServer({ port: 0, projectsDir });
  t.after(async () => {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const request = (path, opts) => fetch(new URL(path, server.url), opts);
  const post = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(server.url).origin }, body: JSON.stringify(body) });

  const modules = ['app.js', 'steps.js', 'sketch.js', 'bbview.js', 'power.js', 'scene3d.js', 'svg-view.js', 'corrections.js',
    'vendor/three/three.module.min.js', 'vendor/three/addons/controls/OrbitControls.js', 'lib/check.js'];
  await Promise.all(modules.map(async (file) => {
    const response = await request(`/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.headers.get('content-type'), /javascript/, file);
    await response.arrayBuffer();
  }));
  const root = await request('/');
  assert.match(await root.text(), /import\('\.\/app\.js'\)/);
  const listing = await (await request('/api/projects')).json();
  assert.deepEqual(listing.projects.map((project) => project.name), ['demo']);

  const [stepEdit, positionEdit, requirementsEdit] = await Promise.all([
    post('/api/project/demo/state', { steps: { s5: { done: true } } }),
    post('/api/project/demo/state', { positions: { esp: [12.5, 0, 18] } }),
    post('/api/project/demo/state', { requirements: { budget: '$150', on_hand: ['Multimeter', 'Cable'] } }),
  ]);
  assert.deepEqual(await stepEdit.json(), { ok: true, changed: ['steps.s5.done'] });
  assert.deepEqual(await positionEdit.json(), { ok: true, changed: ['parts.esp.position'] });
  assert.deepEqual(await requirementsEdit.json(), { ok: true, changed: ['meta.requirements.budget', 'meta.requirements.on_hand'] });
  const saved = await (await request('/api/project/demo')).json();
  assert.deepEqual(saved, JSON.parse(await readFile(projectFile, 'utf8')));
  assert.equal(saved.steps.find((step) => step.id === 's5').done, true);
  assert.deepEqual(saved.parts.find((part) => part.id === 'esp').position, [12.5, 0, 18]);
  assert.equal(saved.meta.requirements.budget, '$150');
  assert.deepEqual(saved.meta.requirements.on_hand, ['Multimeter', 'Cable']);
  assert.equal((await post('/api/project/demo/state', { requirements: { budget: { invalid: true } } })).status, 400);
  assert.deepEqual(JSON.parse(await readFile(projectFile, 'utf8')), saved);

  const { templates } = await (await request('/api/templates')).json();
  assert.ok(templates.includes('robot-arm'));
  assert.equal((await post('/api/projects', { name: '../unwanted', template: 'robot-arm' })).status, 400);
  assert.equal((await post('/api/projects', { name: 'Portable name', template: '../unwanted' })).status, 400);
  assert.equal((await post('/api/projects', { name: 'CON', template: 'robot-arm' })).status, 400);
  const created = await post('/api/projects', { name: 'My Practice Arm', template: 'robot-arm' });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { name: 'my-practice-arm' });
  const copy = await (await request('/api/project/my-practice-arm')).json();
  assert.equal(copy.meta.name, 'My Practice Arm');
  assert.equal(copy.meta.template, 'robot-arm');
  assert.equal(copy.meta.phase, 'define');
  assert.ok(copy.steps.every((step) => !step.done));
  assert.equal((await post('/api/projects', { name: 'My Practice Arm', template: 'robot-arm' })).status, 409);

  const reply = await post('/api/inbox', { project: 'demo', kind: 'stuck', target: 'step:s5', text: 'The logic power LED stays dark.' });
  assert.equal(reply.status, 200);
  const entry = await reply.json();
  assert.match(entry.prompt, /logic power LED/);
  const inbox = await (await request('/api/inbox')).json();
  assert.equal(inbox.requests[0].id, entry.id);
});

test('viewer corrections need review before reuse and restrict reviews to the original project', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'wiremap-corrections-'));
  const projectsDir = join(workspace, 'projects');
  await mkdir(projectsDir);
  const fixture = new URL('./fixtures/viewer/demo.json', import.meta.url);
  await Promise.all(['arm', 'rover'].map((name) => copyFile(fixture, join(projectsDir, `${name}.json`))));
  const server = await startServer({ port: 0, projectsDir });
  t.after(async () => {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const endpoint = (project, suffix = '') => new URL(`/api/project/${project}/feedback${suffix}`, server.url);
  const records = async (project) => (await (await fetch(endpoint(project))).json()).records;
  const post = (url, body, origin = new URL(server.url).origin) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });

  const correction = { original: 'Move input to GPIO22', correction: 'Keep input on GPIO21', evidence: 'Reference diagram', project: 'rover' };
  assert.equal((await post(endpoint('missing'), correction)).status, 404);
  assert.equal((await post(endpoint('arm'), correction, 'https://example.com')).status, 403);
  assert.equal((await post(endpoint('arm'), { ...correction, correction: '' })).status, 400);
  const created = await post(endpoint('arm'), correction);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const [pending] = await records('arm');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.project, 'arm');
  assert.equal(pending.evidence, 'Reference diagram');
  assert.deepEqual(await records('rover'), []);

  const review = `/${id}/review`;
  assert.equal((await post(endpoint('arm', review), { status: 'approved', scope: 'project' })).status, 200);
  assert.deepEqual(await records('rover'), []);
  assert.equal((await post(endpoint('arm', review), { status: 'approved', scope: 'workspace' })).status, 200);
  const [shared] = await records('rover');
  assert.equal(shared.id, id);
  assert.equal(shared.scope, 'workspace');
  assert.equal((await post(endpoint('rover', review), { status: 'dismissed', scope: 'workspace' })).status, 404);
  assert.equal((await post(endpoint('arm', review), { status: 'dismissed', scope: 'workspace' })).status, 200);
  assert.deepEqual(await records('rover'), []);
  assert.equal((await records('arm'))[0].status, 'dismissed');
});
