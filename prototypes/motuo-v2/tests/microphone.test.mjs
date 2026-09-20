import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// These are lifecycle/contract tests of the production HTML, with synthetic
// media hardware. They do not validate browser permissions or engine detection.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const controller = html.split('// BEGIN MICROPHONE CONTROLLER')[1]?.split('// END MICROPHONE CONTROLLER')[0];
assert.ok(controller, 'The HTML must expose the bounded microphone controller.');
const classSource = controller.slice(controller.indexOf('class MicrophoneInput'));
const Class = vm.runInNewContext(`${classSource}; MicrophoneInput`, {});
const lineStarting = (text) => {
  const line = html.split('\n').find((line) => line.trimStart().startsWith(text));
  assert.ok(line, `Missing production source: ${text}`);
  return line;
};
const blockFunction = (name) => {
  const start = html.indexOf(` function ${name}(`);
  assert.ok(start >= 0, `Missing production function ${name}`);
  const end = html.indexOf('\n }', start);
  assert.ok(end >= 0, `Missing production function terminator ${name}`);
  return html.slice(start, end + 3);
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const error = (name) => Object.assign(new Error(name), { name });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function track() {
  return {
    readyState: 'live', muted: false, label: 'Test input', stops: 0,
    getSettings: () => ({ echoCancellation: false, noiseSuppression: false }),
    stop() { this.stops++; this.readyState = 'ended'; },
    end() { this.readyState = 'ended'; this.onended?.(); },
    mute() { this.muted = true; this.onmute?.(); },
    unmute() { this.muted = false; this.onunmute?.(); },
  };
}
function stream(...tracks) {
  if (!tracks.length) tracks = [track()];
  return { getTracks: () => tracks, getAudioTracks: () => tracks };
}
function harness({ hidden = false, secure = true, resume, frequency, waveform, sampleRate = 48000 } = {}) {
  const requests = [], contexts = [], notifications = [];
  const env = {
    isHidden: hidden, isSecure: secure,
    hidden() { return this.isHidden; }, secure() { return this.isSecure; },
    mediaDevices: { getUserMedia(constraints) { const d = deferred(); requests.push({ ...d, constraints }); return d.promise; } },
    Audio: class {
      constructor() {
        this.state = 'suspended'; this.sampleRate = sampleRate; this.closes = 0;
        this.destination = { speaker: true }; this.connections = [];
        contexts.push(this);
      }
      resume() { if (resume) return resume(this); this.state = 'running'; return Promise.resolve(); }
      close() { this.closes++; this.state = 'closed'; return Promise.resolve(); }
      setState(next) { this.state = next; this.onstatechange?.(); }
      createMediaStreamSource(input) {
        assert.ok(input);
        return this.source = {
          disconnects: 0,
          connect: (node) => this.connections.push(node),
          disconnect() { this.disconnects++; },
        };
      }
      createAnalyser() {
        return this.analyser = {
          fftSize: 2048, smoothingTimeConstant: 0, frequencyCalls: 0, timeCalls: 0,
          get frequencyBinCount() { return this.fftSize / 2; },
          getByteFrequencyData(buffer) { this.frequencyCalls++; buffer.fill(0); frequency?.(buffer); },
          getFloatTimeDomainData(buffer) { this.timeCalls++; buffer.fill(0); waveform?.(buffer); },
        };
      }
    },
  };
  const mic = new Class(env, () => notifications.push(mic.status));
  return { mic, env, contexts, requests, notifications };
}
async function activate(h, media = stream()) {
  const pending = h.mic.start();
  h.requests.at(-1).resolve(media);
  await pending;
  assert.equal(h.mic.status, 'live');
  return media;
}

test('default construction never opens microphone or audio context', () => {
  const h = harness();
  assert.equal(h.mic.status, 'off');
  assert.equal(h.mic.sample(), null);
  assert.equal(h.requests.length, 0);
  assert.equal(h.contexts.length, 0);
});

test('insecure origin and missing API fail without requesting hardware', async () => {
  for (const kind of ['secure', 'mediaDevices', 'Audio']) {
    const h = harness({ secure: kind !== 'secure' });
    if (kind !== 'secure') h.env[kind] = undefined;
    await h.mic.start();
    assert.equal(h.mic.status, 'unsupported');
    assert.equal(h.requests.length, 0);
    assert.equal(h.contexts.length, 0);
  }
});

test('starting while already hidden is blocked before microphone request', async () => {
  const h = harness({ hidden: true });
  const pending = h.mic.start();
  // Ensure a regression cannot leave this test hanging on permission.
  h.requests[0]?.resolve(stream());
  await pending;
  assert.equal(h.mic.status, 'background');
  assert.equal(h.requests.length, 0);
  assert.equal(h.contexts.length, 0);
});

test('repeated starts share the pending request and retain only one live graph', async () => {
  const h = harness();
  const pending = h.mic.start();
  await h.mic.start();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve(stream());
  await pending;
  await h.mic.start();
  assert.equal(h.contexts.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.mic.status, 'live');
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].constraints)), {
    video: false,
    audio: { echoCancellation: { ideal: false }, noiseSuppression: { ideal: false }, autoGainControl: { ideal: false } },
  });
});

