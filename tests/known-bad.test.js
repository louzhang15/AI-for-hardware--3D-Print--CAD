// Known-bad design suite (PRD: "a checker regression blocks the release").
// Each tests/known-bad/*.json is a project with one seeded mistake, built from
// real library parts, plus `expect`: the rule and level that must be reported.
// The suite also requires every reference project in projects/ to pass with
// 0 errors, and reports the catch rate (target >= 90%; we require 100%).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProject } from '../lib/check.js';
import { loadLibrary } from '../lib/node/library.js';

const here = dirname(fileURLToPath(import.meta.url));
const library = loadLibrary();
const dir = join(here, 'known-bad');
const cases = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

test('known-bad suite is not empty', () => assert.ok(cases.length >= 15, `only ${cases.length} cases`));

let caught = 0;
for (const f of cases) {
  test(`known-bad: ${f}`, () => {
    const project = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const res = checkProject(project, library);
    const structural = res.issues.filter((i) => ['schema', 'unknown-library-part', 'unknown-endpoint'].includes(i.rule));
    assert.deepEqual(structural, [], 'fixture itself must be well-formed');
    for (const e of project.expect) {
      const hit = res.issues.find((i) => i.rule === e.rule && i.level === e.level &&
        (!e.pins || e.pins.every((p) => i.pins.includes(p))) && (!e.wires || e.wires.every((w) => i.wires.includes(w))));
      assert.ok(hit, `${f}: expected ${e.level} ${e.rule}; got:\n${res.issues.map((i) => `  ${i.level} ${i.rule}: ${i.message}`).join('\n')}`);
    }
    caught++;
  });
}

test('catch rate', () => {
  assert.equal(caught, cases.length, `caught ${caught}/${cases.length}`);
});

for (const f of readdirSync(join(here, '..', 'projects')).filter((x) => x.endsWith('.json'))) {
  test(`reference project passes: ${f}`, () => {
    const project = JSON.parse(readFileSync(join(here, '..', 'projects', f), 'utf8'));
    const res = checkProject(project, library);
    assert.equal(res.errors, 0, res.issues.filter((i) => i.level === 'error').map((i) => i.message).join('\n'));
    const wired = new Set((project.steps || []).flatMap((s) => s.wires || []));
    const missing = (project.wires || []).filter((w) => !wired.has(w.id)).map((w) => w.id);
    assert.deepEqual(missing, [], 'every wire is highlighted in at least one build step');
  });
}
