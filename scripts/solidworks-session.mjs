import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const helper = fileURLToPath(new URL('./solidworks-session.vbs', import.meta.url));
const selectionTypes = {
  1: 'edge', 2: 'face', 3: 'vertex', 4: 'plane', 9: 'sketch', 10: 'sketch segment',
  11: 'sketch point', 12: 'drawing view', 14: 'dimension', 20: 'component', 21: 'mate', 22: 'feature',
};

export async function main(argv) {
  let options;
  try {
    ({ values: options } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (options.help) {
    console.log('Usage: wiremap solidworks-session [--json]\nRead the active SOLIDWORKS document and selection on Windows.');
    return 0;
  }
  const report = await readSession();
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else if (report.status === 'active') console.log(describeSession(report)); else console.log(report.message ?? 'SOLIDWORKS is running. Open or activate a document and try again.');
  return report.status === 'active' ? 0 : 1;
}

/**
 * Read the live SOLIDWORKS session (Windows only). Async so the viewer server
 * never blocks. WIREMAP_SOLIDWORKS_FIXTURE=<file.json> replays a saved report
 * (tests, demos, other platforms).
 */
export function readSession({ timeout = 8000 } = {}) {
  const fixture = process.env.WIREMAP_SOLIDWORKS_FIXTURE;
  if (fixture) {
    try { return Promise.resolve(withTypes(JSON.parse(readFileSync(fixture, 'utf8')))); }
    catch (e) { return Promise.resolve({ status: 'unavailable', message: `Bad SOLIDWORKS fixture: ${e.message}` }); }
  }
  if (process.platform !== 'win32') return Promise.resolve({ status: 'unsupported', message: 'Run this command on the Windows PC running SOLIDWORKS.' });
  const cscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const child = spawn(cscript, ['//B', '//Nologo', '//U', helper], { windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      resolve({ status: 'busy', message: 'SOLIDWORKS did not respond. Dismiss any open dialog and try again.' });
    }, timeout);
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ status: 'unavailable', message: 'Could not start the Windows script host.' }); } });
    child.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        resolve(withTypes(JSON.parse(Buffer.concat(chunks).toString('utf16le').replace(/^\uFEFF/, ''))));
      } catch {
        resolve({ status: 'unavailable', message: 'Could not read the SOLIDWORKS session. Check that SOLIDWORKS and Wiremap are running as the same Windows user.' });
      }
    });
  });
}

function withTypes(report) {
  for (const item of report.selection || []) item.type = item.type || selectionTypes[item.typeCode] || `selection type ${item.typeCode}`;
  return report;
}

/** Short plain-text summary the chatbot gets with each question. */
export function describeSession(report) {
  if (!report || report.status !== 'active') return report?.message ? `SOLIDWORKS: ${report.message}` : '';
  const d = report.document || {};
  const lines = [`SOLIDWORKS ${report.revision || ''}: "${d.title}" (${d.type})${d.path ? ` at ${d.path}` : ''}${d.unsavedChanges ? ', unsaved changes' : ''}.`];
  if (d.configuration) lines.push(`Configuration: ${d.configuration}.`);
  if (d.activeSketch) lines.push(`Editing a sketch that is ${d.activeSketch}.`);
  if (Array.isArray(d.sizeMm)) lines.push(`Bounding box: ${d.sizeMm.map((n) => Math.round(n * 10) / 10).join(' x ')} mm (check printer fit with: wiremap fit-printer --printer <id> --size ${d.sizeMm.map((n) => Math.ceil(n)).join('x')}).`);
  if (d.mass) lines.push(`Mass ${d.mass.grams} g, volume ${d.mass.volumeCm3} cm3${d.material ? `, material ${d.material}` : ', no material set'}.`);
  const f = report.features;
  if (f) {
    const problems = f.problems || [];
    lines.push(problems.length
      ? `Rebuild problems (${problems.length}): ${problems.slice(0, 12).map((p) => `${p.name} [${p.type}] ${p.warning ? 'warning' : 'error'} code ${p.errorCode}`).join('; ')}.`
      : 'No rebuild errors or warnings in the feature tree.');
    const recent = (f.recent || []).filter((x) => !/Folder$|^OriginProfileFeature$|^RefPlane$|^MaterialFolder$|^HistoryFolder$|^Comments/.test(x.type)).slice(-12);
    if (recent.length) lines.push(`Last features (of ${f.total}): ${recent.map((x) => `${x.name} [${x.type}]${x.suppressed ? ' suppressed' : ''}`).join(', ')}.`);
  }
  const sel = report.selection || [];
  lines.push(report.selectionCount ? `Selected (${report.selectionCount}): ${sel.map((x) => (x.name ? `${x.name} (${x.type})` : x.type)).join(', ')}.` : 'Nothing selected.');
  return lines.join('\n');
}

/** One-line status for the viewer panel. */
export function sessionStatus(report) {
  if (!report || report.status !== 'active') return { active: false, text: report?.message || 'SOLIDWORKS not found' };
  const d = report.document || {};
  const problems = report.features?.problems?.length || 0;
  return { active: true, title: d.title, type: d.type, selected: report.selectionCount || 0, problems,
    selectionNames: (report.selection || []).map((x) => x && x.name).filter(Boolean).slice(0, 8),
    text: `${d.title} · ${d.type} · ${report.selectionCount || 0} selected${problems ? ` · ${problems} rebuild problem${problems === 1 ? '' : 's'}` : ''}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
