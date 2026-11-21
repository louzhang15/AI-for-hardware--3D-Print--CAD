// Node-only: the viewer -> AI inbox at <dir>/.wiremap/inbox.jsonl.
// Append-only JSON lines. A request line:
//   {id, ts, kind, project, target:{type,id}, text, status:'pending'}
// A status line (never rewrites history):
//   {type:'status', id, ts, status:'done'|'pending'|'dismissed', note}
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const INBOX_KINDS = ['explain', 'fix', 'swap', 'stuck', 'ask'];
export const TARGET_TYPES = ['wire', 'part', 'pin', 'step', 'issue', 'project', 'print'];
export const STATUSES = ['pending', 'done', 'dismissed'];
export const COMPANION_TARGET = 'project:companion';
const MAX_TEXT = 4000;

export function isCompanionRequest(request) {
  return request?.kind === 'ask' && request.target?.type === 'project' && request.target.id === 'companion';
}

export function inboxPath(dir = process.cwd()) {
  return join(dir, '.wiremap', 'inbox.jsonl');
}

function newId() {
  return `r-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function append(dir, obj) {
  const file = inboxPath(dir);
  mkdirSync(join(dir, '.wiremap'), { recursive: true });
  // One write per line keeps appends from different processes whole.
  appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

/** Parse "wire:w5" into {type:'wire', id:'w5'}. */
export function parseTarget(s) {
  if (s && typeof s === 'object') return { type: String(s.type || ''), id: String(s.id ?? '') };
  const str = String(s || '');
  const i = str.indexOf(':');
  if (i < 0) return { type: str, id: '' };
  return { type: str.slice(0, i), id: str.slice(i + 1) };
}

/**
 * Validate and append a request. Fills id, ts and status. Returns the stored request.
 * Throws on a bad kind, target type or empty request.
 */
export function appendInbox(dir, request) {
  const r = request || {};
  const kind = String(r.kind || '');
  if (!INBOX_KINDS.includes(kind)) throw new Error(`Inbox kind must be one of ${INBOX_KINDS.join(', ')} (got "${kind}")`);
  const target = r.target === undefined || r.target === null ? null : parseTarget(r.target);
  if (target && !TARGET_TYPES.includes(target.type)) throw new Error(`Inbox target type must be one of ${TARGET_TYPES.join(', ')} (got "${target.type}")`);
  const text = String(r.text ?? '').slice(0, MAX_TEXT);
  if (!text && !target) throw new Error('Inbox request needs a target or some text');
  const stored = {
    id: typeof r.id === 'string' && /^[\w.-]{1,64}$/.test(r.id) ? r.id : newId(),
    ts: new Date().toISOString(),
    kind,
    project: r.project ? String(r.project) : null,
    target,
    text,
    status: 'pending',
  };
  if (r.evidence) stored.evidence = r.evidence;
  append(dir, stored);
  return stored;
}

/** Append a status line for a request. Throws if the id is unknown. */
export function markInbox(dir, id, status = 'done', note) {
  if (!STATUSES.includes(status)) throw new Error(`Status must be one of ${STATUSES.join(', ')}`);
  const items = readInbox(dir);
  if (!items.some((x) => x.id === id)) throw new Error(`No inbox request with id "${id}"`);
  const line = { type: 'status', id, ts: new Date().toISOString(), status };
  if (note) line.note = String(note).slice(0, MAX_TEXT);
  append(dir, line);
  return line;
}

/**
 * Read the inbox: every request with its current status folded in, plus its
 * status history. Bad lines are skipped (reported in `readInbox.lastErrors`).
 * @param {string} [dir]
 * @param {{pendingOnly?: boolean}} [opts]
 */
export function readInbox(dir = process.cwd(), opts = {}) {
  const file = inboxPath(dir);
  if (!existsSync(file)) return [];
  const byId = new Map();
  const errors = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { errors.push(`line ${i + 1}: not JSON`); return; }
    if (!obj || typeof obj.id !== 'string') { errors.push(`line ${i + 1}: no id`); return; }
    if (obj.type === 'status') {
      const req = byId.get(obj.id);
      if (!req) { errors.push(`line ${i + 1}: status for unknown id ${obj.id}`); return; }
      req.status = obj.status;
      req.history.push({ ts: obj.ts, status: obj.status, note: obj.note });
      if (obj.note) req.note = obj.note;
      return;
    }
    if (byId.has(obj.id)) { errors.push(`line ${i + 1}: duplicate id ${obj.id}`); return; }
    byId.set(obj.id, { ...obj, status: obj.status || 'pending', history: [] });
  });
  readInbox.lastErrors = errors;
  const all = [...byId.values()];
  return opts.pendingOnly ? all.filter((x) => x.status === 'pending') : all;
}
/** @type {string[]} */
readInbox.lastErrors = [];
