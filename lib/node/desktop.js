// Desktop glue for the overlay: list running apps with their window titles,
// find a Chromium browser, open the overlay as a small app window and keep it
// above other windows (Windows). Node built-ins only.
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { APPS, matchApps, parseBambuConf, parsePrusaIni, primaryApp } from '../apps.js';

const IS_WIN = platform() === 'win32';
const IS_MAC = platform() === 'darwin';

function run(cmd, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Run a PowerShell script. -EncodedCommand (UTF-16LE base64) keeps quotes and newlines intact. */
function ps(script, opts) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], opts);
}

/** [{ name, title, pid }] for running processes (titles on Windows and with wmctrl on Linux). */
export async function listProcesses() {
  if (process.env.WIREMAP_APPS_FIXTURE) {
    try { return JSON.parse(readFileSync(process.env.WIREMAP_APPS_FIXTURE, 'utf8')); } catch { return []; }
  }
  if (IS_WIN) {
    const script = `Add-Type -Namespace W -Name F -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);'
$fg = 0; [void][W.F]::GetWindowThreadProcessId([W.F]::GetForegroundWindow(), [ref]$fg)
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,MainWindowTitle,@{n='Fg';e={$_.Id -eq $fg}} | ConvertTo-Json -Compress`;
    const out = await ps(script);
    if (!out) return [];
    try {
      const j = JSON.parse(out);
      return (Array.isArray(j) ? j : [j]).map((p) => ({ pid: p.Id, name: p.ProcessName, title: p.MainWindowTitle || '', fg: Boolean(p.Fg) }));
    } catch { return []; }
  }
  const out = await run('ps', ['-axo', 'pid=,comm=']);
  const procs = (out || '').split('\n').map((l) => /^\s*(\d+)\s+(.+)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), name: m[2].trim().replace(/^.*\//, ''), title: '' }));
  if (!IS_MAC) {
    const wm = await run('wmctrl', ['-lp'], { timeout: 3000 });
    if (wm) for (const l of wm.split('\n')) {
      const m = /^\S+\s+\S+\s+(\d+)\s+\S+\s+(.*)$/.exec(l);
      if (!m) continue;
      const p = procs.find((x) => x.pid === Number(m[1]));
      if (p && !p.title) p.title = m[2];
    }
  }
  return procs;
}

let lastForeground = null;
/**
 * Supported apps that are running now, plus the one to follow: the app in front,
 * else the last one that was in front (the overlay itself takes focus), else by kind.
 */
export async function detectApps() {
  return matchApps(await listProcesses());
}
export async function detectWithFocus() {
  const apps = await detectApps();
  const fg = apps.find((a) => a.foreground);
  if (fg) lastForeground = fg.id;
  const primary = fg || apps.find((a) => a.id === lastForeground) || primaryApp(apps, null);
  return { apps, primary };
}

/** Process id of the foreground window (Windows only; null elsewhere). */
export async function foregroundPid() {
  if (!IS_WIN) return null;
  const script = 'Add-Type -Namespace W -Name F -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int p);\'; $p=0; [void][W.F]::GetWindowThreadProcessId([W.F]::GetForegroundWindow(), [ref]$p); $p';
  const out = await ps(script, { timeout: 5000 });
  const n = Number(String(out || '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Path to Edge, Chrome, Brave or Chromium, or null. */
export function findBrowser() {
  if (process.env.WIREMAP_BROWSER) return process.env.WIREMAP_BROWSER;
  const env = process.env;
  const cands = IS_WIN ? [
    join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ] : IS_MAC ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  return cands.find((p) => p && existsSync(p)) || null;
}

export const OVERLAY_TITLE = 'Wiremap overlay';
export const OVERLAY_SIZE = { width: 420, height: 780 };

/** Browser arguments for the overlay app window (separate profile so it is its own process). */
export function overlayArgs(url, profileDir) {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${OVERLAY_SIZE.width},${OVERLAY_SIZE.height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,TranslateUI',
    '--disable-session-crashed-bubble', '--hide-crash-restore-bubble',
  ];
}

/**
 * Open the overlay window. Returns the child process (or null if no Chromium
 * browser was found: then the default browser opens the page instead).
 */
export function openOverlayWindow(url, profileDir) {
  const browser = findBrowser();
  mkdirSync(profileDir, { recursive: true });
  if (!browser) {
    const [cmd, args] = IS_WIN ? ['cmd', ['/c', 'start', '', url]] : IS_MAC ? ['open', [url]] : ['xdg-open', [url]];
    try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* none */ }
    return null;
  }
  const child = spawn(browser, overlayArgs(url, profileDir), { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return child;
}

/**
 * Windows: find the overlay window by title, keep it above every other window
 * and place it on the right edge of the work area the first time.
 * Retries for up to `waitMs` while the browser starts.
 */
export async function pinOverlayOnTop({ place = true, waitMs = 12000 } = {}) {
  if (!IS_WIN) return false;
  const { width, height } = OVERLAY_SIZE;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class WMTop {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@
$deadline = (Get-Date).AddMilliseconds(${Math.max(0, waitMs)})
$found = $false
while (-not $found -and (Get-Date) -lt $deadline) {
  [WMTop]::EnumWindows({ param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [void][WMTop]::GetWindowText($h, $sb, 256)
    if ([WMTop]::IsWindowVisible($h) -and $sb.ToString().StartsWith("${OVERLAY_TITLE}")) {
      $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
      $flags = ${place ? '0x0050' : '0x0053'}
      [void][WMTop]::SetWindowPos($h, [IntPtr](-1), $wa.Right - ${width} - 12, $wa.Top + 12, ${width}, [Math]::Min(${height}, $wa.Height - 24), $flags)
      $script:found = $true
    }
    return $true }, [IntPtr]::Zero) | Out-Null
  if (-not $found) { Start-Sleep -Milliseconds 400 }
}
if ($found) { "pinned" } else { "missing" }`;
  const out = await ps(script, { timeout: waitMs + 8000 });
  return /pinned/.test(out || '');
}

/** Close overlay windows started with our profile folder. */
export async function closeOverlayWindows(profileDir) {
  if (IS_WIN) {
    const esc = profileDir.replace(/'/g, "''");
    await ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    return;
  }
  await run('pkill', ['-f', `--user-data-dir=${profileDir}`]);
}

/** Is an overlay browser with our profile folder running? */
export async function overlayRunning(profileDir) {
  if (IS_WIN) {
    const esc = profileDir.replace(/'/g, "''");
    const out = await ps(`(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--app=*' -and $_.CommandLine -like '*${esc}*' } | Measure-Object).Count`);
    return Number(String(out || '0').trim()) > 0;
  }
  const out = await run('pgrep', ['-f', `--user-data-dir=${profileDir}`]);
  return Boolean(out && out.trim());
}

/** Selected printer/filament presets and recent projects from a slicer's settings file. */
export function readSlicerSettings(appId) {
  if (process.env.WIREMAP_SLICER_FIXTURE) {
    try {
      const t = readFileSync(process.env.WIREMAP_SLICER_FIXTURE, 'utf8');
      return t.trim().startsWith('{') ? parseBambuConf(t) : parsePrusaIni(t);
    } catch { return null; }
  }
  const app = APPS.find((a) => a.id === appId);
  if (!app?.conf) return null;
  const home = homedir();
  const base = IS_WIN ? (process.env.APPDATA || join(home, 'AppData', 'Roaming'))
    : IS_MAC ? join(home, 'Library', 'Application Support') : join(home, '.config');
  const file = app.id === 'prusa-slicer' ? join(base, app.conf, `${app.conf}.ini`) : join(base, app.conf, `${app.conf}.conf`);
  if (!existsSync(file)) return { file, missing: true };
  try {
    const t = readFileSync(file, 'utf8');
    const parsed = app.id === 'prusa-slicer' ? parsePrusaIni(t) : parseBambuConf(t);
    return parsed ? { file, ...parsed } : { file, unreadable: true };
  } catch { return { file, unreadable: true }; }
}
