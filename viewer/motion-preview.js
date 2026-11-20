import { clamp, clear, h, s } from './util.js';
import { emptyView } from './svg-view.js';

const ARM_ROLES = ['base', 'shoulder', 'elbow', 'gripper'];
const RAD = Math.PI / 180;
const roverStart = () => ({ x: 330, y: 195, heading: -.35 });

export function armPose(base, shoulder, elbow, gripper) {
  const yaw = base * RAD;
  const upperAngle = (58 + shoulder) * RAD;
  const lowerAngle = upperAngle + (-55 + elbow) * RAD;
  const point = (reach, height) => [238 + reach * (.97 * Math.cos(yaw) - .58 * Math.sin(yaw)),
    307 - height * .97 + reach * (.15 * Math.cos(yaw) + .30 * Math.sin(yaw))];
  const upperReach = 121 * Math.cos(upperAngle);
  const upperHeight = 48 + 121 * Math.sin(upperAngle);
  const foreReach = upperReach + 101 * Math.cos(lowerAngle);
  const foreHeight = upperHeight + 101 * Math.sin(lowerAngle);
  const wrist = point(foreReach, foreHeight);
  const palm = point(foreReach + 22 * Math.cos(lowerAngle), foreHeight + 22 * Math.sin(lowerAngle));
  const angle = Math.atan2(palm[1] - wrist[1], palm[0] - wrist[0]);
  const spread = clamp(18 + gripper * .22, 5, 29);
  const jaws = [-1, 1].map((side) => [[palm[0], palm[1]],
    [palm[0] + Math.cos(angle) * 12 - side * Math.sin(angle) * spread,
      palm[1] + Math.sin(angle) * 12 + side * Math.cos(angle) * spread],
    [palm[0] + Math.cos(angle) * 28 - side * Math.sin(angle) * spread * .6,
      palm[1] + Math.sin(angle) * 28 + side * Math.cos(angle) * spread * .6]]);
  return { links: [point(0, 48), point(upperReach, upperHeight), wrist, palm], jaws };
}

export function advanceRover(pose, left, right, elapsed) {
  const turn = (right - left) * .017 * elapsed;
  const distance = (left + right) * .45 * elapsed;
  return { x: clamp(pose.x + Math.cos(pose.heading + turn / 2) * distance, 78, 582),
    y: clamp(pose.y + Math.sin(pose.heading + turn / 2) * distance, 68, 324),
    heading: pose.heading + turn };
}

function makeDiagram(type) {
  const label = type === 'arm' ? 'Illustration of the robot arm pose' : 'Illustration of the rover motion';
  const svg = s('svg', { class: 'motion-diagram', viewBox: '0 0 660 390', role: 'img', 'aria-label': label });
  svg.append(s('title', null, label));
  if (type === 'arm') {
    const edges = s('polyline', { class: 'motion-link-outline' });
    const links = s('polyline', { class: 'motion-link' });
    const jaws = [-1, 1].map(() => s('polyline', { class: 'motion-jaw' }));
    const joints = [15, 12, 9].map((r) => s('circle', { class: 'motion-joint', r }));
    svg.append(s('ellipse', { class: 'motion-floor', cx: 293, cy: 310, rx: 194, ry: 33 }),
      s('ellipse', { class: 'motion-base', cx: 238, cy: 306, rx: 46, ry: 13 }),
      s('path', { class: 'motion-base', d: 'M192 305v-13c0-8 21-14 46-14s46 6 46 14v13c-1 7-21 13-46 13s-45-6-46-13Z' }),
      s('ellipse', { class: 'motion-top', cx: 238, cy: 292, rx: 46, ry: 13 }),
      s('path', { class: 'motion-base', d: 'M223 292v-32h30v32c-7 6-23 6-30 0Z' }),
      edges, links, ...jaws, ...joints);
    return { svg, draw(values) {
      const pose = armPose(...ARM_ROLES.map((role) => values.get(role) ?? 0));
      const bounds = [...pose.links, ...pose.jaws.flat()];
      const x1 = Math.min(54, ...bounds.map(([x]) => x - 24));
      const y1 = Math.min(13, ...bounds.map(([, y]) => y - 24));
      const x2 = Math.max(603, ...bounds.map(([x]) => x + 24));
      const y2 = Math.max(365, ...bounds.map(([, y]) => y + 24));
      svg.setAttribute('viewBox', `${x1} ${y1} ${x2 - x1} ${y2 - y1}`);
      const points = (list) => list.map((pair) => pair.join(',')).join(' ');
      edges.setAttribute('points', points(pose.links));
      links.setAttribute('points', points(pose.links));
      for (const [index, joint] of joints.entries()) {
        const [x, y] = pose.links[index];
        joint.setAttribute('cx', x);
        joint.setAttribute('cy', y);
      }
      for (const [index, jaw] of jaws.entries()) jaw.setAttribute('points', points(pose.jaws[index]));
    } };
  }

  const body = s('g', { class: 'motion-rover' },
    ...[-1, 1].map((side) => s('rect', { class: 'motion-wheel', x: -36, y: side < 0 ? -32 : 20, width: 57, height: 13, rx: 4 })),
    s('rect', { class: 'motion-top', x: -45, y: -19, width: 83, height: 38, rx: 8 }),
    s('path', { class: 'motion-rover-nose', d: 'M37 -13l14 13-14 13Z' }),
    s('path', { class: 'motion-direction', d: 'M-3 0h24m-9-8 9 8-9 8' }));
  svg.append(s('rect', { class: 'motion-track', x: 28, y: 26, width: 604, height: 338, rx: 24 }),
    s('path', { class: 'motion-center-lines', d: 'M330 26v338M28 195h604' }), body);
  return { svg, draw(values, pose) {
    body.setAttribute('transform', `translate(${pose.x} ${pose.y}) rotate(${pose.heading / RAD})`);
  } };
}

