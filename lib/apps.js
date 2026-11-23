// @ts-check
// Desktop apps the Wiremap overlay follows: slicers, CAD, electronics and
// firmware tools. Pure data and parsing (no OS calls), shared by the overlay
// daemon, the viewer server and the tests.

/**
 * kind: slicer | cad | electronics | firmware
 * proc: lower-case process names without .exe (Windows, macOS, Linux spellings)
 * title: how to pull the open file out of the window title
 */
export const APPS = [
  { id: 'bambu-studio', label: 'Bambu Studio', kind: 'slicer', proc: ['bambu-studio', 'bambustudio', 'bambu studio'], conf: 'BambuStudio' },
  { id: 'orca-slicer', label: 'OrcaSlicer', kind: 'slicer', proc: ['orca-slicer', 'orcaslicer'], conf: 'OrcaSlicer' },
  { id: 'prusa-slicer', label: 'PrusaSlicer', kind: 'slicer', proc: ['prusa-slicer', 'prusaslicer'], conf: 'PrusaSlicer' },
  { id: 'cura', label: 'UltiMaker Cura', kind: 'slicer', proc: ['ultimaker-cura', 'ultimaker cura', 'cura'] },
  { id: 'solidworks', label: 'SOLIDWORKS', kind: 'cad', proc: ['sldworks'] },
  { id: 'fusion', label: 'Fusion', kind: 'cad', proc: ['fusion360', 'fusion 360', 'autodesk fusion'] },
  { id: 'freecad', label: 'FreeCAD', kind: 'cad', proc: ['freecad', 'freecadcmd'] },
  { id: 'onshape', label: 'Onshape', kind: 'cad', proc: ['onshape'] },
  { id: 'openscad', label: 'OpenSCAD', kind: 'cad', proc: ['openscad'] },
  { id: 'blender', label: 'Blender', kind: 'cad', proc: ['blender'] },
  { id: 'kicad', label: 'KiCad', kind: 'electronics', proc: ['kicad', 'eeschema', 'pcbnew'] },
  { id: 'fritzing', label: 'Fritzing', kind: 'electronics', proc: ['fritzing'] },
  { id: 'arduino-ide', label: 'Arduino IDE', kind: 'firmware', proc: ['arduino ide', 'arduino', 'arduino-ide'] },
];

export const KIND_LABEL = { slicer: 'Printing', cad: 'CAD', electronics: 'Electronics', firmware: 'Firmware' };

const norm = (s) => String(s || '').toLowerCase().replace(/\.(exe|app)$/i, '').replace(/^.*[\\/]/, '').trim();

/** The app entry for a process name, or null. */
export function appForProcess(name) {
  const n = norm(name);
  if (!n) return null;
  return APPS.find((a) => a.proc.includes(n)) || null;
}

/**
 * Pull the open document out of a window title.
 *   "arm-deck.3mf - Bambu Studio"         -> arm-deck.3mf
 *   "SOLIDWORKS Premium 2024 - [Bracket.SLDPRT *]" -> Bracket.SLDPRT
 *   "Autodesk Fusion - base v3"           -> base v3
 */
