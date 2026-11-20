// Cross-platform test runner: `node --test` with every tests/*.test.js file
// (Node 20 has no glob support in --test, and Windows shells don't expand *).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.js') && (!only.length || only.some((o) => f.includes(o)))).sort().map((f) => join(dir, f));
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
