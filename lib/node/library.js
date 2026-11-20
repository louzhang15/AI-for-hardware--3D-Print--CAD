// Node-only: load the part library and printer profiles from disk.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIREMAP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadDir(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f === 'index.json') continue;
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const id = data.id || f.replace(/\.json$/, '');
    out[id] = data;
  }
  return out;
}

/** Load every library part: {id: def}. Extra dirs (e.g. a project's own parts) override. */
export function loadLibrary(dir = join(WIREMAP_ROOT, 'library'), ...extra) {
  const lib = loadDir(dir);
  for (const d of extra) Object.assign(lib, loadDir(d));
  return lib;
}

/** Load every printer profile: {id: profile}. */
export function loadPrinters(dir = join(WIREMAP_ROOT, 'printers')) {
  return loadDir(dir);
}

/** Read a project JSON file. Throws with a readable message on bad JSON. */
export function readProject(file) {
  const text = readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}
