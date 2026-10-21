import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {brotliDecompressSync} from 'node:zlib';
import {root} from './helpers.mjs';

// 只解析 WOFF2 的 cmap（cmap 表在 WOFF2 中不做变换），得到字库覆盖的码位。
function woff2Cmap(path) {
  const b = readFileSync(path);
  assert.equal(b.toString('latin1', 0, 4), 'wOF2');
  const numTables = b.readUInt16BE(12), compressed = b.readUInt32BE(20);
  let p = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const c = b[p++]; v = v * 128 + (c & 127); if (!(c & 128)) return v; } throw new Error('bad'); };
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const flags = b[p++], tagIdx = flags & 63, version = flags >> 6;
    let tag = tagIdx;
    if (tagIdx === 63) { tag = b.toString('latin1', p, p + 4); p += 4; }
    const orig = base128();
    const transformed = (tagIdx === 10 || tagIdx === 11) ? version === 0 : version !== 0;
    const len = transformed ? base128() : orig;
    tables.push({tag, len});
  }
  const data = brotliDecompressSync(b.subarray(p, p + compressed));
  let off = 0, cmap = null;
  for (const t of tables) { if (t.tag === 0) cmap = data.subarray(off, off + t.len); off += t.len; }
  const cps = new Set(), n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const so = cmap.readUInt32BE(4 + i * 8 + 4), fmt = cmap.readUInt16BE(so);
    if (fmt === 12) { const groups = cmap.readUInt32BE(so + 12); for (let g = 0; g < groups; g++) { const s = cmap.readUInt32BE(so + 16 + g * 12), e = cmap.readUInt32BE(so + 20 + g * 12); for (let c = s; c <= e; c++) cps.add(c); } }
    if (fmt === 4) { const seg = cmap.readUInt16BE(so + 6) / 2; for (let k = 0; k < seg; k++) { const end = cmap.readUInt16BE(so + 14 + k * 2), start = cmap.readUInt16BE(so + 16 + seg * 2 + k * 2); for (let c = start; c <= end && c !== 0xffff; c++) cps.add(c); } }
  }
  return cps;
}
const font = f => woff2Cmap(new URL(`assets/fonts/${f}`, root));
const han = font('motuo-han.woff2'), display = font('motuo-display.woff2'), num = font('motuo-num.woff2');

function uiStrings() {
  const files = ['index.html', 'app.js', 'native-adapter.js', ...['core', 'render', 'audio'].flatMap(d => readdirSync(new URL(d, root)).filter(f => f.endsWith('.js')).map(f => `${d}/${f}`))];
  let text = '';
  for (const f of files) {
    let s = readFileSync(new URL(f, root), 'utf8');
    if (f.endsWith('.html')) { text += s.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' '); continue; }
    s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(,])\/\/.*$/gm, '$1');
    for (const m of s.matchAll(/'([^'\n\\]*)'|`([^`]*)`/g)) text += ' ' + (m[1] ?? m[2]);
  }
  return text;
}

test('字体文件与 OFL 许可都在 v3 内（不跨目录引用 v2）', () => {
  for (const f of ['motuo-num.woff2', 'motuo-display.woff2', 'motuo-han.woff2', 'OFL-Orbitron.txt', 'OFL-RussoOne.txt', 'OFL-SmileySans.txt']) assert.ok(existsSync(new URL(`assets/fonts/${f}`, root)), f);
  for (const f of ['index.html', 'styles.css', 'app.js']) assert.doesNotMatch(readFileSync(new URL(f, root), 'utf8'), /motuo-v2|https?:\/\/(?!127)/, f);
  assert.ok(han.size > 3800 && display.size > 100 && num.size > 100);
});

test('v3 界面文案的中文全部在 MotuoHan 子集内（不回退系统字体）', () => {
  const cjk = [...new Set(uiStrings().match(/[　-〿㐀-鿿＀-￯]/g) || [])];
  const missing = cjk.filter(c => !han.has(c.codePointAt(0)));
  assert.ok(cjk.length > 150, `found ${cjk.length}`);
  assert.deepEqual(missing, []);
});

test('非 ASCII 符号都被某款打包字体覆盖（² 由代码画成上标 2）', () => {
  const syms = [...new Set(uiStrings().match(/[\u0080-⿿]/g) || [])].filter(c => c !== '²');
  const missing = syms.filter(c => ![han, display, num].some(f => f.has(c.codePointAt(0))));
  assert.deepEqual(missing, []);
});
