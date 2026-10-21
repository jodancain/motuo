/* 声浪来源：麦克风（显式授权，本机分析，不录音、不回放、不上传）或声浪 DEMO（合成特征，明确标注）。
 * 输出 {valid, demo, level, bands[16], trend}；无有效输入时 valid=false，楼群与车身震动保持静止。
 * trend 用复制的 v2 sound-trend.js 计算（只描述相对强弱变化，不识别发动机、不估转速）。 */
export const BANDS = 16;

export function createSoundSource({trend = globalThis.MotuoSoundTrend?.create?.(), now = () => performance.now() / 1000} = {}) {
  let mode = 'off', stream = null, ac = null, analyser = null, freq = null, timeData = null, demoLevel = 0, demoT = 0, status = '声浪关闭';
  const bands = new Float32Array(BANDS);
  let out = {valid: false, demo: false, level: 0, bands, trend: 'waiting', status};
  function stopMic() {
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    if (ac) ac.close().catch(() => {}); ac = null; analyser = null;
  }
  async function startMic() {
    stopMic();
    if (!navigator.mediaDevices?.getUserMedia) { status = '此浏览器不支持麦克风'; mode = 'off'; return false; }
    status = '等待麦克风授权…';
    try {
      const s = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
      if (mode !== 'mic') { s.getTracks().forEach(t => t.stop()); return false; }
      stream = s;
      ac = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      const src = ac.createMediaStreamSource(s); analyser = ac.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = .6;
      src.connect(analyser); // 不连接扬声器
      freq = new Uint8Array(analyser.frequencyBinCount); timeData = new Float32Array(analyser.fftSize);
      status = '麦克风 · 外界混合声音 · 本机分析';
      return true;
    } catch (e) { status = e?.name === 'NotAllowedError' ? '麦克风未授权' : '麦克风不可用'; mode = 'off'; return false; }
  }
  return {
    async setMode(next) {
      mode = ['mic', 'demo'].includes(next) ? next : 'off';
      trend?.reset?.();
      if (mode === 'mic') return startMic();
      stopMic(); status = mode === 'demo' ? '声浪 DEMO · 合成特征' : '声浪关闭';
      return true;
    },
    // 演示驾驶时由剧本提供 DEMO 电平（1Hz 帧），这里在帧间只做频段形状的装饰起伏。
    setDemoLevel(v) { demoLevel = Math.max(0, Math.min(1, v || 0)); },
    sample(dt, paused = false) {
      if (paused || document.hidden) { bands.fill(0); out = {valid: false, demo: mode === 'demo', level: 0, bands, trend: 'waiting', status: paused ? '暂停中' : status}; trend?.reset?.(); return out; }
      if (mode === 'mic' && analyser) {
        analyser.getByteFrequencyData(freq); analyser.getFloatTimeDomainData(timeData);
        let rms = 0; for (const v of timeData) rms += v * v; rms = Math.sqrt(rms / timeData.length);
        const level = Math.min(1, rms * 4.5);
        const n = freq.length * .6;
        for (let i = 0; i < BANDS; i++) {
          const a = Math.floor(Math.pow(i / BANDS, 1.6) * n), b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / BANDS, 1.6) * n));
          let s = 0; for (let k = a; k < b; k++) s += freq[k]; bands[i] = bands[i] * .5 + (s / (b - a) / 255) * .5;
        }
        const tr = trend?.sample?.({valid: true, time: now(), energy: level, spectrum: bands}) || {trend: 'steady'};
        out = {valid: true, demo: false, level, bands, trend: tr.trend, status};
      } else if (mode === 'demo') {
        demoT += dt;
        for (let i = 0; i < BANDS; i++) {
          const shape = .55 + .45 * Math.sin(demoT * (3 + i * .7) + i * 1.3) * Math.sin(demoT * 1.7 + i);
          bands[i] = Math.max(0, Math.min(1, demoLevel * (1.1 - i / BANDS * .5) * shape));
        }
        const tr = trend?.sample?.({valid: true, time: now(), energy: demoLevel, spectrum: bands}) || {trend: 'steady'};
        out = {valid: demoLevel > 0, demo: true, level: demoLevel, bands, trend: tr.trend, status};
      } else { bands.fill(0); out = {valid: false, demo: false, level: 0, bands, trend: 'waiting', status}; }
      return out;
    },
    stop() { mode = 'off'; stopMic(); status = '声浪关闭'; },
    get mode() { return mode; }, get status() { return status; }, get last() { return out; },
  };
}
