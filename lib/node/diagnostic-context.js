import { checkProject } from '../check.js';

function excerpt(value, limit = 160) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

export function projectDiagnosticContext(project, library, { id, target, corrections = [] }) {
  const check = checkProject(project, library);
  const [type, key] = target ? [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)] : [];
  const { model } = check;
  const getPin = (pinKey) => {
    const part = model.parts.get(pinKey.split('.')[0]);
    const pin = part?.pins.find((candidate) => candidate.key === pinKey);
    return pin ? { id: excerpt(pin.key), marking: excerpt(pin.label || pin.name), name: excerpt(pin.name), kind: excerpt(pin.kind), voltage: pin.voltage,
      note: excerpt(pin.note, 300), part: excerpt(part.label || part.name), library: excerpt(part.libraryId) } : { id: excerpt(pinKey) };
  };
  const related = (wire) => type === 'wire' ? wire.id === key
    : type === 'pin' ? wire.fromKey === key || wire.toKey === key
      : type === 'part' ? [wire.fromKey, wire.toKey].some((pin) => pin?.startsWith(`${key}.`)) : false;
  const wires = model.wires.filter(related);
  const belongs = (issue) => type === 'wire' ? issue.wires.includes(key) : type === 'pin' ? issue.pins.includes(key)
    : type === 'part' ? issue.parts.includes(key) : false;
  const relevant = check.issues.filter((issue) => belongs(issue) || issue.level !== 'info')
    .sort((a, b) => Number(belongs(b)) - Number(belongs(a)) || Number(b.level === 'error') - Number(a.level === 'error'));
  return {
    project: id, name: excerpt(project.meta?.name) || id, phase: excerpt(project.meta?.phase), printer: excerpt(project.printer?.profile),
    counts: { parts: model.partList.length, wires: model.wires.length, errors: check.errors, warnings: check.warnings },
    target: target || undefined, pin: type === 'pin' ? getPin(key) : undefined,
    parts: model.partList.slice(0, 16).map((part) => ({ id: excerpt(part.id), model: excerpt(part.libraryId), name: excerpt(part.label || part.name) })),
    connections: wires.filter((wire) => wire.valid).slice(0, 8).map((wire) => ({
      id: excerpt(wire.id), from: getPin(wire.fromKey), to: getPin(wire.toKey),
      label: excerpt(wire.label), purpose: excerpt(wire.purpose, 300), color: excerpt(wire.color),
      voltage: check.wireInfo[wire.id]?.voltage,
    })),
    issues: relevant.slice(0, 8).map(({ rule, level, message, fix }) => ({ rule, level, message: excerpt(message, 380), fix: excerpt(fix, 380) })),
    corrections: corrections.slice(-5).map(({ correction, evidence }) => ({ correction: excerpt(correction, 500), evidence: excerpt(evidence, 300) })),
  };
}
