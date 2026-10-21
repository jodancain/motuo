import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import vm from 'node:vm';

const here = new URL('..', import.meta.url);
const read = path => readFileSync(new URL(path, here), 'utf8');
const fontDir = new URL('assets/fonts/', here);

// Minimal WOFF2 reader: table directory + brotli stream, then the cmap table (format 4/12).
function woff2Cmap(buffer) {
  assert.equal(buffer.toString('latin1', 0, 4), 'wOF2', 'woff2 signature');
  const numTables = buffer.readUInt16BE(12), compressed = buffer.readUInt32BE(20);
  const tags = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
  let off = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buffer[off++]; v = v * 128 + (b & 127); if (!(b & 128)) return v; } throw new Error('bad base128'); };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buffer[off++], idx = flags & 63, version = flags >> 6;
    const tag = idx === 63 ? buffer.toString('latin1', off, (off += 4)) : tags[idx];
    const orig = base128();
    const transformed = (tag === 'glyf' || tag === 'loca') ? version === 0 : version !== 0;
    tables.push({ tag, length: transformed ? base128() : orig });
  }
  const data = brotliDecompressSync(buffer.subarray(off, off + compressed));
  let pos = 0, cmap = null;
  for (const t of tables) { if (t.tag === 'cmap') cmap = data.subarray(pos, pos + t.length); pos += t.length; }
  assert.ok(cmap, 'cmap table');
  const codepoints = new Set(), n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const sub = cmap.readUInt32BE(4 + i * 8 + 4), format = cmap.readUInt16BE(sub);
    if (format === 4) {
      const seg = cmap.readUInt16BE(sub + 6) / 2;
      for (let s = 0; s < seg; s++) {
        const end = cmap.readUInt16BE(sub + 14 + s * 2), start = cmap.readUInt16BE(sub + 16 + seg * 2 + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) codepoints.add(c);
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) { const a = cmap.readUInt32BE(sub + 16 + g * 12), b = cmap.readUInt32BE(sub + 20 + g * 12); for (let c = a; c <= b; c++) codepoints.add(c); }
    }
  }
  return codepoints;
}

test('bundled fonts: woff2, block display, renamed families, preloaded, ≤ 2.5 MB total', () => {
  const css = read('fonts.css');
  const faces = [...css.matchAll(/@font-face\{([^}]*)\}/g)].map(m => m[1]);
  assert.equal(faces.length, 3);
  let total = 0;
  for (const face of faces) {
    assert.match(face, /font-display:block/);
    const file = face.match(/url\("([^"]+)"\)/)[1];
    const buffer = readFileSync(new URL(file, here));
    assert.equal(buffer.toString('latin1', 0, 4), 'wOF2');
    total += buffer.length;
    assert.doesNotMatch(face.match(/font-family:"([^"]+)"/)[1], /Orbitron|Russo|Smiley|得意黑/, 'OFL reserved names are not reused by modified versions');
    assert.match(read('index.html'), new RegExp(`<link rel="preload" href="${file}" as="font" type="font/woff2" crossorigin>`));
  }
  assert.ok(total <= 2.5 * 1024 * 1024, `${total} bytes`);
  const manifest = JSON.parse(readFileSync(new URL('fonts-manifest.json', fontDir), 'utf8'));
  assert.equal(manifest.total_bytes, total);
  for (const lic of ['OFL-Orbitron.txt', 'OFL-RussoOne.txt', 'OFL-SmileySans.txt']) assert.match(readFileSync(new URL(lic, fontDir), 'utf8'), /SIL Open Font License, Version 1\.1/);
  // Every stack ends in system fonts, so a failed load degrades instead of showing nothing.
  for (const v of ['--font-num', '--font-display', '--font-han']) assert.match(css, new RegExp(`${v}:[^;]*(monospace|sans-serif)`));
  const notices = readFileSync(new URL('../../ios/Motuo/Resources/ThirdPartyNotices.txt', here), 'utf8');
  for (const name of ['Orbitron', 'Russo One', 'Smiley Sans']) assert.match(notices, new RegExp(name));
});

test('the Chinese subset covers every CJK character the cockpit can show (missing glyph = failure)', () => {
  const cjk = /[　-〿㐀-䶿一-鿿＀-￯]/g;
  const files = readdirSync(here).filter(f => /\.(html|js|css)$/.test(f) && f !== 'ride-hud-preview.html').map(f => read(f));
  files.push(readFileSync(new URL('../../ios/Motuo/Cockpit/native-runtime.js', here), 'utf8'));
  const used = new Set(files.join('').match(cjk));
  const han = woff2Cmap(readFileSync(new URL('motuo-han.woff2', fontDir)));
  const missing = [...used].filter(ch => !han.has(ch.codePointAt(0)));
  assert.deepEqual(missing, [], `subset is missing: ${missing.join('')} — rerun scripts/build-cockpit-fonts.py`);
  assert.ok(used.size > 300);
  const num = woff2Cmap(readFileSync(new URL('motuo-num.woff2', fontDir)));
  for (const ch of '0123456789.:—×km/h') assert.ok(num.has(ch.codePointAt(0)), ch);
});

