import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The real native bridge (ios/Motuo/Cockpit/native-runtime.js) with the page's own
// title/controls functions. DOM and page services are permissive stubs.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../../../ios/Motuo/Cockpit/native-runtime.js', import.meta.url), 'utf8');
const functionSource = name => {
  const start = html.indexOf(` function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  return html.slice(start, html.indexOf('\n', start));
};

function element(name, registry) {
  const store = { name, textContent: '', innerHTML: '', dataset: {}, style: {}, hidden: false, attrs: {} };
  const proxy = new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'documentElement' || k === 'body') return (t[k] = element(`${name}.${k}`, registry));
      if (k === 'classList') return (t.classList = { add() {}, remove() {}, toggle() {}, contains: () => false });
      if (k === 'setAttribute') return (a, v) => { t.attrs[a] = v; };
      if (k === 'querySelector') return sel => registry(`${name} ${sel}`);
      return () => proxy;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return proxy;
}

function harness({ world = true } = {}) {
  const elements = new Map(), posted = [], wrapped = [], pages = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, element(id, $)); return elements.get(id); };
  const doc = element('document', $);
  const context = vm.createContext({
    window: { webkit: { messageHandlers: { motuo: { postMessage: m => posted.push(m.action) } } } },
    document: doc, performance: { now: () => 1000 }, console,
  });
  context.globals = {
    $, posted, wrapped, pages,
    state: { phase: 'idle', page: 'cockpit', seconds: 0, distance: 0, motion: 'ready', scenario: 'normal', reduced: false },
    motionLabels: { ready: [], launch: [], cruise: [], turn: [], stop: [], gps: [], brake: [], accelerate: [] },
    fxLevel: () => ({ world }),
    gameFx: { wrappedRecap: (ride, summary, opts) => { wrapped.push({ ride, opts }); return {}; } },
    game: { summary: () => ({ score: 10 }) },
  };
  vm.runInContext(`
    const {$, posted, wrapped, pages, state, motionLabels, fxLevel, gameFx, game} = globals;
    const nativeHost = true, icon = n => n, all = () => [];
    let soundDemo = false, audioLive = false, energy = 0, spectrum = [], wave = [], bandLevels = [0,0,0], inputDb = null, inputClipped = false, inputQuality = '';
    const departure = { capture: () => null }, motionClock = { setHint() {} };
    function clearSoundFeatures() {} function render() {} function cancelDeparture() {} function hudReset() {} function pauseFx() {}
    function pulseEvent() {} function beginDeparture() {} function renderPerfTier() {}
    function setPage(p) { pages.push(p); state.page = p; $('page-title').textContent = cockpitTitle(state.phase); }
    ${functionSource('cockpitTitle')}
    ${functionSource('updateControls')}
    ${runtime}
    globalThis.receive = window.MotuoNativeReceive;
  `, context);
  const snapshot = extra => ({ phase: 'idle', speedKmh: null, speedSource: 'unavailable', seconds: 0, distanceM: 0, motion: 'ready', sound: { live: false, status: '' }, ...extra });
  return { ...context.globals, receive: s => context.receive(snapshot(s)) };
}

test('the status title follows the native phase: idle, riding, paused', () => {
  const h = harness();
  h.receive({ phase: 'riding', speedKmh: 46, speedSource: 'gps', motion: 'cruise' });
  assert.equal(h.$('page-title').textContent, '路上见');
  h.receive({ phase: 'paused', speedSource: 'gps' });
  assert.equal(h.$('page-title').textContent, '暂停中');
  h.receive({ phase: 'riding', speedKmh: 30, speedSource: 'gps' });
  assert.equal(h.$('page-title').textContent, '路上见');
  h.receive({ phase: 'idle' });
  assert.equal(h.$('page-title').textContent, '准备出发');
  assert.match(html, /titles=\{cockpit:cockpitTitle\(state\.phase\)/, 'the browser page uses the same title function');
});

test('the native modal flag reaches the page state (it gates game events)', () => {
  const h = harness();
  h.receive({ phase: 'riding', speedKmh: 20, speedSource: 'gps', modal: true });
  assert.equal(h.state.nativeModal, true);
  h.receive({ phase: 'riding', speedKmh: 20, speedSource: 'gps', modal: false });
  assert.equal(h.state.nativeModal, false);
  assert.match(html, /modal=!!state\.nativeModal\|\|!!document\.querySelector\('dialog\[open\]'\)/);
  assert.match(html, /paused:paused\|\|modal/);
});

test('a saved native ride plays the full-screen recap once, labelled by its source, and hands over to the native detail', () => {
  const h = harness();
  h.receive({ phase: 'riding', speedKmh: 20, speedSource: 'gps' });
  const finishedRide = { id: 'r1', distanceM: 2400, durationS: 300, maxSpeedKmh: 52.4, simulated: false };
  h.receive({ phase: 'idle', finishedRide });
  h.receive({ phase: 'idle', finishedRide });
  assert.equal(h.wrapped.length, 1, 'one recap per saved ride');
  assert.deepEqual(JSON.parse(JSON.stringify(h.wrapped[0].ride)), { distance: 2400, seconds: 300, maxSpeed: 52.4, source: 'measured' });
  assert.equal(h.wrapped[0].opts.native, true);
  assert.deepEqual(h.posted.slice(-1), ['wrappedShown']);
  h.wrapped[0].opts.onClose('detail');
  assert.equal(h.posted.at(-1), 'rideDetail');
  h.wrapped[0].opts.onClose('done');
  assert.equal(h.posted.at(-1), 'wrappedDone');
  h.receive({ phase: 'idle', finishedRide: { ...finishedRide, id: 'r2', simulated: true } });
  assert.equal(h.wrapped[1].ride.source, 'simulated');
});

test('without the world layer (restrained intensity) the native recap opens directly', () => {
  const h = harness({ world: false });
  h.receive({ phase: 'idle', finishedRide: { id: 'r9', distanceM: 10, durationS: 5, maxSpeedKmh: 3, simulated: true } });
  assert.equal(h.wrapped.length, 0);
  assert.equal(h.posted.at(-1), 'rideDetail');
});

test('every action the web runtime sends is on the native bridge allowlist', () => {
  const swift = readFileSync(new URL('../../../ios/Motuo/Cockpit/CockpitWebView.swift', import.meta.url), 'utf8');
  const allow = new Set([...swift.match(/static let commands:Set<String>=\[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]));
  const sent = new Set([...runtime.matchAll(/nativeSend\('([A-Za-z]+)'\)/g)].map(m => m[1]));
  for (const m of runtime.matchAll(/'([A-Za-z]+)'/g)) if (/^(rideDetail|wrappedDone|wrappedShown)$/.test(m[1])) sent.add(m[1]);
  const mapped = runtime.match(/const actions=\{([^}]*)\}/)[1];
  for (const m of mapped.matchAll(/:'([A-Za-z]+)'/g)) sent.add(m[1]);
  assert.ok(sent.size >= 10);
  for (const action of sent) assert.ok(allow.has(action), `native allowlist is missing "${action}"`);
});
