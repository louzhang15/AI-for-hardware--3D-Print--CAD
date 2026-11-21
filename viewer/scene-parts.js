import * as THREE from 'three';

// These component silhouettes are for orientation. Pin coordinates are
// supplied separately by the library and do not depend on the preview.
export function makeComponentPreview(part, size, color) {
  const id = part.libraryId;
  if (!['esp32-devkit-v1', 'pca9685-breakout', 'servo-sg90'].includes(id)) return null;

  const [width, height, depth] = size;
  const group = new THREE.Group();
  const boardY = height * .40;
  const boardThickness = Math.min(height * .18, 1.6);
  const deck = boardY + boardThickness;
  const materials = new Map();

  function block(fractionX, bottom, top, fractionZ, x, z, tint) {
    if (!materials.has(tint)) materials.set(tint, new THREE.MeshStandardMaterial({ color: tint, roughness: .7 }));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width * fractionX, top - bottom, depth * fractionZ), materials.get(tint));
    mesh.position.set(width * x, (bottom + top) / 2, depth * z);
    group.add(mesh);
  }

  if (id === 'servo-sg90') {
    const shell = new THREE.Color(color).lerp(new THREE.Color('#273d58'), .42);
    block(.70, 0, height * .74, .96, 0, 0, shell);
    block(1, height * .47, height * .53, 1, 0, 0, shell);
    block(.70, height * .72, height * .80, .96, 0, 0, '#31455c');
    for (const [radius, bottom, top, tint] of [
      [.36, .80, .91, '#36516d'], [.19, .91, 1, '#d2dbe4'],
    ]) {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius * depth, radius * depth, (top - bottom) * height, 16),
        new THREE.MeshStandardMaterial({ color: tint, roughness: .66 }));
      shaft.position.set(width * .17, height * (top + bottom) / 2, 0);
      group.add(shaft);
    }
    return group;
  }

  const pcb = new THREE.Color(color).lerp(new THREE.Color('#23624d'), .48);
  block(1, boardY, deck, 1, 0, 0, pcb);

  const dark = '#202831';
  const metal = '#a6b5c0';
  if (id === 'esp32-devkit-v1') {
    for (const x of [-.405, .405]) {
      block(.09, 0, boardY, .73, x, .095, dark);
      block(.105, deck, height * .87, .73, x, .095, dark);
    }
    // Module and antenna at one end, USB shell at the opposite end.
    block(.62, deck, height * .78, .51, 0, -.20, '#244438');
    block(.56, height * .78, height, .28, 0, -.15, metal);
    block(.29, deck, height * .85, .15, 0, .425, metal);
    block(.20, height * .57, height * .76, .008, 0, .496, dark);
    for (const x of [-.23, .23]) block(.10, deck, height * .74, .065, x, .396, '#374455');
  } else {
    // Four groups of three-row servo headers and the separate power terminal.
    for (const x of [-.292, -.089, .114, .317]) {
      block(.166, 0, boardY, .28, x, .325, dark);
      block(.166, deck, height * .86, .28, x, .325, dark);
    }
    for (const x of [-.451, .451]) block(.075, deck, height * .84, .56, x, -.06, dark);
    block(.216, deck, height, .28, 0, -.358, '#276650');
    for (const x of [-.055, .055]) block(.04, height * .88, height, .065, x, -.355, metal);
    block(.205, deck, height * .65, .25, .076, -.016, '#2c333b');
  }
  return group;
}
