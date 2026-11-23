// Overlay: app detection from process lists and window titles, slicer preset
// parsing, the login item, the /api/apps endpoint and the overlay page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appForProcess, fileFromTitle, matchApps, primaryApp, parseBambuConf, parsePrusaIni, presetMatchesProfile, nozzleFromPreset, APPS } from '../lib/apps.js';
import { overlayUrl, autostartPlan, defaultProject } from '../scripts/overlay.mjs';
import { overlayArgs } from '../lib/node/desktop.js';
import { loadPrinters } from '../lib/node/library.js';
import { startServer } from '../viewer/serve.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'wiremap-overlay-'));
const PROCS = [
  { pid: 10, name: 'bambu-studio', title: 'robot-arm-deck - Bambu Studio' },
  { pid: 11, name: 'SLDWORKS.exe', title: 'SOLIDWORKS Premium 2024 SP2 - [electronics-deck.SLDPRT *]' },
  { pid: 12, name: 'explorer', title: '' },
  { pid: 13, name: 'Arduino IDE', title: 'arm_bringup | Arduino IDE 2.3.2' },
];
const procFile = join(tmp, 'apps.json');
writeFileSync(procFile, JSON.stringify(PROCS));
const confFile = join(tmp, 'BambuStudio.conf');
writeFileSync(confFile, JSON.stringify({ presets: { machine: 'Bambu Lab X1 Carbon 0.4 nozzle', filament: 'Bambu PETG Basic', filament_1: 'Bambu PETG Basic' }, recent_projects: ['C:/x/robot-arm-deck.3mf'] }));

test('process names map to apps on every OS spelling', () => {
  assert.equal(appForProcess('bambu-studio.exe').id, 'bambu-studio');
  assert.equal(appForProcess('BambuStudio').id, 'bambu-studio');
  assert.equal(appForProcess('/Applications/OrcaSlicer.app').id, 'orca-slicer');
  assert.equal(appForProcess('SLDWORKS.exe').id, 'solidworks');
  assert.equal(appForProcess('Fusion360.exe').id, 'fusion');
  assert.equal(appForProcess('chrome'), null);
  assert.ok(APPS.length >= 12);
});

test('open file comes out of the window title', () => {
  const by = (id) => APPS.find((a) => a.id === id);
  assert.equal(fileFromTitle(by('solidworks'), 'SOLIDWORKS Premium 2024 SP2 - [electronics-deck.SLDPRT *]'), 'electronics-deck.SLDPRT');
  assert.equal(fileFromTitle(by('bambu-studio'), 'robot-arm-deck - Bambu Studio'), 'robot-arm-deck');
  assert.equal(fileFromTitle(by('bambu-studio'), 'C:\\prints\\deck.3mf - Bambu Studio'), 'deck.3mf');
  assert.equal(fileFromTitle(by('bambu-studio'), 'Bambu Studio'), null);
  const apps = matchApps(PROCS);
  assert.deepEqual(apps.map((a) => a.id).sort(), ['arduino-ide', 'bambu-studio', 'solidworks']);
  assert.equal(primaryApp(apps).id, 'bambu-studio', 'slicer wins when nothing is in front');
  assert.equal(primaryApp(apps, 11).id, 'solidworks', 'the foreground app wins');
  assert.equal(primaryApp(matchApps(PROCS.map((p) => ({ ...p, fg: p.pid === 13 })))).id, 'arduino-ide', 'the window in front wins');
});

