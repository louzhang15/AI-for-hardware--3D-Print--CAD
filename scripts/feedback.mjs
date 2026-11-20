#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listFeedback, recordFeedback, reviewFeedback } from '../lib/node/feedback.js';

const HELP = `Usage: wiremap feedback <command> [options]

  record --project NAME --original TEXT --correction TEXT [--evidence TEXT]
  list [--project NAME] [--all] [--json]
  approve <id> [--workspace]
  dismiss <id>

Corrections are saved locally in .wiremap/feedback.jsonl. A correction is
pending until explicitly approved. Approve for its project by default or
use --workspace to make it applicable to every project in this workspace.
List approved corrections with --project NAME before working on a design.
With no project, list shows workspace-wide approvals. Use --all for history.

Pass --dir PATH to select the folder that holds .wiremap/ (default: current directory).
The project may be a viewer name or a path such as projects/robot-arm.json.
`;

const COMMANDS = {
  record: { project: { type: 'string' }, original: { type: 'string' }, correction: { type: 'string' }, evidence: { type: 'string' } },
  list: { project: { type: 'string' }, all: { type: 'boolean' } },
  approve: { workspace: { type: 'boolean' } },
  dismiss: {},
};

function display(record) {
  console.log(`${record.id} [${record.status}, ${record.scope}] ${record.project}`);
  for (const [label, text] of [['Original', record.original], ['Correction', record.correction], ['Evidence', record.evidence]]) {
    if (text) console.log(`  ${label}: ${text.replace(/\r\n?|\n/g, '\n    ')}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return command ? 0 : 2;
  }
  if (!Object.hasOwn(COMMANDS, command)) {
    console.error(`Unknown feedback command: ${command}`);
    return 2;
  }

  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args, allowPositionals: true, options: {
      dir: { type: 'string', default: '.' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      ...COMMANDS[command],
    } }));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (values.help) { console.log(HELP); return 0; }

  const reviewing = command === 'approve' || command === 'dismiss';
  if (positionals.length !== (reviewing ? 1 : 0)) {
    console.error(reviewing ? `Usage: wiremap feedback ${command} <id>` : 'Use named options for this command.');
    return 2;
  }
  const dir = resolve(values.dir);
  try {
    if (command === 'list') {
      const rows = listFeedback(dir, values);
      if (values.json) console.log(JSON.stringify(rows, null, 2));
      else if (!rows.length) console.log(values.all ? 'No matching corrections.' : 'No approved corrections apply.');
      else rows.forEach(display);
    } else {
      const record = command === 'record' ? recordFeedback(dir, values) : reviewFeedback(dir, positionals[0], {
        status: command === 'approve' ? 'approved' : 'dismissed', scope: values.workspace ? 'workspace' : 'project',
      });
      if (values.json) console.log(JSON.stringify(record));
      else if (command === 'record') console.log(`Recorded ${record.id} for ${record.project}. Pending approval.`);
      else console.log(`${record.id} is ${record.status} (${record.scope}).`);
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
