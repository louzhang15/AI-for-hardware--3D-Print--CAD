// Node-only: Bambu Studio awareness. Bambu Studio has no plugin API, so this
// reads what it writes to disk:
//   - the project .3mf (a zip): print settings, objects, and after slicing,
//     time, filament use and slicer warnings per plate
//   - BambuStudio.conf: recent projects (to find the one that is open) and the
//     selected printer and filament presets
// No network access and no account needed.
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_ENTRY = 40 * 1024 * 1024;

// ------------------------------------------------------------------ zip

/** Read selected entries of a zip file. Returns {name: Buffer}. */
export function readZip(file, want = () => true) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOff);
    const out = {};
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const compSize = cd.readUInt32LE(p + 20);
      const rawSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (!want(name) || compSize === 0xffffffff || rawSize > MAX_ENTRY) continue;
      const lh = Buffer.alloc(30);
      readSync(fd, lh, 0, 30, local);
      if (lh.readUInt32LE(0) !== 0x04034b50) continue;
      const dataStart = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(compSize);
      readSync(fd, data, 0, compSize, dataStart);
      if (method === 0) out[name] = data;
      else if (method === 8) out[name] = inflateRawSync(data);
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------------ 3MF

const first = (v) => (Array.isArray(v) ? v[0] : v);
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return m ? m[1] : undefined;
};

export const PRINTER_IDS = [
  [/a1 ?mini/i, 'bambu-a1-mini'], [/\bA1\b/i, 'bambu-a1'], [/p1s/i, 'bambu-p1s'], [/p1p/i, 'bambu-p1s'],
  [/p2s/i, 'bambu-p2s'], [/x1/i, 'bambu-x1c'], [/h2d/i, 'bambu-h2d'],
];
export function printerProfileId(model) {
  const hit = PRINTER_IDS.find(([re]) => re.test(String(model || '')));
  return hit ? hit[1] : null;
}

/** Read a Bambu Studio project (.3mf). */
export function readBambu3mf(file) {
  const z = readZip(file, (n) => /^Metadata\/(project_settings|slice_info|model_settings)\.config$/.test(n) || /^3D\/.*\.model$/.test(n));
  const report = { file, savedAt: statSync(file).mtime.toISOString(), settings: {}, plates: [], objects: [], sizeMm: null };
  const ps = z['Metadata/project_settings.config'];
  if (ps) {
    try {
      const j = JSON.parse(ps.toString('utf8'));
      const pick = (k) => (j[k] === undefined ? undefined : first(j[k]));
      report.settings = {
        printer: pick('printer_model') || pick('printer_settings_id'), printerPreset: pick('printer_settings_id'),
        processPreset: pick('print_settings_id'), nozzle: pick('nozzle_diameter'),
        bedType: pick('curr_bed_type'), layerHeight: pick('layer_height'), initialLayer: pick('initial_layer_print_height'),
        walls: pick('wall_loops'), topLayers: pick('top_shell_layers'), bottomLayers: pick('bottom_shell_layers'),
        infill: pick('sparse_infill_density'), infillPattern: pick('sparse_infill_pattern'),
        supports: pick('enable_support'), supportType: pick('support_type'), brim: pick('brim_type'),
        filamentType: [].concat(j.filament_type || []).filter(Boolean),
        filamentPreset: [].concat(j.filament_settings_id || []).filter(Boolean),
        nozzleTemp: pick('nozzle_temperature'), bedTemp: pick(`${String(pick('curr_bed_type') || '').toLowerCase().includes('textured') ? 'textured_plate_temp' : 'hot_plate_temp'}`),
        speed: pick('outer_wall_speed'),
      };
      for (const k of Object.keys(report.settings)) if (report.settings[k] === undefined) delete report.settings[k];
    } catch { report.settingsError = 'project_settings.config is not valid JSON'; }
  }
  const si = z['Metadata/slice_info.config'];
  if (si) {
    const xml = si.toString('utf8');
    for (const plate of xml.match(/<plate>[\s\S]*?<\/plate>/g) || []) {
      const meta = {};
      for (const m of plate.matchAll(/<metadata\s+key="([^"]+)"\s+value="([^"]*)"/g)) meta[m[1]] = m[2];
      report.plates.push({
        index: Number(meta.index) || report.plates.length + 1,
        seconds: meta.prediction ? Number(meta.prediction) : null,
        grams: meta.weight ? Number(meta.weight) : null,
        supportUsed: meta.support_used === 'true',
        outside: meta.outside === 'true',
        objects: (plate.match(/<object\b[^>]*>/g) || []).map((t) => attr(t, 'name')).filter(Boolean),
        filaments: (plate.match(/<filament\b[^>]*>/g) || []).map((t) => ({ type: attr(t, 'type'), color: attr(t, 'color'), grams: Number(attr(t, 'used_g')) || 0, metres: Number(attr(t, 'used_m')) || 0 })),
        warnings: (plate.match(/<warning\b[^>]*>/g) || []).map((t) => ({ msg: attr(t, 'msg'), level: attr(t, 'level'), code: attr(t, 'error_code') })),
      });
    }
  }
  const ms = z['Metadata/model_settings.config'];
  if (ms) {
    const xml = ms.toString('utf8');
    for (const obj of xml.match(/<object\b[\s\S]*?<\/object>/g) || []) {
      const name = /<metadata\s+key="name"\s+value="([^"]*)"/.exec(obj);
      if (name) report.objects.push(name[1]);
    }
  }
  // Overall size from the mesh vertices (mm), across all model files.
  const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  for (const [name, buf] of Object.entries(z)) {
    if (!name.endsWith('.model')) continue;
    const text = buf.toString('utf8');
    for (const m of text.matchAll(/<vertex\s+x="([-\d.eE+]+)"\s+y="([-\d.eE+]+)"\s+z="([-\d.eE+]+)"/g)) {
      for (let i = 0; i < 3; i++) { const v = Number(m[i + 1]); if (v < min[i]) min[i] = v; if (v > max[i]) max[i] = v; }
    }
  }
  if (Number.isFinite(min[0])) report.sizeMm = max.map((v, i) => Math.round((v - min[i]) * 10) / 10);
  report.printerProfile = printerProfileId(report.settings.printer);
  return report;
}

