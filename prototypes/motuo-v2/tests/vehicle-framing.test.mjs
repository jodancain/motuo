import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../vendor/three/three.module.js';

const source = readFileSync(new URL('../vehicle-viewer.js', import.meta.url), 'utf8');
const start = source.indexOf('  function fitDistance('), end = source.indexOf('\n  function setView(', start);
assert.ok(start >= 0 && end > start, 'extract the production camera-fit function');
const orbitStart = source.indexOf('  function setAutoRotate(');
assert.ok(orbitStart >= 0 && orbitStart < start, 'extract the production orbit activation and framing functions');

function fixture() {
  const size = new THREE.Vector3(0.8, 1.2, 2.1), focus = new THREE.Vector3(0, 0.58, 0);
  const points = [];
  // A narrow body, wide high mirrors, and wheel silhouettes avoid the large
  // empty upper corners of a full bounding box. This is a synthetic test mesh.
  for (const z of [-0.73, 0.73]) {
    for (let step = 0; step < 16; step++) {
      const a = step * Math.PI / 8;
      for (const x of [-0.09, 0.09]) points.push(new THREE.Vector3(x, 0.32 + Math.cos(a) * 0.32, z + Math.sin(a) * 0.32));
    }
  }
  for (const x of [-0.22, 0.22]) {
    for (const [y, z] of [[0.26, -0.1], [0.76, -0.75], [0.95, -0.3], [0.85, 0.6], [1.2, 0.55]]) points.push(new THREE.Vector3(x, y, z));
  }
  points.push(new THREE.Vector3(-0.4, 1.08, 0.38), new THREE.Vector3(0.4, 1.08, 0.38));
  const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 60);
  const controls = { target: focus.clone(), maxDistance: 8, update() {} };
  const framing = new Function('THREE', 'camera', 'size', 'focus', 'fitPoints', 'controls', `
    let autoRotate = false, loaded = true, departure = null;
    const orbitFits = new Map();
    function controlsEnabled() {}
    function wake() {}
    ${source.slice(orbitStart, end)}
    return { fit: fitDistance, fitForView, setAutoRotate };
  `)(THREE, camera, size, focus, points, controls);
  return { camera, ...framing, focus, points, controls };
}

test('all silhouette points project within portrait and landscape viewports at representative viewing angles', () => {
  const { camera, fit, focus, points } = fixture();
  for (const aspect of [0.65, 0.9, 16 / 9, 3.5]) {
    for (let yaw = 0; yaw < 8; yaw++) {
      const direction = new THREE.Vector3(Math.sin(yaw * Math.PI / 4), 0.32, Math.cos(yaw * Math.PI / 4)).normalize();
      camera.aspect = aspect; camera.updateProjectionMatrix();
      const distance = fit(direction);
      assert.ok(Number.isFinite(distance) && distance > camera.near && distance < camera.far);
      camera.position.copy(focus).addScaledVector(direction, distance);
      camera.lookAt(focus); camera.updateMatrixWorld(true);
      let occupancy = 0;
      for (const point of points) {
        // Use Three's independent perspective projection, not a copy of fit math.
        const projected = point.clone().project(camera);
        assert.ok(Math.abs(projected.x) <= 0.91 && Math.abs(projected.y) <= 0.91,
          `point cropped: aspect=${aspect}, yaw=${yaw}, projected=${projected.toArray()}`);
        assert.ok(projected.z >= -1 && projected.z <= 1, 'point stays between near and far planes');
        occupancy = Math.max(occupancy, Math.abs(projected.x), Math.abs(projected.y));
      }
      assert.ok(occupancy > 0.6, `silhouette should not shrink into empty space: ${occupancy}`);
    }
  }
});

test('narrowing a viewport preserves framing by increasing distance when width is the limiting dimension', () => {
  const { fit, points } = fixture();
  const direction = new THREE.Vector3(1, 0.15, 0).normalize();
  const original = points.map(point => point.clone());
  const portrait = fit(direction, 0.65), landscape = fit(direction, 3.5);
  assert.ok(portrait > landscape, 'side profile requires more distance in portrait');
  assert.ok(portrait < landscape * 4, 'narrow framing remains reasonably sized');
  assert.ok(points.every((point, index) => point.equals(original[index])), 'fitting never mutates model points');
  assert.ok(direction.equals(new THREE.Vector3(1, 0.15, 0).normalize()), 'fitting never changes the selected direction');
});

test('auto orbit holds one radius while all silhouette points remain visible throughout a full rotation', () => {
  const { camera, fit, fitForView, setAutoRotate, focus, points } = fixture();
  const axis = new THREE.Vector3(0, 1, 0), projected = new THREE.Vector3();
  for (const aspect of [0.65, 1, 16 / 9, 3.5]) {
    for (const elevation of [0.15, 0.32, 0.6]) {
      setAutoRotate(false);
      camera.aspect = aspect; camera.updateProjectionMatrix();
      const hero = new THREE.Vector3(0.7, elevation, 0.7).normalize();
      camera.position.copy(focus).addScaledVector(hero, fit(hero));
      setAutoRotate(true);
      const radius = camera.position.distanceTo(focus);
      assert.ok(radius >= fitForView(hero) - 1e-9, 'orbit activation reserves a full-turn fit');
      for (let angle = 0; angle < 360; angle += 5) {
        const direction = hero.clone().applyAxisAngle(axis, THREE.MathUtils.degToRad(angle));
        assert.ok(Math.abs(fitForView(direction) - fitForView(hero)) < 1e-9, 'heading changes do not pump camera radius');
        camera.position.copy(focus).addScaledVector(direction, radius);
        camera.lookAt(focus); camera.updateMatrixWorld(true);
        for (const point of points) {
          projected.copy(point).project(camera);
          assert.ok(Math.abs(projected.x) < 0.93 && Math.abs(projected.y) < 0.93,
            `orbit crops point: aspect=${aspect}, elevation=${elevation}, angle=${angle}`);
          assert.ok(projected.z >= -1 && projected.z <= 1);
        }
      }
    }
  }
});

test('enabling orbit only pulls out when necessary and keeps manually zoomed-out distance and direction', () => {
  const { camera, fit, fitForView, setAutoRotate, focus, controls } = fixture();
  camera.aspect = 16 / 9;
  const direction = new THREE.Vector3(1.5, 0.48, 1.25).normalize();
  camera.position.copy(focus).addScaledVector(direction, fit(direction));
  setAutoRotate(true);
  const safeRadius = fitForView(direction);
  assert.ok(camera.position.distanceTo(focus) >= safeRadius - 1e-9);
  setAutoRotate(false);
  const zoomedOut = safeRadius * 1.5;
  camera.position.copy(focus).addScaledVector(direction, zoomedOut);
  setAutoRotate(true);
  assert.ok(Math.abs(camera.position.distanceTo(focus) - zoomedOut) < 1e-9);
  assert.ok(camera.position.clone().sub(focus).normalize().distanceTo(direction) < 1e-9);
  assert.ok(controls.target.equals(focus));
  const position = camera.position.clone();
  setAutoRotate(false);
  assert.ok(camera.position.equals(position), 'stopping orbit preserves the current framing');
  assert.equal(fitForView(direction), fit(direction), 'manual views use their tighter directional fit');
});
