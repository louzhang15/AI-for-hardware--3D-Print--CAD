#!/usr/bin/env node
// Wiremap viewer server: serves the static viewer, the shared lib/ code and a
// tiny JSON API over the projects directory. Node 20+ built-ins only.
//
//   node viewer/serve.mjs [--port 4321] [--projects ./projects] [--open]
//
// Binds 127.0.0.1 only. Writes are limited to step/position/phase state in a
// project file, creating projects from local templates, and the inbox queue.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createProject, listTemplates, projectSlug } from '../scripts/new-project.mjs';
import { listFeedback, recordFeedback, reviewFeedback } from '../lib/node/feedback.js';

const VIEWER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(VIEWER_DIR, '..');
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const MAX_BODY = 1024 * 1024;
const PHASES = ['define', 'parts', 'power', 'wire', 'firmware', 'print', 'assemble', 'test'];
const INBOX_KINDS = ['explain', 'fix', 'swap', 'stuck', 'ask'];
const TARGET_RE = /^(wire|part|pin|step|issue|project|print):[^\n]{1,200}$/;
const REQUIREMENT_FIELDS = new Set(['size', 'payload', 'runtime', 'budget', 'power', 'on_hand']);
const RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
let appsCache = null;
const FEEDBACK_ROUTE = /^\/api\/project\/([^/]+)\/feedback(?:\/(f-[0-9a-f-]{36})\/review)?$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.stl': 'model/stl',
  '.3mf': 'model/3mf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
};
// What /files/ may serve from the user's repo (prints/ and cad/ only).
const FILE_EXTS = new Set(['.stl', '.3mf', '.glb', '.gltf', '.bin', '.png', '.jpg', '.jpeg']);
const FILE_DIRS = ['prints', 'cad'];

// ---------------------------------------------------------------- helpers

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  });
  res.end(buf);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), MIME['.json']);
const fail = (res, status, message) => json(res, status, { error: message });

