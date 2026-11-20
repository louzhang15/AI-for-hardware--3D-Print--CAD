// Keyword matcher shared by the Claude Code prompt hook and its tests.
// Matches everyday hardware / CAD / 3D-printing language, not ordinary coding.

const WORDS = [
  // electronics
  'wiring', 'wire', 'wires', 'wired', 'rewire', 'pinout', 'pin out', 'breadboard', 'jumper', 'solder', 'soldering', 'voltage', 'volts',
  'amps', 'amperage', 'current draw', 'milliamp', 'mah', 'esp32', 'esp8266', 'arduino', 'raspberry pi', 'pi pico', 'rp2040', 'microcontroller',
  'servo', 'servos', 'stepper', 'nema', 'dc motor', 'motor driver', 'motors', 'l298n', 'tb6612', 'drv8825', 'a4988', 'pca9685', 'mosfet',
  'transistor', 'resistor', 'capacitor', 'diode', 'led strip', 'neopixel', 'ws2812', 'i2c', 'uart', 'pwm', 'gpio', 'spi bus', 'sensor',
  'ultrasonic', 'hc-sr04', 'mpu6050', 'imu', 'lidar', 'buck converter', 'boost converter', 'regulator', 'lipo', 'li-ion', '18650', 'battery pack',
  'bms', 'fuse', 'power supply', 'psu', 'brownout', 'browns out', 'resets when', 'jitter', 'jitters', 'multimeter', 'schematic', 'circuit',
  'pcb', 'kicad', 'fritzing', 'logic level', 'level shifter', '3.3v', '5v', '12v', 'ground loop', 'common ground', 'relay', 'robot', 'robotic',
  'drone', 'quadcopter', 'rover', 'iot', 'smart lamp', 'weather station', 'electronics', 'hardware build', 'firmware pins', 'pins.h',
  // CAD / printing
  'cad', 'stl', 'step file', '3mf', 'build123d', 'cadquery', 'openscad', 'freecad', 'fusion 360', 'fusion360', 'onshape', 'bracket', 'mount',
  'enclosure', 'case for', 'housing', 'standoff', 'heat-set', 'heat set insert', 'threaded insert', '3d print', '3d-print', '3d printer',
  '3d printed', 'printable', 'slicer', 'bambu', 'a1 mini', 'p1s', 'p2s', 'x1c', 'x1 carbon', 'h2d', 'orcaslicer', 'prusaslicer', 'prusa',
  'ender', 'klipper', 'octoprint', 'filament', 'pla', 'petg', 'abs', 'asa', 'tpu', 'infill', 'supports', 'build plate', 'build volume',
  'tolerance', 'clearance fit', 'press fit', 'dovetail',
];

function escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const PATTERN = new RegExp(`(^|[^a-z0-9])(${WORDS.map(escape).sort((a, b) => b.length - a.length).join('|')})(?=$|[^a-z0-9])`, 'i');

// Words that look like hardware terms but usually are not, in coding talk.
const CODING_CONTEXT = /\b(css|html|react|component|api route|endpoint|webpack|eslint|sql|database|docker|kubernetes|unit test|regex|typescript|django|flask)\b/i;
const WEAK = new Set(['wire', 'wires', 'wired', 'mount', 'circuit', 'sensor', 'supports', 'case for', 'housing', 'jumper', 'tolerance', 'abs', 'pla', 'cad', 'psu', 'fuse', 'relay', 'regulator', 'imu']);

/** @returns {{match: boolean, keyword?: string}} */
export function matchHardware(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) return { match: false };
  const text = prompt.toLowerCase();
  const re = new RegExp(PATTERN.source, 'gi');
  let m;
  const hits = [];
  while ((m = re.exec(text))) hits.push(m[2].toLowerCase());
  if (!hits.length) return { match: false };
  const strong = hits.filter((h) => !WEAK.has(h));
  if (strong.length) return { match: true, keyword: strong[0] };
  // Only weak words: require no coding context, or two different weak words.
  if (!CODING_CONTEXT.test(text) || new Set(hits).size >= 2) return { match: true, keyword: hits[0] };
  return { match: false };
}

export const REMINDER = 'This looks like a hardware, electronics, CAD or 3D printing task. Use the wiremap skill: keep the design in a project file, run `wiremap check` until 0 errors, use `wiremap calc` for every number, and show the user the local viewer.';
