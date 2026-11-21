import { prepareLogEvidence } from '../lib/diagnostic-logs.js';

const maxBytes = 64 * 1024;

/** Read only the end of a user-selected text log and keep the most recent messages. */
export async function readDiagnosticLog(file) {
  const prefix = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  const utf16 = prefix[0] === 0xff && prefix[1] === 0xfe ? 'utf-16le'
    : prefix[0] === 0xfe && prefix[1] === 0xff ? 'utf-16be' : null;
  let offset = Math.max(0, file.size - maxBytes);
  if (utf16 && offset % 2) offset++;
  const bytes = await file.slice(offset).arrayBuffer();
  const text = new TextDecoder(utf16 || 'utf-8').decode(bytes).replace(/\r\n?/g, '\n');
  if (text.includes('\0')) throw new Error('Choose a plain-text log. Export binary recordings to text first.');
  const evidence = prepareLogEvidence({ name: file.name, text, truncated: offset > 0 });
  if (!evidence) throw new Error('This log is empty.');
  return { name: evidence.name, text: evidence.text.replace(/^[\udc00-\udfff]/, ''), truncated: evidence.truncated };
}