test('canceled permission result stops every late track and does not become live', async () => {
  const h = harness();
  const pending = h.mic.start();
  h.mic.stop();
  const late = stream(track(), track());
  h.requests[0].resolve(late);
  await pending;
  assert.equal(h.mic.status, 'off');
  assert.ok(late.getTracks().every((item) => item.stops === 1));
  assert.equal(h.contexts[0].closes, 1);
  assert.equal(h.mic.stream, null);
  assert.equal(h.mic.sample(), null);
});

test('old rejected request cannot overwrite a newer live session', async () => {
  const h = harness();
  const old = h.mic.start();
  h.mic.stop();
  const fresh = h.mic.start();
  const freshStream = stream();
  h.requests[1].resolve(freshStream);
  await fresh;
  h.requests[0].reject(error('NotAllowedError'));
  await old;
  assert.equal(h.mic.status, 'live');
  assert.equal(h.mic.stream, freshStream);
  assert.equal(freshStream.getTracks()[0].stops, 0);
});

test('late stream from old request cannot replace or stop the newer stream', async () => {
  const h = harness();
  const old = h.mic.start();
  h.mic.stop();
  const freshStream = await activate(h);
  const late = stream();
  h.requests[0].resolve(late);
  await old;
  assert.equal(late.getTracks()[0].stops, 1);
  assert.equal(freshStream.getTracks()[0].stops, 0);
  assert.equal(h.mic.stream, freshStream);
});

test('permission and device errors release context and allow explicit retry', async () => {
  const statuses = { NotAllowedError: 'denied', NotFoundError: 'missing', NotReadableError: 'unavailable', SecurityError: 'denied', AbortError: 'interrupted', UnknownError: 'unavailable' };
  for (const [name, expected] of Object.entries(statuses)) {
    const h = harness();
    const pending = h.mic.start();
    h.requests[0].reject(error(name));
    await pending;
    assert.equal(h.mic.status, expected, name);
    assert.equal(h.contexts[0].closes, 1, name);
    assert.equal(h.mic.sample(), null, name);
    await activate(h);
    assert.equal(h.requests.length, 2, name);
    assert.equal(h.mic.detail, '', name);
  }
});

test('mute invalidates samples without opening another stream; unmute restores live', async () => {
  const h = harness();
  const input = (await activate(h)).getTracks()[0];
  input.mute();
  assert.equal(h.mic.status, 'muted');
  assert.equal(h.mic.sample(), null);
  await h.mic.start();
  assert.equal(h.requests.length, 1);
  input.unmute();
  assert.equal(h.mic.status, 'live');
  assert.notEqual(h.mic.sample(), null);
});

test('initially muted stream is not announced as live', async () => {
  const h = harness();
  const input = track(); input.muted = true;
  const pending = h.mic.start();
  h.requests[0].resolve(stream(input));
  await pending;
  assert.equal(h.mic.status, 'muted');
  assert.equal(h.mic.sample(), null);
});

test('ended input releases tracks and graph, with explicit recovery', async () => {
  const h = harness();
  const media = await activate(h);
  const input = media.getTracks()[0];
  input.end();
  assert.equal(h.mic.status, 'interrupted');
  assert.equal(input.stops, 1);
  assert.equal(h.contexts[0].closes, 1);
  assert.equal(h.contexts[0].source.disconnects, 1);
  assert.equal(h.mic.sample(), null);
  await activate(h);
});

