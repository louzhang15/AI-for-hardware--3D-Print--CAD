import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDiagnosticLog } from '../viewer/companion-log.js';

const file = (contents) => Object.assign(new Blob([contents]), { name: 'robot.log' });

test('diagnostic log preview preserves text and reads Windows UTF-16 files', async () => {
  const source = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('INFO connected\r\nWARN motor café\r\n', 'utf16le')]);
  assert.deepEqual(await readDiagnosticLog(file(source)), {
    name: 'robot.log',
    text: 'INFO connected\nWARN motor café',
    truncated: false,
  });
});

test('diagnostic log reader keeps the recent tail without reading the whole file', async () => {
  const source = file('first line\n' + 'x'.repeat(150_000) + '\nERROR motor timed out');
  const reads = [];
  const recording = {
    size: source.size,
    name: source.name,
    slice(start, end) { reads.push([start, end]); return source.slice(start, end); },
  };
  const result = await readDiagnosticLog(recording);
  assert.equal(result.text.length, 12_000);
  assert.ok(result.text.endsWith('\nERROR motor timed out'));
  assert.equal(result.truncated, true);
  assert.deepEqual(reads, [[0, 3], [source.size - 64 * 1024, undefined]]);

  const unicode = await readDiagnosticLog(file('A😀' + 'x'.repeat(11_999)));
  assert.equal(unicode.text, 'x'.repeat(11_999));
  assert.equal(unicode.truncated, true);
});

test('empty and binary diagnostic attachments are rejected', async () => {
  await assert.rejects(readDiagnosticLog(file('  \n')), /empty/i);
  await assert.rejects(readDiagnosticLog(file(Buffer.from([0x41, 0, 0x43]))), /plain-text/i);
});

test('preview sends masked text and no generated findings', async () => {
  const attachment = await readDiagnosticLog(file('INFO api_key=private-123\nERROR brownout'));
  assert.deepEqual(attachment, {
    name: 'robot.log',
    text: 'INFO api_key=[redacted]\nERROR brownout',
    truncated: false,
  });
});
