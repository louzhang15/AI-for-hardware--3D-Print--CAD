#!/usr/bin/env node
// wiremap new <template> <name> [--dir projects]: start a project from a template.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [join(ROOT, 'templates'), join(ROOT, 'projects')];

export function listTemplates() {
  const out = new Map();
  for (const dir of SOURCES) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.json') && !out.has(f.slice(0, -5))) out.set(f.slice(0, -5), join(dir, f));
  }
  return out;
}

/** Fresh copy of a template: progress cleared, schema path pointed at this install. */
export function instantiate(template, name, projectsDir) {
  const p = JSON.parse(readFileSync(template, 'utf8'));
  p.$schema = resolve(ROOT, 'schema', 'project.schema.json');
  p.meta = { ...(p.meta || {}), name, template: template.split(/[\\/]/).pop().replace(/\.json$/, '') };
  if (!p.meta.phase) p.meta.phase = 'define';
  for (const s of p.steps || []) s.done = false;
  if (p.breadboard) delete p.breadboard.layout;
  for (const part of p.parts || []) { delete part.bb; if (part.bom) delete part.bom.checked; }
  for (const w of p.wires || []) delete w.bb;
  void projectsDir;
  return p;
}

export async function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const dirIdx = argv.indexOf('--dir');
  const dir = resolve(dirIdx >= 0 ? argv[dirIdx + 1] : 'projects');
  const templates = listTemplates();
  if (argv.includes('--help') || args.length < 2) {
    console.log(`Usage: wiremap new <template> <name> [--dir projects]\nTemplates: ${[...templates.keys()].join(', ')}`);
    return args.length < 2 && !argv.includes('--help') ? 2 : 0;
  }
  const [tpl, name] = args;
  if (!templates.has(tpl)) { console.error(`Unknown template "${tpl}". Templates: ${[...templates.keys()].join(', ')}`); return 2; }
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  const file = join(dir, `${slug}.json`);
  if (existsSync(file)) { console.error(`${file} already exists; pick another name.`); return 2; }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(instantiate(templates.get(tpl), name, dir), null, 2) + '\n');
  console.log(`Created ${file} from the ${tpl} template. Next: wiremap check ${file}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