test('manual stop cleans synchronously although track.stop fires no ended event', async () => {
  const h = harness();
  const media = await activate(h);
  const context = h.contexts[0];
  assert.deepEqual(context.connections, [context.analyser], 'No speaker/monitor connection');
  h.mic.stop();
  h.mic.stop();
  assert.equal(h.mic.status, 'off');
  assert.equal(context.closes, 1);
  assert.equal(context.source.disconnects, 1);
  assert.equal(media.getTracks()[0].stops, 1);
  assert.equal(media.getTracks()[0].onended, null);
  assert.equal(context.onstatechange, null);
});

test('AudioContext suspension interrupts capture and prevents stale live features', async () => {
  const h = harness();
  const media = await activate(h);
  h.contexts[0].setState('suspended');
  assert.equal(h.mic.status, 'interrupted');
  assert.equal(media.getTracks()[0].stops, 1);
  assert.equal(h.mic.sample(), null);
});

test('resume rejection after stream grant cleans up the granted track', async () => {
  const h = harness({ resume: () => Promise.reject(error('NotAllowedError')) });
  const pending = h.mic.start();
  const media = stream();
  h.requests[0].resolve(media);
  await pending;
  assert.equal(h.mic.status, 'denied');
  assert.equal(media.getTracks()[0].stops, 1);
  assert.equal(h.contexts[0].closes, 1);
});

test('cancel while AudioContext resume is pending cannot resurrect live capture', async () => {
  const resumed = deferred();
  const h = harness({ resume: () => resumed.promise });
  const pending = h.mic.start();
  const media = stream();
  h.requests[0].resolve(media);
  await flush();
  h.mic.stop();
  resumed.resolve();
  await pending;
  assert.equal(h.mic.status, 'off');
  assert.equal(media.getTracks()[0].stops, 1);
  assert.equal(h.mic.sample(), null);
});

test('ended event during pending resume wins over later resume and unmute callbacks', async () => {
  const resumed = deferred();
  const h = harness({ resume: () => resumed.promise });
  const pending = h.mic.start();
  const input = track();
  h.requests[0].resolve(stream(input));
  await flush();
  const staleUnmute = input.onunmute;
  input.mute();
  assert.equal(h.mic.status, 'muted');
  input.end();
  assert.equal(h.mic.status, 'interrupted');
  h.contexts[0].state = 'running'; // A deliberately late/mock platform callback.
  staleUnmute();
  resumed.resolve();
  await pending;
  assert.equal(h.mic.status, 'interrupted');
  assert.equal(h.mic.stream, null);
  assert.equal(input.stops, 1);
  assert.equal(h.mic.sample(), null);
});

test('no audio track or already ended track fails instead of advertising live capture', async () => {
  for (const media of [
    { getAudioTracks: () => [], getTracks: () => [] },
    stream(Object.assign(track(), { readyState: 'ended' })),
  ]) {
    const h = harness();
    const pending = h.mic.start();
    h.requests[0].resolve(media);
    await pending;
    assert.equal(h.mic.status, 'unavailable');
    assert.equal(h.contexts[0].closes, 1);
    assert.equal(h.mic.sample(), null);
  }
});

test('background transition during pending permission discards late stream', async () => {
  const h = harness();
  const pending = h.mic.start();
  h.env.isHidden = true;
  const media = stream();
  h.requests[0].resolve(media);
  await pending;
  assert.equal(h.mic.status, 'background');
  assert.equal(media.getTracks()[0].stops, 1);
  assert.equal(h.contexts[0].closes, 1);
});

test('hidden tab and dead/muted tracks return no sample even before event dispatch', async () => {
  const h = harness();
  const media = await activate(h);
  h.env.isHidden = true;
  assert.equal(h.mic.sample(), null);
  h.env.isHidden = false;
  media.getTracks()[0].muted = true;
  assert.equal(h.mic.sample(), null);
  media.getTracks()[0].muted = false;
  media.getTracks()[0].readyState = 'ended';
  assert.equal(h.mic.sample(), null);
  assert.equal(h.contexts[0].analyser.frequencyCalls, 0);
});

