/* Motuo HUD motion controllers built on motion-kit.
 * Decoration only: every controller reads values the page already rendered and
 * never writes a measurement. Temporary layers are tracked so cancel() leaves none.
 */
(function (global) {
  'use strict';
  const M = global.MotuoMotion;
  const TAU = Math.PI * 2;
  const IMPACT_STEP = .6;           // m/s² per burst level
  const ROLLABLE = /^\d{1,3}$/;      // only whole readings roll; '—' and estimates stay instant

  // Deterministic jitter so particle bursts are reproducible in tests.
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  function create(doc = global.document, {clock = null, isReduced = () => false, tier = () => clock?.tier || 'normal', win = global} = {}) {
    const q = selector => doc.querySelector(selector);
    const qa = selector => [...(doc.querySelectorAll?.(selector) || [])];
    const layers = new Set();
    const running = new Map();     // channel -> Animation[]
    const cleanups = new Map();    // channel -> fn

    function layer(className, parent, tag = 'div') {
      const el = doc.createElement(tag);
      el.className = className; el.setAttribute('aria-hidden', 'true');
      parent.append(el); layers.add(el);
      return el;
    }
    function drop(el) { if (!el) return; el.remove(); layers.delete(el); }
    function animate(channel, el, frames, options) {
      if (!el?.animate) return null;
      const animation = el.animate(frames, {fill: 'backwards', ...options});
      animation.finished?.catch?.(() => {});
      if (!running.has(channel)) running.set(channel, []);
      running.get(channel).push(animation);
      return animation;
    }
    function cancel(channel) {
      for (const animation of running.get(channel) || []) animation.cancel();
      running.delete(channel);
      const cleanup = cleanups.get(channel); cleanups.delete(channel);
      cleanup?.();
    }
    // Resolve a channel once its animations finish, unless it was replaced meanwhile.
    function settle(channel, cleanup) {
      const list = running.get(channel) || [];
      cleanups.set(channel, cleanup);
      Promise.all(list.map(a => a.finished?.catch?.(() => {}))).then(() => {
        if (running.get(channel) !== list) return;
        running.delete(channel);
        if (cleanups.get(channel) === cleanup) { cleanups.delete(channel); cleanup(); }
      });
    }
    const timing = (name, opts) => M.springTiming(name, opts);
    const eco = () => tier() === 'eco';

    /* 1. Standby: kinetic wordmark + staggered HUD assembly + one boot scan. */
    function splitLetters(el) {
      if (!el) return [];
      // Re-split if someone replaced the text since (native labels do this).
      if (el.dataset?.split === 'letters' && el.querySelector('.k-letter')) return [...el.querySelectorAll('.k-letter')];
      const text = el.textContent;
      el.setAttribute('aria-label', text);
      el.replaceChildren(...[...text].map(ch => {
        const span = doc.createElement('span');
        span.className = 'k-letter'; span.setAttribute('aria-hidden', 'true');
        span.textContent = ch; return span;
      }));
      el.dataset.split = 'letters';
      return [...el.querySelectorAll('.k-letter')];
    }
    function intro() {
      cancel('intro');
      if (isReduced()) return;
      const letters = splitLetters(q('.wordmark'));
      const pop = timing('pop'), snappy = timing('snappy', {maxMs: 520});
      letters.forEach((el, i) => animate('intro', el, [
        {transform: 'translateY(70%) rotate(8deg)', opacity: 0, filter: 'blur(4px)'},
        {transform: 'none', opacity: 1, filter: 'blur(0)'},
      ], {duration: pop.duration, easing: pop.easing, delay: 80 + M.stagger(i, letters.length, {step: M.staggers.standard})}));
      const parts = ['.page-head', '.vehicle-title', '.standby-3d-tools', '#sound-trend-open', '#accel-meter', '.drive-meters .sport-stats', '.music', '.bottom .statuses', '#ride-primary']
        .map(q).filter(el => el && el.getBoundingClientRect().width > 0);
      // Individual translate/scale compose with any layout transform the element has.
      // Controls never pass through opacity 0: a tap during the intro must land on a visible target.
      const controls = new Set(['.page-head', '.standby-3d-tools', '#sound-trend-open', '.music', '#ride-primary'].map(q));
      parts.forEach((el, i) => animate('intro', el, [
        {translate: '0 16px', scale: '.97', opacity: controls.has(el) ? 1 : 0},
        {translate: '0 0', scale: '1', opacity: 1},
      ],{duration: snappy.duration, easing: snappy.easing, delay: 160 + M.stagger(i, parts.length)}));
      const cockpit = q('#cockpit');
      if (cockpit && !cockpit.hidden) {
        const scan = layer('boot-scan', cockpit);
        animate('intro', scan, [{transform: 'translateY(-10%)', opacity: 0}, {opacity: 1, offset: .2}, {transform: 'translateY(110%)', opacity: 0}],
          {duration: M.durations.long, easing: M.easing.sweep.css, delay: 120});
        settle('intro', () => drop(scan));
      } else settle('intro', () => {});
    }

    /* 2. Speed roller: per-digit slide between the previous and the current real
     *    integer only. The page text stays the source of truth (screen readers,
     *    native bridge, tests); the overlay is aria-hidden and marked data-transition. */
    let lastSpeed = null;
    function charRects(el) {
      const node = el.firstChild, text = el.textContent;
      if (node && doc.createRange) {
        const rects = [];
        for (let i = 0; i < text.length; i++) {
          const range = doc.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
          rects.push(range.getBoundingClientRect());
        }
        return rects;
      }
      const r = el.getBoundingClientRect(), w = r.width / Math.max(1, text.length);
      return [...text].map((_, i) => ({left: r.left + i * w, top: r.top, width: w, height: r.height}));
    }
    function speed(el, {active = true} = {}) {
      if (!el) return;
      const text = el.textContent;
      const previous = lastSpeed; lastSpeed = text;
      if (previous === null || previous === text) return;
      cancel('roll');
      if (!active || isReduced() || !el.animate || !ROLLABLE.test(previous) || !ROLLABLE.test(text)) return;
      const parent = el.parentNode, box = parent?.getBoundingClientRect?.();
      if (!box || !box.width) return;
      const rects = charRects(el);
      if (!rects.length || !rects[0].width) return;
      const style = win.getComputedStyle?.(el);
      const overlay = layer('speed-roller', parent, 'span');
      // Longhands: WebKit may report an empty `font` shorthand.
      if (style) for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariantNumeric', 'letterSpacing', 'color', 'textShadow']) overlay.style[key] = style[key];
      // Rects are viewport px; ancestors may be scaled (exaggerated speed size).
      const k = box.width / (parent.offsetWidth || box.width) || 1;
      overlay.style.lineHeight = rects[0].height / k + 'px';
      const up = Number(text) > Number(previous), roll = timing('roll', {maxMs: 300});
      let changed = 0;
      [...text].forEach((ch, i) => {
        const old = previous[previous.length - (text.length - i)] ?? '';
        const r = rects[i], column = doc.createElement('span');
        column.className = 'roller-column';
        Object.assign(column.style, {left: (r.left - box.left) / k + 'px', top: (r.top - box.top) / k + 'px', width: r.width / k + 'px', height: r.height / k + 'px'});
        const stack = doc.createElement('span'); stack.className = 'roller-stack';
        const a = doc.createElement('span'), b = doc.createElement('span');
        a.textContent = old === ch ? ch : old; b.textContent = ch;
        // Increasing values arrive from below, decreasing from above.
        if (up) stack.append(a, b); else stack.append(b, a);
        column.append(stack); overlay.append(column);
        if (old === ch) { stack.style.transform = up ? 'none' : 'translateY(-50%)'; return; }
        changed++;
        const frames = up ? [{transform: 'translateY(0)'}, {transform: 'translateY(-50%)'}] : [{transform: 'translateY(-50%)'}, {transform: 'translateY(0)'}];
        if (!eco()) { frames[0].filter = 'blur(0)'; frames.splice(1, 0, {filter: 'blur(1.2px)', offset: .4}); frames[frames.length - 1].filter = 'blur(0)'; }
        animate('roll', stack, frames, {duration: roll.duration, easing: roll.easing, fill: 'both'});
      });
      if (!changed) { drop(overlay); return; }
      el.classList.add('speed-rolling');
      const instrument = el.closest?.('#instrument');
      if (instrument) instrument.dataset.transition = 'rolling';
      settle('roll', () => { drop(overlay); el.classList.remove('speed-rolling'); if (instrument) delete instrument.dataset.transition; });
    }

    /* 3. Acceleration impact: edge glow ∝ |validated a|, streaks and particle bursts
     *    when the displayed value climbs a 0.6 m/s² level. Unknown => nothing. */
    const impact = {canvas: null, ctx: null, w: 0, h: 0, dpr: 1, glow: 0, target: 0, dir: 0, level: 0, frozen: false, particles: [], remove: null, random: rng(7), focus: null, measuredAt: -1e9, seconds: 0};
    function impactCanvas() {
      const cockpit = q('#cockpit');
      if (!cockpit) return null;
      if (!impact.canvas || impact.canvas.parentNode !== cockpit) {
        impact.canvas = doc.createElement('canvas');
        impact.canvas.className = 'impact-canvas'; impact.canvas.setAttribute('aria-hidden', 'true');
        cockpit.append(impact.canvas); impact.ctx = impact.canvas.getContext?.('2d') || null;
      }
      return impact.canvas;
    }
    function measureImpact(now) {
      if (now - impact.measuredAt < 500 && impact.w) return;
      impact.measuredAt = now;
      const cockpit = q('#cockpit'), box = cockpit?.getBoundingClientRect(), s = q('#speed')?.getBoundingClientRect();
      if (!box || !box.width) { impact.w = 0; return; }
      const dpr = Math.min(win.devicePixelRatio || 1, eco() ? 1 : 2);
      if (impact.w !== box.width || impact.h !== box.height || impact.dpr !== dpr) {
        impact.w = box.width; impact.h = box.height; impact.dpr = dpr;
        impact.canvas.width = Math.round(box.width * dpr); impact.canvas.height = Math.round(box.height * dpr);
      }
      impact.focus = s && s.width ? {x: s.left - box.left + s.width / 2, y: s.top - box.top + s.height / 2, w: s.width, h: s.height} : {x: box.width / 2, y: box.height * .45, w: 120, h: 80};
    }
    function burst(level, dir) {
      if (!impact.focus) return;
      const n = Math.round((eco() ? 10 : 26) * Math.min(1.6, .7 + level * .3));
      const base = dir > 0 ? Math.PI : 0;   // accelerate: spray behind; brake: surge forward
      for (let i = 0; i < n; i++) {
        const angle = base + (impact.random() - .5) * 1.7, speedPx = 160 + impact.random() * 300;
        impact.particles.push({x: impact.focus.x + Math.cos(angle) * impact.focus.w * .45, y: impact.focus.y + (impact.random() - .5) * impact.focus.h * .7,
          vx: Math.cos(angle) * speedPx, vy: Math.sin(angle) * speedPx * .55, life: .45 + impact.random() * .45, age: 0, size: .8 + impact.random() * 1.8, dir});
      }
      if (impact.particles.length > 140) impact.particles.splice(0, impact.particles.length - 140);
      const meter = q('#accel-meter'), pop = timing('pop', {maxMs: 420});
      cancel('impact-pop');
      animate('impact-pop', meter, [{scale: '1'}, {scale: '1.035', offset: .3}, {scale: '1'}], {duration: pop.duration, easing: M.easing.out.css});
      animate('impact-pop', q('#instrument'), [{translate: '0 0'}, {translate: `${dir > 0 ? -3 : 3}px 0`, offset: .25}, {translate: '0 0'}], {duration: pop.duration, easing: pop.easing});
    }
    function drawImpact(now, dt) {
      const c = impact.ctx;
      if (!impact.frozen) {
        impact.seconds += dt;
        impact.glow += (impact.target - impact.glow) * (1 - Math.exp(-dt / .14));
        for (const p of impact.particles) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= Math.exp(-dt * 2.2); p.vy *= Math.exp(-dt * 2.2); }
        impact.particles = impact.particles.filter(p => p.age < p.life);
      }
      q('#cockpit')?.style.setProperty('--impact', impact.glow.toFixed(3));
      measureImpact(now);
      if (c && impact.w) {
        c.setTransform(impact.dpr, 0, 0, impact.dpr, 0, 0);
        c.clearRect(0, 0, impact.w, impact.h);
        c.globalCompositeOperation = 'lighter';
        const f = impact.focus, rgb = impact.dir < 0 ? '255,170,128' : '120,228,255';
        // Velocity streaks avoid the readout band; they decorate, never cover digits.
        const lines = Math.round(impact.glow * (eco() ? 7 : 16));
        for (let i = 0; i < lines; i++) {
          const lane = (i * .618034) % 1, y = impact.h * (.12 + lane * .7);
          if (Math.abs(y - f.y) < f.h * .6) continue;
          const len = impact.w * (.08 + impact.glow * .16), travel = ((impact.seconds * (1.2 + lane) + lane) % 1);
          const x = impact.dir < 0 ? travel * (impact.w + len) - len : impact.w - travel * (impact.w + len);
          const g = c.createLinearGradient(x, y, x + len, y);
          g.addColorStop(impact.dir < 0 ? 1 : 0, `rgba(${rgb},0)`); g.addColorStop(impact.dir < 0 ? 0 : 1, `rgba(${rgb},${(.1 + impact.glow * .35).toFixed(3)})`);
          c.strokeStyle = g; c.lineWidth = 1 + impact.glow; c.beginPath(); c.moveTo(x, y); c.lineTo(x + len, y); c.stroke();
        }
        // Screen-edge light: both sides for push; braking also lights the leading (top) edge.
        if (impact.glow > .01) {
          const alpha = (impact.glow * .5).toFixed(3), band = impact.w * .11;
          const edge = (x0, y0, x1, y1, x, y, w, h) => { const g = c.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, `rgba(${rgb},${alpha})`); g.addColorStop(1, `rgba(${rgb},0)`); c.fillStyle = g; c.fillRect(x, y, w, h); };
          edge(0, 0, band, 0, 0, 0, band, impact.h);
          edge(impact.w, 0, impact.w - band, 0, impact.w - band, 0, band, impact.h);
          if (impact.dir < 0) edge(0, 0, 0, impact.h * .18, 0, 0, impact.w, impact.h * .18);
        }
        for (const p of impact.particles) {
          const fade = 1 - p.age / p.life, col = p.dir < 0 ? '255,182,140' : '150,236,255';
          c.strokeStyle = `rgba(${col},${(fade * .75).toFixed(3)})`; c.lineWidth = p.size;
          c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - p.vx * .035, p.y - p.vy * .035); c.stroke();
        }
        c.globalCompositeOperation = 'source-over';
      }
      if (impact.frozen) { impact.remove = null; return false; }   // hold the frozen frame
      if (impact.target === 0 && impact.glow < .004 && !impact.particles.length) {
        impact.glow = 0; q('#cockpit')?.style.setProperty('--impact', '0');
        if (c && impact.w) c.clearRect(0, 0, impact.w, impact.h);
        impact.remove = null; return false;
      }
      return true;
    }
    function feedback({valid = false, accel = 0, active = false, paused = false} = {}) {
      const cockpit = q('#cockpit');
      if (isReduced()) { resetImpact(); return; }
      const usable = valid && active && !paused && Number.isFinite(accel);
      impact.frozen = paused;
      impact.target = usable ? M.clamp(Math.abs(accel) / 2) : 0;
      if (usable && Math.abs(accel) >= .08) impact.dir = accel > 0 ? 1 : -1;
      if (cockpit) cockpit.dataset.impact = !usable || Math.abs(accel) < .08 ? 'none' : accel > 0 ? 'push' : 'brake';
      const level = usable ? Math.min(3, Math.floor(Math.abs(accel) / IMPACT_STEP)) : 0;
      if (!impactCanvas()) return;
      if (level > impact.level) { measureImpact(-1e9); burst(level, impact.dir); }
      if (!paused || usable) impact.level = level;
      if (!impact.remove && clock && (impact.target > 0 || impact.glow > 0 || impact.particles.length || paused)) impact.remove = clock.add(drawImpact, {throttle: true});
    }
    function resetImpact() {
      impact.remove?.(); impact.remove = null;
      impact.particles = []; impact.glow = impact.target = 0; impact.level = 0; impact.frozen = false;
      const cockpit = q('#cockpit');
      cockpit?.style.setProperty('--impact', '0'); if (cockpit) cockpit.dataset.impact = 'none';
      if (impact.ctx && impact.w) impact.ctx.clearRect(0, 0, impact.w, impact.h);
      cancel('impact-pop');
    }

    /* 4. Sound trend beat: a pulse only when the trend label changes and the
     *    source is a live microphone or explicit DEMO. Music never reaches here. */
    let lastTrend = null;
    function beat({trend = '', source = 'unknown', active = false, paused = false} = {}) {
      const previous = lastTrend; lastTrend = trend;
      if (previous === null || previous === trend || isReduced() || paused || !active) return;
      if (source !== 'mic' && source !== 'demo') return;
      cancel('beat');
      const pop = timing('pop', {maxMs: 460});
      animate('beat', q('#sound-trend-value'), [{translate: '0 55%', opacity: 0}, {translate: '0 0', opacity: 1}],{duration: pop.duration, easing: pop.easing});
      animate('beat', q('#rpm-segments'), [{filter: 'brightness(2.1) saturate(1.4)'}, {filter: 'none'}], {duration: M.durations.medium, easing: M.easing.out.css});
      animate('beat', q('#sound-trend-open'), [{boxShadow: '0 0 0 0 rgba(120,220,255,.55), inset 0 0 26px rgba(120,220,255,.25)'}, {boxShadow: '0 0 0 14px rgba(120,220,255,0), inset 0 0 0 rgba(120,220,255,0)'}], {duration: M.durations.medium, easing: M.easing.out.css});
      settle('beat', () => {});
    }

    /* 5. Kinetic chapter word: real state label, letters/lines spring up through a mask. */
    let lastWord = null;
    function kinetic(el) {
      if (!el) return;
      const text = el.textContent, previous = lastWord; lastWord = text;
      if (previous === null || previous === text || isReduced()) return;
      cancel('kinetic');
      const pop = timing('pop', {maxMs: 520}), lines = [...el.children];
      lines.forEach((line, i) => animate('kinetic', line, [
        {transform: 'translateY(105%) skewY(6deg)', opacity: 0, clipPath: 'inset(0 0 100% 0)'},
        {transform: 'none', opacity: 1, clipPath: 'inset(0 0 0 0)'},
      ], {duration: pop.duration, easing: pop.easing, delay: M.stagger(i, lines.length, {step: M.staggers.dramatic})}));
      settle('kinetic', () => {});
    }

    /* 6. Scene transitions: slide wipe for mode, clock wipe for theme. The veil is
     *    translucent, so readouts stay legible throughout. */
    // Built on the next shared frame: the click handler that switched the theme has
    // just written styles, and reading layout here would force a synchronous reflow.
    function scene(kind = 'mode', options = {}) {
      cancel('scene');
      if (!clock) { buildScene(kind, options); return; }
      const id = clock.requestFrame(() => { if (cleanups.get('scene') === pending) { cleanups.delete('scene'); buildScene(kind, options); } });
      const pending = () => clock.cancelFrame(id);
      cleanups.set('scene', pending);
    }
    function buildScene(kind, {label = ''} = {}) {
      const cockpit = q('#cockpit');
      if (isReduced() || !cockpit || cockpit.hidden || cockpit.classList.contains('departing')) return;
      const wipe = layer('scene-wipe scene-wipe-' + kind, cockpit);
      const tag = doc.createElement('div'); tag.className = 'scene-tag'; tag.textContent = label; wipe.append(tag);
      const letters = splitLetters(tag);
      const duration = kind === 'scene' ? 620 : 520;
      animate('scene', q('#fx-canvas'), [{scale: '1.07'}, {scale: '1'}], {duration: timing('smooth').duration, easing: timing('smooth').easing});
      letters.forEach((el, i) => animate('scene', el, [{opacity: 0, transform: 'translateY(60%)'}, {opacity: 1, transform: 'none', offset: .45}, {opacity: 0, transform: 'translateY(-30%)'}],
        // The label lives inside the veil, so it finishes within the wipe itself.
        {duration: Math.round(duration * .8), easing: M.easing.out.css, delay: M.stagger(i, letters.length, {step: M.staggers.micro, maxTotal: Math.round(duration * .2)})}));
      if (kind === 'scene' && clock) {
        // Clock wipe: a conic mask retracts the old veil; the hand only rotates (compositor).
        const hand = doc.createElement('div'); hand.className = 'scene-wipe-hand'; wipe.append(hand);
        let started = -1;
        const stop = clock.add(now => {
          if (started < 0) started = now;
          const p = M.easing.inOut(M.clamp((now - started) / duration));
          const mask = `conic-gradient(from -90deg at 50% 55%, transparent ${(p * 360).toFixed(1)}deg, #000 0)`;
          wipe.style.maskImage = wipe.style.webkitMaskImage = mask;
          hand.style.transform = `rotate(${(p * 360 - 89).toFixed(1)}deg)`;
          if (p >= 1) { drop(wipe); return false; }
          return true;
        });
        // Keep the channel open until the mask completes.
        animate('scene', wipe, [{opacity: 1}, {opacity: 1}], {duration});
        settle('scene', () => { stop(); drop(wipe); });
      } else {
        animate('scene', wipe, [{clipPath: 'inset(0 0 0 0)'}, {clipPath: 'inset(0 0 0 100%)'}], {duration, easing: M.easing.inOut.css, fill: 'both'})
          ?.finished?.then?.(() => drop(wipe), () => {});
        const edge = layer('scene-wipe-edge', wipe);
        animate('scene', edge, [{transform: 'translateX(0)'}, {transform: 'translateX(100%)'}], {duration, easing: M.easing.inOut.css, fill: 'both'});
        settle('scene', () => drop(wipe));
      }
    }

    /* 7. Pause = time freeze; resume = time restarts with weight. */
    function freeze(paused) {
      cancel('freeze');
      const app = q('#app'), cockpit = q('#cockpit');
      app?.classList.toggle('time-frozen', !!paused);
      if (isReduced() || !cockpit || cockpit.hidden) return;
      const heavy = timing('heavy', {maxMs: 700}), smooth = timing('smooth', {maxMs: 520});
      if (paused) {
        const flash = layer('freeze-flash', cockpit);
        animate('freeze', flash, [{opacity: .5}, {opacity: 0}], {duration: M.durations.short, easing: M.easing.out.css, fill: 'both'});
        // A brief settle into stillness; the resting frozen look is CSS (.time-frozen).
        animate('freeze', cockpit, [{scale: '1'}, {scale: '.988', offset: .35}, {scale: '1'}], {duration: heavy.duration, easing: M.easing.out.css, fill: 'none'});
        animate('freeze', q('#fx-canvas'), [{filter: 'none'}, {filter: 'saturate(.2) brightness(.75)'}], {duration: smooth.duration, easing: smooth.easing});
        animate('freeze', q('.pause-shade'), [{translate: '0 -12px', scale: '.94', opacity: 0}, {translate: '0 0', scale: '1', opacity: 1}], {duration: timing('pop').duration, easing: timing('pop').easing});
        settle('freeze', () => drop(flash));
      } else {
        const sweep = layer('freeze-sweep', cockpit);
        animate('freeze', sweep, [{transform: 'translateX(-110%)'}, {transform: 'translateX(110%)'}], {duration: M.durations.medium, easing: M.easing.sweep.css, fill: 'both'});
        animate('freeze', cockpit, [{scale: '.988'}, {scale: '1'}], {duration: timing('pop', {maxMs: 480}).duration, easing: timing('pop').easing, fill: 'none'});
        animate('freeze', q('#fx-canvas'), [{filter: 'saturate(.2) brightness(.75)'}, {filter: 'none'}], {duration: smooth.duration, easing: smooth.easing});
        settle('freeze', () => drop(sweep));
      }
    }

    /* 8. Recap: Unwrapped-style cards. Tally counts toward the final recorded
     *    summary, is labelled 汇总动画 and always lands on the exact text. */
    function parseTally(text) {
      if (/^\d+:\d{2}$/.test(text)) { const [m, s] = text.split(':').map(Number); return {value: m * 60 + s, format: v => String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(Math.floor(v % 60)).padStart(2, '0')}; }
      if (/^\d+\.\d+$/.test(text)) { const digits = text.split('.')[1].length; return {value: Number(text), format: v => v.toFixed(digits)}; }
      if (/^\d+$/.test(text)) return {value: Number(text), format: v => String(Math.floor(v))};
      return null;
    }
    let tally = null;
    function recap() {
      cancel('recap'); tally?.cancel(); tally = null;
      const page = q('#page-recap');
      if (!page) return;
      const finals = qa('.recap-metrics strong').map(el => ({el, text: el.textContent, parsed: parseTally(el.textContent)}));
      const restore = () => {
        for (const item of finals) { item.el.textContent = item.text; delete item.el.dataset.transition; }
        page.querySelector('.recap-metrics')?.removeAttribute('aria-busy');
        page.classList.remove('tallying');
      };
      if (isReduced()) { restore(); return; }
      page.classList.add('hud-recap');
      const items = ['.recap-mark', '.recap>.eyebrow', '.recap h2', '.recap>p', '.recap-route'].map(s => page.querySelector(s)).filter(Boolean);
      const cards = [...page.querySelectorAll('.recap-metrics>div')];
      const tail = [...page.querySelectorAll('#recap-chapters .chapter'), page.querySelector('.recap-note'), page.querySelector('#recap-done')].filter(Boolean);
      const snappy = timing('snappy', {maxMs: 520}), pop = timing('pop');
      items.forEach((el, i) => animate('recap', el, [{translate: '0 22px', scale: '.96', opacity: 0}, {translate: '0 0', scale: '1', opacity: 1}],{duration: snappy.duration, easing: snappy.easing, delay: M.stagger(i, items.length)}));
      cards.forEach((el, i) => animate('recap', el, [{transform: 'perspective(600px) rotateX(75deg) translateY(18px)', opacity: 0}, {transform: 'none', opacity: 1}], {duration: pop.duration, easing: pop.easing, delay: 260 + M.stagger(i, cards.length, {step: M.staggers.dramatic})}));
      tail.forEach((el, i) => animate('recap', el, [{translate: '0 14px', opacity: 0}, {translate: '0 0', opacity: 1}],{duration: snappy.duration, easing: snappy.easing, delay: 520 + M.stagger(i, tail.length, {step: M.staggers.micro, maxTotal: 360})}));
      settle('recap', () => {});
      const counted = finals.filter(item => item.parsed && item.parsed.value > 0);
      if (!counted.length || !clock) { restore(); return; }
      page.classList.add('tallying');
      page.querySelector('.recap-metrics')?.setAttribute('aria-busy', 'true');
      tally = M.createTimeline(clock);
      counted.forEach((item, i) => {
        item.el.dataset.transition = 'tally';
        item.el.textContent = item.parsed.format(0);
        tally.add({at: 300 + i * M.staggers.dramatic, duration: M.durations.long,
          update: p => { item.el.textContent = item.parsed.format(item.parsed.value * M.easing.out(p)); },
          end: () => { item.el.textContent = item.text; delete item.el.dataset.transition; },
          cancel: () => { item.el.textContent = item.text; delete item.el.dataset.transition; }});
      });
      tally.add({at: 0, duration: 0, cancel: restore});
      const own = tally;
      own.finished.then(() => { if (tally === own) { restore(); tally = null; } });
      own.play();
    }

    /* Lifecycle */
    function cancelTransient() {
      for (const channel of [...running.keys(), ...cleanups.keys()]) cancel(channel);
      tally?.cancel(); tally = null;
      for (const el of [...layers]) drop(el);
      const s = q('#speed'); s?.classList.remove('speed-rolling');
      const instrument = q('#instrument'); if (instrument?.dataset) delete instrument.dataset.transition;
    }
    function cancelAll() { cancelTransient(); resetImpact(); q('#app')?.classList.remove('time-frozen'); }
    function resetTracking() { lastSpeed = lastTrend = lastWord = null; }
    function debug() {
      return {layers: layers.size, channels: [...running.keys()], animations: [...running.values()].reduce((n, list) => n + list.length, 0),
        particles: impact.particles.length, glow: impact.glow, impactTask: !!impact.remove, tally: !!tally};
    }
    return Object.freeze({intro, speed, feedback, beat, kinetic, scene, freeze, recap, cancel, cancelTransient, cancelAll, resetTracking, debug,
      cancelIntro: () => cancel('intro'), cancelRoll: () => cancel('roll')});
  }

  global.MotuoHudMotion = Object.freeze({create});
})(typeof window !== 'undefined' ? window : globalThis);
