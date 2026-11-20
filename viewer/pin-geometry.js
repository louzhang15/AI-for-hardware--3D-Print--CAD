const validFootprint = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

export function pinPlacement(part, pin, index) {
  const [width, height, depth] = part.size;
  const mapped = validFootprint(pin.pos);
  const [u, v] = mapped ? pin.pos : [(index + 1) * width / (part.pins.length + 1), depth / 2];
  const x = u - width / 2;
  const z = v - depth / 2;

  // In the file format, pin.z is height in mm above the part's bottom face.
  if (Number.isFinite(pin.z)) return { anchor: [x, pin.z, z], mapped };

  // An edge-mounted cable plug needs a sideways contact. Its footprint is
  // available for some parts, but its height varies by the physical variant.
  if (mapped && part.breadboard?.fit === 'offboard' && Array.isArray(part.geometry?.connectors)) {
    const connector = part.geometry.connectors.find((entry) => validFootprint(entry?.pos) &&
      Math.abs(u - entry.pos[0]) <= 1.5 && Math.abs(v - entry.pos[1]) <= 3 &&
      ((entry.side === 'left' && u <= 1.5) || (entry.side === 'right' && u >= width - 1.5)));
    if (connector) return { anchor: [x, height / 2, z], mapped: false, normal: [connector.side === 'left' ? -1 : 1, 0, 0] };
  }

  return { anchor: [x, height, z], mapped };
}
