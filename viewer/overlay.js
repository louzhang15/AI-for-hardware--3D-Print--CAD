// Wiremap overlay: the small window that sits next to Bambu Studio, a slicer,
// a CAD or an electronics app (opened by `wiremap overlay`, or ?overlay=1).
// It follows the app you have open and shows what matters there: the print
// checklist in a slicer, sizes to model in CAD, wiring problems in KiCad or the
// Arduino IDE, the printer's tolerance table, mechanics and the assistant.
import { h, clear, icon, api, copyText, toast, store } from './util.js';
import { renderMechanics, fitCallout } from './mechanics.js';
import { printFit, insertHole, FIT_TYPES } from '/lib/calc.js';
import { fitPart, materialCheck, usableVolume } from '/lib/printer.js';
import { presetMatchesProfile, nozzleFromPreset, APPS, KIND_LABEL } from '/lib/apps.js';

const fmt = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toFixed(d)).toString() : '–');
const TABS_BY_KIND = {
  slicer: [['check', 'Print check'], ['tol', 'Tolerances'], ['mech', 'Mechanics'], ['ask', 'Ask']],
  cad: [['check', 'Design'], ['tol', 'Tolerances'], ['mech', 'Mechanics'], ['ask', 'Ask']],
  electronics: [['check', 'Wiring'], ['mech', 'Mechanics'], ['ask', 'Ask']],
  firmware: [['check', 'Pins'], ['ask', 'Ask']],
  none: [['check', 'Checklist'], ['tol', 'Tolerances'], ['mech', 'Mechanics'], ['ask', 'Ask']],
};
const APP_GLYPH = { slicer: 'print', cad: 'ruler', electronics: 'chip', firmware: 'chip', none: 'layers' };

/** Common sizes a maker models every week, as [label, args for printFit or insert]. */
const TOLERANCE_ROWS = [
  ['M2 screw passes through', { nominal: 2, fit: 'free', feature: 'hole' }],
  ['M2.5 screw passes through', { nominal: 2.5, fit: 'free', feature: 'hole' }],
  ['M3 screw passes through', { nominal: 3, fit: 'free', feature: 'hole' }],
  ['M4 screw passes through', { nominal: 4, fit: 'free', feature: 'hole' }],
  ['M3 heat-set insert', { insert: 'M3' }],
  ['M2.5 heat-set insert', { insert: 'M2.5' }],
  ['3 mm pin that turns', { nominal: 3, fit: 'sliding', feature: 'hole' }],
  ['3 mm pin pressed in', { nominal: 3, fit: 'press', feature: 'hole' }],
  ['5 mm motor shaft pressed in', { nominal: 5, fit: 'press', feature: 'hole' }],
  ['608 bearing (Ø22) pressed in', { nominal: 22, fit: 'press', feature: 'hole' }],
  ['SG90 servo body (12.2 wide)', { nominal: 12.2, fit: 'snug', feature: 'slot' }],
  ['MG996R servo body (20 wide)', { nominal: 20, fit: 'snug', feature: 'slot' }],
  ['Printed peg into a 5 mm hole', { nominal: 5, fit: 'sliding', feature: 'shaft' }],
];

// ------------------------------------------------------------- design focus

const STOP_TOKENS = new Set(['v1', 'v2', 'v3', 'copy', 'final', 'new', 'part', 'assy', 'asm', 'the', 'and', 'for', 'of', 'a']);
const EXT_RE = /\.(3mf|stl|step|stp|gcode|sldprt|sldasm|slddrw|f3d|fcstd|scad|blend|kicad_pcb|kicad_sch|ino|obj|py|vbs)$/i;

/** Lower-case word tokens of a name or file path, without folder, extension or filler words. */
export function designTokens(text) {
  const base = String(text || '').replace(/^.*[\\/]/, '').replace(EXT_RE, '').toLowerCase();
  return base.split(/[^a-z0-9]+/).filter((t) => t && !STOP_TOKENS.has(t) && !/^\d{1,2}$/.test(t));
}

/**
 * Which print, part or step of the project is the open file about?
 * Exact name (id, name, file basename) scores 100; otherwise the share of the
 * file's words found in the candidate's words, after dropping the project's own
 * name words ("robot-arm-deck" in project "robot-arm" leaves "deck").
 * Returns { kind, id, item, name, score, steps } or null.
 */
