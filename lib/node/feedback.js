import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ID = /^f-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const PROJECT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;
const MAX_TEXT = 4000;
const REVIEW_STATUSES = ['approved', 'dismissed'];
const SCOPES = ['project', 'workspace'];

export function feedbackPath(dir = process.cwd()) {
  return join(dir, '.wiremap', 'feedback.jsonl');
}

function projectName(value) {
  if (typeof value !== 'string') throw new Error('A project name is required.');
  const input = value.trim();
  // Bare viewer names are case-sensitive and may end in .json themselves.
  const name = /[\\/]/.test(input) ? input.match(/(?:^|[\\/])([^\\/]+)\.json$/)?.[1] : input;
  if (!name || !PROJECT.test(name)) throw new Error('Use a project name or a path ending in a project .json filename.');
  return name;
}

function textField(value, label, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (!optional && !text) throw new Error(`${label} is required.`);
  if (text.length > MAX_TEXT) throw new Error(`${label} must be at most ${MAX_TEXT} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) {
    throw new Error(`${label} contains an unsupported control character.`);
  }
  return text;
}

function fields(input) {
  return {
    project: projectName(input?.project),
    original: textField(input?.original, 'Original'),
    correction: textField(input?.correction, 'Correction'),
    evidence: textField(input?.evidence, 'Evidence', true),
  };
}

function appendFeedback(dir, event) {
  const file = feedbackPath(dir);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a+', 0o600);
  try {
    const size = fstatSync(fd).size;
    const lastByte = Buffer.alloc(1);
    // Separate a previously interrupted write from the next complete event.
    const needsSeparator = size > 0 && readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 10;
    appendFileSync(fd, `${needsSeparator ? '\n' : ''}${JSON.stringify(event)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function readFeedback(dir) {
  let contents;
  try {
    contents = readFileSync(feedbackPath(dir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }

  const byId = new Map();
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (typeof event?.id !== 'string' || !ID.test(event.id) ||
          typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts))) continue;
      const { id, ts } = event;
      if (event.type === 'record' && !byId.has(id)) {
        byId.set(id, { id, ts, ...fields(event), status: 'pending', scope: 'project' });
      } else if (event.type === 'review' && byId.has(id) && REVIEW_STATUSES.includes(event.status) && SCOPES.includes(event.scope)) {
        byId.set(id, { ...byId.get(id), status: event.status, scope: event.scope, reviewedAt: ts });
      }
    } catch {
      // A malformed or interrupted event cannot replace earlier valid history.
    }
  }
  return byId;
}

export function recordFeedback(dir, input) {
  const record = {
    id: `f-${randomUUID()}`, ts: new Date().toISOString(), ...fields(input), status: 'pending', scope: 'project',
  };
  appendFeedback(dir, { type: 'record', ...record });
  return record;
}

export function listFeedback(dir, { project, all = false } = {}) {
  const name = project === undefined ? null : projectName(project);
  return [...readFeedback(dir).values()].reverse().filter((record) => {
    if (all && (name === null || record.project === name)) return true;
    return record.status === 'approved' && (record.scope === 'workspace' || record.project === name);
  });
}

export function reviewFeedback(dir, id, { status, scope = 'project' } = {}) {
  if (!REVIEW_STATUSES.includes(status)) throw new Error('Review status must be approved or dismissed.');
  if (!SCOPES.includes(scope)) throw new Error('Review scope must be project or workspace.');
  const record = readFeedback(dir).get(id);
  if (!record) throw new Error(`Unknown feedback id: ${id}`);
  const ts = new Date().toISOString();
  appendFeedback(dir, { type: 'review', id, ts, status, scope });
  return { ...record, status, scope, reviewedAt: ts };
}
