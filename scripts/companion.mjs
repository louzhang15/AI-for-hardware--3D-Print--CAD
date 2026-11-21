import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const viewer = fileURLToPath(new URL('../viewer/serve.mjs', import.meta.url));
const width = 520;
const height = 680;

export function centeredBounds(area) {
  const w = Math.min(width, area.width);
  const h = Math.min(height, area.height);
  return {
    x: area.x + Math.floor((area.width - w) / 2),
    y: area.y + Math.floor((area.height - h) / 2),
    width: w,
    height: h,
  };
}

async function startDetached(file, args, windowsHide = true) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide });
  await once(child, 'spawn');
  child.unref();
}

async function companionReady(origin) {
  const request = { redirect: 'error', signal: AbortSignal.timeout(400) };
  try {
    const api = await fetch(`${origin}/api/companion`, request);
    if (!api.ok || (await api.json()).available !== true) return false;
    const page = await fetch(`${origin}/companion.html`, request);
    return page.ok && (await page.text()).includes('<title>Wiremap Companion</title>');
  } catch {
    return false;
  }
}

async function ensureViewer(port) {
  const origin = `http://127.0.0.1:${port}`;
  if (await companionReady(origin)) return origin;
  await startDetached(process.execPath, [viewer, '--port', String(port)]);
  for (let attempt = 0; attempt < 20; attempt++) {
    await setTimeout(150);
    if (await companionReady(origin)) return origin;
  }
  throw new Error(`Wiremap Companion did not start on port ${port}. Try another port with --port.`);
}

function windowsBrowser() {
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const folders = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], local].filter(Boolean);
  const paths = [
    join('Google', 'Chrome', 'Application', 'chrome.exe'),
    join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const binary of paths) {
    const executable = folders.map((folder) => join(folder, binary)).find((path) => existsSync(path));
    if (executable) return executable;
  }
  return null;
}

function desktopBounds() {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = 'Add-Type -AssemblyName System.Windows.Forms; $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; "$($area.X),$($area.Y),$($area.Width),$($area.Height)"';
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const coordinates = result.stdout?.trim().match(/^(-?\d+),(-?\d+),(\d+),(\d+)$/)?.slice(1).map(Number);
  if (result.status !== 0 || !coordinates) return null;
  const [x, y, w, h] = coordinates;
  return w && h ? centeredBounds({ x, y, width: w, height: h }) : null;
}

async function openDesktop(url) {
  const browser = process.platform === 'win32' ? windowsBrowser() : null;
  if (!browser) return false;
  const bounds = desktopBounds();
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const args = [
    `--app=${url}`,
    `--user-data-dir=${join(local, 'Wiremap', 'Companion', basename(browser, '.exe'))}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    `--window-size=${bounds?.width ?? width},${bounds?.height ?? height}`,
  ];
  if (bounds) args.push(`--window-position=${bounds.x},${bounds.y}`);
  await startDetached(browser, args, false);
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { port: { type: 'string' }, 'no-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    });
    if (values.help) {
      console.log('Usage: wiremap companion [--port 4321] [--no-open]');
      return 0;
    }
    const port = Number(values.port ?? 4321);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a number between 1 and 65535');
    const url = `${await ensureViewer(port)}/companion.html`;
    console.log(`Wiremap Companion: ${url}`);
    if (!values['no-open'] && !await openDesktop(url)) {
      console.log('Open the link in your browser. The centered desktop window uses Chrome or Edge on Windows.');
    }
    return 0;
  } catch (error) {
    console.error(`wiremap companion: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