export function matchDesign(project, projectName, file) {
  let ft = designTokens(file);
  if (!ft.length || !project) return null;
  const projWords = new Set([...designTokens(projectName), ...designTokens(project.meta?.name)]);
  const trimmed = ft.filter((t) => !projWords.has(t));
  if (trimmed.length) ft = trimmed;
  const fileKey = ft.join('-');
  const cands = [];
  for (const p of project.prints || []) {
    const names = [p.id, p.name, p.source, ...(p.files || []), ...(p.pieces || []).map((x) => x.file || x)].filter((x) => typeof x === 'string');
    cands.push({ kind: 'print', id: p.id, item: p, name: p.name || p.id, names });
  }
  for (const p of project.parts || []) cands.push({ kind: 'part', id: p.id, item: p, name: p.name || p.id, names: [p.id, p.name, p.library].filter(Boolean) });
  let best = null;
  for (const c of cands) {
    let score = 0;
    for (const n of c.names) {
      const nt = designTokens(n);
      if (!nt.length) continue;
      if (nt.join('-') === fileKey) { score = 100; break; }
      const set = new Set(nt);
      const hit = ft.filter((t) => set.has(t));
      if (!hit.some((t) => t.length >= 3)) continue;
      const s = (hit.length / ft.length) * 80 + (hit.length / nt.length) * 15 + (c.kind === 'print' ? 2 : 0);
      if (s > score) score = s;
    }
    if (score >= 50 && (!best || score > best.score)) best = { ...c, score: Math.round(score) };
  }
  if (!best) return null;
  const key = best.kind === 'print' ? 'prints' : 'parts';
  const steps = (project.steps || []).filter((st) => Array.isArray(st[key]) && st[key].includes(best.id));
  return { kind: best.kind, id: best.id, item: best.item, name: best.name, score: best.score, steps };
}

/** Text with dimensions and loads in bold: "Ø3.40 mm", "0.9 kg·cm", "20 N". */
function boldDims(text) {
  const out = [];
  const re = /(Ø?\d+(?:\.\d+)?(?:\s?×\s?\d+(?:\.\d+)?)*\s?(?:mm|kg·cm|N·m|MPa|N|g|°|V|A|%)(?![a-z]))/g;
  let last = 0, m;
  const t = String(text || '');
  while ((m = re.exec(t))) {
    if (m.index > last) out.push(t.slice(last, m.index));
    out.push(h('b', null, m[0]));
    last = m.index + m[0].length;
  }
  if (last < t.length) out.push(t.slice(last));
  return out;
}

