import { spawnSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

const LOG_LIMIT = 256 * 1024;
const helper = fileURLToPath(new URL('./serial-log.ps1', import.meta.url));
const HELP = `Usage:
  wiremap serial-log --list
  wiremap serial-log --port COM3 [--baud 115200] [--seconds 5]
  wiremap serial-log --file saved-log.txt

Lists Windows COM ports or reads UTF-8 log output for 1–30 seconds (8N1).
Capture sends no bytes and requests DTR and RTS off. Some boards may still
reset when their port opens. Close other serial monitors before capturing.
On any platform --file reads the last 256 KiB of an existing text log.`;

const cleanLog = (text) => stripVTControlCharacters(text).replace(/^\uFEFF/, '')
  .replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');

function readLogFile(path) {
  if (!statSync(path).isFile()) throw new Error('Select a regular text log file.');
  const fd = openSync(path, 'r');
  try {
    const { size } = fstatSync(fd);
    const bom = Buffer.alloc(2);
    readSync(fd, bom, 0, 2, 0);
    const utf16 = bom[0] === 0xff && bom[1] === 0xfe;
    const start = Math.max(0, size - LOG_LIMIT);
    const offset = utf16 ? start + (start % 2) : start;
    const bytes = Buffer.alloc(size - offset);
    const length = readSync(fd, bytes, 0, bytes.length, offset);
    const text = bytes.subarray(0, length).toString(utf16 ? 'utf16le' : 'utf8');
    return { text: cleanLog(text), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

function integer(value, fallback, description, min, max) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${description} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

export async function main(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      list: { type: 'boolean' }, port: { type: 'string' }, baud: { type: 'string' },
      seconds: { type: 'string' }, file: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
      console.log(HELP);
      return 0;
    }
    if ([values.list, values.port !== undefined, values.file !== undefined].filter(Boolean).length !== 1) {
      throw new Error('Choose one of --list, --port COM3, or --file saved-log.txt.');
    }
    if ((values.baud !== undefined || values.seconds !== undefined) && values.port === undefined) {
      throw new Error('--baud and --seconds are for live serial capture only.');
    }
    if (values.file !== undefined) {
      const log = readLogFile(values.file);
      process.stdout.write(log.text);
      if (log.truncated) console.error('Showing the last 256 KiB of the file.');
      if (!log.text.trim()) console.error('No readable log text found.');
      return log.text.trim() ? 0 : 1;
    }
    if (values.port !== undefined && !/^COM[1-9][0-9]{0,4}$/i.test(values.port)) {
      throw new Error('Specify a Windows COM port such as COM3.');
    }
    const baud = integer(values.baud, 115200, 'Baud rate', 300, 4_000_000);
    const seconds = integer(values.seconds, 5, 'Capture duration', 1, 30);
    if (process.platform !== 'win32') {
      console.error('Live serial capture uses Windows COM ports. On this host, use --file with a saved serial log.');
      return 1;
    }
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = values.list ? ['-List'] : ['-Port', values.port.toUpperCase(), '-Baud', String(baud), '-Seconds', String(seconds)];
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, ...args], {
      maxBuffer: LOG_LIMIT + 64 * 1024, timeout: (seconds + 5) * 1000, windowsHide: true,
    });
    const log = cleanLog(result.stdout?.toString('utf8') || '');
    process.stdout.write(log);
    if (result.error || result.status !== 0) {
      console.error(values.list ? 'Could not list Windows COM ports.' : `Could not complete capture on ${values.port.toUpperCase()}. Check the port and close other serial monitors.`);
      return 1;
    }
    if (result.stderr?.length) process.stderr.write(cleanLog(result.stderr.toString('utf8')));
    if (!log.trim()) {
      console.error(values.list ? 'No Windows COM ports found.' : 'No readable serial text received. Check the port, baud rate, and whether the firmware is logging.');
      return values.list ? 0 : 1;
    }
    return 0;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