// ------------------------------------------------------------------ finding the open project

export function confPath() {
  if (process.env.WIREMAP_BAMBU_CONF) return process.env.WIREMAP_BAMBU_CONF;
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'BambuStudio', 'BambuStudio.conf');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'BambuStudio', 'BambuStudio.conf');
  return join(homedir(), '.config', 'BambuStudio', 'BambuStudio.conf');
}

/** Selected presets and recent projects from BambuStudio.conf (JSON). */
export function readConf(file = confPath()) {
  if (!existsSync(file)) return null;
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/^#.*$/gm, '')); } catch { return null; }
  const recent = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (/\.3mf$/i.test(v)) recent.push(v); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(j.recent_projects ?? j.recent ?? j);
  const presets = j.presets || {};
  return {
    recent: [...new Set(recent)],
    printer: presets.printer || presets.machine, process: presets.print || presets.process,
    filaments: [].concat(presets.filaments || presets.filament || []).filter((x) => typeof x === 'string'),
  };
}

/** Most recently saved project among Bambu Studio's recent files and extra paths. */
export function findProject(extra = []) {
  if (process.env.WIREMAP_BAMBU_FILE) return process.env.WIREMAP_BAMBU_FILE;
  const conf = readConf();
  const files = [...(conf?.recent || []), ...extra].filter((f) => { try { return existsSync(f) && statSync(f).isFile(); } catch { return false; } });
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] || null;
}

/** Full snapshot: {status, conf, project}. */
export function readBambuSession(extra = []) {
  const conf = readConf();
  const file = findProject(extra);
  if (!file && !conf) return { status: 'unavailable', message: 'Bambu Studio not found on this computer.' };
  let project = null; let error = null;
  if (file) { try { project = readBambu3mf(file); } catch (e) { error = `Could not read ${file}: ${e.message}`; } }
  return { status: project ? 'active' : 'no_project', conf, project, message: error || (project ? undefined : 'Bambu Studio found, but no saved project yet. Save the project (Ctrl+S) so Wiremap can read it.') };
}

