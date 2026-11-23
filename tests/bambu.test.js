// Bambu Studio awareness: a synthetic project .3mf (deflate-compressed, like
// Bambu Studio writes) and BambuStudio.conf are read, summarised for the
// chatbot, and checked against Wiremap's printer profiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../lib/node/threemf.js';
import { readBambu3mf, readConf, findProject, readBambuSession, describeBambu, bambuStatus, printerProfileId } from '../lib/node/bambu.js';
import { loadPrinters } from '../lib/node/library.js';
import * as printerLib from '../lib/printer.js';

function zip(files) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text); const data = deflateRawSync(raw); const n = Buffer.from(name);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data); central.push(ch, n); offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const dir = mkdtempSync(join(tmpdir(), 'wiremap-bambu-'));
const project = join(dir, 'servo-bracket.3mf');
writeFileSync(project, zip({
  '3D/3dmodel.model': '<model><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="62.5" y="40" z="0"/><vertex x="10" y="10" z="3.2"/></vertices></mesh></object></resources></model>',
  'Metadata/project_settings.config': JSON.stringify({
    printer_model: 'Bambu Lab A1 mini', printer_settings_id: 'Bambu Lab A1 mini 0.4 nozzle', print_settings_id: '0.20mm Standard @BBL A1M',
    nozzle_diameter: ['0.4'], curr_bed_type: 'Textured PEI Plate', layer_height: '0.2', wall_loops: '2', sparse_infill_density: '15%',
    sparse_infill_pattern: 'grid', enable_support: '0', brim_type: 'auto_brim', filament_type: ['ABS'], nozzle_temperature: ['260'], textured_plate_temp: ['90'],
  }),
  'Metadata/slice_info.config': `<?xml version="1.0"?><config><plate>
    <metadata key="index" value="1"/><metadata key="prediction" value="2700"/><metadata key="weight" value="8.12"/>
    <metadata key="outside" value="false"/><metadata key="support_used" value="false"/>
    <object identify_id="7" name="servo-bracket.stl" skipped="false"/>
    <filament id="1" type="ABS" color="#000000" used_m="2.71" used_g="8.12"/>
    <warning msg="Enclosure recommended for ABS" level="1" error_code="1000C002"/>
  </plate></config>`,
  'Metadata/model_settings.config': '<config><object id="1"><metadata key="name" value="servo-bracket.stl"/></object></config>',
}));
const older = join(dir, 'old.3mf');
writeFileSync(older, zip({ 'Metadata/project_settings.config': '{}' }));
utimesSync(older, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
const conf = join(dir, 'BambuStudio.conf');
writeFileSync(conf, JSON.stringify({ presets: { printer: 'Bambu Lab A1 mini 0.4 nozzle', filaments: ['Generic ABS'] }, recent_projects: { 1: older, 2: project, 3: join(dir, 'missing.3mf') } }));
process.env.WIREMAP_BAMBU_CONF = conf;

test('reads settings, plates, warnings, objects and size from a compressed project', () => {
  const r = readBambu3mf(project);
  assert.equal(r.settings.printer, 'Bambu Lab A1 mini');
  assert.equal(r.settings.infill, '15%');
  assert.equal(r.settings.bedTemp, '90', 'bed temperature for the selected plate type');
  assert.deepEqual(r.settings.filamentType, ['ABS']);
  assert.equal(r.plates[0].seconds, 2700);
  assert.equal(r.plates[0].grams, 8.12);
  assert.equal(r.plates[0].warnings[0].msg, 'Enclosure recommended for ABS');
  assert.deepEqual(r.objects, ['servo-bracket.stl']);
  assert.deepEqual(r.sizeMm, [62.5, 40, 3.2]);
  assert.equal(r.printerProfile, 'bambu-a1-mini');
});

test('finds the newest existing recent project and the selected presets', () => {
  const c = readConf();
  assert.equal(c.printer, 'Bambu Lab A1 mini 0.4 nozzle');
  assert.deepEqual(c.filaments, ['Generic ABS']);
  assert.equal(findProject(), project, 'newest file wins; missing files skipped');
});

test('chatbot summary includes settings, time, warnings, printer fit and the ABS material check', () => {
  const text = describeBambu(readBambuSession(), loadPrinters(), printerLib);
  assert.match(text, /servo-bracket\.3mf/);
  assert.match(text, /layer 0\.2 mm, 2 walls, infill 15% grid, supports off/);
  assert.match(text, /Plate 1: 45 min, 8\.12 g \(ABS #000000 8\.12 g\); slicer warnings: Enclosure recommended for ABS/);
  assert.match(text, /fits/);
  assert.match(text, /Material check: ABS on .* is "(warn|no)"/);
  assert.deepEqual(bambuStatus(readBambuSession()), { active: true, status: 'active', file: 'servo-bracket.3mf', sliced: true, warnings: 1,
    text: 'servo-bracket.3mf · 45 min, 8.12 g · 1 warning' });
});

test('printer names map to Wiremap profiles', () => {
  assert.equal(printerProfileId('Bambu Lab A1'), 'bambu-a1');
  assert.equal(printerProfileId('Bambu Lab X1 Carbon'), 'bambu-x1c');
  assert.equal(printerProfileId('Bambu Lab H2D'), 'bambu-h2d');
  assert.equal(printerProfileId('Prusa MK4'), null);
});

test('no Bambu Studio at all is reported plainly', () => {
  const saved = process.env.WIREMAP_BAMBU_CONF;
  process.env.WIREMAP_BAMBU_CONF = join(dir, 'nope.conf');
  assert.equal(readBambuSession().status, 'unavailable');
  process.env.WIREMAP_BAMBU_CONF = saved;
});