function isInside(base, p) {
  const rel = path.relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a URL sub-path safely under base. Returns the real file path or
 * null. Rejects "..", NUL, backslashes, hidden segments and symlinks that
 * point outside base.
 */
async function safeResolve(base, subPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(subPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segs = decoded.split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  const target = path.resolve(base, ...segs);
  if (!isInside(base, target)) return null;
  try {
    const realBase = await fsp.realpath(base);
    const real = await fsp.realpath(target);
    if (!isInside(realBase, real)) return null;
    const st = await fsp.stat(real);
    if (!st.isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

async function serveFile(res, file, req) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  try {
    const st = await fsp.stat(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {
    fail(res, 404, 'Not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large (max 1 MB)'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  try {
    const v = JSON.parse(text || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw Object.assign(new Error('Body must be a JSON object'), { status: 400 });
  }
}

async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

function loadJsonDir(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f === 'index.json' || f.startsWith('.')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out[data.id || f.replace(/\.json$/, '')] = data;
    } catch (e) {
      out[f.replace(/\.json$/, '')] = { id: f.replace(/\.json$/, ''), $error: `Invalid JSON: ${e.message}` };
    }
  }
  return out;
}

async function tryImport(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return null;
  try {
    return await import(pathToFileURL(file).href);
  } catch {
    return null;
  }
}

function inboxPrompt(entry) {
  const where = entry.project ? ` in projects/${entry.project}.json` : '';
  const t = entry.target && typeof entry.target === 'object' ? `${entry.target.type} ${entry.target.id}`.trim() : String(entry.target || '');
  const verbs = { explain: 'Explain', fix: 'Fix', swap: 'Suggest a replacement for', stuck: 'I am stuck on', ask: 'Question about' };
  const text = String(entry.text || '').replace(/\s+/g, ' ').trim();
  return `Use wiremap: handle viewer request ${entry.id}${where}. ${verbs[entry.kind] || 'Handle'} ${t}: ${text} `
    + '(Details are in .wiremap/inbox.jsonl. Re-run the checker after any change and mark the request done.)';
}

// ---------------------------------------------------------------- server

/**
 * Start the viewer server.
 * @param {{port?: number, projectsDir?: string, host?: string, quiet?: boolean, pollMs?: number}} opts
 * @returns {Promise<{server: http.Server, url: string, port: number, close: () => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const host = '127.0.0.1';
  const projectsDir = path.resolve(opts.projectsDir || path.join(ROOT, 'projects'));
  const repoDir = path.dirname(projectsDir);
  const pollMs = opts.pollMs ?? 1500;
  if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true });

  const libMod = await tryImport('lib/node/library.js');
  const inboxMod = await tryImport('lib/node/inbox.js');

  let port = 0;
  const clients = new Set();
  const pendingWrites = new Map();

  // ---------- change detection: fs.watch + polling fallback, deduped by mtime/size
  const sigs = new Map();
  const scan = () => {
    const now = new Map();
    let names = [];
    try { names = fs.readdirSync(projectsDir); } catch { /* dir removed */ }
    for (const f of names) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const st = fs.statSync(path.join(projectsDir, f));
        now.set(f.slice(0, -5), `${st.mtimeMs}:${st.size}`);
      } catch { /* raced with delete */ }
    }
    return now;
  };
  for (const [k, v] of scan()) sigs.set(k, v);
  const emit = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  const compare = () => {
    const now = scan();
    for (const [k, v] of now) if (sigs.get(k) !== v) { sigs.set(k, v); emit('change', k); }
    for (const k of [...sigs.keys()]) if (!now.has(k)) { sigs.delete(k); emit('change', k); }
  };
  let debounce = null;
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(compare, 120); };
  let watcher = null;
  try {
    watcher = fs.watch(projectsDir, { persistent: false }, schedule);
    watcher.on('error', () => { watcher = null; });
  } catch { watcher = null; }
  const poll = setInterval(compare, watcher ? Math.max(pollMs, 3000) : pollMs);
  poll.unref();
  const heartbeat = setInterval(() => { for (const c of clients) c.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();

  // ---------- security: Host / Origin must be our own loopback address
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const hostOk = (req) => allowedHosts().has(String(req.headers.host || '').toLowerCase());
  const originOk = (req) => {
    const o = req.headers.origin;
    if (o === undefined) return true; // non-browser clients (curl, tests); Host is still checked
    try {
      const u = new URL(o);
      return u.protocol === 'http:' && allowedHosts().has(u.host.toLowerCase());
    } catch { return false; }
  };

  const projectFile = (name) => {
    if (typeof name !== 'string') return null;
    if (name.endsWith('.json')) name = name.slice(0, -5);
    if (!NAME_RE.test(name) || name.startsWith('.')) return null;
    const file = path.resolve(projectsDir, `${name}.json`);
    if (!isInside(projectsDir, file) || path.dirname(file) !== projectsDir) return null;
    return { name, file };
  };

  async function listProjects() {
    const out = [];
    let names = [];
    try { names = await fsp.readdir(projectsDir); } catch { /* none */ }
    for (const f of names.sort()) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const file = path.join(projectsDir, f);
      try {
        const lst = await fsp.lstat(file);
        if (lst.isSymbolicLink()) {
          const real = await fsp.realpath(file);
          if (!isInside(await fsp.realpath(projectsDir), real)) continue;
        }
        const st = await fsp.stat(file);
        if (!st.isFile()) continue;
        const entry = { name: f.slice(0, -5), file: `projects/${f}`, mtime: st.mtime.toISOString(), size: st.size };
        try {
          const p = JSON.parse(await fsp.readFile(file, 'utf8'));
          const steps = Array.isArray(p.steps) ? p.steps : [];
          entry.meta = p.meta || {};
          entry.phase = (p.meta && p.meta.phase) || 'define';
          entry.counts = {
            parts: Array.isArray(p.parts) ? p.parts.length : 0,
            wires: Array.isArray(p.wires) ? p.wires.length : 0,
            steps: steps.length,
            stepsDone: steps.filter((s) => s && s.done).length,
            prints: Array.isArray(p.prints) ? p.prints.length : 0,
          };
        } catch (e) {
          entry.error = `Invalid JSON: ${e.message}`;
          entry.phase = 'define';
          entry.meta = {};
        }
        out.push(entry);
      } catch { /* raced */ }
    }
    return out;
  }

  function mergeState(project, body) {
    const changed = [];
    if (body.steps && typeof body.steps === 'object' && !Array.isArray(body.steps)) {
      const steps = Array.isArray(project.steps) ? project.steps : [];
      for (const [id, v] of Object.entries(body.steps)) {
        const step = steps.find((s) => s && s.id === id);
        if (!step || !v || typeof v !== 'object' || typeof v.done !== 'boolean') continue;
        step.done = v.done;
        changed.push(`steps.${id}.done`);
      }
    }
    if (body.positions && typeof body.positions === 'object' && !Array.isArray(body.positions)) {
      for (const [id, pos] of Object.entries(body.positions)) {
        if (!Array.isArray(pos) || pos.length !== 3 || !pos.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e5)) continue;
        const rounded = pos.map((n) => Math.round(n * 10) / 10);
        const part = (project.parts || []).find((p) => p && p.id === id);
        const print = part ? null : (project.prints || []).find((p) => p && p.id === id);
        const target = part || print;
        if (!target) continue;
        target.position = rounded;
        changed.push(`${part ? 'parts' : 'prints'}.${id}.position`);
      }
    }
    if (body.have && typeof body.have === 'object' && !Array.isArray(body.have)) {
      for (const [id, v] of Object.entries(body.have)) {
        const part = (project.parts || []).find((p) => p && p.id === id);
        if (!part || typeof v !== 'boolean') continue;
        part.have = v;
        changed.push(`parts.${id}.have`);
      }
    }
    if (body.phase !== undefined) {
      if (!PHASES.includes(body.phase)) throw Object.assign(new Error(`phase must be one of ${PHASES.join(', ')}`), { status: 400 });
      project.meta = project.meta && typeof project.meta === 'object' ? project.meta : {};
      project.meta.phase = body.phase;
      changed.push('meta.phase');
    }
    if (body.requirements !== undefined) {
      const fields = body.requirements;
      const bad = (message) => Object.assign(new Error(message), { status: 400 });
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw bad('requirements must be an object');
      const meta = project.meta && typeof project.meta === 'object' && !Array.isArray(project.meta) ? project.meta : {};
      const current = meta.requirements;
      const next = current && typeof current === 'object' && !Array.isArray(current) ? { ...current } : {};
      for (const [key, value] of Object.entries(fields)) {
        if (!REQUIREMENT_FIELDS.has(key)) throw bad(`Unknown requirement field: ${key}`);
        const valid = key === 'on_hand'
          ? Array.isArray(value) && value.length <= 30 && value.every((item) => typeof item === 'string' && item.length <= 160)
          : typeof value === 'string' && value.length <= 500;
        if (value !== null && !valid) throw bad(`Invalid value for ${key}`);
        if (value === null) delete next[key];
        else next[key] = value;
        changed.push(`meta.requirements.${key}`);
      }
      project.meta = { ...meta, requirements: next };
    }
    return changed;
  }

  async function updateState(file, body) {
    const previous = pendingWrites.get(file);
    const write = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      const text = await fsp.readFile(file, 'utf8');
      let project;
      try { project = JSON.parse(text); }
      catch (error) { throw Object.assign(new Error(`Project file is not valid JSON, not writing: ${error.message}`), { status: 409 }); }
      const changed = mergeState(project, body);
      if (changed.length) await writeAtomic(file, `${JSON.stringify(project, null, 2)}\n`);
      return changed;
    });
    pendingWrites.set(file, write);
    try { return await write; }
    finally { if (pendingWrites.get(file) === write) pendingWrites.delete(file); }
  }

  /**
   * Wire edits from the viewer (move an end, add, delete, recolour). The file
   * before each edit goes on a per-project undo stack in .wiremap/history/.
   */
  async function editWires(file, name, op) {
    const previous = pendingWrites.get(file);
    const write = (previous || Promise.resolve()).catch(() => {}).then(async () => {
      const histDir = path.join(repoDir, '.wiremap', 'history');
      const hist = path.join(histDir, `${name}.jsonl`);
      const text = await fsp.readFile(file, 'utf8');
      if (op.op === 'undo') {
        let lines = [];
        try { lines = (await fsp.readFile(hist, 'utf8')).split('\n').filter(Boolean); } catch { /* none */ }
        if (!lines.length) throw Object.assign(new Error('Nothing to undo'), { status: 409 });
        const last = JSON.parse(lines.pop());
        await writeAtomic(file, last.text);
        await fsp.writeFile(hist, lines.length ? `${lines.join('\n')}\n` : '');
        return { undone: last.op, remaining: lines.length };
      }
      let project;
      try { project = JSON.parse(text); }
      catch (error) { throw Object.assign(new Error(`Project file is not valid JSON, not writing: ${error.message}`), { status: 409 }); }
      const lib = libMod && libMod.loadLibrary ? libMod.loadLibrary(path.join(ROOT, 'library'), path.join(repoDir, 'library')) : loadJsonDir(path.join(ROOT, 'library'));
      const { applyWireEdit } = await import('../lib/edit.js');
      const out = applyWireEdit(project, lib, op);
      await fsp.mkdir(histDir, { recursive: true });
      let lines = [];
      try { lines = (await fsp.readFile(hist, 'utf8')).split('\n').filter(Boolean); } catch { /* none */ }
      lines.push(JSON.stringify({ ts: new Date().toISOString(), op: `${op.op} ${op.id || ''}`.trim(), text }));
      await fsp.writeFile(hist, `${lines.slice(-30).join('\n')}\n`);
      await writeAtomic(file, `${JSON.stringify(out.project, null, 2)}\n`);
      return { wire: out.wire, changed: out.changed };
    });
    pendingWrites.set(file, write);
    try { return await write; }
    finally { if (pendingWrites.get(file) === write) pendingWrites.delete(file); }
  }

  async function appendInboxEntry(body) {
    const kind = body.kind;
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!INBOX_KINDS.includes(kind)) throw bad(`kind must be one of ${INBOX_KINDS.join(', ')}`);
    if (!TARGET_RE.test(target)) throw bad('target must look like "wire:w5" (wire, part, pin, step, issue, project or print), at most 200 characters');
    if (!text || text.length > 4000) throw bad('text must be 1-4000 characters');
    let project = null;
    if (body.project !== undefined && body.project !== null) {
      const pf = projectFile(body.project);
      if (!pf) throw bad('invalid project name');
      project = pf.name;
    }
    const req = { kind, target, text, project };
    let entry = null;
    if (inboxMod && typeof inboxMod.appendInbox === 'function') {
      try {
        entry = await inboxMod.appendInbox(repoDir, req);
      } catch (e) {
        throw bad(e && e.message ? e.message : 'invalid request');
      }
    } else {
      const dir = path.join(repoDir, '.wiremap');
      await fsp.mkdir(dir, { recursive: true });
      const i = target.indexOf(':');
      entry = { id: `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, ts: new Date().toISOString(), kind, project, target: { type: target.slice(0, i), id: target.slice(i + 1) }, text, status: 'pending' };
      await fsp.appendFile(path.join(dir, 'inbox.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
    }
    return { id: entry.id, prompt: inboxPrompt(entry), request: entry };
  }

  let chatBusy = false;
  async function handleApi(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/library') {
      let lib = {};
      try {
        lib = libMod && libMod.loadLibrary
          ? libMod.loadLibrary(path.join(ROOT, 'library'), path.join(repoDir, 'library'))
          : { ...loadJsonDir(path.join(ROOT, 'library')), ...loadJsonDir(path.join(repoDir, 'library')) };
      } catch (e) {
        lib = { ...loadJsonDir(path.join(ROOT, 'library')), ...loadJsonDir(path.join(repoDir, 'library')) };
      }
      return json(res, 200, lib);
    }
    if (req.method === 'GET' && pathname === '/api/printers') {
      let printers;
      try { printers = libMod && libMod.loadPrinters ? libMod.loadPrinters(path.join(ROOT, 'printers')) : loadJsonDir(path.join(ROOT, 'printers')); }
      catch { printers = loadJsonDir(path.join(ROOT, 'printers')); }
      return json(res, 200, printers);
    }
    if (req.method === 'GET' && pathname === '/api/projects') {
      return json(res, 200, { projectsDir: path.relative(repoDir, projectsDir) || '.', projects: await listProjects() });
    }
    if (req.method === 'GET' && pathname === '/api/templates') {
      return json(res, 200, { templates: [...listTemplates().keys()].filter((name) => NAME_RE.test(name) && !name.startsWith('.')).sort() });
    }
    if (req.method === 'POST' && pathname === '/api/projects') {
      const body = await readJsonBody(req);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80 || /[/\\\p{Cc}]/u.test(name)) return fail(res, 400, 'Enter a name of 1–80 characters without slashes or control characters.');
      const slug = projectSlug(name);
      if (RESERVED_FILENAME.test(slug) || slug.endsWith('.json') || !projectFile(slug)) return fail(res, 400, 'Choose a different project name.');
      const templateName = body.template;
      const template = typeof templateName === 'string' && NAME_RE.test(templateName) && !templateName.startsWith('.') && listTemplates().get(templateName);
      if (!template) return fail(res, 400, 'Choose an available template.');
      try { createProject(template, name, projectsDir); }
      catch (error) {
        if (error.code === 'EEXIST') return fail(res, 409, 'That project already exists. Choose a different name.');
        throw error;
      }
      return json(res, 201, { name: slug });
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 2000\n: connected\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const feedback = FEEDBACK_ROUTE.exec(pathname);
    if (feedback) {
      let raw;
      try { raw = decodeURIComponent(feedback[1]); } catch { return fail(res, 400, 'Bad project name'); }
      const pf = projectFile(raw);
      if (!pf) return fail(res, 400, 'Bad project name');
      const real = await safeResolve(projectsDir, `${pf.name}.json`);
      if (!real) return fail(res, 404, `No project "${pf.name}"`);
      const project = pf.name;
      const id = feedback[2];
      if (req.method === 'GET' && !id) return json(res, 200, { records: listFeedback(repoDir, { project, all: true }) });
      if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
      const body = await readJsonBody(req);
      try {
        if (!id) return json(res, 201, recordFeedback(repoDir, { project, original: body.original, correction: body.correction, evidence: body.evidence }));
        const ownRecord = listFeedback(repoDir, { project, all: true }).some((entry) => entry.id === id && entry.project === project);
        if (!ownRecord) return fail(res, 404, 'Correction not found in this project');
        return json(res, 200, reviewFeedback(repoDir, id, { status: body.status, scope: body.scope }));
      } catch (error) {
        if (error.code) throw error;
        return fail(res, 400, error.message);
      }
    }
    let m = /^\/api\/project\/([^/]+)$/.exec(pathname);
    if (m && req.method === 'GET') {
      let raw;
      try { raw = decodeURIComponent(m[1]); } catch { return fail(res, 400, 'Bad project name'); }
      const pf = projectFile(raw);
      if (!pf) return fail(res, 400, 'Bad project name');
      const real = await safeResolve(projectsDir, `${pf.name}.json`);
      if (!real) return fail(res, 404, `No project "${pf.name}"`);
      const text = await fsp.readFile(real, 'utf8');
      return send(res, 200, text, MIME['.json']);
    }
    m = /^\/api\/project\/([^/]+)\/wire(\/undo)?$/.exec(pathname);
    if (m && req.method === 'POST') {
      let raw;
      try { raw = decodeURIComponent(m[1]); } catch { return fail(res, 400, 'Bad project name'); }
      const pf = projectFile(raw);
      if (!pf) return fail(res, 400, 'Bad project name');
      const real = await safeResolve(projectsDir, `${pf.name}.json`);
      if (!real) return fail(res, 404, `No project "${pf.name}"`);
      const body = m[2] ? {} : await readJsonBody(req);
      try {
        const out = await editWires(real, pf.name, m[2] ? { op: 'undo' } : body);
        return json(res, 200, { ok: true, ...out });
      } catch (e) {
        if (e && e.status) return fail(res, e.status, e.message);
        throw e;
      }
    }
    m = /^\/api\/project\/([^/]+)\/state$/.exec(pathname);
    if (m && req.method === 'POST') {
      let raw;
      try { raw = decodeURIComponent(m[1]); } catch { return fail(res, 400, 'Bad project name'); }
      const pf = projectFile(raw);
      if (!pf) return fail(res, 400, 'Bad project name');
      const body = await readJsonBody(req);
      const real = await safeResolve(projectsDir, `${pf.name}.json`);
      if (!real) return fail(res, 404, `No project "${pf.name}"`);
      const changed = await updateState(real, body);
      return json(res, 200, { ok: true, changed });
    }
    if (pathname === '/api/apps' && req.method === 'GET') {
      // Desktop apps the overlay follows (slicers, CAD, electronics), with the
      // open file from the window title and the slicer's selected presets.
      const now = Date.now();
      if (!appsCache || now - appsCache.at > 2000) {
        const desk = await import('../lib/node/desktop.js');
        let apps = [], primary = null;
        try { ({ apps, primary } = await desk.detectWithFocus()); } catch { apps = []; }
        const slicers = {};
        for (const a of apps) if (a.kind === 'slicer') slicers[a.id] = desk.readSlicerSettings(a.id);
        appsCache = { at: now, body: { apps, primary, slicers } };
      }
      return json(res, 200, appsCache.body);
    }
    if (pathname === '/api/solidworks' && req.method === 'GET') {
      const sw = await import('../scripts/solidworks-session.mjs');
      const report = await sw.readSession();
      return json(res, 200, { ...sw.sessionStatus(report), status: report.status });
    }
    if (pathname === '/api/bambu' && req.method === 'GET') {
      const bambu = await import('../lib/node/bambu.js');
      return json(res, 200, bambu.bambuStatus(bambu.readBambuSession()));
    }
    if (pathname === '/api/chat/providers' && req.method === 'GET') {
      const { detectProviders } = await import('../lib/node/chat.js');
      return json(res, 200, await detectProviders(true));
    }
    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const question = String(body.question || '').trim().slice(0, 4000);
      if (!question) return fail(res, 400, 'Empty question');
      if (chatBusy) return fail(res, 429, 'Still answering the last question');
      const provider = ['claude', 'codex'].includes(body.provider) ? body.provider : 'auto';
      let projectFile = null;
      const name = typeof body.project === 'string' && /^[A-Za-z0-9._-]+$/.test(body.project) ? body.project : null;
      if (name) projectFile = await safeResolve(projectsDir, `${name}.json`);
      const { chat } = await import('../lib/node/chat.js');
      chatBusy = true;
      try {
        // Live SOLIDWORKS context, when the user allows it and SOLIDWORKS is open.
        let swContext = '';
        if (body.solidworks !== false) {
          const sw = await import('../scripts/solidworks-session.mjs');
          const report = await sw.readSession();
          if (report.status === 'active') swContext = sw.describeSession(report);
        }
        if (body.bambu !== false) {
          const bambu = await import('../lib/node/bambu.js');
          const report = bambu.readBambuSession();
          if (report.status !== 'unavailable') {
            const { loadPrinters } = await import('../lib/node/library.js');
            const printerLib = await import('../lib/printer.js');
            swContext = [swContext, bambu.describeBambu(report, loadPrinters(path.join(ROOT, 'printers')), printerLib)].filter(Boolean).join('\n');
          }
        }
        const out = await chat({
          question, project: name, projectFile, wiremapRoot: ROOT, cwd: repoDir,
          access: ['read', 'edit', 'full'].includes(body.access) ? body.access : 'read',
          step: String(body.step || '').slice(0, 600), selection: String(body.selection || '').slice(0, 300),
          context: [String(body.context || '').slice(0, 2000), swContext].filter(Boolean).join('\n'),
          history: Array.isArray(body.history) ? body.history.slice(-6).map((t) => ({ who: t?.who === 'you' ? 'you' : 'bot', text: String(t?.text || '') })) : [],
        }, provider);
        return json(res, 200, out);
      } catch (e) {
        return json(res, e.status || 500, { error: e.message, tried: e.tried || [] });
      } finally {
        chatBusy = false;
      }
    }
    if (pathname === '/api/inbox' && req.method === 'POST') {
      const body = await readJsonBody(req);
      return json(res, 200, await appendInboxEntry(body));
    }
    if (pathname === '/api/inbox' && req.method === 'GET') {
      if (inboxMod && inboxMod.readInbox) {
        try { return json(res, 200, { requests: await inboxMod.readInbox(repoDir) }); } catch { /* fall through */ }
      }
      const f = path.join(repoDir, '.wiremap', 'inbox.jsonl');
      const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
      const out = [];
      for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* skip */ } }
      return json(res, 200, { requests: out });
    }
    return fail(res, 404, 'Unknown API route');
  }

  async function handle(req, res) {
    if (!hostOk(req)) return fail(res, 403, 'Forbidden host');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return fail(res, 400, 'Bad URL'); }
    const pathname = url.pathname;
    if (req.method === 'POST') {
      if (!originOk(req)) return fail(res, 403, 'Forbidden origin');
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('application/json')) return fail(res, 415, 'Content-Type must be application/json');
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'Method not allowed');
    }

    if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
    if (req.method === 'POST') return fail(res, 405, 'Method not allowed');

    // Raw path check before URL normalisation hides "..": refuse outright.
    const rawPath = String(req.url).split('?')[0];
    if (/(^|\/)(\.|%2e){2}(\/|%2f|$)/i.test(rawPath) || /%2f|%5c|%00/i.test(rawPath)) return fail(res, 400, 'Bad path');

    for (const prefix of ['lib', 'library', 'printers', 'schema']) {
      if (pathname.startsWith(`/${prefix}/`)) {
        const real = await safeResolve(path.join(ROOT, prefix), pathname.slice(prefix.length + 2));
        if (!real) return fail(res, 404, 'Not found');
        return serveFile(res, real, req);
      }
    }
    if (pathname.startsWith('/files/')) {
      const sub = pathname.slice('/files/'.length);
      const first = sub.split('/')[0];
      if (!FILE_DIRS.includes(first)) return fail(res, 404, 'Only prints/ and cad/ files are served');
      const real = await safeResolve(repoDir, sub);
      if (!real || !FILE_EXTS.has(path.extname(real).toLowerCase())) return fail(res, 404, 'Not found');
      return serveFile(res, real, req);
    }
    const sub = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (sub === 'serve.mjs') return fail(res, 404, 'Not found');
    const real = await safeResolve(VIEWER_DIR, sub);
    if (!real) return fail(res, 404, 'Not found');
    return serveFile(res, real, req);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      fail(res, e && e.status ? e.status : 500, e && e.message ? e.message : 'Server error');
    });
  });
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4321, host, () => { server.off('error', reject); resolve(); });
  });
  port = server.address().port;
  const url = `http://localhost:${port}/`;

  const close = () => new Promise((resolve) => {
    clearInterval(poll);
    clearInterval(heartbeat);
    clearTimeout(debounce);
    if (watcher) watcher.close();
    for (const c of clients) c.end();
    clients.clear();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  return { server, url, port, close };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { port: 4321, projectsDir: null, open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7));
    else if (a === '--projects') out.projectsDir = argv[++i];
    else if (a.startsWith('--projects=')) out.projectsDir = a.slice(11);
    else if (a === '--open') out.open = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* no browser */ }
}

/**
 * CLI entry: parse args, start the server and keep running until SIGINT/SIGTERM.
 * @param {string[]} argv arguments after the command (e.g. ['--port', '4321'])
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node viewer/serve.mjs [--port 4321] [--projects ./projects] [--open]');
    return 0;
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    console.error('wiremap: --port must be a number between 0 and 65535');
    return 2;
  }
  const projectsDir = args.projectsDir ? path.resolve(process.cwd(), args.projectsDir) : path.join(ROOT, 'projects');
  let srv;
  try {
    srv = await startServer({ port: args.port, projectsDir });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') console.error(`wiremap: port ${args.port} is busy. Try --port ${args.port + 1}`);
    else console.error(`wiremap: ${e && e.message ? e.message : e}`);
    return 1;
  }
  console.log(`Wiremap viewer: ${srv.url}`);
  console.log(`Watching ${projectsDir}`);
  if (args.open) openBrowser(srv.url);
  return new Promise((resolve) => {
    const stop = () => { srv.close().then(() => resolve(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; process.exit(code); });
}
