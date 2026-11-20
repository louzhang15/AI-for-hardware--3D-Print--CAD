import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clear, h, layoutPositions, partColor } from './util.js';
import { activeFocus, emptyView, tool } from './svg-view.js';

const axis = new THREE.Vector3(0, 1, 0);
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
    this.xray = true;
    this.generation = 0;
    this.frame = null;
    this.visible = false;
  }

  render() {
    const firstRender = !this.renderer;
    if (!this.renderer && !this.setup()) return;
    for (const child of [...this.contents.children]) { release(child); child.removeFromParent(); }
    clear(this.labels);
    this.parts = new Map();
    this.prints = new Map();
    this.pins = new Map();
    this.wires = new Map();
    this.status.hidden = true;
    const generation = ++this.generation;
    const { partList, wires } = this.app.data.check.model;
    const positions = layoutPositions(partList);
    for (const part of partList) this.addPart(part, positions.get(part.id), generation);
    if (this.assembly) {
      for (const [i, print] of (this.app.data.project.prints || []).entries()) this.addPrint(print, i, generation);
    }
    for (const wire of wires) if (wire.valid) this.addWire(wire);
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
    const sceneHost = h('div.three-host', null, renderer.domElement);
    this.labels = h('div.scene-labels', { 'aria-hidden': 'true' });
    this.status = h('p.small.scene-status', { role: 'status', hidden: true });
    clear(this.host).append(sceneHost, this.labels, this.status);
    this.scene = new THREE.Scene();
    this.contents = new THREE.Group();
    this.camera = new THREE.PerspectiveCamera(45, 1, .1, 30000);
    this.camera.position.set(220, 240, 300);
    this.grid = new THREE.GridHelper(1200, 60, '#607187', '#3a495b');
    this.grid.position.y = -.1;
    this.grid.material.transparent = true;
    this.grid.material.opacity = .45;
    const light = new THREE.DirectionalLight(0xffffff, 2.3);
    light.position.set(250, 400, 180);
    this.scene.add(this.contents, this.grid, light, new THREE.HemisphereLight(0xffffff, 0x485365, 2));
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.addEventListener('change', () => this.requestDraw());
    this.ray = new THREE.Raycaster();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.host);
    this.bindPointer();
    return true;
  }

  addPart(part, position, generation) {
    const target = { type: 'part', id: part.id };
    const size = dims(part.size);
    const item = this.addBox(target, part.label || part.name || part.id, size, position, part.rotation, partColor(part));
    this.parts.set(part.id, item);
    for (const [i, pin] of part.pins.entries()) {
      const [u, v] = Array.isArray(pin.pos) ? pin.pos : [(i + 1) * size[0] / (part.pins.length + 1), size[2] / 2];
      const pinInfo = this.app.data.check.pinInfo?.[pin.key];
      const marker = new THREE.Mesh(new THREE.SphereGeometry(1.2, 9, 7), new THREE.MeshStandardMaterial({ color: pinInfo?.connected ? '#f5cc71' : '#97a6b7' }));
      marker.position.set(u - size[0] / 2, size[1] + .75, v - size[2] / 2);
      marker.userData.target = { type: 'pin', id: pin.key };
      item.group.add(marker);
      this.pins.set(pin.key, marker);
    }
    if (part.model && fromFile(part.model)) this.showAsset(item, [part.model], partColor(part), generation);
  }

  addPrint(print, index, generation) {
    const target = { type: 'print', id: print.id };
    const [x, y, z] = dims(print.size);
    // Print dimensions use the slicer's X, Y, Z order.
    const size = [x, z, y];
    const position = coordinates(print.position, [(index - 1) * 74, 0, 65]);
    const color = print.color || '#729ee4';
    const item = this.addBox(target, print.name || print.id, size, position, print.rotation, color);
    item.explode = coordinates(print.explode, [(index - 1) * 24, 32 + index * 10, 0]);
    if (this.exploded) item.group.position.add(new THREE.Vector3().fromArray(item.explode));
    this.prints.set(print.id, item);
    const pieces = (print.pieces || []).map((piece) => piece.file).filter((path) => path && fromFile(path));
    const file = (print.files || []).find((path) => fromFile(path));
    if (pieces.length || file) this.showAsset(item, pieces.length ? pieces : [file], color, generation);
  }

  addBox(target, label, size, position, rotation, color) {
    const group = new THREE.Group();
    group.userData.target = target;
    group.position.fromArray(coordinates(position, [0, 0, 0]));
    group.rotation.set(...coordinates(rotation, [0, 0, 0]).map(THREE.MathUtils.degToRad));
    const placeholder = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial({ color, roughness: .7 }));
    placeholder.position.y = size[1] / 2;
    group.add(placeholder);
    this.contents.add(group);
    const text = h('span.label3d', null, label);
    this.labels.append(text);
    return { group, position: group.position.clone(), placeholder, text, height: size[1] };
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
    item.height = box.max.y - box.min.y;
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
    const dim = this.xray && activeFocus(focus);
    const shade = (object, lit, ignorePins = false) => object.traverse((child) => {
      if (ignorePins && child.userData.target?.type === 'pin') return;
      for (const material of [child.material].flat().filter(Boolean)) setShade(material, lit);
    });
    for (const [id, item] of this.parts) shade(item.group, !dim || focus.parts.has(id), true);
    for (const [id, item] of this.prints) shade(item.group, !dim || focus.prints.has(id));
    for (const [key, pin] of this.pins) shade(pin, !dim || focus.pins.has(key) || (!focus.pins.size && focus.parts.has(key.split('.')[0])));
    for (const [id, { mesh, role }] of this.wires) {
      mesh.visible = !this.filter || role === this.filter;
      shade(mesh, !dim || focus.wires.has(id));
    }
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

  fit() {
    const box = new THREE.Box3().setFromObject(this.contents);
    const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const distance = Math.max(100, size.length() * (this.camera.aspect < .85 ? 1.35 / Math.max(.25, this.camera.aspect) : 1.35));
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.controls.update();
    this.requestDraw();
  }

  onStep() {
    if (!this.visible || !this.parts || !activeFocus(this.app.focus)) return;
    const box = new THREE.Box3();
    for (const id of this.app.focus.parts) if (this.parts.has(id)) box.expandByObject(this.parts.get(id).group);
    for (const id of this.app.focus.prints) if (this.prints.has(id)) box.expandByObject(this.prints.get(id).group);
    if (box.isEmpty()) return;
    const point = box.getCenter(new THREE.Vector3());
    this.camera.position.add(point.clone().sub(this.controls.target));
    this.controls.target.copy(point);
    this.controls.update();
  }

  resize() {
    if (!this.renderer) return;
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (!width || !height) return;
    const previouslyUnsized = !this.width;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (previouslyUnsized) this.fit();
    this.requestDraw();
  }

  requestDraw() {
    if (this.frame != null || !this.visible || !this.width) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.renderer.render(this.scene, this.camera);
      for (const item of [...this.parts.values(), ...this.prints.values()]) {
        const vector = item.group.getWorldPosition(new THREE.Vector3()).addScaledVector(axis, item.height + 3).project(this.camera);
        item.text.hidden = vector.z < -1 || vector.z > 1 || Math.abs(vector.x) > .97 || Math.abs(vector.y) > .98;
        item.text.style.left = `${(1 + vector.x) * this.width / 2}px`;
        item.text.style.top = `${(1 - vector.y) * this.height / 2}px`;
      }
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
      for (const intersection of this.ray.intersectObjects(this.contents.children, true)) {
        let object = intersection.object;
        if (!object.visible) continue;
        while (object && !object.userData.target) object = object.parent;
        if (object?.userData.target) return object.userData.target;
      }
      return null;
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
        const content = target?.type === 'wire' ? this.app.wireTooltipHtml(target.id)
          : target?.type === 'pin' ? this.app.pinTooltipHtml(target.id) : null;
        if (content) this.app.tooltip.show(event.clientX, event.clientY, content);
        else this.app.tooltip.hide();
      }
    });
    canvas.addEventListener('pointerup', (event) => {
      if (drag) {
        drag.item.position.copy(drag.item.group.position);
        this.app.savePositions({ [drag.target.id]: drag.item.position.toArray().map((n) => Number(n.toFixed(2))) });
        drag = null;
      } else if (down && Math.hypot(event.clientX - down[0], event.clientY - down[1]) < 5) {
        const target = hit(event);
        if (target) this.app.select(target);
        else this.app.clearSelection();
      }
      down = null;
    });
    canvas.addEventListener('pointercancel', () => { down = null; drag = null; });
    canvas.addEventListener('pointerleave', () => this.app.tooltip.hide());
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
    return [filter, tool('Fit', 'fit', () => this.fit()), tool(this.xray ? 'X-ray on' : 'X-ray off', 'xray', () => {
      this.xray = !this.xray;
      this.applyFocus(this.app.focus);
      this.app.renderCenterBar();
    }), this.assembly && tool(this.exploded ? 'Assemble' : 'Explode', 'explode', () => this.setExploded())];
  }

  onShow() { this.visible = true; this.resize(); }
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
