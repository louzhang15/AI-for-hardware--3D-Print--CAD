#!/usr/bin/env node
// wiremap overlay: watch for Bambu Studio, OrcaSlicer, PrusaSlicer, Cura,
// SOLIDWORKS, Fusion, FreeCAD, KiCad, Arduino IDE (and more) and open the
// Wiremap overlay next to them: a small always-on-top window (Windows) with
// the project's print checklist, tolerances, mechanics and the assistant.
//
//   wiremap overlay                  watch in the foreground (Ctrl+C to stop)
//   wiremap overlay --install        start it automatically when you log in (asks first)
//   wiremap overlay --uninstall      remove the login item
//   wiremap overlay --once [--json]  show what is running now and exit
//   wiremap overlay --open           open the overlay now, without waiting for an app
//   wiremap overlay --apps           list the apps it follows
//
// Options: --project <name> (default: the most recently edited project),
//          --port 4321, --keep (leave the overlay open when the app closes),
//          --yes (skip the install question), --dry-run (print, do nothing).

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APPS, KIND_LABEL, primaryApp } from '../lib/apps.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';
const PROFILE_DIR = join(ROOT, '.wiremap', 'overlay-browser');

const HELP = `Usage: wiremap overlay [--install | --uninstall | --once | --open | --apps]
                       [--project name] [--port 4321] [--keep] [--yes] [--dry-run]

Opens the Wiremap overlay by itself when a slicer, CAD, electronics or
firmware app starts, and keeps it on top of that app (Windows). Run it once,
or use --install so it starts at login.`;

function parse(argv) {
  const o = { port: 4321 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--project') o.project = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--interval') o.interval = Number(next());
    else if (a.startsWith('--')) o[a.slice(2)] = true;
  }
  return o;
}

/** The most recently edited project in projects/ (falls back to the first one). */
export function defaultProject(dir = join(ROOT, 'projects')) {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }));
    files.sort((a, b) => b.t - a.t);
    return files[0] ? files[0].f.replace(/\.json$/, '') : null;
  } catch { return null; }
}

/** URL of the overlay page for an app and project. */
export function overlayUrl(base, { app, project } = {}) {
  const q = new URLSearchParams({ overlay: '1' });
  if (app) q.set('app', app);
  return `${base.replace(/\/$/, '')}/?${q}${project ? `#/p/${encodeURIComponent(project)}` : ''}`;
}

async function serverUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** Reuse a running viewer on the port, or start one in this process. */
async function ensureServer(port) {
  if (await serverUp(port)) return { url: `http://127.0.0.1:${port}`, own: null };
  const { startServer } = await import('../viewer/serve.mjs');
  const srv = await startServer({ port, projectsDir: join(ROOT, 'projects') });
  return { url: srv.url.replace(/\/$/, ''), own: srv };
}

// ------------------------------------------------------------ autostart

function nodeBin() { return process.execPath; }
const CLI = join(ROOT, 'bin', 'wiremap.mjs');