test('the open file is matched to a print or part (run in the browser module)', { timeout: 60000 }, async (t) => {
  let chromium = null;
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
  if (!chromium) { t.diagnostic('playwright not installed: matcher check skipped'); return; }
  const server = await startServer({ port: 0, projectsDir: join(root, 'projects') });
  let browser;
  try { browser = await chromium.launch(); } catch (e) { await server.close(); t.diagnostic(`chromium unavailable: ${e.message}`); return; }
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  await page.goto(new URL('/', server.url).href);
  const r = await page.evaluate(async () => {
    const { matchDesign, designTokens } = await import('/overlay.js');
    const project = await (await fetch('/api/project/robot-arm')).json();
    const m = (f) => { const x = matchDesign(project, 'robot-arm', f); return x ? `${x.kind}:${x.id}` : null; };
    return {
      tokens: designTokens('C:\\cad\\Electronics-Deck_v2.SLDPRT'),
      sldprt: m('electronics-deck.SLDPRT'),
      title: m('robot-arm-deck'),
      stl: m('cad/robot-arm/electronics-deck.stl'),
      part: m('Shoulder SG90 servo'),
      none: m('gearbox-housing.f3d'),
      empty: m(''),
      steps: matchDesign(project, 'robot-arm', 'electronics-deck.SLDPRT').steps.length,
    };
  });
  assert.deepEqual(r.tokens, ['electronics', 'deck']);
  assert.equal(r.sldprt, 'print:electronics-deck');
  assert.equal(r.title, 'print:electronics-deck', 'project words are dropped from the title');
  assert.equal(r.stl, 'print:electronics-deck');
  assert.equal(r.part, 'part:servo-shoulder');
  assert.equal(r.none, null);
  assert.equal(r.empty, null);
  assert.ok(r.steps >= 0);
});

test('slicer settings: Bambu/Orca JSON and PrusaSlicer INI', () => {
  const b = parseBambuConf(JSON.stringify({ presets: { machine: 'Bambu Lab A1 mini 0.4 nozzle', filament: 'Bambu PLA Basic', filament_1: 'Bambu PLA Basic' }, recent_projects: ['a.3mf', 'b.3mf'] }));
  assert.equal(b.printer, 'Bambu Lab A1 mini 0.4 nozzle');
  assert.deepEqual(b.filaments, ['Bambu PLA Basic']);
  assert.deepEqual(b.recent, ['a.3mf', 'b.3mf']);
  assert.equal(parseBambuConf('not json'), null);
  const p = parsePrusaIni('[presets]\nprinter = Original Prusa MK4\nfilament = Prusament PETG\n[recent_projects]\n1 = C:/a.3mf\n');
  assert.equal(p.printer, 'Original Prusa MK4');
  assert.deepEqual(p.filaments, ['Prusament PETG']);
  assert.deepEqual(p.recent, ['C:/a.3mf']);
});

test('slicer preset vs project printer', () => {
  const P = loadPrinters();
  assert.equal(presetMatchesProfile('Bambu Lab A1 mini 0.4 nozzle', P['bambu-a1-mini']), true);
  assert.equal(presetMatchesProfile('Bambu Lab A1 0.4 nozzle', P['bambu-a1-mini']), false, 'A1 is not the A1 mini');
  assert.equal(presetMatchesProfile('Bambu Lab A1 mini 0.4 nozzle', P['bambu-a1']), false, 'A1 mini is not the A1');
  assert.equal(presetMatchesProfile('Bambu Lab X1 Carbon 0.4 nozzle', P['bambu-x1c']), true);
  assert.equal(presetMatchesProfile('Bambu Lab P1S 0.4 nozzle', P['bambu-p1s']), true);
  assert.equal(presetMatchesProfile(null, P['bambu-p1s']), null);
  assert.equal(nozzleFromPreset('Bambu Lab X1 Carbon 0.2 nozzle'), 0.2);
});

test('overlay window, URL and login item', () => {
  assert.equal(overlayUrl('http://127.0.0.1:4321/', { app: 'bambu-studio', project: 'robot-arm' }), 'http://127.0.0.1:4321/?overlay=1&app=bambu-studio#/p/robot-arm');
  const args = overlayArgs('http://x/?overlay=1', '/tmp/prof');
  assert.ok(args.includes('--app=http://x/?overlay=1') && args.some((a) => a.startsWith('--user-data-dir=')));
  const plan = autostartPlan({ project: 'robot-arm' });
  assert.match(plan.body, /overlay/);
  assert.match(plan.body, /--project robot-arm/);
  assert.ok(defaultProject(join(root, 'projects')));
});

