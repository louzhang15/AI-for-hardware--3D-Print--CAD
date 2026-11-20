import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clear, h, layoutPositions, partColor } from './util.js';
import { activeFocus, emptyView, tool } from './svg-view.js';
import { createInspector } from './inspect3d.js';
import { pinPlacement } from './pin-geometry.js';
import { tagName, silkscreen } from './pinout.js';
import { store } from './util.js';

const axis = new THREE.Vector3(0, 1, 0);
const angle = new THREE.Vector3(.65, 1, .85).normalize();
const overhead = new THREE.Vector3(0, 1, .0001).normalize();
const assetPattern = /\.(?:stl|3mf|glb|gltf)$/i;
const fromFile = (path) => /^((prints|cad)\/)/.test(path) && assetPattern.test(path);
const coordinates = (value, fallback) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : fallback;
const dims = (value) => coordinates(value, [40, 8, 24]).map((n) => Math.max(1, n));

function release(object) {
  object.traverse((mesh) => {
    mesh.geometry?.dispose();
    for (const material of [mesh.material].flat().filter(Boolean)) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
}

async function loadAsset(path, color) {
  const url = `/files/${path.split('/').map(encodeURIComponent).join('/')}`;
  if (/\.(gltf|glb)$/i.test(path)) {
    const manager = new THREE.LoadingManager().setURLModifier((resource) => {
      const resolved = new URL(resource, location.origin);
      if (resolved.protocol === 'data:' || resolved.protocol === 'blob:' ||
        (resolved.origin === location.origin && resolved.pathname.startsWith('/files/'))) return resource;
      // Let the loader report an ordinary load failure without requesting an external host.
      return '/files/';
    });
    return (await new GLTFLoader(manager).loadAsync(url)).scene;
  }
  const mesh = /\.stl$/i.test(path)
    ? new THREE.Mesh(await new STLLoader().loadAsync(url), new THREE.MeshStandardMaterial({ color }))
    : await new ThreeMFLoader().loadAsync(url);
  // Mesh files from slicers and CAD are Z-up. Wiremap places parts on an XZ desk.
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function wireShape(start, end, lift, radius) {
  const curve = new THREE.CubicBezierCurve3(start, start.clone().addScaledVector(axis, lift), end.clone().addScaledVector(axis, lift), end);
  return new THREE.TubeGeometry(curve, 24, radius, 7, false);
}

function setShade(material, highlighted) {
  const shades = material.userData.wiremap || (material.userData.wiremap = { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite });
  material.opacity = highlighted ? shades.opacity : shades.opacity * .14;
  material.transparent = !highlighted || shades.transparent;
  material.depthWrite = highlighted && shades.depthWrite;
}

export class Scene3DView {
  constructor(app, host, { mode }) {
    this.app = app;
    this.host = host;
    this.assembly = mode === 'assembly';
    this.filter = '';
    this.exploded = false;
    this.showOtherWires = false;
    this.showUnused = false;
    this.generation = 0;
    this.frame = null;
    this.visible = false;
    this.holo = store.get('wiremap.holo', false) === true;
    this.pinNames = true;
  }

  render() {
    const firstRender = !this.renderer;
    if (!this.renderer && !this.setup()) return;
    for (const child of [...this.contents.children]) { release(child); child.removeFromParent(); }
    this.parts = new Map();
    this.prints = new Map();
    this.pins = new Map();
    this.geometry = new Map();
    this.wires = new Map();
    this.status.hidden = true;
    const generation = ++this.generation;
    const { partList, wires } = this.app.data.check.model;
    this.wiredPins = new Set(wires.filter((wire) => wire.valid).flatMap((wire) => [wire.fromKey, wire.toKey]));
    const positions = layoutPositions(partList);
    for (const part of partList) this.addPart(part, positions.get(part.id), generation);
    if (this.assembly) {
      for (const [i, print] of (this.app.data.project.prints || []).entries()) this.addPrint(print, i, generation);
    }
    for (const wire of wires) if (wire.valid) this.addWire(wire);
    if (this.holo) this.applyHolo();
    else {
      this.grid.visible = Boolean(this.gridOn);
      this.grid.material.color = new THREE.Color('#91a0b3');
      this.grid.material.opacity = .27;
    }
    this.applyFocus(this.app.focus);
    if (firstRender) this.fit();
  }

  setup() {
    try { this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch {
      const fallback = emptyView('3D graphics are unavailable', 'This browser could not initialize WebGL. The circuit and part list are available in Sketch.');
      fallback.append(tool('Open Sketch', 'chip', () => this.app.switchView('sketch')));
      clear(this.host).append(fallback);
      return false;
    }
    const { renderer } = this;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.setAttribute('aria-label', this.assembly ? '3D assembly' : '3D circuit');
    this.labelLayer = h('div.label-layer', { 'aria-hidden': 'true' });
    this.canvasHost = h('div.three-host', null, renderer.domElement, this.labelLayer);
    this.status = h('p.small.scene-status', { role: 'status', hidden: true });
    this.inspector = this.assembly ? null : createInspector(this);
    clear(this.host).append(h('div.scene-workspace', null, this.inspector?.picker, this.canvasHost, this.inspector?.details, this.status));
    this.scene = new THREE.Scene();
    this.contents = new THREE.Group();
    this.camera = new THREE.PerspectiveCamera(45, 1, .1, 30000);
    this.camera.position.copy(angle).multiplyScalar(300);
    this.grid = new THREE.GridHelper(480, 24, '#90a4ba', '#91a0b3');
    this.grid.position.y = -.1;
    this.grid.material.transparent = true;
    this.grid.material.opacity = .27;
    this.grid.material.depthWrite = false;
    this.grid.visible = false;
    this.gridOn = false;
    const light = new THREE.DirectionalLight(0xffffff, 2.3);
    light.position.set(250, 400, 180);
    this.scene.add(this.contents, this.grid, light, new THREE.HemisphereLight(0xffffff, 0x485365, 2));
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.minDistance = 8;
    this.controls.maxDistance = 8000;
    this.controls.addEventListener('change', () => this.requestDraw());
    this.ray = new THREE.Raycaster();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvasHost);
    this.onTheme();
    this.bindPointer();
    return true;
  }

  addPart(part, position, generation) {
    const target = { type: 'part', id: part.id };
    const size = dims(part.size);
    const item = this.addBox(target, size, position, part.rotation, partColor(part));
    this.parts.set(part.id, item);
    const body = { ...part, size };
    let mapped = true;
    for (const [i, pin] of part.pins.entries()) {
      const placement = pinPlacement(body, pin, i);
      mapped &&= placement.mapped;
      const marker = new THREE.Group();
      const metal = new THREE.MeshStandardMaterial({ color: '#d1a651', roughness: .42, metalness: .22 });
      const contact = new THREE.Mesh(new THREE.CylinderGeometry(.69, .69, 1.6, 9), metal);
      contact.position.y = .36;
      const insulator = new THREE.Mesh(new THREE.BoxGeometry(1.8, .65, 1.8), new THREE.MeshStandardMaterial({ color: '#26364a' }));
      insulator.position.y = -.26;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.08, .23, 8, 18), new THREE.MeshBasicMaterial({ color: '#2f70ed' }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 1.18;
      ring.visible = false;
      marker.add(contact, insulator, ring);
      marker.position.fromArray(placement.anchor);
      if (placement.normal) marker.quaternion.setFromUnitVectors(axis, new THREE.Vector3().fromArray(placement.normal).normalize());
      marker.userData.target = { type: 'pin', id: pin.key };
      marker.userData.ring = ring;
      marker.userData.mapped = placement.mapped;
      item.group.add(marker);
      this.pins.set(pin.key, marker);
    }
    this.geometry.set(part.id, mapped && part.pins.length ? 'mapped' : 'estimated');
    if (part.model && fromFile(part.model)) this.showAsset(item, [part.model], partColor(part), generation);
  }

  addPrint(print, index, generation) {
    const target = { type: 'print', id: print.id };
    const [x, y, z] = dims(print.size);
    // Print dimensions use the slicer's X, Y, Z order.
    const size = [x, z, y];
    const position = coordinates(print.position, [(index - 1) * 74, 0, 65]);
    const color = print.color || '#729ee4';
    const item = this.addBox(target, size, position, print.rotation, color);
    item.explode = coordinates(print.explode, [(index - 1) * 24, 32 + index * 10, 0]);
    if (this.exploded) item.group.position.add(new THREE.Vector3().fromArray(item.explode));
    this.prints.set(print.id, item);
    const pieces = (print.pieces || []).map((piece) => piece.file).filter((path) => path && fromFile(path));
    const file = (print.files || []).find((path) => fromFile(path));
    if (pieces.length || file) this.showAsset(item, pieces.length ? pieces : [file], color, generation);
  }

  addBox(target, size, position, rotation, color) {
    const group = new THREE.Group();
    group.userData.target = target;
    group.position.fromArray(coordinates(position, [0, 0, 0]));
    group.rotation.set(...coordinates(rotation, [0, 0, 0]).map(THREE.MathUtils.degToRad));
    const placeholder = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial({ color, roughness: .7 }));
    placeholder.position.y = size[1] / 2;
    group.add(placeholder);
    this.contents.add(group);
    return { group, position: group.position.clone(), placeholder };
  }

  async showAsset(item, paths, color, generation) {
    const results = await Promise.allSettled(paths.map((path) => loadAsset(path, color)));
    const assets = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    if (this.generation !== generation || assets.length !== paths.length) {
      for (const asset of assets) release(asset);
      if (this.generation === generation) {
        this.status.textContent = 'Some 3D files could not be loaded. Their dimensions are shown as placeholder blocks.';
        this.status.hidden = false;
      }
      return;
    }
    const model = new THREE.Group();
    model.add(...assets);
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) { release(model); return; }
    const center = box.getCenter(new THREE.Vector3());
    model.position.set(-center.x, -box.min.y, -center.z);
    item.group.add(model);
    item.placeholder.removeFromParent();
    release(item.placeholder);
    this.applyFocus(this.app.focus);
  }

  addWire(wire, item = null) {
    const from = this.pins.get(wire.fromKey);
    const to = this.pins.get(wire.toKey);
    if (!from || !to) return;
    const a = from.getWorldPosition(new THREE.Vector3());
    const b = to.getWorldPosition(new THREE.Vector3());
    const info = this.app.wireInfo(wire.id);
    const lift = Math.max(10, Math.min(55, a.distanceTo(b) * .22));
    const radius = info.role === 'power' ? .9 + Math.min(1.6, Math.sqrt(info.current || 0) * .35) : .85;
    const geometry = wireShape(a, b, lift, radius);
    if (item) {
      item.mesh.geometry.dispose();
      item.mesh.geometry = geometry;
      return;
    }
    const color = !info.color || ['#16191f', '#111111', '#000000'].includes(info.color) ? '#858893' : info.color;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: .52 }));
    mesh.userData.target = { type: 'wire', id: wire.id };
    this.contents.add(mesh);
    this.wires.set(wire.id, { mesh, wire, role: info.role });
  }

  applyFocus(focus) {
    if (!this.parts) return;
    const selection = this.app.selection;
    const selectedPart = selection?.type === 'part' ? selection.id : selection?.type === 'pin' ? selection.id.split('.')[0] : null;
    if (selectedPart !== this.inspectedPart) this.inspectedPart = null;
    if (selection?.type === 'pin') {
      const pins = new Set([selection.id]);
      const wires = new Set();
      for (const [id, { wire }] of this.wires) {
        if (wire.fromKey !== selection.id && wire.toKey !== selection.id) continue;
        wires.add(id);
        pins.add(wire.fromKey);
        pins.add(wire.toKey);
      }
      focus = { ...focus, wires, pins, parts: new Set([...pins].map((key) => key.split('.')[0])) };
    }
    const dim = activeFocus(focus);
    const shade = (object, lit, ignorePins = false) => object.traverse((child) => {
      if (ignorePins && child.userData.target?.type === 'pin') return;
      for (const material of [child.material].flat().filter(Boolean)) setShade(material, lit);
    });
    for (const [id, item] of this.parts) shade(item.group, !dim || focus.parts.has(id), true);
    for (const [id, item] of this.prints) shade(item.group, !dim || focus.prints.has(id));
    for (const [key, pin] of this.pins) {
      const selected = selection?.type === 'pin' && selection.id === key;
      const part = key.split('.')[0];
      const inspected = this.inspectedPart === part;
      pin.visible = this.showUnused || this.wiredPins.has(key) || selected || inspected;
      pin.userData.ring.visible = ['pin', 'wire', 'wires'].includes(selection?.type) && focus.pins.has(key);
      shade(pin, !dim || inspected || selected || focus.pins.has(key) || (!focus.pins.size && focus.parts.has(part)));
    }
    for (const [id, { mesh, role }] of this.wires) {
      mesh.visible = (focus.wires.has(id) && Boolean(selection)) || ((!this.filter || role === this.filter) &&
        (!selection || this.showOtherWires));
      shade(mesh, !dim || focus.wires.has(id));
    }
    this.inspector?.update();
    this.requestDraw();
  }

  setExploded() {
    this.exploded = !this.exploded;
    for (const item of this.prints.values()) {
      item.group.position.copy(item.position);
      if (this.exploded) item.group.position.add(new THREE.Vector3().fromArray(item.explode));
    }
    this.fit();
    this.app.renderCenterBar();
  }

  fit(box = new THREE.Box3().setFromObject(this.contents), direction = this.camera.position.clone().sub(this.controls.target).normalize(), pad = 1.16) {
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(.5);
    const right = new THREE.Vector3().crossVectors(axis, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const vertical = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const free = this.width ? this.freeArea() : { w: 1, h: 1 };
    const vertical0 = vertical * (this.height ? free.h / this.height : 1);
    const horizontal = vertical * this.camera.aspect * (this.width ? free.w / this.width : 1);
    let distance = 23;
    for (const x of [-half.x, half.x]) for (const y of [-half.y, half.y]) for (const z of [-half.z, half.z]) {
      const offset = new THREE.Vector3(x, y, z);
      const clearance = pad * Math.max(Math.abs(offset.dot(right)) / horizontal, Math.abs(offset.dot(up)) / vertical0);
      distance = Math.max(distance, offset.dot(direction) + clearance);
    }
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.controls.update();
    this.requestDraw();
  }

  focusPart(id) {
    const item = this.parts?.get(id);
    if (!item) return;
    this.inspectedPart = id;
    this.applyFocus(this.app.focus);
    this.inspector?.showPinList();
    this.resize();
    this.fit(new THREE.Box3().setFromObject(item.group), overhead);
  }

  /** Keep the picture clear of an overlay on the right (the Ask Wiremap panel). */
  setInset(inset) {
    const v = typeof inset === 'number' ? { right: inset, bottom: 0 } : (inset || {});
    this.insetR = Math.max(0, v.right || 0);
    this.insetB = Math.max(0, v.bottom || 0);
    if (this.camera) { this.applyInset(); this.requestDraw(); }
  }

  /** Free area not covered by the panel: {w, h} in px. */
  freeArea() {
    const w = this.width - (this.insetR < this.width * .8 ? this.insetR || 0 : 0);
    const h = this.height - (this.insetB < this.height * .8 ? this.insetB || 0 : 0);
    return { w, h };
  }

  applyInset() {
    const { width, height } = this;
    const { w, h } = this.freeArea();
    if (width && height && (w < width || h < height)) this.camera.setViewOffset(width, height, (width - w) / 2, (height - h) / 2, width, height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** Zoom to everything in the current focus (parts and wire ends). */
  fitFocus() {
    if (!this.parts) return;
    const box = new THREE.Box3();
    for (const id of this.app.focus.parts) if (this.parts.has(id)) box.expandByObject(this.parts.get(id).group);
    for (const id of this.app.focus.wires) if (this.wires.has(id)) box.expandByObject(this.wires.get(id).mesh);
    // Extra room so the pin name tags around the edges stay on screen.
    if (!box.isEmpty()) this.fit(box, undefined, 1.6);
  }

  focusWire(id) {
    const item = this.wires?.get(id);
    if (item) this.fit(new THREE.Box3().setFromObject(item.mesh), overhead);
  }

  onTheme() {
    if (!this.scene) return;
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim();
    this.scene.background = new THREE.Color(this.holo ? '#04101c' : (surface || '#f3f6fa'));
    this.canvasHost?.classList.toggle('holo', this.holo);
    this.requestDraw();
  }

  onStep() {
    if (!this.visible || !this.parts || !activeFocus(this.app.focus)) return;
    const box = new THREE.Box3();
    for (const id of this.app.focus.parts) if (this.parts.has(id)) box.expandByObject(this.parts.get(id).group);
    for (const id of this.app.focus.prints) if (this.prints.has(id)) box.expandByObject(this.prints.get(id).group);
    if (box.isEmpty()) return;
    // Zoom to the step so its pins spread apart and their name tags stay readable.
    this.fit(box);
  }

  resize() {
    if (!this.renderer) return;
    const width = this.canvasHost.clientWidth;
    const height = this.canvasHost.clientHeight;
    if (!width || !height) return;
    const previouslyUnsized = !this.width;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.applyInset();
    if (previouslyUnsized) this.fit();
    this.requestDraw();
  }

  requestDraw() {
    if (this.frame != null || !this.visible || !this.width) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.renderer.render(this.scene, this.camera);
      this.drawLabels();
    });
  }

  bindPointer() {
    const canvas = this.renderer.domElement;
    const point = new THREE.Vector2();
    const setRay = (event) => {
      const rect = canvas.getBoundingClientRect();
      point.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
      this.ray.setFromCamera(point, this.camera);
    };
    const hit = (event) => {
      setRay(event);
      let closest = null;
      for (const intersection of this.ray.intersectObjects(this.contents.children, true)) {
        if (closest && intersection.distance > closest.distance + 3) break;
        let object = intersection.object;
        if (!object.visible) continue;
        while (object?.visible && !object.userData.target) object = object.parent;
        if (!object?.visible || !object.userData.target) continue;
        const { target } = object.userData;
        if (target.type === 'pin') return target;
        if (!closest) closest = { target, distance: intersection.distance };
      }
      return closest?.target || null;
    };
    let down = null;
    let drag = null;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      down = [event.clientX, event.clientY];
      if (!event.shiftKey) return;
      const target = hit(event);
      const maps = { part: this.parts, print: this.prints };
      const item = target && maps[target.type]?.get(target.id);
      if (!item || (target.type === 'print' && this.exploded)) return;
      const plane = new THREE.Plane(axis, -item.position.y);
      const start = this.ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (!start) return;
      event.stopImmediatePropagation();
      canvas.setPointerCapture(event.pointerId);
      drag = { item, target, plane, start, origin: item.position.clone() };
    }, { capture: true });
    canvas.addEventListener('pointermove', (event) => {
      if (drag) {
        setRay(event);
        const point3d = this.ray.ray.intersectPlane(drag.plane, new THREE.Vector3());
        if (!point3d) return;
        drag.item.group.position.copy(drag.origin).add(point3d.sub(drag.start));
        for (const item of this.wires.values()) this.addWire(item.wire, item);
        this.requestDraw();
      } else if (!down) {
        const target = hit(event);
        canvas.style.cursor = target ? 'pointer' : 'grab';
      }
    });
    canvas.addEventListener('pointerup', (event) => {
      if (drag) {
        drag.item.position.copy(drag.item.group.position);
        this.app.savePositions({ [drag.target.id]: drag.item.position.toArray().map((n) => Number(n.toFixed(2))) });
        drag = null;
      } else if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) < 5) {
        const target = hit(event);
        if (target) this.app.select(target, { sheet: this.assembly });
        else this.app.clearSelection();
      }
      down = null;
    });
    canvas.addEventListener('pointercancel', () => { down = null; drag = null; });
    canvas.addEventListener('contextmenu', (event) => { const target = hit(event); if (target) this.app.contextMenu(event, target); });
  }

  tools() {
    if (!this.renderer) return null;
    const roles = [...new Set([...this.wires.values()].map((entry) => entry.role).filter(Boolean))];
    const filter = h('select.input', { 'aria-label': 'Filter connections', onchange: (event) => {
      this.filter = event.target.value;
      this.applyFocus(this.app.focus);
    } }, h('option', { value: '' }, 'All wires'), roles.map((role) => h('option', { value: role }, this.app.roleLabel(role))));
    filter.value = this.filter;
    const toggle = (label, enabled, change, title) => h('label.scene-toggle', { title },
      h('input.tick', { type: 'checkbox', checked: enabled, onchange: (event) => change(event.target.checked) }), label);
    return [filter, tool('Fit', 'fit', () => this.fit()), tool('Top view', 'panel', () => this.fit(undefined, overhead), 'Top'),
      tool('Angled view', 'explode', () => this.fit(undefined, angle), 'Angle'),
      toggle('Grid', this.gridOn, (on) => { this.gridOn = on; this.grid.visible = on || this.holo; this.requestDraw(); }, 'Reference grid with 20 mm spacing'),
      this.assembly ? tool(this.exploded ? 'Assemble' : 'Explode', 'explode', () => this.setExploded()) :
        toggle('All pins', this.showUnused, (on) => { this.showUnused = on; this.applyFocus(this.app.focus); }),
      !this.assembly && toggle('Keep other wires', this.showOtherWires, (on) => { this.showOtherWires = on; this.applyFocus(this.app.focus); }),
      toggle('Pin names', this.pinNames, (on) => { this.pinNames = on; this.requestDraw(); }, 'Show the exact pin name at both ends of each wire'),
      toggle('Hologram', this.holo, (on) => { this.holo = on; store.set('wiremap.holo', on); this.onTheme(); this.render(); }, 'Holographic workshop view')];
  }

  applyHolo() {
    const cyan = new THREE.Color('#3fd8ff');
    const edgeMat = new THREE.LineBasicMaterial({ color: '#7fe9ff', transparent: true, opacity: .85 });
    for (const item of [...this.parts.values(), ...this.prints.values()]) {
      item.group.traverse((child) => {
        if (!child.isMesh || child.userData.target?.type === 'pin' || child.parent?.userData.target?.type === 'pin') return;
        const m = child.material;
        if (!m || m.userData.holo) return;
        m.color = cyan.clone().lerp(m.color, .25);
        m.emissive = new THREE.Color('#0b5a7a');
        m.transparent = true; m.opacity = .32; m.depthWrite = false; m.userData.holo = true;
        if (m.userData.wiremap) Object.assign(m.userData.wiremap, { opacity: .32, transparent: true, depthWrite: false });
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(child.geometry, 25), edgeMat.clone());
        edges.position.copy(child.position); edges.rotation.copy(child.rotation); edges.scale.copy(child.scale);
        child.parent.add(edges);
      });
    }
    for (const { mesh } of this.wires.values()) {
      mesh.material.emissive = mesh.material.color.clone().multiplyScalar(.75);
    }
    this.grid.visible = true;
    this.grid.material.color = new THREE.Color('#1f6f93');
    this.grid.material.opacity = .45;
  }

  /** HTML name tags over the canvas: part names, and the exact pin name at both ends of lit wires. */
  drawLabels() {
    const layer = this.labelLayer;
    if (!layer || !this.parts || !this.width) return;
    const focus = this.app.focus;
    const dim = activeFocus(focus);
    const narrow = this.width < 520;
    const items = [];
    const project = (v) => {
      const p = v.clone().project(this.camera);
      if (p.z > 1 || p.z < -1) return null;
      return [(p.x + 1) / 2 * this.width, (1 - p.y) / 2 * this.height];
    };
    for (const [id, item] of this.parts) {
      if (dim && !focus.parts.has(id)) continue;
      const box = new THREE.Box3().setFromObject(item.group);
      const at = project(new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y + 3, (box.min.z + box.max.z) / 2));
      const tag = tagName(this.app, this.app.part(id));
      if (at) items.push({ key: `part:${id}`, cls: 'part', text: narrow && tag.length > 12 ? `${tag.slice(0, 11)}…` : tag, at });
    }
    if (this.pinNames) {
      const keys = dim ? [...focus.pins] : (this.wiredPins.size <= 16 ? [...this.wiredPins] : []);
      for (const key of keys) {
        const marker = this.pins.get(key);
        if (!marker || !marker.visible) continue;
        const at = project(marker.getWorldPosition(new THREE.Vector3()));
        const area = this.freeArea();
        if (!at || at[0] < 0 || at[1] < 0 || at[0] > area.w || at[1] > area.h) continue;
        const pin = this.app.pin(key);
        const role = this.app.data.check.pinInfo?.[key]?.role;
        const part = this.app.part(key.split('.')[0]);
        items.push({ key: `pin:${key}`, cls: 'pin', text: dim && !narrow ? `${tagName(this.app, part)} · ${silkscreen(pin)}` : silkscreen(pin),
          color: this.app.roleColor(role), at, anchor: at.slice() });
      }
    }
    // Greedy de-overlap: pins first (they matter most), then part tags.
    // Each tag tries spots around its pin; a leader line joins tag and pin.
    items.sort((a, b) => (a.cls === b.cls ? a.at[1] - b.at[1] : a.cls === 'pin' ? -1 : 1));
    const placed = [];
    const seen = new Set();
    if (!this.leaderSvg) {
      this.leaderSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.leaderSvg.classList.add('leader-svg');
      layer.prepend(this.leaderSvg);
    }
    const lines = [];
    for (const it of items) {
      const w = 10 + it.text.length * (it.cls === 'pin' ? 7.4 : 7.8);
      const hgt = it.cls === 'pin' ? 20 : 22;
      const [ax, ay] = it.at;
      const gap = it.cls === 'pin' ? 16 : 6;
      const spots = it.cls === 'pin'
        ? [[-w / 2, -hgt - gap], [gap, -hgt / 2], [-w - gap, -hgt / 2], [-w / 2, gap], [gap, -hgt - gap], [-w - gap, -hgt - gap], [gap, gap], [-w - gap, gap]]
        : [[-w / 2, -hgt - gap]];
      let best = null;
      const area = this.freeArea();
      for (let ring = 0; ring < 6 && !best; ring++) {
        for (const [dx, dy] of spots) {
          const x = Math.min(Math.max(2, ax + dx * (1 + ring * 0.9)), area.w - w - 2);
          const y = Math.min(Math.max(2, ay + dy * (1 + ring * 0.9)), area.h - hgt - 2);
          if (!placed.some((r) => x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + hgt + 2 > r.y)) { best = [x, y]; break; }
        }
      }
      // No clear spot: drop part tags, and pin tags only when the screen is already full.
      if (!best && (it.cls === 'part' || placed.length > 18)) continue;
      let [x, y] = best || [ax - w / 2, ay - hgt - gap];
      const free = this.freeArea();
      x = Math.min(Math.max(2, x), free.w - w - 2);
      y = Math.min(Math.max(2, y), free.h - hgt - 2);
      placed.push({ x, y, w, h: hgt });
      let el = layer.querySelector(`[data-k="${CSS.escape(it.key)}"]`);
      if (!el) { el = h(`div.scene-label.${it.cls}`, { 'data-k': it.key }); layer.append(el); }
      el.textContent = it.text;
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      el.style.setProperty('--c', it.color || '');
      if (it.cls === 'pin') {
        const cx = Math.min(Math.max(ax, x), x + w); const cy = Math.min(Math.max(ay, y), y + hgt);
        lines.push(`<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="${it.color || '#3a4250'}"/><circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="3" fill="${it.color || '#3a4250'}"/>`);
      }
      seen.add(it.key);
    }
    this.leaderSvg.innerHTML = lines.join('');
    for (const el of [...layer.children]) if (el !== this.leaderSvg && !seen.has(el.dataset.k)) el.remove();
  }

  onShow() { this.visible = true; this.resize(); if (!this.assembly) this.onStep(); }
  onHide() { this.visible = false; this.app.tooltip.hide(); }

  destroy() {
    this.generation++;
    if (!this.renderer) return;
    if (this.frame != null) cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.controls.dispose();
    release(this.scene);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
