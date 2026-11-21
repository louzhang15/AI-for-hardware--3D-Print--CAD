import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { describeBambu, readBambuSession } from '../lib/node/bambu-session.js';
import { writeZip } from '../lib/node/threemf.js';
import { startServer } from '../viewer/serve.mjs';

const settings = {
  printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle', nozzle_diameter: ['0.4'], filament_type: ['ABS'],
  layer_height: '0.2', wall_loops: '2', sparse_infill_density: '15%', enable_support: '0',
};
const config = { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) };
const sliced = {
  name: 'Metadata/slice_info.config',
  data: `<config><plate><metadata key="index" value="1"/><metadata key="prediction" value="2700"/>
    <metadata key="weight" value="8.12"/><warning msg="Check supports &amp; brim" level="1" error_code="7"/>
    <warning error_code="7" msg="Check supports &amp; brim"/></plate></config>`,
};

test('saved Bambu settings and warnings are loaded locally and can be added to a draft', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wiremap-bambu-preview-'));
  const project = join(dir, 'panel.3mf');
  const conf = join(dir, 'BambuStudio.conf');
  await writeFile(project, writeZip([config, sliced]));
  await writeFile(conf, JSON.stringify({ recent_projects: { 1: join(dir, 'missing.3mf'), 2: project } }) + '\n# footer\n');
  t.after(() => { delete process.env.WIREMAP_BAMBU_CONF; delete process.env.WIREMAP_BAMBU_FILE; });
  process.env.WIREMAP_BAMBU_CONF = conf;
  delete process.env.WIREMAP_BAMBU_FILE;
  const report = readBambuSession();
  assert.equal(report.file, 'panel.3mf');
  assert.equal(report.plates[0].seconds, 2700);
  assert.deepEqual(report.plates[0].warnings, [{ message: 'Check supports & brim', code: '7' }]);
  assert.match(describeBambu(report), /material check for ABS/);
  assert.match(describeBambu(report), /45m 0s, 8.12 g/);
  const server = await startServer({ port: 0, projectsDir: join(dir, 'projects') });
  t.after(() => server.close());
  const url = new URL('/api/companion/bambu', server.url);
  const data = await (await fetch(url)).json();
  assert.equal(data.status, 'saved');
  assert.match(data.text, /panel\.3mf/);
  assert.ok(!data.text.includes(dir));
  assert.equal((await fetch(url, { headers: { Origin: 'https://example.com' } })).status, 403);
});

test('deflated Bambu metadata is read and rejected if damaged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wiremap-bambu-deflated-'));
  const file = join(dir, 'deflated.3mf');
  const zip = writeZip([config]);
  const entryStart = 30 + Buffer.byteLength(config.name);
  const endStart = zip.length - 22;
  const oldDirectory = zip.readUInt32LE(endStart + 16);
  const compressed = deflateRawSync(zip.subarray(entryStart, oldDirectory));
  zip.writeUInt16LE(8, 8);
  zip.writeUInt32LE(compressed.length, 18);
  zip.writeUInt16LE(8, oldDirectory + 10);
  zip.writeUInt32LE(compressed.length, oldDirectory + 20);
  zip.writeUInt32LE(entryStart + compressed.length, endStart + 16);
  const bytes = Buffer.concat([zip.subarray(0, entryStart), compressed, zip.subarray(oldDirectory)]);
  await writeFile(file, bytes);
  assert.equal(readBambuSession({ file }).status, 'saved');
  bytes.writeUInt32LE(0, entryStart + compressed.length + 16);
  await writeFile(file, bytes);
  assert.equal(readBambuSession({ file }).status, 'unavailable');
});
