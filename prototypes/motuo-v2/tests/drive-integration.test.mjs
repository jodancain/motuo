import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the HTML's real adapter and rendering functions with production
// signal helpers. DOM stubs only collect output; this is not browser/device QA.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const lineStarting = prefix => {
  const line = html.split('\n').find(line => line.trimStart().startsWith(prefix));
  assert.ok(line, `Missing production line: ${prefix}`);
  return line;
};
const functionSource = name => {
  const start = html.indexOf(` function ${name}(`);
  assert.ok(start >= 0, `Missing production function: ${name}`);
  const firstLineEnd = html.indexOf('\n', start);
  const firstLine = html.slice(start, firstLineEnd);
  if (firstLine.trimEnd().endsWith('}')) return firstLine;
  const end = html.indexOf('\n }', start);
  assert.ok(end >= 0, `Missing production function terminator: ${name}`);
  return html.slice(start, end + 3);
};

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', hidden: false, dataset: {}, style: {},
      classList: { toggle() {}, remove() {}, add() {} },
      setAttribute() {}, close() {},
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      querySelector: selector => element(`${id} ${selector}`),
    });
    return elements.get(id);
  };
  const env = vm.createContext({
    window: {}, performance: { now: () => 0 }, document: { fullscreenElement: null },
    $: element, all: () => [],
    renderVehicle() {}, renderMotion() {}, cancelDeparture() {}, stopInput() {},
    updateControls() {}, showRecap() {}, mapSnapshot: () => '<svg/>',
    routePoints: [], reroutePoints: [], pathOf: () => '',
    locationOnRoute: () => ({ point: [0, 0], traveled: [], angle: 0 }),
  });
  for (const file of ['inertial-speed.js', 'drive-signals.js', 'sound-trend.js']) {
    vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), env);
  }
  vm.runInContext(`
    ${lineStarting('const driveTracker=')}
    ${lineStarting('const state=')}
    ${lineStarting('const motionLabels=')}
    let energy=0, spectrum=Array(24).fill(0), audioLive=false, soundDemo=false;
    ${functionSource('signed2')}
    ${functionSource('updateSpeedEstimate')}
    ${functionSource('renderDriveMeters')}
    ${functionSource('speedUnavailableText')}
    ${functionSource('render')}
    ${functionSource('finish')}
    globalThis.api={state, update:updateSpeedEstimate, meters:renderDriveMeters, render, finish};
  `, env);
  const api = env.api;
  Object.assign(api.state, { phase: 'riding', speed: 36, motion: 'cruise' });
  const sample = (wallMs, rideSeconds, values = {}) => {
    Object.assign(api.state, { seconds: rideSeconds, visualSeconds: rideSeconds }, values);
    api.update(wallMs);
    api.render();
  };
  return { ...api, sample, element };
}

test('GPS-outage acceleration uses the same sample clock as inertial integration after a slow frame', () => {
  const h = harness();
  h.sample(0, 0);
  h.sample(100, .1, { scenario: 'gps', motion: 'gps' });
  // The HTML clamps animation/ride progress to 0.2 s, but this valid IMU
  // interval spans 0.4 s. Differentiating against ride time used to double it.
  h.sample(500, .3);
  assert.equal(h.state.speedReading.source, 'inertial');
  assert.equal(h.element('accel-value').textContent, '+0.35');
  assert.equal(h.element('accel-source').textContent, 'DEMO · 惯导速度差分');
  assert.equal(h.element('speed-estimate').hidden, false);
  const speedBeforeRender = h.state.speedReading.speedKmh;
  h.render(); h.render();
  assert.equal(h.state.speedReading.speedKmh, speedBeforeRender);
  assert.equal(h.element('accel-value').textContent, '+0.35');
});

test('entering and recovering from an outage does not differentiate across speed sources', () => {
  const h = harness();
  h.sample(0, 0);
  h.sample(100, .1, { speed: 36.36 });
  assert.equal(h.element('accel-value').textContent, '+1.00');
  h.sample(200, .2, { scenario: 'gps', motion: 'gps' });
  assert.equal(h.state.speedReading.source, 'inertial');
  assert.equal(h.element('accel-value').textContent, '—');
  h.sample(300, .3);
  assert.equal(h.element('accel-value').textContent, '+0.35');
  h.sample(400, .4, { scenario: 'normal', motion: 'cruise', speed: 18 });
  assert.equal(h.state.speedReading.source, 'gps');
  assert.equal(h.element('accel-value').textContent, '—');
  assert.equal(h.element('speed-estimate').hidden, true);
  h.sample(500, .5, { speed: 18 });
  assert.equal(h.element('accel-value').textContent, '0.00');
});

test('an IMU gap clears both the displayed speed and acceleration until GPS returns', () => {
  const h = harness();
  h.sample(0, 0);
  h.sample(100, .1, { scenario: 'gps', motion: 'gps' });
  h.sample(701, .3);
  assert.equal(h.state.speedReading.reason, 'imu_gap');
  assert.equal(h.element('speed').textContent, '—');
  assert.equal(h.element('accel-value').textContent, '—');
  assert.equal(h.element('speed-estimate').hidden, true);
  h.sample(800, .4);
  assert.equal(h.element('speed').textContent, '—');
});

test('finishing during an inertial estimate leaves no approximate speed on the idle cockpit', () => {
  const h = harness();
  h.sample(0, 0);
  h.sample(100, .1, { scenario: 'gps', motion: 'gps' });
  assert.equal(h.element('speed-estimate').hidden, false);
  h.finish();
  h.render();
  assert.equal(h.state.phase, 'idle');
  assert.equal(h.state.speedReading.source, 'unavailable');
  assert.equal(h.state.speedReading.speedKmh, null);
  assert.equal(h.element('speed-estimate').hidden, true);
  assert.equal(h.element('speed').textContent, '0');
  assert.equal(h.element('map-speed').textContent, '0');
  assert.doesNotMatch(h.element('speed-source').textContent, /惯导/);
  assert.equal(h.element('accel-value').textContent, '—');
});
