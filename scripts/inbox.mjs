#!/usr/bin/env node
// Viewer -> AI inbox (.wiremap/inbox.jsonl).
//   node scripts/inbox.mjs list [--all] [--json] [--dir D]
//   node scripts/inbox.mjs done <id> [--note text] [--dir D]
//   node scripts/inbox.mjs add --kind explain --target wire:w5 --text "..." [--project projects/x.json] [--dir D]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendInbox, markInbox, readInbox, inboxPath, INBOX_KINDS } from '../lib/node/inbox.js';

const HELP = `Usage: node scripts/inbox.mjs <command> [options]

The viewer writes requests ("explain this wire", "fix this") to
.wiremap/inbox.jsonl. The AI reads them between steps and marks them done.

Commands:
  list [--all] [--json]       pending requests (--all: every request)
  done <id> [--note text]     mark a request handled (appends a status line)
  add --kind K --target T --text "..." [--project P]
                              add a request (for testing). K: ${INBOX_KINDS.join(', ')}
                              T: wire:w5 | part:esp | pin:esp.GPIO21 | step:s9 | issue:<id>

Options:
  --dir D     folder that holds .wiremap/ (default: current directory)
  --help      this text
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      opts[k] = v;
      i++;
    } else opts._.push(a);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.help || !opts._.length) { console.log(HELP); return opts.help ? 0 : 2; }
  const dir = resolve(opts.dir || process.cwd());
  const cmd = opts._[0];
  try {
    if (cmd === 'list') {
      const items = readInbox(dir, { pendingOnly: !opts.all });
      if (opts.json) { console.log(JSON.stringify(items, null, 2)); return 0; }
      if (!items.length) { console.log(opts.all ? `Inbox is empty (${inboxPath(dir)}).` : 'No pending requests.'); return 0; }
      for (const r of items) {
        const t = r.target ? `${r.target.type}:${r.target.id}` : '-';
        console.log(`${r.id}  [${r.status}]  ${r.kind}  ${t}${r.project ? `  (${r.project})` : ''}`);
        if (r.text) console.log(`    ${r.text.replace(/\n/g, '\n    ')}`);
        if (r.note) console.log(`    note: ${r.note}`);
      }
      for (const e of readInbox.lastErrors) console.error(`warning: ${e}`);
      return 0;
    }
    if (cmd === 'done') {
      const id = opts._[1];
      if (!id) { console.error('Usage: inbox done <id> [--note text]'); return 2; }
      markInbox(dir, id, 'done', opts.note);
      console.log(`Marked ${id} done.`);
      return 0;
    }
    if (cmd === 'add') {
      const r = appendInbox(dir, { kind: opts.kind, target: opts.target, text: opts.text, project: opts.project });
      console.log(opts.json ? JSON.stringify(r) : `Added ${r.id}.`);
      return 0;
    }
    console.error(`Unknown command "${cmd}".\n\n${HELP}`);
    return 2;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
