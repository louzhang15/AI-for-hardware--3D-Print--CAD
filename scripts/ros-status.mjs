import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const maxLogBytes = 128 * 1024;
const maxRecent = 20;
const levels = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR', 50: 'FATAL' };
const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;
const topicName = /^(?:\/[A-Za-z_][A-Za-z0-9_]*)+$/;
const usage = `Usage:
  wiremap ros-status [--topic /imu/data [--sample]] [--timeout 5] [--json]
  wiremap ros-status --file <.log|.txt|.json|.jsonl> [--json]

Inspect the ROS 2 graph in the current ROS environment. An explicit --sample
subscribes to one message from the named topic. Log import works without ROS
and extracts recent evidence from launch logs or JSON rosout records.`;

function text(value, limit = 600) {
  return typeof value === 'string' ? value.replace(ansi, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, limit) : '';
}

function levelOf(value) {
  const label = text(value).toUpperCase();
  if ((typeof value === 'number' || typeof value === 'string') && Object.hasOwn(levels, value)) return levels[value];
  if (label === 'WARNING') return 'WARN';
  return Object.values(levels).includes(label) ? label : 'UNKNOWN';
}

function jsonEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = text(value.msg ?? value.message);
  if (!message) return null;
  const sec = value.stamp?.sec;
  const nanos = value.stamp?.nanosec;
  const timestamp = Number.isInteger(sec) && Number.isInteger(nanos)
    ? `${sec}.${Number(nanos).toString().padStart(9, '0')}` : text(value.timestamp ?? value.time, 80);
  return { level: levelOf(value.level ?? value.severity), logger: text(value.name ?? value.logger, 120), timestamp, message };
}

function consoleEntry(line) {
  const row = text(line, 1200);
  if (!row) return null;
  const match = /^\s*(?:\[[^\]]+\]\s+)?\[\s*(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\s*\]\s*(?:\[([+-]?\d+(?:\.\d+)?)\]\s*)?(?:\[([^\]]+)\]\s*:?)?\s*(.*)$/i.exec(row);
  if (!match) return { level: 'UNKNOWN', logger: '', timestamp: '', message: row.slice(0, 600) };
  return { level: levelOf(match[1]), logger: text(match[3], 120), timestamp: match[2] || '', message: text(match[4]) };
}

function logTail(file) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const status = fstatSync(fd);
    if (!status.isFile()) throw new Error('Choose a regular ROS log file.');
    const { size } = status;
    const header = Buffer.alloc(2);
    readSync(fd, header, 0, 2, 0);
    const utf16 = header[0] === 0xff && header[1] === 0xfe;
    const bigEndian = header[0] === 0xfe && header[1] === 0xff;
    let start = Math.max(0, size - maxLogBytes);
    if ((utf16 || bigEndian) && start % 2) start++;
    const buffer = Buffer.alloc(size - start);
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const used = buffer.subarray(0, utf16 || bigEndian ? length - (length % 2) : length);
    if (bigEndian) used.swap16();
    let content = used.toString(utf16 || bigEndian ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
    if (content.includes('\0')) throw new Error('Choose a UTF-8 or UTF-16 text log or JSON export.');
    if (start) {
      // Discard the first entry only if the bounded read begins inside a line.
      const separator = Buffer.alloc(utf16 || bigEndian ? 2 : 1);
      readSync(fd, separator, 0, separator.length, start - separator.length);
      if (separator[bigEndian ? 1 : 0] !== 10) {
        const next = content.indexOf('\n');
        content = next >= 0 ? content.slice(next + 1) : '';
      }
    }
    return { content, truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

export function inspectRosLog(file) {
  const { content, truncated } = logTail(file);
  const type = extname(file).toLowerCase();
  const counts = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0, UNKNOWN: 0 };
  const entries = [];
  let skipped = 0;
  const add = (entry) => {
    if (!entry) { skipped++; return; }
    counts[entry.level]++;
    entries.push(entry);
  };
  if (type === '.json') {
    if (truncated) throw new Error('This JSON log is too large to read in full. Export JSONL or plain text for a bounded tail.');
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error('Invalid JSON log. Expected a rosout record, an array, or an object with a messages array.'); }
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.messages) ? parsed.messages : [parsed];
    for (const row of records) add(jsonEntry(row));
  } else {
    for (const row of content.split(/\r?\n/)) {
      if (!row.trim()) continue;
      if (type === '.jsonl' || type === '.ndjson') {
        let value;
        try { value = JSON.parse(row); } catch { /* Count malformed lines below. */ }
        add(jsonEntry(value));
      } else add(consoleEntry(row));
    }
  }
  return {
    source: basename(file), truncated, sampledEntries: entries.length, counts, skipped,
    recent: entries.slice(-maxRecent),
    issues: entries.filter(({ level }) => ['WARN', 'ERROR', 'FATAL'].includes(level)).slice(-maxRecent),
  };
}