test('true silence yields zero signal with valid input, never a decorative waveform', async () => {
  const h = harness();
  await activate(h);
  const sample = h.mic.sample();
  assert.equal(sample.rms, 0);
  assert.equal(sample.db, -100);
  assert.equal(sample.level, 0);
  assert.equal(sample.clipped, false);
  assert.ok([...sample.spectrum, ...sample.bands, ...sample.wave].every((value) => value === 0));
});

test('FFT uses real context sample rate and produces a bounded 24-bin spectrum', async () => {
  for (const sampleRate of [44100, 48000]) {
    const frequencyHz = 1000;
    const h = harness({ sampleRate, frequency(buffer) { buffer[Math.round(frequencyHz / (sampleRate / 2) * buffer.length)] = 255; }, waveform(buffer) { buffer.fill(0.5); } });
    await activate(h);
    const sample = h.mic.sample();
    assert.equal(sample.spectrum.length, 24);
    assert.equal(sample.wave.length, 80);
    assert.equal(sample.bands.length, 3);
    assert.equal(sample.rms, 0.5);
    assert.ok(Math.abs(sample.db - 20 * Math.log10(0.5)) < 1e-8);
    assert.equal(sample.level, 1);
    const peak = sample.spectrum.indexOf(1);
    const expected = Math.floor(Math.log(frequencyHz / 35) / Math.log(12000 / 35) * 24);
    assert.ok(Math.abs(peak - expected) <= 1, `sampleRate=${sampleRate}, peak=${peak}`);
    assert.ok(sample.spectrum.every((value) => value >= 0 && value <= 1));
    assert.equal(sample.bands[0], 0);
    assert.ok(sample.bands[1] > 0);
    assert.equal(sample.bands[2], 0);
  }
});

test('clipping flag is based on input samples rather than decorative energy', async () => {
  const h = harness({ waveform(buffer) { buffer.fill(1, 0, Math.ceil(buffer.length * 0.05)); } });
  await activate(h);
  assert.equal(h.mic.sample().clipped, true);
});

function featureHarness(mic) {
  const elements = new Map();
  const node = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: '', dataset: {}, attributes: {}, classList: { toggle() {} }, setAttribute(key, value) { this.attributes[key] = value; } });
    return elements.get(id);
  };
  const docEvents = {}, windowEvents = {};
  const document = { hidden: false, addEventListener: (name, fn) => { docEvents[name] = fn; } };
  const env = vm.createContext({ microphone: mic, $: node, document, window: { addEventListener: (name, fn) => { windowEvents[name] = fn; } }, performance: { now: () => clock }, state: { beat: 0, music: false, song: 0, visualSeconds: 10 }, synchronizeAudio: () => {}, updateMusic: () => {}, songs: ['a', 'b'], stopVoices: () => {} });
  let clock = 1000;
  vm.runInContext(`
    let spectrum=Array(24).fill(0),wave=Array(80).fill(0),audioLive=false,bandLevels=[0,0,0],energy=0;
    let soundDemo=false,inputDb=null,inputClipped=false,inputQuality='等待输入',inputSampleTime=0;
    let audioContext=null,nextNote=0,audioBeatZero=0,noteIndex=0;
    ${lineStarting('const inputLabels=')}
    ${lineStarting('function clearSoundFeatures()')}
    ${blockFunction('sampleAudio')}
    ${blockFunction('renderInput')}
    ${lineStarting('function stopInput(')}
    ${lineStarting('function music()')}
    ${lineStarting('function changeSong(')}
    ${lineStarting("document.addEventListener('visibilitychange'")}
    ${lineStarting("window.addEventListener('pagehide'")}
    globalThis.api={
      sample:sampleAudio,render:renderInput,music,changeSong,
      demo(value){soundDemo=value;},
      read(){return {spectrum,wave,audioLive,bandLevels,energy,inputDb,inputClipped,inputQuality,beat:state.beat,soundDemo};}
    };
  `, env);
  return { api: env.api, document, docEvents, windowEvents, elements, advance: () => { clock += 200; } };
}