/** Where the login item lives and what it contains, per OS. */
export function autostartPlan({ project, port = 4321 } = {}) {
  const extra = [project ? `--project ${project}` : '', port !== 4321 ? `--port ${port}` : ''].filter(Boolean).join(' ');
  if (IS_WIN) {
    const dir = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const q = (s) => `""${s}""`;
    const body = `' Wiremap overlay: starts hidden at login. Delete this file (or run wiremap overlay --uninstall) to stop it.\r\nSet sh = CreateObject("WScript.Shell")\r\nsh.CurrentDirectory = "${ROOT}"\r\nsh.Run "${q(nodeBin())} ${q(CLI)} overlay${extra ? ' ' + extra : ''}", 0, False\r\n`;
    return { file: join(dir, 'Wiremap overlay.vbs'), body };
  }
  if (IS_MAC) {
    const args = [nodeBin(), CLI, 'overlay', ...extra.split(' ').filter(Boolean)].map((a) => `    <string>${a}</string>`).join('\n');
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.wiremap.overlay</string>
  <key>ProgramArguments</key><array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
`;
    return { file: join(homedir(), 'Library', 'LaunchAgents', 'dev.wiremap.overlay.plist'), body };
  }
  const body = `[Desktop Entry]\nType=Application\nName=Wiremap overlay\nExec="${nodeBin()}" "${CLI}" overlay${extra ? ' ' + extra : ''}\nPath=${ROOT}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`;
  return { file: join(homedir(), '.config', 'autostart', 'wiremap-overlay.desktop'), body };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

async function install(o) {
  const plan = autostartPlan(o);
  console.log(`Wiremap will add a login item so the overlay starts by itself:\n  ${plan.file}`);
  if (o['dry-run']) { console.log('\n' + plan.body); return 0; }
  if (!o.yes && !(await confirm('Add it?'))) { console.log('Nothing written.'); return 1; }
  mkdirSync(dirname(plan.file), { recursive: true });
  writeFileSync(plan.file, plan.body);
  console.log(`Added. It starts at your next login. To start it now: node bin/wiremap.mjs overlay`);
  return 0;
}

function uninstall(o) {
  const plan = autostartPlan(o);
  if (!existsSync(plan.file)) { console.log('No Wiremap login item found.'); return 0; }
  if (o['dry-run']) { console.log(`Would remove ${plan.file}`); return 0; }
  unlinkSync(plan.file);
  console.log(`Removed ${plan.file}`);
  return 0;
}

// ------------------------------------------------------------ watch loop

function describe(apps) {
  if (!apps.length) return 'none of the followed apps is running';
  return apps.map((a) => `${a.label}${a.file ? ` (${a.file})` : ''}`).join(', ');
}

async function watch(o) {
  const desk = await import('../lib/node/desktop.js');
  const server = await ensureServer(o.port);
  const project = o.project || defaultProject();
  console.log(`Wiremap overlay watching for: ${APPS.map((a) => a.label).join(', ')}`);
  console.log(`Viewer: ${server.url}${project ? `  project: ${project}` : ''}`);
  if (!desk.findBrowser()) console.log('No Edge/Chrome found: the overlay opens in your default browser and cannot stay on top.');
  let open = false, current = null, pinned = false, stopping = false, ticks = 0;
  const interval = Number.isFinite(o.interval) && o.interval >= 500 ? o.interval : 2500;

  const show = async (app) => {
    const url = overlayUrl(server.url, { app: app?.id, project });
    if (o['dry-run']) { console.log(`would open ${url}`); open = true; return; }
    if (!(await desk.overlayRunning(PROFILE_DIR))) {
      desk.openOverlayWindow(url, PROFILE_DIR);
      pinned = await desk.pinOverlayOnTop({ place: true });
    } else if (!pinned) pinned = await desk.pinOverlayOnTop({ place: false, waitMs: 2000 });
    open = true;
  };

  if (o.open) await show(null);
  const tick = async () => {
    if (stopping) return;
    let main = null;
    try { ({ primary: main } = await desk.detectWithFocus()); } catch { main = null; }
    if (main && (!current || main.id !== current.id)) {
      console.log(`${new Date().toLocaleTimeString()}  ${main.label} (${KIND_LABEL[main.kind]}) is open -> overlay`);
      current = main;
      await show(main);
    } else if (!main && current) {
      console.log(`${new Date().toLocaleTimeString()}  ${current.label} closed`);
      current = null;
      if (open && !o.keep && !o.open && !o['dry-run']) { await desk.closeOverlayWindows(PROFILE_DIR); open = false; pinned = false; }
    } else if (main && open && !o['dry-run'] && ++ticks % 5 === 0 && !(await desk.overlayRunning(PROFILE_DIR))) {
      // the user closed the overlay window: stay closed until the app is reopened
      open = false;
    }
    if (o.onceTick) return;
    setTimeout(tick, interval);
  };
  await tick();
  return new Promise((done) => {
    const stop = async () => {
      stopping = true;
      if (open && !o.keep && !o['dry-run']) await desk.closeOverlayWindows(PROFILE_DIR);
      if (server.own) await server.own.close();
      done(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function main(argv = []) {
  const o = parse(argv);
  if (o.help || o.h) { console.log(HELP); return 0; }
  if (o.apps) {
    for (const a of APPS) console.log(`  ${a.label.padEnd(16)} ${KIND_LABEL[a.kind].padEnd(12)} ${a.proc.join(', ')}`);
    return 0;
  }
  if (o.install) return install(o);
  if (o.uninstall) return uninstall(o);
  if (o.once) {
    const desk = await import('../lib/node/desktop.js');
    const apps = await desk.detectApps();
    const main = primaryApp(apps, null);
    const slicer = main?.kind === 'slicer' ? desk.readSlicerSettings(main.id) : null;
    if (o.json) console.log(JSON.stringify({ apps, primary: main, slicer, browser: desk.findBrowser() }, null, 2));
    else console.log(`Running: ${describe(apps)}${slicer?.printer ? `\n${main.label} printer preset: ${slicer.printer}` : ''}\nBrowser for the overlay: ${desk.findBrowser() || 'none found (default browser fallback)'}`);
    return 0;
  }
  if (!Number.isInteger(o.port) || o.port <= 0 || o.port > 65535) { console.error('wiremap overlay: --port must be 1-65535'); return 2; }
  return watch(o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; if (c !== undefined) process.exit(c); });
}
