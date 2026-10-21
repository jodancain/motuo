// 桥接白名单：网页源码里发出的每个动作都必须在原生白名单里（上一轮曾漏加，只靠超时兜底）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {NATIVE_ACTIONS} from '../native-adapter.js';

const v3 = new URL('../', import.meta.url), repo = new URL('../../../', import.meta.url);
const swift = readFileSync(new URL('ios/Motuo/Cockpit/CockpitWebView.swift', repo), 'utf8');
const commands = new Set([...swift.match(/static let commands:Set<String>=\[([^\]]*)\]/)[1].matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]));
function jsFiles(dir) {
  return readdirSync(dir).flatMap(f => { const u = new URL(f, dir); if (f === 'vendor' || f === 'tests' || f === 'assets') return []; return statSync(u).isDirectory() ? jsFiles(new URL(f + '/', dir)) : f.endsWith('.js') ? [u] : []; });
}
const sources = jsFiles(v3).map(u => ({file: u.pathname.split('motuo-v3/')[1], text: readFileSync(u, 'utf8')}));

test('原生白名单包含 v3 适配层声明的全部动作', () => {
  for (const a of NATIVE_ACTIONS) assert.ok(commands.has(a), `CockpitWebView.commands 缺少 ${a}`);
  assert.ok(!commands.has('eval'));
});
test('扫描 v3 源码：每个 send(\'动作\') 都在白名单；postMessage 只出现在适配层', () => {
  const found = new Set();
  for (const {file, text} of sources) {
    // send('x') 直接发送；startNativeCountdown('x') 在倒计时走完后转发同一动作。
    for (const m of text.matchAll(/\b(?:send|startNativeCountdown)\(\s*['"]([A-Za-z]+)['"]/g)) found.add(m[1]);
    if (file !== 'native-adapter.js') assert.doesNotMatch(text, /postMessage\s*\(/, `${file} 不应绕过适配层直接 postMessage`);
  }
  assert.ok(found.size >= 10, `找到的动作太少：${[...found]}`);
  for (const a of found) { assert.ok(NATIVE_ACTIONS.includes(a), `${a} 不在 NATIVE_ACTIONS`); assert.ok(commands.has(a), `${a} 不在原生白名单`); }
  // 反向：适配层声明的动作都真的被网页用到（ready 由 native.ready() 发出）
  for (const a of NATIVE_ACTIONS) if (a !== 'ready' && a !== 'wrappedShown') assert.ok(found.has(a), `${a} 声明了但没有用到`);
});
test('v2 回退包：native-runtime.js 与 HTML 动作表里的动作都在白名单', () => {
  const rt = readFileSync(new URL('ios/Motuo/Cockpit/native-runtime.js', repo), 'utf8');
  const acts = new Set([...rt.matchAll(/nativeSend\(\s*['"]([A-Za-z]+)['"]/g)].map(m => m[1]));
  const map = rt.match(/const actions=\{([^}]*)\}/)[1];
  for (const m of map.matchAll(/:'([A-Za-z]+)'/g)) acts.add(m[1]);
  for (const m of rt.matchAll(/action=['"]([A-Za-z]+)['"]/g)) acts.add(m[1]);
  assert.ok(acts.size >= 10);
  for (const a of acts) assert.ok(commands.has(a), `v2 动作 ${a} 不在白名单`);
});
test('原生打包：视口 cover、原生样式存在且小控件不排成底部导航', () => {
  assert.match(readFileSync(new URL('index.html', v3), 'utf8'), /viewport-fit=cover/);
  const css = readFileSync(new URL('ios/Motuo/Cockpit/v3/native-runtime.css', repo), 'utf8');
  for (const id of ['btn-world', 'btn-garage', 'btn-sound', 'btn-settings']) assert.match(css, new RegExp(`#${id}\\{top:\\d+px\\}`), id);
  assert.doesNotMatch(css, /#btn-(world|garage|sound|settings)[^{]*\{[^}]*bottom:/);
  const prep = readFileSync(new URL('scripts/prepare-native-cockpit.py', repo), 'utf8');
  assert.match(prep, /native-runtime\.css/); assert.match(prep, /motuo-v3/);
  const styles = readFileSync(new URL('styles.css', v3), 'utf8');
  for (const sel of ['.page{', '.landscape .sheet{', '.comic{']) assert.match(styles.slice(styles.indexOf(sel)), /^[^}]*env\(safe-area-inset/, `${sel} 需要避开安全区`);
});