test('production sampleAudio clears stale live values and does not silently enable demo', () => {
  const mic = { status: 'live', sample: () => ({ spectrum: Array(24).fill(0.7), wave: Array(80).fill(0.2), bands: [0.6, 0.4, 0.2], db: -20, level: 0.9, clipped: false }) };
  const h = featureHarness(mic);
  h.api.sample();
  assert.ok(h.api.read().energy > 0);
  mic.status = 'interrupted'; mic.sample = () => null;
  h.advance(); h.api.sample();
  const empty = h.api.read();
  assert.equal(empty.audioLive, false);
  assert.equal(empty.soundDemo, false);
  assert.equal(empty.energy, 0);
  assert.equal(empty.beat, 0);
  assert.equal(empty.inputDb, null);
  assert.ok([...empty.spectrum, ...empty.wave, ...empty.bandLevels].every((value) => value === 0));
});

test('explicit sound demo is labeled and cannot masquerade as real input', () => {
  const h = featureHarness({ status: 'off', sample: () => null });
  h.api.demo(true); h.api.sample(); h.api.render();
  const data = h.api.read();
  assert.equal(data.audioLive, false);
  assert.equal(data.inputDb, null);
  assert.equal(data.inputQuality, '模拟声浪 · 非实测');
  assert.ok(data.energy > 0);
  assert.equal(h.elements.get('input-status').textContent, '声浪演示');
  assert.equal(h.elements.get('input-status').dataset.state, 'demo');
});

test('music play and song changes cannot populate or alter input features', () => {
  const h = featureHarness({ status: 'off', sample: () => null });
  h.api.sample();
  const before = JSON.stringify(h.api.read());
  h.api.music(); h.api.changeSong(1); h.advance(); h.api.sample();
  assert.equal(JSON.stringify(h.api.read()), before);
  h.api.music(); h.api.changeSong(-1); h.advance(); h.api.sample();
  assert.equal(JSON.stringify(h.api.read()), before);
});

test('UI distinguishes waiting, muted and real capture, including actual input name', () => {
  const mic = { status: 'requesting', sample: () => null };
  const h = featureHarness(mic);
  h.api.render();
  assert.equal(h.elements.get('mic-enable').textContent, '取消等待');
  assert.equal(h.elements.get('input-status').textContent, '等待授权');
  mic.status = 'live'; mic.track = track();
  h.api.render();
  assert.equal(h.elements.get('mic-pill-label').textContent, '聆听中');
  assert.equal(h.elements.get('input-device').textContent, 'Test input');
  assert.equal(h.elements.get('mic-enable').textContent, '关闭麦克风');
  mic.status = 'muted'; h.api.render();
  assert.equal(h.elements.get('input-status').textContent, '输入暂不可用');
  assert.notEqual(h.elements.get('mic-pill-label').textContent, '聆听中');
});

test('production visibility handler stops live input and never restarts on return', async () => {
  const h = harness();
  const media = await activate(h);
  const ui = featureHarness(h.mic);
  ui.document.hidden = true; ui.docEvents.visibilitychange();
  assert.equal(h.mic.status, 'background');
  assert.equal(media.getTracks()[0].stops, 1);
  ui.document.hidden = false; ui.docEvents.visibilitychange();
  assert.equal(h.mic.status, 'background');
  assert.equal(h.requests.length, 1);
});

test('production visibility handler cancels pending request and explicit sound demo', async () => {
  const h = harness();
  const pending = h.mic.start();
  const ui = featureHarness(h.mic);
  ui.document.hidden = true; ui.docEvents.visibilitychange();
  const media = stream(); h.requests[0].resolve(media); await pending;
  assert.equal(h.mic.status, 'background');
  assert.equal(media.getTracks()[0].stops, 1);
  ui.api.demo(true); ui.api.sample();
  ui.docEvents.visibilitychange();
  assert.equal(ui.api.read().soundDemo, false);
});

test('pagehide always releases microphone resources', async () => {
  const h = harness();
  const media = await activate(h);
  const ui = featureHarness(h.mic);
  ui.windowEvents.pagehide();
  assert.equal(h.mic.status, 'background');
  assert.equal(media.getTracks()[0].stops, 1);
  assert.equal(h.contexts[0].closes, 1);
});
