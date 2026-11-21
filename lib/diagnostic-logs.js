export const MAX_DIAGNOSTIC_TEXT = 12_000;

const symptoms = [
  [/brownout|brown.out detector/i, 'A brownout is reported. Measure voltage at the controller under load and compare it during actuator startup.'],
  [/guru meditation|backtrace:|hardfault|stack overflow/i, 'A crash or backtrace is logged. Preserve the first error and decode its addresses against the matching firmware build.'],
  [/i2c.{0,45}(nack|not found|timed? out)|(?:nack|no ack).{0,28}i2c/i, 'I²C communication failed. Compare the bus and address with firmware, then check supply, ground, and SDA/SCL on the actual board.'],
  [/incompatible qos|incompatible.*(reliability|durability)/i, 'ROS reports incompatible QoS. Compare the publisher and subscriber reliability and durability settings.'],
  [/extrapolation (?:into|would require)|lookuptransform|invalid frame id/i, 'A ROS transform lookup failed. Compare the frame names, transform timestamps, and clock settings.'],
  [/could not contact.*(daemon|master)|failed to discover|no publisher/i, 'ROS discovery or publication failed. Check the graph and matching ROS domain and network settings.'],
];

export function prepareLogEvidence(log) {
  if (!log || typeof log.name !== 'string' || typeof log.text !== 'string') return null;
  const raw = log.text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\b(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\b((?:[\w-]*_)?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;{}]+)/gi, '$1[redacted]')
    .trim();
  if (!raw) return null;
  const text = raw.slice(-MAX_DIAGNOSTIC_TEXT);
  const name = log.name.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'Diagnostic log';
  return { name, text, truncated: log.truncated === true || raw.length > text.length,
    findings: symptoms.filter(([pattern]) => pattern.test(text)).map(([, hint]) => hint) };
}