function runRosCommand(args, timeoutMs) {
  return new Promise((done) => {
    execFile('ros2', args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return done({ ok: true, output: text(stdout, 200_000), warning: text(stderr) });
      let message = text(stderr) || text(stdout, 600) || 'ROS 2 exited without data.';
      if (error.code === 'ENOENT') message = 'ROS 2 CLI is unavailable. Run this command inside a sourced ROS 2 environment, or pass --file with an exported log.';
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') message = 'ROS 2 output exceeded the capture limit.';
      else if (error.killed) message = 'ROS 2 did not return data before the timeout.';
      done({ ok: false, error: message });
    });
  });
}

export async function inspectRosGraph({ topic, sample = false, timeoutMs = 5000, run = runRosCommand } = {}) {
  if (topic && !topicName.test(topic)) throw new Error('Use an absolute ROS topic name such as /imu/data.');
  if (sample && !topic) throw new Error('--sample requires --topic.');
  const commands = {
    nodes: ['node', 'list', '--no-daemon'],
    topics: ['topic', 'list', '-t', '--no-daemon'],
    ...(topic ? { endpoint: ['topic', 'info', '--verbose', '--no-daemon', topic] } : {}),
    ...(sample ? { sample: ['topic', 'echo', '--once', '--no-daemon', topic] } : {}),
  };
  const results = Object.fromEntries(await Promise.all(Object.entries(commands).map(async ([key, args]) => [key, await run(args, timeoutMs)])));
  const endpoint = results.endpoint?.output || null;
  const publisher = endpoint?.match(/^Publisher count: (\d+)/m)?.[1];
  const subscriber = endpoint?.match(/^Subscription count: (\d+)/m)?.[1];
  return {
    distro: process.env.ROS_DISTRO || null, domainId: process.env.ROS_DOMAIN_ID || '0',
    nodes: results.nodes.output?.split('\n').map((line) => line.trim()).filter((line) => topicName.test(line)) || [],
    topics: [...(results.topics.output || '').matchAll(/^(\/\S+)\s+\[([^\]]*)\]\s*$/gm)]
      .map(([, name, types]) => ({ name, types: types.split(',').map((type) => type.trim()).filter(Boolean) })),
    ...(topic ? {
      topic,
      endpoint,
      publisherCount: publisher === undefined ? null : Number(publisher),
      subscriberCount: subscriber === undefined ? null : Number(subscriber),
    } : {}),
    ...(sample ? { sample: results.sample.output || null } : {}),
    warnings: Object.entries(results).flatMap(([source, result]) => result.warning ? [{ source, message: result.warning }] : []),
    failures: Object.entries(results).flatMap(([source, result]) => !result.ok ? [{ source, message: result.error }] : []),
  };
}

function printLog(report) {
  console.log(`ROS log: ${report.source} · ${report.sampledEntries} entries${report.truncated ? ' (bounded tail)' : ''}`);
  console.log(Object.entries(report.counts).map(([level, count]) => `${level} ${count}`).join(' · '));
  if (report.skipped) console.log(`Skipped ${report.skipped} invalid or non-log records.`);
  const entries = report.issues.length ? report.issues : report.recent;
  for (const row of entries) console.log([row.level, row.timestamp, row.logger, row.message].filter(Boolean).join(' · '));
}

function printGraph(report) {
  console.log(`ROS 2 graph · domain ${report.domainId}${report.distro ? ` · ${report.distro}` : ''}`);
  if (!report.failures.some(({ source }) => source === 'nodes')) console.log(`Nodes: ${report.nodes.join(', ') || '(none discovered)'}`);
  if (!report.failures.some(({ source }) => source === 'topics')) {
    if (!report.topics.length) console.log('Topics: (none discovered)');
    for (const topic of report.topics) console.log(`${topic.name} [${topic.types.join(', ')}]`);
  }
  if (report.endpoint) console.log(report.endpoint);
  if (report.sample) console.log(`Sample from ${report.topic}:\n${report.sample}`);
  for (const detail of [...report.warnings, ...report.failures]) console.log(`${detail.source}: ${detail.message}`);
}

export async function main(argv) {
  let options;
  try {
    ({ values: options } = parseArgs({ args: argv, options: {
      file: { type: 'string' }, topic: { type: 'string' }, timeout: { type: 'string' },
      sample: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } }));
    if (options.help) { console.log(usage); return 0; }
    if (options.file !== undefined && (!options.file || options.topic !== undefined || options.sample || options.timeout !== undefined)) {
      throw new Error('--file is an offline mode and cannot be combined with live options.');
    }
    if (options.topic !== undefined && !topicName.test(options.topic)) throw new Error('Use an absolute topic name such as /imu/data.');
    if (options.sample && !options.topic) throw new Error('--sample requires --topic.');
    const seconds = Number(options.timeout ?? 5);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('--timeout must be a whole number of seconds from 1 to 30.');
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  try {
    const report = options.file ? inspectRosLog(options.file)
      : await inspectRosGraph({ topic: options.topic, sample: options.sample, timeoutMs: Number(options.timeout ?? 5) * 1000 });
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else if (options.file) printLog(report);
    else printGraph(report);
    return report.failures?.length ? 1 : 0;
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ error: error.message }));
    else console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
