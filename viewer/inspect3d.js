import { ROLE_LABELS } from '../lib/nets.js';
import { fmtV, h, splitKey } from './util.js';

const PIN_KINDS = {
  power_in: 'Power input', power_out: 'Power output', power_rail: 'Power rail',
  uart_tx: 'UART transmit', uart_rx: 'UART receive', passive: 'Passive', nc: 'No connect',
};

const endpoint = (wire, end) => wire[`${end}Key`] || wire[end];

export function createInspector(view) {
  const { app } = view;
  let model;
  let listedPart;
  let listedPin;
  let listedMapPart;
  let listedWireSelection;
  let mapEntries = [];
  let connections = [];
  let activePin = '';

  const choosePart = h('select.input', { 'aria-label': 'Component', onchange: () => selectPart(choosePart.value) });
  const chooseWire = h('select.input', { 'aria-label': 'Connection', onchange: () => {
    if (chooseWire.value) app.select({ type: 'wire', id: chooseWire.value }, { sheet: false });
    else app.clearSelection();
  } });
  const choosePin = h('select.input', { 'aria-label': 'Pin', onchange: () => {
    if (choosePin.value) app.select({ type: 'pin', id: choosePin.value }, { sheet: false });
    else selectPart(choosePart.value);
  } });
  const focus = h('button.btn.small.scene-inspect-focus', { type: 'button', onclick: () => {
    const selection = app.selection;
    if (selection?.type === 'wire' && typeof view.focusWire === 'function') view.focusWire(selection.id);
    else if (choosePart.value && typeof view.focusPart === 'function') view.focusPart(choosePart.value);
  } }, 'Inspect pins');
  const clear = h('button.btn.ghost.small.scene-inspect-clear', { type: 'button', 'aria-label': 'Clear connection selection',
    onclick: () => { app.clearSelection(); choosePart.focus(); } }, 'Clear');
  const picker = h('div.scene-inspect-picker', null,
    h('label.scene-inspect-field.scene-connection-field', null, 'Connection', chooseWire),
    h('label.scene-inspect-field', null, 'Component', choosePart),
    h('label.scene-inspect-field', null, 'Pin', choosePin),
    typeof view.focusPart === 'function' || typeof view.focusWire === 'function' ? focus : null, clear);

  const summary = h('div.scene-inspect-summary', { 'aria-live': 'polite' });
  const ask = h('button.btn.ghost.small.scene-inspect-ask', { type: 'button', hidden: true, onclick: () => {
    const selection = app.selection;
    if (selection?.type === 'wire') {
      const wire = app.describeWire(selection.id);
      if (wire) app.askWithNote({ kind: 'ask', target: `wire:${selection.id}`, title: 'Ask about this wire',
        context: `Help troubleshoot wire ${selection.id} (${wire.label}) from ${app.pinText(wire.from)} (${wire.from}) to ${app.pinText(wire.to)} (${wire.to}).`,
        placeholder: 'What are you seeing?' });
    } else if (selection?.type === 'pin') {
      app.askWithNote({ kind: 'ask', target: `pin:${selection.id}`, title: 'Ask about this pin',
        context: `Help troubleshoot ${app.pinText(selection.id)} (${selection.id}) and its connections.`, placeholder: 'What are you seeing?' });
    }
  } });
  const selectedWire = h('div.scene-inspect-wire', { hidden: true });
  const wireList = h('ul.scene-inspect-connections', { 'aria-label': 'Connected wires', hidden: true });
  const issues = h('ul.scene-inspect-issues', { 'aria-label': 'Checker messages for this selection', hidden: true });
  const mapTitle = h('summary', null, 'Pin list');
  const search = h('input.input', { type: 'search', placeholder: 'Find a pin', 'aria-label': 'Find a pin', oninput: filterPins });
  const pinList = h('div.scene-pin-list');
  const pinMap = h('details.scene-pin-map', { hidden: true }, mapTitle, search, pinList);
  const details = h('section.scene-inspect-details', { 'aria-label': '3D connection inspector' },
    summary, selectedWire, wireList, issues, ask, pinMap);

  function filterPins() {
    const term = search.value.trim().toLowerCase();
    for (const entry of mapEntries) entry.button.hidden = !entry.text.includes(term);
  }

  function updatePinMap(part, key, changed) {
    pinMap.hidden = !part?.pins.length;
    if (changed || part !== listedMapPart) {
      listedMapPart = part;
      search.value = '';
      const pins = part?.pins || [];
      const wired = view.wiredPins || new Set();
      mapTitle.textContent = `Pin list · ${pins.filter((pin) => wired.has(pin.key)).length} of ${pins.length} wired`;
      mapEntries = pins.map((pin) => {
        const label = app.pinText(pin.key, false);
        return { key: pin.key, text: `${label} ${pin.key}`.toLowerCase(), button: h('button.scene-pin-button', {
          type: 'button', onclick: () => app.select({ type: 'pin', id: pin.key }, { sheet: false }),
        }, h('b', null, label), h('span.small', null, wired.has(pin.key) ? 'Wired' : 'Unwired')) };
      });
      pinList.replaceChildren(...mapEntries.map((entry) => entry.button));
    }
    for (const entry of mapEntries) entry.button.setAttribute('aria-pressed', String(entry.key === key));
  }

  function selectPart(id) {
    if (id) {
      app.select({ type: 'part', id }, { sheet: false });
      view.focusPart?.(id);
    }
    else app.clearSelection();
  }

  function showConnections(pinKey) {
    connections = [];
    if (pinKey) {
      for (const wire of model?.wires || []) {
        const from = endpoint(wire, 'from');
        const to = endpoint(wire, 'to');
        if (wire.valid === false || (pinKey !== from && pinKey !== to)) continue;
        const other = pinKey === from ? to : from;
        if (!other || !app.pin(other)) continue;
        const description = app.describeWire(wire.id);
        const label = wire.label || description?.label || wire.id;
        const otherLabel = app.pinText(other);
        const button = h('button.btn.small.scene-inspect-wire-button', { type: 'button', 'aria-label': `Inspect wire ${label}`,
          onclick: () => app.select({ type: 'wire', id: wire.id }, { sheet: false }) }, label);
        const farButton = h('button.btn.ghost.small.scene-inspect-endpoint', { type: 'button', 'aria-label': `Inspect ${otherLabel}`,
          onclick: () => { app.select({ type: 'pin', id: other }, { sheet: false }); choosePin.focus(); } }, otherLabel);
        connections.push({ id: wire.id, button, row: h('li.scene-inspect-row', null, button, h('span', { 'aria-hidden': 'true' }, '↔'), farButton) });
      }
    }
    wireList.replaceChildren(...connections.map(({ row }) => row));
    wireList.hidden = !connections.length;
  }

  function update() {
    const check = app.data?.check;
    const newModel = check?.model;
    const changed = model !== newModel;
    model = newModel;
    const parts = model?.partList || [];
    const selection = app.selection;
    const wire = selection?.type === 'wire' ? app.describeWire(selection.id) : null;
    let pinKey = selection?.type === 'pin' && app.pin(selection.id) ? selection.id : '';
    if (wire) {
      const pins = [wire.from, wire.to].filter((key) => key && app.pin(key));
      pinKey = pins.includes(activePin) ? activePin : pins.find((key) => splitKey(key).part === choosePart.value) || pins[0] || '';
    }
    activePin = pinKey;
    const partId = pinKey ? splitKey(pinKey).part : selection?.type === 'part' ? selection.id : '';
    const part = partId ? app.part(partId) : null;

    if (changed || !choosePart.options.length) choosePart.replaceChildren(
      h('option', { value: '' }, parts.length ? 'Choose a component' : 'No components'),
      ...parts.map((entry) => h('option', { value: entry.id }, entry.label || entry.name || entry.id)));
    if (changed || !chooseWire.options.length) chooseWire.replaceChildren(
      h('option', { value: '' }, 'Choose a wire'),
      ...(model?.wires || []).filter((entry) => entry.valid !== false).map((entry) => {
        const description = app.describeWire(entry.id);
        return h('option', { value: entry.id }, description?.title || entry.label || entry.id);
      }));
    chooseWire.value = wire ? selection.id : '';
    chooseWire.disabled = chooseWire.options.length < 2;
    choosePart.value = part?.id || '';
    choosePart.disabled = !parts.length;
    if (changed || part !== listedPart || !choosePin.options.length) {
      listedPart = part;
      choosePin.replaceChildren(
        h('option', { value: '' }, !part ? 'Choose a component first' : part.pins.length ? 'Choose a pin' : 'No pins'),
        ...(part?.pins || []).map((pin) => h('option', { value: pin.key }, pin.label && pin.label !== pin.name ? `${pin.label} (${pin.name})` : pin.name)));
    }
    choosePin.value = pinKey;
    choosePin.disabled = !part?.pins.length;
    const canFocusWire = wire && typeof view.focusWire === 'function';
    focus.textContent = canFocusWire ? 'Focus connection' : 'Inspect pins';
    focus.disabled = !canFocusWire && !(part && typeof view.focusPart === 'function');
    clear.disabled = !selection;

    if (changed || pinKey !== listedPin) {
      listedPin = pinKey;
      showConnections(pinKey);
    }
    wireList.hidden = Boolean(wire) || !connections.length;
    for (const { id, row, button } of connections) {
      const selected = id === selection?.id && selection.type === 'wire';
      row.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }

    const geometry = part && view.geometry?.get(part.id);
    const partMapping = geometry === 'mapped' ? 'Library pin positions' : geometry === 'estimated' ? 'Estimated pin positions' : '';
    const pin = pinKey ? app.pin(pinKey) : null;
    let content;
    if (pin) {
      const mapped = view.pins?.get(pinKey)?.userData?.mapped;
      const mapping = mapped === true ? 'Library pin position' : mapped === false ? 'Estimated pin position' : partMapping;
      const pi = check.pinInfo?.[pinKey];
      const wireFacts = connections.map(({ id }) => app.wireInfo(id));
      const role = pi?.role || wireFacts.find((info) => info?.role)?.role;
      const voltage = check.netInfo?.[pi?.net]?.voltage ?? wireFacts.find((info) => Number.isFinite(info?.voltage))?.voltage ?? pin.voltage;
      const rating = Number.isFinite(voltage) ? `Expected ${fmtV(voltage)}` : Number.isFinite(pin.vmax) ? `Max ${fmtV(pin.vmax)}` : '';
      const count = connections.length;
      const description = [ROLE_LABELS[role || pin.kind] || PIN_KINDS[pin.kind], rating, count ? `${count} connected ${count === 1 ? 'wire' : 'wires'}` : 'No connected wires', mapping];
      content = [h('strong', null, app.pinText(pinKey)),
        h('span.scene-inspect-meta', null, description.filter(Boolean).join(' · '))];
    } else if (part) {
      content = [h('strong', null, part.label || part.name || part.id),
        h('span.scene-inspect-meta', null, [partMapping, part.pins.length ? 'Match these labels to the markings on your board.' : 'This component has no pins.'].filter(Boolean).join(' · '))];
    } else {
      content = [h('span.scene-inspect-meta', null, 'Choose one wire to see exactly where both ends go, or choose a component for its pin list.')];
    }
    summary.hidden = Boolean(wire);
    summary.replaceChildren(...content);
    ask.hidden = typeof app.askWithNote !== 'function' || !(wire || (selection?.type === 'pin' && pin));
    ask.textContent = wire ? 'Ask about this wire' : 'Ask about this pin';
    selectedWire.hidden = !wire;
    const wireSelection = wire ? selection.id : null;
    if (changed || wireSelection !== listedWireSelection) {
      listedWireSelection = wireSelection;
      selectedWire.replaceChildren();
      if (wire) {
        const labels = [wire.from, wire.to].map((key) => {
          const pin = app.pin(key);
          const partId = splitKey(key).part;
          const part = app.part(partId);
          const name = part?.label || part?.name || partId;
          return h('button.scene-wire-end', {
            type: 'button', 'aria-label': `Inspect ${app.pinText(key)}`, title: name,
            onclick: () => app.select({ type: 'pin', id: key }, { sheet: false }),
          }, h('span.scene-end-part', null, name),
          h('span.scene-end-pin', null, h('strong', null, pin?.label || pin?.name || key),
            pin?.label && pin.label !== pin.name ? h('span', null, pin.name) : null));
        });
        const details = wire.facts.filter((fact) => fact[0] === 'Colour' || fact[0] === 'Voltage');
        selectedWire.append(h('strong', null, wire.label), details.length
          ? h('span.scene-wire-facts', null, details.map(([name, value]) => `${name} ${value}`).join(' · ')) : null, h('div.scene-wire-path', null,
          labels[0], h('span', { 'aria-hidden': 'true' }, '↔'), labels[1]));
      }
    }

    const matches = (check?.issues || []).filter((issue) => (issue.level === 'error' || issue.level === 'warning')
      && (selection?.type === 'pin' ? issue.pins?.includes(selection.id) : selection?.type === 'wire' && issue.wires?.includes(selection.id)));
    issues.replaceChildren(...matches.map((issue) => h(`li.scene-inspect-issue.${issue.level}`, null,
      h('strong', null, issue.level === 'error' ? 'Error' : 'Warning'), h('span', null, issue.message || issue.rule))));
    issues.hidden = !matches.length;
    updatePinMap(part, pinKey, changed);
  }

  update();
  return { picker, details, update, showPinList: () => { pinMap.open = true; } };
}