export function fileFromTitle(app, title) {
  // "* Untitled - BambuStudio": a leading "*" marks unsaved changes.
  const t = String(title || '').trim().replace(/^\*\s*/, '').replace(/\s*\*$/, '');
  if (!t) return null;
  const bracket = /\[([^\]]+?)\s*\*?\]/.exec(t);
  if (bracket) return bracket[1].replace(/\s*\*$/, '').trim() || null;
  const withExt = /([^\\/:*?"<>|\-–—]+\.(3mf|stl|step|stp|gcode|sldprt|sldasm|f3d|fcstd|scad|blend|kicad_pcb|kicad_sch|ino|obj))\b/i.exec(t);
  if (withExt) return withExt[1].trim();
  const squash = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const label = app ? squash(app.label) : '';
  const parts = t.split(/\s+[-–—|]\s+/).map((x) => x.trim().replace(/^\*\s*/, '')).filter(Boolean);
  const rest = parts.filter((p) => !(label && squash(p).includes(label)) && !/^(autodesk|untitled|home|new project)$/i.test(p));
  return rest[0] && rest[0].length < 120 ? rest[0] : null;
}

/**
 * Match a process list [{ name, title, pid }] to supported apps.
 * One entry per app (the first window with a title wins).
 */
export function matchApps(processes) {
  const seen = new Map();
  for (const p of processes || []) {
    const app = appForProcess(p.name);
    if (!app) continue;
    const prev = seen.get(app.id);
    if (prev && prev.title) continue;
    seen.set(app.id, { id: app.id, label: app.label, kind: app.kind, pid: p.pid ?? null, title: p.title || '', file: fileFromTitle(app, p.title), foreground: Boolean(p.fg) || Boolean(prev?.foreground) });
  }
  return [...seen.values()];
}

/** Pick the app the overlay should focus on: the foreground one if known, else slicer > cad > electronics > firmware. */
export function primaryApp(apps, foregroundPid) {
  if (!apps.length) return null;
  const fg = apps.find((a) => (a.pid && a.pid === foregroundPid) || a.foreground);
  if (fg) return fg;
  const rank = { slicer: 0, cad: 1, electronics: 2, firmware: 3 };
  return [...apps].sort((a, b) => rank[a.kind] - rank[b.kind])[0];
}

// ---------------------------------------------------------------------------
// Slicer settings files (best effort: formats change between versions)

/**
 * Bambu Studio / OrcaSlicer keep "<Name>.conf" (JSON) in the user config folder,
 * with the selected presets and recent projects.
 * Returns { printer, filaments, process, recent } (any may be null/empty).
 */
export function parseBambuConf(text) {
  let j;
  try { j = JSON.parse(String(text).replace(/^﻿/, '').replace(/^#.*$/gm, '')); } catch { return null; }
  const presets = j.presets || j.app?.presets || {};
  // Names only: "filaments" (list) or "filament", "filament_1"...; skip colour and AMS keys.
  const filaments = [];
  const isName = (v) => typeof v === 'string' && /[a-z]/i.test(v) && !/^#/.test(v);
  if (Array.isArray(presets.filaments)) for (const v of presets.filaments) if (isName(v)) filaments.push(v);
  for (const [k, v] of Object.entries(presets)) if (/^filament(_\d+)?$/.test(k) && isName(v)) filaments.push(v);
  const recent = [];
  const walk = (o, depth = 0) => {
    if (!o || depth > 4) return;
    if (Array.isArray(o)) { for (const x of o) if (typeof x === 'string' && /\.3mf$/i.test(x)) recent.push(x); else walk(x, depth + 1); return; }
    if (typeof o === 'object') for (const [k, v] of Object.entries(o)) {
      if (/recent/i.test(k) && typeof v === 'object') {
        for (const x of Object.values(v)) if (typeof x === 'string' && /\.3mf$/i.test(x)) recent.push(x);
        if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && /\.3mf$/i.test(x)) recent.push(x);
      } else if (typeof v === 'object') walk(v, depth + 1);
    }
  };
  walk(j);
  return {
    printer: presets.machine || presets.printer || null,
    process: presets.process || presets.print || null,
    filaments: [...new Set(filaments)],
    nozzle: presets.nozzle_diameter || null,
    recent: [...new Set(recent)].slice(0, 10),
  };
}

/** PrusaSlicer.ini: [presets] printer = ..., filament = ...; [recent_projects] 1 = path */
export function parsePrusaIni(text) {
  const out = { printer: null, process: null, filaments: [], nozzle: null, recent: [] };
  let sect = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const s = /^\[(.+)\]$/.exec(line);
    if (s) { sect = s[1].toLowerCase(); continue; }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, k, v] = kv;
    if (sect === 'presets') {
      if (k === 'printer') out.printer = v;
      else if (k === 'print') out.process = v;
      else if (/^filament/.test(k) && v) out.filaments.push(v);
    } else if (sect === 'recent_projects' && v) out.recent.push(v);
  }
  return out;
}

/**
 * Does the slicer's selected printer preset match the project's printer profile?
 * "Bambu Lab A1 mini 0.4 nozzle" vs profile { name: 'Bambu Lab A1 mini' } -> true.
 * Returns null when either side is unknown.
 */
export function presetMatchesProfile(preset, profile) {
  if (!preset || !profile) return null;
  const clean = (s) => String(s).toLowerCase().replace(/bambu lab|bambulab|\(.*?\)|\d+(\.\d+)?\s*mm?\s*nozzle|nozzle|[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const a = clean(preset), b = clean(profile.name || profile.id);
  if (!a || !b) return null;
  // "a1" must not match "a1 mini"
  const toks = (s) => s.split(' ').filter(Boolean);
  const ta = toks(a), tb = toks(b);
  return tb.every((t) => ta.includes(t)) && ta.filter((t) => ['mini', 'carbon', 'combo', 'pro', 'max'].includes(t)).every((t) => tb.includes(t) || t === 'combo');
}

/** Nozzle size from a preset name: "... 0.4 nozzle" -> 0.4 */
export function nozzleFromPreset(preset) {
  const m = /(\d+(?:\.\d+)?)\s*(?:mm)?\s*nozzle/i.exec(String(preset || ''));
  return m ? Number(m[1]) : null;
}
