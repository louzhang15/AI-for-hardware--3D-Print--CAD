import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const report = readSession();
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else if (report.status === 'active') {
    const { title, type, configuration, activeSketch, unsavedChanges } = report.document;
    console.log(`SOLIDWORKS ${report.revision} · ${title} (${type})${unsavedChanges ? ' · unsaved changes' : ''}`);
    if (configuration) console.log(`Configuration: ${configuration}`);
    if (activeSketch) console.log(`Active sketch constraints: ${activeSketch}`);
    console.log(`${report.selectionCount} selected${report.selection.length ? ': ' + report.selection.map(({ type, name }) => name ? `${name} (${type})` : type).join(', ') : ''}`);
  } else console.log(report.message ?? 'SOLIDWORKS is running. Open or activate a document and try again.');
  return report.status === 'active' ? 0 : 1;
}

function readSession() {
  if (process.platform !== 'win32') return { status: 'unsupported', message: 'Run this command on the Windows PC running SOLIDWORKS.' };
  const cscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cscript.exe');
  const run = spawnSync(cscript, ['//B', '//Nologo', '//U', helper], { windowsHide: true, timeout: 8000 });
  if (run.error?.code === 'ETIMEDOUT') {
    return { status: 'busy', message: 'SOLIDWORKS did not respond. Dismiss any open dialog and try again.' };
  }
  try {
    const report = JSON.parse(run.stdout.toString('utf16le').replace(/^\uFEFF/, ''));
    for (const item of report.selection || []) item.type = selectionTypes[item.typeCode] || `selection type ${item.typeCode}`;
    return report;
  } catch {
    return { status: 'unavailable', message: 'Could not read the SOLIDWORKS session. Check that SOLIDWORKS and Wiremap are running as the same Windows user.' };
  }
}
