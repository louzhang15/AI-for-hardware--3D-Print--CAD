import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { crc32 } from './threemf.js';
import { loadPrinters } from './library.js';
import { materialCheck } from '../printer.js';

const LIMIT = 2 * 1024 * 1024;
const settingsPath = 'Metadata/project_settings.config';
const slicesPath = 'Metadata/slice_info.config';

function readAt(fd, start, length, size) {
  if (start < 0 || length < 0 || start + length > size) throw new Error('Invalid 3MF archive offset.');
  const bytes = Buffer.alloc(length);
  if (readSync(fd, bytes, 0, length, start) !== length) throw new Error('The 3MF archive changed while reading.');
  return bytes;
}

function readMetadata(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailSize = Math.min(size, 65_557);
    const tail = readAt(fd, size - tailSize, tailSize, size);
    let end = tail.length - 22;
    while (end >= 0 && (tail.readUInt32LE(end) !== 0x06054b50
      || end + 22 + tail.readUInt16LE(end + 20) !== tail.length)) end--;
    if (end < 0) throw new Error('This file is not a complete 3MF archive.');
    const length = tail.readUInt32LE(end + 12);
    const start = tail.readUInt32LE(end + 16);
    if (length > LIMIT || start + length > size - tailSize + end) throw new Error('Unsupported 3MF directory.');
    const directory = readAt(fd, start, length, size);
    const found = new Map();
    for (let at = 0; at < directory.length;) {
      if (at + 46 > length || directory.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid 3MF directory.');
      const nameLength = directory.readUInt16LE(at + 28);
      const next = at + 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
      if (next > length) throw new Error('Truncated 3MF directory.');
      const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
      if (name === settingsPath || name === slicesPath) {
        const compressed = directory.readUInt32LE(at + 20);
        const expanded = directory.readUInt32LE(at + 24);
        const encoding = directory.readUInt16LE(at + 10);
        if (found.has(name) || compressed > LIMIT || expanded > LIMIT || ![0, 8].includes(encoding)
          || (directory.readUInt16LE(at + 8) & 1)) throw new Error('Unsupported Bambu metadata entry.');
        const offset = directory.readUInt32LE(at + 42);
        const local = readAt(fd, offset, 30, size);
        if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid 3MF metadata header.');
        const dataStart = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (dataStart + compressed > start) throw new Error('Invalid Bambu metadata range.');
        const raw = readAt(fd, dataStart, compressed, size);
        const bytes = encoding === 8 ? inflateRawSync(raw, { maxOutputLength: LIMIT }) : raw;
        if (bytes.length !== expanded || crc32(bytes) !== directory.readUInt32LE(at + 16)) throw new Error('Damaged Bambu metadata.');
        found.set(name, bytes.toString('utf8'));
      }
      if (found.size === 2) break;
      at = next;
    }
    return found;
  } finally {
    closeSync(fd);
  }
}