export function mountOverlay(app) {
  const params = new URLSearchParams(location.search);
  document.body.classList.add('overlay-mode');
  const launched = Boolean(params.get('app'));
  const state = {
    tab: store.get('overlay.tab', 'check'),
    appInfo: params.get('app') ? { id: params.get('app'), ...(APPS.find((a) => a.id === params.get('app')) || {}), file: null } : null,
    slicer: null,
    sw: null,
    key: '',
  };

  const glyph = h('span.ov-glyph');
  const appName = h('strong.ov-app');
  const appFile = h('span.ov-file');
  const projSel = h('select.ov-proj', { 'aria-label': 'Project', onchange: (e) => { location.hash = `#/p/${encodeURIComponent(e.target.value)}`; } });
  const themeBtn = h('button.ov-icon', { type: 'button', 'aria-label': 'Switch light or dark', onclick: () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t; store.set('theme', t);
  } }, icon('moon', 16));
  const tabs = h('div.ov-tabs', { role: 'tablist', 'aria-label': 'Overlay sections' });
  const body = h('div.ov-body', { role: 'tabpanel' });
  const askSlot = h('div.ov-ask');
  const foot = h('footer.ov-foot');
  const root = h('div.ov', null,
    h('header.ov-head', null,
      glyph,
      h('div.ov-id', null, appName, appFile),
      themeBtn),
    h('div.ov-projrow', null, h('label', null, 'Project'), projSel),
    tabs, body, askSlot, foot);
  document.body.append(root);
  document.title = 'Wiremap overlay';

  function kind() { return state.appInfo?.kind || 'none'; }
  function profile() { return app.printers?.[app.data?.project?.printer?.profile] || null; }

  function renderHead() {
    const k = kind();
    clear(glyph).append(icon(APP_GLYPH[k], 18));
    glyph.dataset.kind = k;
    appName.textContent = state.appInfo?.label || 'Wiremap';
    appFile.textContent = state.appInfo?.file || (state.appInfo ? `${KIND_LABEL[k]} helper` : 'Open Bambu Studio, a slicer or CAD and I follow it');
    document.title = `Wiremap overlay${state.appInfo?.label ? ` - ${state.appInfo.label}` : ''}`;
    clear(foot).append(launched
      ? h('span', null, icon('pin', 13), `Stays on top while ${state.appInfo?.label || 'the app'} is open.`)
      : h('span', null, 'Run ', h('code', null, 'node bin/wiremap.mjs overlay'), ' to open this by itself next to Bambu Studio or CAD.'));
  }

  function renderTabs() {
    const list = TABS_BY_KIND[kind()];
    if (!list.some(([id]) => id === state.tab)) state.tab = list[0][0];
    clear(tabs).append(...list.map(([id, label]) => h(`button.ov-tab${state.tab === id ? '.on' : ''}`, {
      type: 'button', role: 'tab', 'aria-selected': String(state.tab === id),
      onclick: () => { state.tab = id; store.set('overlay.tab', id); renderTabs(); renderBody(); },
    }, label)));
  }

  async function renderProjects() {
    try {
      const { projects } = JSON.parse(await api('/api/projects'));
      const current = app.data?.name;
      clear(projSel).append(...(current ? [] : [h('option', { value: '' }, 'Choose a project')]),
        ...projects.map((p) => h('option', { value: p.name, selected: p.name === current }, p.title || p.meta?.name || p.name)));
      if (!current && projects[0] && !location.hash.startsWith('#/p/')) location.hash = `#/p/${encodeURIComponent(projects[0].name)}`;
    } catch { /* server gone */ }
  }

  // ------------------------------------------------------------- sections
  const row = (state, title, text, extra, emph = '') => h(`li.ov-row.${state}${emph ? `.${emph}` : ''}`, null, h('span.ov-dot'), h('div', null, h('b', null, title), text ? h('p', null, text) : null, extra || null));
  /** '' when nothing is in focus, 'ov-hit' for the focused item, 'ov-dim' for the rest. */
  const emphFor = (kindName, id) => {
    const f = state.focus;
    if (!f) return '';
    return f.kind === kindName && f.id === id ? 'ov-hit' : 'ov-dim';
  };
  const sec = (title, ...kids) => h('section.ov-sec', null, h('h3', null, title), ...kids);

  function slicerPrinterSection() {
    const prof = profile();
    const items = [];
    const sl = state.slicer;
    const label = state.appInfo?.label || 'The slicer';
    if (!prof) items.push(row('warn', 'No printer set in the project', 'Add printer.profile (for example bambu-a1-mini) so sizes and fits use your machine.'));
    if (sl && sl.printer) {
      const match = presetMatchesProfile(sl.printer, prof);
      items.push(row(match === false ? 'bad' : match ? 'ok' : 'none', `${label} is set to ${sl.printer}`,
        match === false ? `Your project is sized for ${prof.name}. Pick that printer in ${label}, or change the project printer before you slice.`
          : match ? `Matches your project printer (${prof.name}).` : null));
      const nz = nozzleFromPreset(sl.printer);
      if (nz && prof?.nozzle_diameter && Math.abs(nz - prof.nozzle_diameter) > 1e-6) items.push(row('warn', `${nz} mm nozzle selected`, `Fits and wall thicknesses in this project assume ${prof.nozzle_diameter} mm.`));
      const mats = [...new Set((app.data?.project.prints || []).map((p) => (p.material || app.data.project.printer?.material || '').toUpperCase()).filter(Boolean))];
      for (const m of mats) {
        const hit = (sl.filaments || []).some((f) => f.toUpperCase().includes(m));
        if (sl.filaments?.length) items.push(row(hit ? 'ok' : 'warn', hit ? `${m} filament loaded` : `${m} not in the selected filaments`, hit ? null : `Selected: ${sl.filaments.join(', ')}.`));
      }
    } else if (prof) {
      items.push(row('none', `Printer: ${prof.name}`, sl?.missing || sl?.unreadable ? `Could not read ${label}'s settings, so check the printer dropdown matches.` : `Check ${label} has ${prof.name} selected.`));
    }
    return sec('Printer', h('ul.ov-rows', null, items));
  }

  function printsSection() {
    const prof = profile();
    const prints = app.data?.project.prints || [];
    if (!prints.length) return sec('Parts to print', h('p.ov-muted', null, 'No printed parts in this project yet. Ask your AI to design the mounts and enclosure.'));
    const list = h('ul.ov-rows');
    for (const p of prints) {
      const facts = [];
      let st = 'ok';
      const notes = [];
      if (Array.isArray(p.size) && prof) {
        try {
          const f = fitPart(p.size, prof);
          if (!f.fits) { st = 'bad'; notes.push(`Too big for the ${prof.name}: split it (wiremap split-part).`); }
          else facts.push(`${p.size.map((x) => fmt(x, 1)).join(' × ')} mm, fits the bed`);
        } catch { /* bad size */ }
      }
      const mat = p.material || app.data.project.printer?.material;
      if (mat && prof) {
        const m = materialCheck(mat, prof);
        if (m.status === 'no') { st = 'bad'; notes.push(m.reason); } else if (m.status === 'warn') { if (st === 'ok') st = 'warn'; notes.push(m.reason); }
        facts.push(mat);
      }
      const set = p.settings || {};
      const chips = [set.orientation && `Orientation: ${set.orientation}`, set.supports !== undefined && (set.supports ? 'Supports on' : 'No supports'), set.infill !== undefined && `${set.infill}% infill`, set.layer && `${set.layer} mm layers`, set.walls && `${set.walls} walls`].filter(Boolean);
      const issues = (app.data.check.issues || []).filter((i) => /^mech-(wall|heat|printed-fit|beam)/.test(i.rule) && i.message.includes(p.name || p.id));
      for (const i of issues) { notes.push(i.message); if (i.level === 'error') st = 'bad'; else if (st === 'ok') st = 'warn'; }
      list.append(row(st, p.name || p.id, facts.join(', '),
        h('div', null, chips.length ? h('div.ov-chips', null, chips.map((c) => h('span', null, c))) : null, notes.map((n) => h('p.ov-note', null, n))), emphFor('print', p.id)));
    }
    const cmd = `node bin/wiremap.mjs export-print --project projects/${app.data.name}.json --out exports/${app.data.name}`;
    return sec('Parts to print', list,
      h('div.ov-cmd', null, h('code', null, cmd), h('button.ov-icon', { type: 'button', 'aria-label': 'Copy the export command', onclick: async () => { if (await copyText(cmd)) toast('Command copied', 'ok'); } }, icon('copy', 14))),
      h('p.ov-muted', null, 'This writes one 3MF per plate with orientation and settings. Open it here and slice.'));
  }

  function beforePrintSection() {
    const prof = profile();
    const tips = [];
    for (const n of prof?.notes || []) tips.push(h('li.ov-row.none.tip', null, h('span.ov-dot'), h('p', null, n)));
    const fitIssues = (app.data?.check.issues || []).filter((i) => /^mech-(printed-fit|fit-|stackup)/.test(i.rule));
    for (const i of fitIssues) tips.unshift(row(i.level === 'error' ? 'bad' : 'warn', i.message, i.fix));
    return tips.length ? sec('Before you press print', h('ul.ov-rows', null, tips)) : null;
  }

  function cadSection() {
    const out = [];
    if (state.appInfo?.id === 'solidworks') {
      const sw = state.sw;
      out.push(sec('SOLIDWORKS now', h('ul.ov-rows', null,
        sw?.active ? [row(sw.problems ? 'bad' : 'ok', sw.title || 'Active document', `${sw.type || ''}${sw.selected ? `, ${sw.selected} selected` : ''}${sw.problems ? `, ${sw.problems} rebuild problem${sw.problems === 1 ? '' : 's'}` : ', rebuilds cleanly'}`)]
          : [row('none', 'Waiting for SOLIDWORKS', sw?.text || 'Open a part and I read the active document and selection.')])));
    }
    const prof = profile();
    if (prof) {
      const u = usableVolume(prof);
      out.push(sec('Fits on your printer', h('p.ov-big', null, `${u.map((x) => fmt(x, 0)).join(' × ')} mm`), h('p.ov-muted', null, `${prof.name} build volume minus a ${prof.margin_mm ?? 5} mm margin. Bigger parts get split with joints.`)));
    }
    const fits = app.data?.check.mechanics?.fits || [];
    if (fits.length) out.push(sec('Sizes to model', h('div.mx-fits.compact', null, fits.map(fitCallout))));
    const boards = (app.data?.check.model.partList || []).filter((p) => p.geometry?.board && (p.geometry.holes || []).length);
    if (boards.length) {
      out.push(sec('Boards to mount', h('ul.ov-rows', null, boards.map((p) => {
        const g = p.geometry;
        const holes = g.holes.map((x) => x.d || x.diameter).filter(Boolean);
        return row(g.confidence === 'verified' ? 'ok' : 'none', app.shortName(p), `${g.board.slice(0, 2).map((x) => fmt(x, 1)).join(' × ')} mm, ${g.holes.length} × Ø${fmt(holes[0] || 0, 1)} holes. Exact positions: wiremap part-geometry ${p.libraryId || p.id}`, null, emphFor('part', p.id));
      }))));
    }
    return out;
  }

  function wiringSection() {
    const check = app.data?.check;
    const issues = (check?.issues || []).filter((i) => !i.rule.startsWith('mech') && i.level !== 'info');
    const out = [sec(issues.length ? `${issues.length} wiring ${issues.length === 1 ? 'problem' : 'problems'}` : 'Wiring',
      h('ul.ov-rows', null, issues.length ? issues.slice(0, 12).map((i) => row(i.level === 'error' ? 'bad' : 'warn', i.message, i.fix)) : [row('ok', 'No wiring rule violations found', 'Not a guarantee: heat, noise and firmware are not checked.')]))];
    const wires = (check?.model.wires || []).filter((w) => w.valid).slice(0, 40);
    if (wires.length) {
      out.push(sec('Connections', h('ul.ov-wires', null, wires.map((w) => {
        const info = check.wireInfo[w.id] || {};
        return h('li', null, h('i', { style: { background: app.roleColor(info.role) } }), h('span', null, app.pinText(w.fromKey)), h('span.ov-to', null, 'to'), h('span', null, app.pinText(w.toKey)));
      }))));
    }
    return out;
  }

  function toleranceTab() {
    const prof = profile();
    const src = prof?.clearance_mm ? `Clearances from the ${prof.name} profile` : 'Wiremap starting clearances';
    const table = h('table.ov-tol', null,
      h('thead', null, h('tr', null, h('th', null, 'What goes in'), h('th', null, 'Model it at'))),
      h('tbody', null, TOLERANCE_ROWS.map(([label, a]) => {
        try {
          if (a.insert) {
            const r = insertHole({ size: a.insert });
            return h('tr', null, h('td', null, label), h('td', null, h('b', null, `Ø${Number(r.value).toFixed(2)}`), h('span', null, ` ${fmt(r.depth, 1)} deep`)));
          }
          const r = printFit({ ...a, profile: prof || undefined });
          const sym = a.feature === 'slot' ? '' : 'Ø';
          return h('tr', null, h('td', null, label), h('td', null, h('b', null, `${sym}${Number(r.value).toFixed(2)}`), h('span', null, ` ${a.fit}`)));
        } catch { return null; }
      })));
    // calculator
    const nominal = h('input.ov-in', { type: 'number', step: '0.05', min: '0.1', value: '3', 'aria-label': 'Real size in mm' });
    const fitSel = h('select.ov-in', { 'aria-label': 'Fit' }, FIT_TYPES.map((f) => h('option', { value: f, selected: f === 'sliding' }, f)));
    const featSel = h('select.ov-in', { 'aria-label': 'Printed feature' }, [['hole', 'Printed hole'], ['slot', 'Printed slot'], ['shaft', 'Printed peg']].map(([v, l]) => h('option', { value: v }, l)));
    const out = h('div.ov-calc-out');
    const calc = () => {
      try {
        const r = printFit({ nominal: Number(nominal.value), fit: fitSel.value, feature: featSel.value, profile: prof || undefined });
        clear(out).append(h('span.ov-calc-v', null, `${featSel.value === 'slot' ? '' : 'Ø'}${Number(r.value).toFixed(2)} mm`), h('span.ov-muted', null, `${fmt(r.clearance_per_side, 2)} mm per side`));
      } catch (e) { clear(out).append(h('span.ov-muted', null, e.message)); }
    };
    for (const el of [nominal, fitSel, featSel]) el.addEventListener('input', calc);
    calc();
    return [
      sec('Your size', h('div.ov-calc', null, h('label', null, 'Real part (mm)', nominal), h('label', null, 'Fit', fitSel), h('label', null, 'Printed as', featSel)), out),
      sec('Common sizes', table, h('p.ov-muted', null, `${src}. Printers vary: print the tolerance coupon once and put your measured values in printers/${prof?.id || '<printer>'}.json.`)),
    ];
  }

  /** Words that tie a fit, bolt or issue to the focused item (its id and name). */
  function relatedTo(f, text, parts = []) {
    if (!f) return false;
    if (f.kind === 'part' && parts.includes(f.id)) return true;
    const own = new Set([...designTokens(f.id), ...designTokens(f.name)].filter((t) => t.length >= 3));
    const tt = new Set(designTokens(text));
    const hits = [...own].filter((t) => tt.has(t)).length;
    return hits >= Math.min(2, own.size) && hits > 0;
  }

  function focusCard() {
    const file = state.appInfo?.file;
    if (!file || !app.data) return null;
    const f = state.focus;
    if (!f) {
      return h('div.ov-nomatch', null, h('span', null, 'Not in this project: ', h('b', null, file)),
        h('span.ov-muted', null, `Ask your AI to add it as a print or part so its sizes get checked.`));
    }
    const check = app.data.check;
    const lines = [];
    const it = f.item;
    if (f.kind === 'print') {
      const facts = [Array.isArray(it.size) ? `${it.size.map((x) => fmt(x, 1)).join(' × ')} mm` : null, it.material || app.data.project.printer?.material, it.status].filter(Boolean);
      lines.push(h('p.ov-focus-facts', null, boldDims(facts.join(', '))));
      const set = it.settings || {};
      const chips = [set.orientation && `Orientation: ${set.orientation}`, set.supports !== undefined && (set.supports ? 'Supports on' : 'No supports'), set.infill !== undefined && `${set.infill}% infill`, set.layer && `${set.layer} mm layers`, it.min_wall_mm && `${it.min_wall_mm} mm walls`].filter(Boolean);
      if (chips.length) lines.push(h('div.ov-chips', null, chips.map((c) => h('span', null, c))));
    } else {
      const def = app.part(f.id);
      const g = def?.geometry;
      const facts = [def?.name || f.name, def?.libraryId].filter(Boolean);
      lines.push(h('p.ov-focus-facts', null, facts.join(', ')));
      if (g?.board) {
        const holes = (g.holes || []).map((x) => x.d || x.diameter).filter(Boolean);
        lines.push(h('p.ov-focus-facts', null, boldDims(`Outline ${g.board.slice(0, 2).map((x) => fmt(x, 1)).join(' × ')} mm${holes.length ? `, ${g.holes.length} holes Ø${fmt(holes[0], 1)} mm` : ''}.`)));
      }
    }
    const sw = state.appInfo?.id === 'solidworks' ? state.sw : null;
    if (sw?.active) {
      const names = Array.isArray(sw.selectionNames) && sw.selectionNames.length ? sw.selectionNames.join(', ') : null;
      lines.push(h('p.ov-focus-sel', null, names ? ['Selected: ', h('b', null, names)] : sw.selected ? `${sw.selected} item${sw.selected === 1 ? '' : 's'} selected in SOLIDWORKS.` : 'Nothing selected in SOLIDWORKS.'));
    }
    const fits = (check.mechanics?.fits || []).filter((x) => relatedTo(f, x.id, x.parts || []) || (f.kind === 'part' && (app.data.project.mechanics?.fits || []).some((y) => y.id === x.id && (y.parts || []).includes(f.id))));
    if (fits.length) lines.push(h('div.mx-fits.compact', null, fits.map(fitCallout)));
    const bolts = (check.mechanics?.bolts || []).filter((b) => relatedTo(f, b.id));
    for (const b of bolts) lines.push(h('p.ov-focus-line', null, boldDims(`${b.id.charAt(0).toUpperCase()}${b.id.slice(1)}: ${b.per_bolt_n} N per bolt, holds ${b.capacity_n} N (${b.limited_by}).`)));
    const issues = (check.issues || []).filter((i) => i.level !== 'info' && (relatedTo(f, i.message, i.parts || []) || (f.kind === 'part' && (i.parts || []).includes(f.id))));
    if (issues.length) {
      lines.push(h('ul.ov-focus-issues', null, issues.slice(0, 6).map((i) => h(`li.${i.level}`, null,
        h('strong', null, i.level === 'error' ? 'Fix: ' : 'Check: '), boldDims(i.message)))));
    } else lines.push(h('p.ov-focus-ok', null, 'No checker problems name this item.'));
    if (f.steps.length) lines.push(h('p.ov-focus-step', null, `Used in step: `, h('b', null, f.steps.map((st) => st.title).join('; '))));
    return h('section.ov-focus', { 'aria-label': `Now designing ${f.name}` },
      h('p.ov-focus-kicker', null, `Now designing in ${state.appInfo?.label || 'this app'}`),
      h('h3', null, f.name),
      ...lines);
  }

  function renderBody() {
    state.focus = app.data && state.appInfo?.file ? matchDesign(app.data.project, app.data.name, state.appInfo.file) : null;
    const askOn = state.tab === 'ask';
    body.hidden = askOn;
    askSlot.hidden = !askOn;
    if (askOn) {
      if (app.companion && app.companion.root.parentNode !== askSlot) askSlot.append(app.companion.root);
      app.companion?.toggle(true);
      return;
    }
    const top = body.scrollTop;
    clear(body);
    if (!app.data) { body.append(h('p.ov-muted', null, 'Choose a project above.')); return; }
    const k = kind();
    const parts = [];
    if (state.tab === 'check' || state.tab === 'tol') parts.push(focusCard());
    if (state.tab === 'check') {
      if (k === 'slicer' || k === 'none') parts.push(slicerPrinterSection(), printsSection(), beforePrintSection());
      if (k === 'cad') parts.push(...cadSection());
      if (k === 'electronics' || k === 'firmware') parts.push(...wiringSection());
      if (k === 'none') parts.push(...cadSection().slice(1));
    } else if (state.tab === 'tol') parts.push(...toleranceTab());
    else if (state.tab === 'mech') parts.push(renderMechanics(app, { compact: true }));
    body.append(...parts.filter(Boolean));
    body.scrollTop = top;
  }

  async function poll() {
    try {
      const res = JSON.parse(await api('/api/apps'));
      // Follow the app in front; before the first answer, the app the overlay was opened for.
      const pick = res.primary || (res.apps || []).find((a) => a.id === params.get('app')) || null;
      const slicer = pick && res.slicers ? res.slicers[pick.id] || null : null;
      if (pick) state.appInfo = pick;
      state.slicer = slicer;
      if (state.appInfo?.id === 'solidworks') {
        try { state.sw = JSON.parse(await api('/api/solidworks')); } catch { state.sw = null; }
      }
      const key = JSON.stringify([pick?.id, pick?.file, slicer?.printer, slicer?.filaments, state.sw?.title, state.sw?.selected, state.sw?.selectionNames]);
      if (key !== state.key) { state.key = key; renderHead(); renderTabs(); if (state.tab !== 'ask') renderBody(); }
    } catch { /* server not reachable: keep the last view */ }
  }

  app.onProjectRendered = () => { renderProjects(); renderHead(); renderTabs(); renderBody(); };
  renderHead(); renderTabs(); renderProjects(); renderBody();
  poll();
  setInterval(() => { if (!document.hidden) poll(); }, 4000);
  return { root, render: renderBody };
}
