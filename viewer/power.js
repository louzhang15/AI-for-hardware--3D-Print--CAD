import { budgetBar } from './panels.js';
import { clear, fmtA, fmtV, h, icon } from './util.js';
import { activeFocus, emptyView, markFocus } from './svg-view.js';

export class PowerTreeView {
  constructor(app, host) {
    this.app = app;
    this.host = host;
  }

  render() {
    const { app, host } = this;
    const { rails = [], runtime = [] } = app.data.check.power || {};
    const byNet = new Map(rails.map((rail) => [rail.net, rail]));
    const groups = new Map();
    for (const rail of rails) {
      const parent = byNet.has(rail.parent) ? rail.parent : null;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(rail);
    }
    const visited = new Set();
    this.entries = new Map();
    clear(host);
    if (!rails.length) {
      host.append(emptyView('No power rails detected', 'Connect a power source to the project to see typical and peak load.'));
      return;
    }

    const renderRail = (rail) => {
      if (visited.has(rail.net)) return null;
      visited.add(rail.net);
      const source = app.pinText(rail.source);
      const loads = h('ul.pt-loads', null, (rail.loads || []).map((load) => h('li', null,
        h('button.btn.ghost.small', { onclick: () => app.select({ type: 'pin', id: load.key }) }, app.pinText(load.key)),
        h('span.small.muted', null, `${fmtA(load.current)} typ · ${fmtA(load.peak)} peak`))));
      const card = h('div.rail.pt-card', { 'data-rail': rail.net },
        h('div.rail-head', null, h('span.v', null, fmtV(rail.voltage)),
          h('button.btn.ghost.small.name', { onclick: () => app.select({ type: 'rail', id: rail.net }) }, source),
          h(`span.pill.${rail.status === 'error' ? 'error' : rail.status === 'warn' ? 'warn' : 'ok'}`, null,
            rail.status === 'error' ? 'Over budget' : rail.status === 'warn' ? 'Low headroom' : 'Within budget')),
        budgetBar(rail), loads.childElementCount ? loads : h('p.small.muted', null, 'No connected loads'));
      this.entries.set(rail.net, { rail, card });
      const children = (groups.get(rail.net) || []).map(renderRail).filter(Boolean);
      return h('li', null, card, children.length ? h('ul.pt-branches', null, children) : null);
    };
    const roots = (groups.get(null) || []).map(renderRail);
    for (const rail of rails) if (!visited.has(rail.net)) roots.push(renderRail(rail));
    host.append(h('div.power-tree', null,
      h('h2', null, icon('bolt'), 'Power tree'),
      h('ul.pt-roots', null, roots),
      runtime.length ? h('section', null, h('h3', null, 'Battery runtime'), runtime.map((entry) =>
        h('p', null, `${app.part(entry.battery)?.name || entry.battery} · ${entry.hours} h at ${fmtA(entry.avg)} average`,
          entry.formula && h('span.small.muted', null, ` (${entry.formula})`)))) : null));
  }

  applyFocus(focus) {
    if (!this.entries) return;
    // A signal selection may have no connection to a power rail.
    const matches = new Set([...this.entries].filter(([net, { rail }]) => focus.nets.has(net) || focus.parts.has(rail.sourcePart) ||
      (rail.loads || []).some((load) => focus.parts.has(load.part))).map(([net]) => net));
    for (const [net, { card }] of this.entries) markFocus(card, activeFocus(focus) && matches.size && !matches.has(net), matches.has(net));
  }
}