test('native bundle ships the fonts and the asset handler serves woff2', () => {
  assert.match(readFileSync(new URL('../../scripts/prepare-native-cockpit.py', here), 'utf8'), /assets\/fonts/);
  const handler = readFileSync(new URL('../../ios/Motuo/Cockpit/CockpitWebView.swift', here), 'utf8');
  assert.match(handler, /"woff2"/); assert.match(handler, /font\/woff2/);
});

// Bike layer: the long-press start state machine and safety rails.
const ctx = vm.createContext({ window: { performance: { now: () => 0 } } });
vm.runInContext(read('bike-fx.js'), ctx);
const B = ctx.window.MotuoBikeFX;

test('tap revs; a short hold fizzles; only a full charge + release enters a cancellable countdown', () => {
  let startable = true;
  const m = B.createChargeMachine({ fullMs: 1000, confirmMs: 1500, canStart: () => startable });
  assert.equal(m.press(0), 'charge'); assert.equal(m.release(120), 'rev'); assert.equal(m.state, 'idle');
  m.press(0); m.tick(600); assert.equal(m.release(600), 'fizzle', 'released before full: no start');
  m.press(0); assert.equal(m.tick(1000), 'armed'); assert.equal(m.release(1100), 'confirm'); assert.equal(m.state, 'confirming');
  assert.equal(m.tick(2000), null); assert.equal(m.cancel(), 'cancel', 'the countdown can be cancelled');
  assert.equal(m.tick(9000), null); assert.equal(m.state, 'idle');
  m.press(0); m.tick(1000); m.release(1000); assert.equal(m.tick(2600), 'start');
  assert.equal(m.tick(2700), null, 'starts exactly once');
});

test('drags, riding, dialogs and non-start pages never start a ride', () => {
  let startable = true;
  const m = B.createChargeMachine({ fullMs: 1000, confirmMs: 1500, canStart: () => startable });
  m.press(0); assert.equal(m.move(40), 'drag'); assert.equal(m.tick(2000), null); assert.equal(m.state, 'idle');
  m.press(0); m.tick(1000); m.release(1000); startable = false; assert.equal(m.tick(1200), 'cancel', 'dialog opened / ride started elsewhere');
  startable = false; m.press(0); assert.equal(m.tick(1000), 'armed-dash'); assert.equal(m.release(1000), 'dash', 'garage: charge only dashes');
});

function bikeHarness({ reduced = false, flash = true } = {}) {
  const els = new Map(), listeners = {};
  const el = id => { if (!els.has(id)) els.set(id, { id, hidden: true, dataset: {}, style: { setProperty(k, v) { this[k] = v; } }, classList: { toggle() {} }, textContent: '', querySelector: s => el(id + ' ' + s), addEventListener(t, f) { (listeners[id] ||= {})[t] = f; }, getBoundingClientRect: () => ({ left: 100, top: 100, width: 300, height: 200 }), getContext: () => null }); return els.get(id); };
  const doc = { querySelector: s => el(s) };
  const canvas = el('canvas'); canvas.parentNode = el('host');
  let flashes = 0, started = 0, t = 0;
  const env = vm.createContext({ window: { performance: { now: () => t }, innerWidth: 800, innerHeight: 600 } });
  vm.runInContext(read('bike-fx.js'), env);
  const fx = env.window.MotuoBikeFX.create(doc, { isReduced: () => reduced, getCanvas: () => canvas, allowFlash: () => (flash && ++flashes, flash), canStart: () => true, onStart: () => started++, win: env.window });
  const host = el('#host'); fx.bind(host, { startable: true });
  const fire = (type, x = 250) => listeners['#host'][type]({ clientX: x, clientY: 200 });
  return { fx, fire, el, setT: v => { t = v; }, get flashes() { return flashes; }, get started() { return started; } };
}

test('gestures are ignored while riding; impact frames spend the shared flash budget', () => {
  const h = bikeHarness();
  h.fx.frameInput({ active: true, accel: 1 });
  h.fire('pointerdown'); assert.equal(h.fx.machine.state, 'idle', 'riding: no charge, no start');
  h.fx.frameInput({ active: false });
  h.fire('pointerdown'); assert.equal(h.fx.machine.state, 'charging');
  h.fire('pointerup'); assert.equal(h.fx.machine.state, 'idle');
  const before = h.flashes;
  h.fx.event({ kind: 'milestone' });
  assert.equal(h.flashes, before + 1, 'impact frame asks the flash limiter');
  const denied = bikeHarness({ flash: false });
  assert.equal(denied.fx.impactFrame(), false, 'no budget, no impact frame');
  assert.equal(denied.el('#impact-frame').hidden, true);
});

test('reduced motion: no particles or onomatopoeia; a dialog cancels a pending start', () => {
  const r = bikeHarness({ reduced: true });
  r.fx.react('rev'); r.fx.event({ kind: 'boost' });
  assert.equal(r.fx.debug().parts, 0); assert.equal(r.fx.debug().words, 0);
  const h = bikeHarness();
  h.fire('pointerdown'); h.setT(1200); h.fx.machine.tick(1200); h.fire('pointerup');
  assert.equal(h.fx.machine.state, 'confirming');
  h.fx.setModal(true);
  assert.equal(h.fx.machine.state, 'idle');
  assert.equal(h.started, 0);
});