function controlsFor(preview) {
  const arm = preview.type === 'arm';
  const entries = arm ? preview.joints : preview.motors;
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, arm ? 4 : 2).flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') return [];
    const min = arm && Number.isFinite(entry.min) ? entry.min : arm ? -45 : -100;
    const max = arm && Number.isFinite(entry.max) ? entry.max : arm ? 45 : 100;
    if (min >= max) return [];
    return [{ min, max, neutral: clamp(Number.isFinite(entry.neutral) ? entry.neutral : 0, min, max),
      label: entry.label || (arm ? ARM_ROLES[index] : index ? 'Right motor' : 'Left motor'),
      role: arm ? (ARM_ROLES.includes(entry.role) ? entry.role : ARM_ROLES[index]) : index,
      part: entry.part }];
  });
}

export class MotionPreview {
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.frame = null;
    this.controls = [];
    this.pose = roverStart();
    this.seconds = 0;
    this.manualDrive = false;
    this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.onMotionChange = () => {
      if (!this.diagram) return;
      if (this.app.motion === false) this.pause();
      this.update();
    };
    this.motionObserver = new MutationObserver(this.onMotionChange);
  }

  render() {
    const preview = this.app.data?.project?.preview;
    const controls = controlsFor(preview || {});
    const availableParts = controls.map(({ part }) => Boolean(part && this.app.part(part)));
    const configKey = JSON.stringify([preview, availableParts]);
    if (this.diagram && configKey === this.configKey) {
      this.update();
      return;
    }
    this.pause();
    this.configKey = configKey;
    if (!preview || !['arm', 'rover'].includes(preview.type)) {
      this.diagram = null;
      clear(this.host).append(emptyView('No motion preview', 'This project does not define a mechanical motion preview.'));
      return;
    }
    const arm = preview.type === 'arm';
    this.pose = roverStart();
    this.seconds = 0;
    this.manualDrive = false;
    this.diagram = makeDiagram(preview.type);
    this.button = h('button.btn.primary', { type: 'button', onclick: () => this.frame === null ? this.play() : this.pause() }, 'Play demo');
    this.reset = h('button.btn', { type: 'button', onclick: () => this.resetPose() }, 'Reset');
    this.controls = controls.map((control) => {
      const id = `motion-control-${control.role}`;
      const readout = h('output.motion-value', { for: id });
      const slider = h('input.motion-slider', { id, type: 'range', min: control.min, max: control.max, step: 1,
        value: control.neutral, oninput: () => {
          if (arm) this.pause();
          else this.manualDrive = true;
          this.update();
        } });
      const inspect = control.part && this.app.part(control.part) ? h('button.btn.ghost.small.motion-inspect', {
        type: 'button', 'aria-label': `Inspect pins for ${control.label}`, onclick: () => this.app.inspectPins(control.part),
      }, 'Inspect pins') : null;
      const field = h('div.motion-control', null, h('div.motion-control-head', null,
        h('label', { for: id }, control.label), readout), slider, inspect);
      return { ...control, slider, readout, field };
    });
    this.leftMotor = arm ? null : this.controls.find(({ role }) => role === 0)?.slider;
    this.rightMotor = arm ? null : this.controls.find(({ role }) => role === 1)?.slider;
    this.arm = arm;
    this.motionNote = h('p.motion-note', { hidden: this.app.motion });
    const figure = h('div.motion-figure', null, this.diagram.svg);
    const panel = h('section.motion-panel', { 'aria-label': arm ? 'Joint controls' : 'Motor controls' },
      h('h2', null, arm ? 'Joint controls' : 'Motor controls'),
      ...this.controls.map(({ field }) => field),
      !this.controls.length ? h('p.motion-note', null, 'This project has no adjustable controls.') : null,
      h('div.motion-actions', null, this.button, this.reset), this.motionNote);
    clear(this.host).append(h('div.motion-preview', null,
      h('header.motion-heading', null, h('h2', null, preview.title || (arm ? 'Robot arm motion' : 'Rover motion')),
        h('p', null, 'Illustrative motion preview. No hardware is controlled.')),
      h('div.motion-layout', null, figure, panel)));
    this.update();
  }

  update() {
    for (const { slider, readout } of this.controls) {
      const value = `${slider.value}${this.arm ? '°' : '%'}`;
      readout.value = value;
      slider.setAttribute('aria-valuetext', this.arm ? `${slider.value} degrees` : `${slider.value} percent`);
    }
    const values = new Map(this.controls.map(({ role, slider, neutral }) => [role, Number(slider.value) - (this.arm ? neutral : 0)]));
    this.diagram.draw(values, this.pose);
    this.button.disabled = this.app.motion === false || !this.controls.length;
    this.button.textContent = this.frame === null ? this.arm || !this.manualDrive ? 'Play demo' : 'Start motion' : 'Pause';
    this.motionNote.hidden = this.app.motion !== false;
    this.motionNote.textContent = 'Automatic motion is off. The controls still adjust the preview.';
  }

  play() {
    if (this.frame !== null || this.app.motion === false) return;
    let previous;
    const tick = (now) => {
      if (this.app.motion === false) { this.pause(); return; }
      const elapsed = previous === undefined ? 0 : Math.min(.05, (now - previous) / 1000);
      previous = now;
      this.seconds += elapsed;
      if (this.arm) {
        for (const [index, control] of this.controls.entries()) {
          const phase = Math.sin(this.seconds * (.75 + index * .24)) * .65;
          const range = phase > 0 ? control.max - control.neutral : control.neutral - control.min;
          control.slider.value = clamp(Math.round(control.neutral + phase * range), control.min, control.max);
        }
      } else {
        if (!this.manualDrive) {
          const yaw = Math.sin(this.seconds * .55) * 40;
          for (const { role, slider } of this.controls) slider.value = Math.round(49 + (role === 1 ? yaw : -yaw));
        }
        this.pose = advanceRover(this.pose, Number(this.leftMotor?.value ?? 0), Number(this.rightMotor?.value ?? 0), elapsed);
      }
      this.frame = requestAnimationFrame(tick);
      this.update();
    };
    this.frame = requestAnimationFrame(tick);
    this.update();
  }

  pause() {
    if (this.frame === null) return;
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.update();
  }

  resetPose() {
    this.pause();
    this.pose = roverStart();
    this.seconds = 0;
    this.manualDrive = false;
    for (const { slider, neutral } of this.controls) slider.value = neutral;
    this.update();
  }

  onShow() {
    this.motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
    this.motionQuery.addEventListener('change', this.onMotionChange);
    if (this.diagram) this.update();
  }

  onHide() {
    this.motionObserver.disconnect();
    this.motionQuery.removeEventListener('change', this.onMotionChange);
    this.pause();
  }

  destroy() { this.onHide(); }
}