const fmtTime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.round(s / 60)} min`);
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

/** Plain text for the chatbot. `printers` = Wiremap printer profiles (for fit and material hints). */
export function describeBambu(report, printers = {}, check = {}) {
  if (!report || report.status === 'unavailable') return report?.message ? `Bambu Studio: ${report.message}` : '';
  const lines = [];
  const c = report.conf;
  if (c && (c.printer || c.filaments?.length)) lines.push(`Bambu Studio presets: printer ${c.printer || '?'}${c.process ? `, process ${c.process}` : ''}${c.filaments?.length ? `, filament ${c.filaments.join(' / ')}` : ''}.`);
  const p = report.project;
  if (!p) { lines.push(report.message || 'No saved Bambu Studio project found.'); return lines.join('\n'); }
  const s = p.settings;
  lines.push(`Bambu Studio project "${p.file.split(/[\\/]/).pop()}" (saved ${ago(p.savedAt)}) at ${p.file}.`);
  const set = [s.printer && `printer ${s.printer}`, s.nozzle && `${s.nozzle} mm nozzle`, s.bedType && `${s.bedType}`,
    s.layerHeight && `layer ${s.layerHeight} mm`, s.walls && `${s.walls} walls`, s.infill && `infill ${s.infill}${s.infillPattern ? ` ${s.infillPattern}` : ''}`,
    s.supports !== undefined && `supports ${['1', 'true'].includes(String(s.supports)) ? `on (${s.supportType || 'auto'})` : 'off'}`, s.brim && `brim ${s.brim}`,
    s.filamentType?.length && `filament ${s.filamentType.join(' / ')}`, s.nozzleTemp && `nozzle ${s.nozzleTemp} °C`, s.bedTemp && `bed ${s.bedTemp} °C`].filter(Boolean);
  if (set.length) lines.push(`Settings: ${set.join(', ')}.`);
  if (p.objects.length) lines.push(`Objects: ${p.objects.slice(0, 15).join(', ')}.`);
  if (p.sizeMm) lines.push(`Overall model size: ${p.sizeMm.join(' x ')} mm.`);
  if (p.plates.length) {
    for (const pl of p.plates.slice(0, 6)) {
      const fil = pl.filaments.map((f) => `${f.type || '?'} ${f.color || ''} ${f.grams} g`.replace(/\s+/g, ' ').trim()).join(', ');
      const warn = pl.warnings.map((w) => w.msg).filter(Boolean);
      lines.push(`Plate ${pl.index}: ${pl.seconds ? fmtTime(pl.seconds) : '? time'}, ${pl.grams ?? '?'} g${fil ? ` (${fil})` : ''}${pl.supportUsed ? ', uses supports' : ''}${pl.outside ? ', SOME OBJECTS ARE OUTSIDE THE PLATE' : ''}${warn.length ? `; slicer warnings: ${warn.join('; ')}` : ''}.`);
    }
  } else lines.push('Not sliced yet (no time or filament estimate). Slice the plate and save to see them.');
  const prof = p.printerProfile && printers[p.printerProfile];
  if (prof) {
    if (p.sizeMm && check.fitPart) {
      try {
        const fit = check.fitPart(p.sizeMm, prof);
        lines.push(`Wiremap printer check (${prof.name || p.printerProfile}): ${fit.fits ? 'fits' : 'does NOT fit'}${fit.suggestion ? `. ${fit.suggestion}` : ''}.`);
      } catch { /* ignore */ }
    }
    if (check.materialCheck) {
      for (const m of new Set(s.filamentType || [])) {
        try {
          const r = check.materialCheck(m, prof);
          if (r.status !== 'ok') lines.push(`Material check: ${m} on ${prof.name || p.printerProfile} is "${r.status}": ${r.reason}.`);
        } catch { /* ignore */ }
      }
    }
  }
  return lines.join('\n');
}

export function bambuStatus(report) {
  if (!report || report.status === 'unavailable') return { active: false, status: report?.status || 'unavailable', text: report?.message || 'Bambu Studio not found' };
  const p = report.project;
  if (!p) return { active: false, status: report.status, text: report.message || 'no saved project' };
  const pl = p.plates[0];
  const warnings = p.plates.reduce((n, x) => n + x.warnings.length, 0);
  return { active: true, status: 'active', file: p.file.split(/[\\/]/).pop(), sliced: p.plates.length > 0, warnings,
    text: `${p.file.split(/[\\/]/).pop()}${pl?.seconds ? ` · ${fmtTime(pl.seconds)}, ${pl.grams} g` : ' · not sliced'}${warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}` };
}