test('wiremap overlay --once reads running apps and slicer presets', () => {
  const r = spawnSync(process.execPath, [join(root, 'bin', 'wiremap.mjs'), 'overlay', '--once', '--json'], {
    env: { ...process.env, WIREMAP_APPS_FIXTURE: procFile, WIREMAP_SLICER_FIXTURE: confFile }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.primary.id, 'bambu-studio');
  assert.equal(j.slicer.printer, 'Bambu Lab X1 Carbon 0.4 nozzle');
  const help = spawnSync(process.execPath, [join(root, 'bin', 'wiremap.mjs'), 'overlay', '--install', '--dry-run'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /login item/);
});

test('/api/apps and the overlay page follow the open app', { timeout: 90000 }, async (t) => {
  process.env.WIREMAP_APPS_FIXTURE = procFile;
  process.env.WIREMAP_SLICER_FIXTURE = confFile;
  const server = await startServer({ port: 0, projectsDir: join(root, 'projects') });
  t.after(async () => { await server.close(); delete process.env.WIREMAP_APPS_FIXTURE; delete process.env.WIREMAP_SLICER_FIXTURE; });
  const res = await (await fetch(new URL('/api/apps', server.url))).json();
  assert.equal(res.primary.id, 'bambu-studio');
  assert.equal(res.slicers['bambu-studio'].printer, 'Bambu Lab X1 Carbon 0.4 nozzle');

  let chromium = null;
  try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* optional */ }
  if (!chromium) { t.diagnostic('playwright not installed: page check skipped'); return; }
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.diagnostic(`chromium unavailable: ${e.message}`); return; }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 420, height: 780 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(new URL('/?overlay=1&app=bambu-studio#/p/robot-arm', server.url).href);
  await page.waitForSelector('.ov-tab');
  await page.waitForFunction(() => /X1 Carbon/.test(document.querySelector('.ov-body')?.textContent || ''), null, { timeout: 15000 });
  const text = await page.locator('.ov-body').innerText();
  assert.match(text, /Your project is sized for Bambu Lab A1 mini/);
  assert.match(text, /PLA not in the selected filaments/);
  assert.match(text, /Electronics tie-down deck/);
  assert.match(await page.locator('.ov-app').innerText(), /Bambu Studio/);
  await page.getByRole('tab', { name: 'Tolerances' }).click();
  assert.match(await page.locator('.ov-body').innerText(), /M3 screw passes through\s+Ø3\.60/);
  await page.getByRole('tab', { name: 'Mechanics' }).click();
  assert.ok(await page.locator('.mx-gauge').count() >= 3);
  await page.getByRole('tab', { name: 'Ask' }).click();
  assert.ok(await page.locator('.ov-ask .cmp-panel').isVisible());

  // SOLIDWORKS in front with electronics-deck.SLDPRT open: the deck is the focus.
  const swFile = join(tmp, 'apps-sw.json');
  writeFileSync(swFile, JSON.stringify(PROCS.map((p) => ({ ...p, fg: p.pid === 11 }))));
  process.env.WIREMAP_APPS_FIXTURE = swFile;
  await new Promise((r) => setTimeout(r, 2100)); // /api/apps caches for 2 s
  const sw = await browser.newPage({ viewport: { width: 420, height: 780 } });
  sw.on('pageerror', (e) => errors.push(e.message));
  await sw.addInitScript(() => localStorage.setItem('wiremap:overlay.tab', JSON.stringify('check')));
  await sw.goto(new URL('/?overlay=1&app=solidworks#/p/robot-arm', server.url).href);
  await sw.waitForSelector('.ov-focus', { timeout: 15000 });
  assert.match(await sw.locator('.ov-focus h3').innerText(), /Electronics tie-down deck/);
  assert.match(await sw.locator('.ov-focus').innerText(), /Now designing in SOLIDWORKS/);
  assert.ok(await sw.locator('.ov-focus b').count() >= 1, 'dimensions in bold');
  await sw.getByRole('tab', { name: 'Tolerances' }).click();
  assert.equal(await sw.locator('.ov-focus').count(), 1, 'focus card stays above the tolerance table');
  assert.deepEqual(errors, []);
});