function recentProject(conf) {
  if (!conf) return null;
  try {
    if (statSync(conf).size > LIMIT) return null;
    const data = JSON.parse(readFileSync(conf, 'utf8').replace(/^\uFEFF/, '').replace(/^#.*$/gm, ''));
    let best = null;
    for (const file of Object.values(data.recent_projects || {})) {
      if (typeof file !== 'string' || !/\.3mf$/i.test(file)) continue;
      try {
        const info = statSync(file);
        if (info.isFile() && (!best || info.mtimeMs > best.time)) best = { file, time: info.mtimeMs };
      } catch { /* Ignore missing recent files. */ }
    }
    return best?.file || null;
  } catch {
    return null;
  }
}

const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
const attributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
  .map(([, key, dq, sq]) => [key, (dq ?? sq).replace(/&(amp|quot|apos|lt|gt);/g, (_, name) => entities[name])]));
const number = (value) => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

function plateResults(xml) {
  return [...xml.matchAll(/<plate\b[^>]*>([\s\S]*?)<\/plate>/g)].slice(0, 32).map(([, plate]) => {
    const fields = Object.fromEntries([...plate.matchAll(/<metadata\b[^>]*>/g)]
      .map(([tag]) => attributes(tag)).map(({ key, value }) => [key, value]));
    const warnings = new Map();
    for (const [tag] of plate.matchAll(/<warning\b[^>]*>/g)) {
      const { msg, error_code: code } = attributes(tag);
      if (!msg && !code) continue;
      const message = (msg || code).slice(0, 260);
      warnings.set(message, { message, code: code?.slice(0, 32) || null });
      if (warnings.size >= 12) break;
    }
    return {
      index: number(fields.index), seconds: number(fields.prediction), grams: number(fields.weight),
      outside: fields.outside === 'true', supportsUsed: fields.support_used === 'true',
      warnings: [...warnings.values()],
    };
  });
}

export function readBambuSession({ file = process.env.WIREMAP_BAMBU_FILE, conf = process.env.WIREMAP_BAMBU_CONF
  || (process.env.APPDATA && join(process.env.APPDATA, 'BambuStudio', 'BambuStudio.conf')) } = {}) {
  const saved = file || recentProject(conf);
  if (!saved) return { status: 'unavailable', message: 'Save a Bambu Studio project as 3MF to include its settings.' };
  const name = basename(saved);
  try {
    if (!/\.3mf$/i.test(saved)) throw new Error('Select a saved 3MF project.');
    const metadata = readMetadata(saved);
    if (!metadata.has(settingsPath)) return { status: 'unavailable', message: 'This 3MF has no saved Bambu Studio print settings.' };
    const data = JSON.parse(metadata.get(settingsPath));
    const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value) ? String(value).slice(0, 160) : null;
    const items = (value) => (Array.isArray(value) ? value : [value]).slice(0, 16).map(scalar).filter(Boolean);
    const printer = scalar(data.printer_settings_id) || scalar(data.printer_model);
    const model = /\b(a1 mini|a1|p1s|p2s|x1 carbon|x1c|h2d)\b/i.exec(printer || '')?.[0].toLowerCase();
    const suffix = ({ 'a1 mini': 'a1-mini', 'x1 carbon': 'x1c' })[model] || model;
    const profile = suffix && loadPrinters()[`bambu-${suffix}`];
    const filament = items(data.filament_type);
    const materialWarnings = profile
      ? filament.map((material) => materialCheck(material, profile)).filter(({ status }) => ['no', 'warn'].includes(status))
      : [];
    return {
      status: 'saved', file: name, printer,
      nozzle: items(data.nozzle_diameter), filament, materialWarnings, layer: scalar(data.layer_height),
      walls: scalar(data.wall_loops), infill: scalar(data.sparse_infill_density), bed: scalar(data.curr_bed_type),
      supports: scalar(data.enable_support), plates: plateResults(metadata.get(slicesPath) || ''),
    };
  } catch (error) {
    return { status: 'unavailable', message: error instanceof SyntaxError || error.code
      ? 'Could not read the saved Bambu Studio project.' : error.message };
  }
}

export function describeBambu(report) {
  if (report.status !== 'saved') return report.message;
  const settings = [
    report.printer, report.nozzle.length && !(report.nozzle.length === 1 && report.printer?.includes(`${report.nozzle[0]} nozzle`))
      ? `${report.nozzle.join('/')} mm nozzle` : null,
    report.filament.join(', '), report.layer ? `${report.layer} mm layers` : null, report.walls ? `${report.walls} walls` : null,
    report.infill ? `${report.infill} infill` : null, report.bed,
    report.supports === '1' || report.supports === '0' ? `supports ${report.supports === '1' ? 'on' : 'off'}` : null,
  ].filter(Boolean);
  const plates = report.plates.map((plate, i) => {
    const stats = [plate.seconds != null ? `${Math.floor(plate.seconds / 60)}m ${plate.seconds % 60}s` : null,
      plate.grams != null ? `${plate.grams} g` : null, plate.outside ? 'object outside the bed' : null].filter(Boolean);
    if (plate.warnings.length) stats.push(`Slicer warnings: ${plate.warnings.map(({ message }) =>
      message === 'not_support_traditional_timelapse' ? 'Traditional timelapse is unavailable for this plate' : message).join('; ')}`);
    return `Plate ${plate.index ?? i + 1}: ${stats.join(', ') || 'sliced'}`;
  });
  const warnings = report.materialWarnings.map(({ material, reason }) => `Wiremap material check for ${material}: ${reason}`);
  return [`Saved Bambu Studio project: ${report.file}`, settings.join(' · '), ...warnings,
    ...(plates.length ? plates : ['No saved slicing results.'])].filter(Boolean).join('\n');
}
