#!/usr/bin/env node
// wiremap new <template> <name> [--dir projects]: start a project from a template.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

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
export function instantiate(template, name) {
  const p = JSON.parse(readFileSync(template, 'utf8'));
  p.$schema = resolve(ROOT, 'schema', 'project.schema.json');
  p.meta = { ...p.meta, name, phase: 'define', template: template.split(/[\\/]/).pop().replace(/\.json$/, '') };
  for (const s of p.steps || []) s.done = false;
  if (p.breadboard) delete p.breadboard.layout;
  for (const part of p.parts || []) {
    if (!part.bb?.offboard) delete part.bb;
    if (part.bom) delete part.bom.checked;
  }
  for (const w of p.wires || []) delete w.bb;
  return p;
}

export function projectSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'project';
}

export function createProject(template, name, projectsDir) {
  const file = join(projectsDir, `${projectSlug(name)}.json`);
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(file, JSON.stringify(instantiate(template, name), null, 2) + '\n', { flag: 'wx' });
  return file;
}

export async function main(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, allowPositionals: true, options: {
      dir: { type: 'string', default: 'projects' }, help: { type: 'boolean', short: 'h' },
    } });
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const templates = listTemplates();
  if (args.values.help || args.positionals.length !== 2) {
    console.log(`Usage: wiremap new <template> <name> [--dir projects]\nTemplates: ${[...templates.keys()].join(', ')}`);
    return args.values.help ? 0 : 2;
  }
  const [tpl, name] = args.positionals;
  if (!templates.has(tpl)) { console.error(`Unknown template "${tpl}". Templates: ${[...templates.keys()].join(', ')}`); return 2; }
  const dir = resolve(args.values.dir);
  let file;
  try {
    file = createProject(templates.get(tpl), name, dir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    console.error(`${error.path} already exists; pick another name.`);
    return 2;
  }
  console.log(`Created ${file} from the ${tpl} template. Next: wiremap check ${file}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
