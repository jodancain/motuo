/* Motuo game FX: the exaggerated layer (world, overlay, shake, flashes, callouts,
 * scene transitions, bullet time, wrapped recap). Decoration only — every input is a
 * reading the page already displays; scores are game scores, labelled as such.
 * Safety rails: flashes go through one rate limiter (≤2/s, WCAG 2.3.1 allows 3);
 * nothing opaque is placed over the speed reading.
 */
(function (global) {
  'use strict';
  const G = global.MotuoGame, W = global.MotuoWorld, M = global.MotuoMotion;
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
  const TRANSITIONS = Object.freeze(['shatter', 'glitch', 'iris', 'warp']);
  const TONES = {cyan: '120,232,255', magenta: '255,90,220', red: '255,96,88', violet: '186,120,255', amber: '255,196,90', white: '240,248,255'};
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  function create(doc = global.document, {clock = null, isReduced = () => false, tier = () => clock?.tier || 'normal', intensity = () => G.INTENSITY.extreme, win = global} = {}) {
    const q = s => doc.querySelector(s);
    const random = rng(11);
    const flashes = G.createFlashLimiter({maxPerSecond: 2});
    const channels = new Map();
    const temp = new Set();
    let world = null, overlay = null, ctx = null, ow = 0, oh = 0, odpr = 1, measuredAt = -1e9, focus = null, carRect = null;
    let particles = [], rings = [], shards = [], trails = [], bars = [];
    let trauma = 0, timeScale = 1, scaleTarget = 1, rewindUntil = 0, burstUntil = 0, transitionIndex = 0, lastSpeedText = null, paused = false;
    let lastNow = 0, input = {};
    // CSS variables are scoped to the speed readout and written only when they change:
    // per-frame writes on #app restyled the whole HUD and repainted every glow.
    const varCache = new Map();
    function setVar(name, value) {
      const el = q('.speed-content'); if (!el) return;
      if (varCache.get(name) === value && varCache.get('el') === el) return;
      varCache.set(name, value); varCache.set('el', el); el.style.setProperty(name, value);
      if (name === '--heat-color' || name === '--heat') q('#app')?.style.setProperty(name, value);
    }
    const eco = () => tier() === 'eco';
    const fx = () => intensity();
    const now = () => global.performance.now();

    function track(channel, animation) { if (!animation) return null; animation.finished?.catch?.(() => {}); if (!channels.has(channel)) channels.set(channel, []); channels.get(channel).push(animation); return animation; }
    function stop(channel) { for (const a of channels.get(channel) || []) a.cancel(); channels.delete(channel); }
    function animate(channel, el, frames, options) { return el?.animate ? track(channel, el.animate(frames, {fill: 'backwards', ...options})) : null; }
    function tempLayer(className, parent, tag = 'div') { const el = doc.createElement(tag); el.className = className; el.setAttribute('aria-hidden', 'true'); parent.append(el); temp.add(el); return el; }
    function drop(el) { el?.remove(); temp.delete(el); }

    /* World + overlay setup (lazy, so tests and no-WebGL browsers stay fine). */
    function ensure() {
      const cockpit = q('#cockpit');
      if (!cockpit) return false;
      if (!world && W && q('#game-world')) world = W.create(q('#game-world'), {scaleFor: () => eco() ? .42 : .7});
      if (!overlay) { overlay = q('#game-overlay'); ctx = overlay?.getContext?.('2d') || null; }
      return true;
    }
    function measure(t) {
      if (t - measuredAt < 400 && ow) return;
      measuredAt = t;
      const box = q('#cockpit')?.getBoundingClientRect(), s = q('#speed')?.getBoundingClientRect(), car = q('#chase-host')?.getBoundingClientRect();
      if (!box || !box.width || !overlay) { ow = 0; return; }
      const dpr = Math.min(win.devicePixelRatio || 1, eco() ? 1 : 1.5);
      if (ow !== box.width || oh !== box.height || odpr !== dpr) { ow = box.width; oh = box.height; odpr = dpr; overlay.width = Math.round(ow * dpr); overlay.height = Math.round(oh * dpr); }
      focus = s && s.width ? {x: s.left - box.left + s.width / 2, y: s.top - box.top + s.height / 2, w: s.width, h: s.height} : {x: ow / 2, y: oh * .45, w: 120, h: 80};
      carRect = car && car.width ? {x: car.left - box.left, y: car.top - box.top, w: car.width, h: car.height} : null;
    }

    /* Primitives */
    // While a dialog (HTML or native) covers the HUD, events, flashes and shake are held.
    let modal = false;
    function setModal(on) {
      const next = !!on; if (next === modal) return;
      modal = next;
      if (modal) { stop('callout'); stop('flash'); stop('judge'); trauma = 0; for (const id of ['#game-callout', '#game-judge']) { const el = q(id); if (el) el.hidden = true; } }
    }
    function shake(amount) { if (modal || isReduced() || !fx().shake) return; trauma = clamp(trauma + amount); }
    function flash(tone = 'white', strength = 1) {
      const f = fx().flash * strength;
      if (modal || isReduced() || !f || !flashes.allow(now())) return false;
      const el = q('#game-flash');
      if (!el) return false;
      el.style.setProperty('--flash-rgb', TONES[tone] || TONES.white);
      // Peak ≤0.5 and above 0.3 for ≤120 ms: the speed stays legible through it.
      stop('flash');
      animate('flash', el, [{opacity: 0}, {opacity: Math.min(.5, f), offset: .15}, {opacity: 0}], {duration: 320, easing: 'linear'});
      if (world) world.state.flash = Math.min(.6, f);
      return true;
    }
    function burst(x, y, n, tone, {spread = TAU, angle = 0, speed = 420, life = .9, size = 2.4, gravity = 0} = {}) {
      const count = Math.round(n * fx().particles * (eco() ? .4 : 1));
      for (let i = 0; i < count; i++) {
        const a = angle + (random() - .5) * spread, v = speed * (.35 + random() * .8);
        particles.push({x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: life * (.6 + random() * .6), age: 0, size: size * (.5 + random()), tone, gravity});
      }
      if (particles.length > 600) particles.splice(0, particles.length - 600);
    }
    function ring(x, y, tone, {max = 1.2, life = .7, width = 6} = {}) { rings.push({x, y, tone, max, life, age: 0, width}); }

    /* Callouts: giant kinetic words, always labelled as game/demo. */
    function callout(word, sub, tone = 'cyan', {big = 1} = {}) {
      const el = q('#game-callout');
      if (!el) return;
      stop('callout');
      el.dataset.tone = tone;
      el.style.setProperty('--callout-scale', String(fx().callout * big));
      el.replaceChildren();
      const w = doc.createElement('b'); w.className = 'callout-word'; w.textContent = word; if (w.dataset) w.dataset.text = word;
      const s = doc.createElement('small'); s.className = 'callout-sub'; s.textContent = sub;
      el.append(w, s); el.hidden = false;
      if (isReduced()) { animate('callout', el, [{opacity: 1}, {opacity: 1, offset: .8}, {opacity: 0}], {duration: 1400, fill: 'both'})?.finished.then(() => { el.hidden = true; }, () => {}); return; }
      animate('callout', el, [
        {opacity: 0, scale: '3.2'},
        {opacity: 1, scale: '.92', offset: .18},
        {opacity: 1, scale: '1.04', offset: .3},
        {opacity: 1, scale: '1', offset: .78},
        {opacity: 0, scale: '1.5'},
      ], {duration: 1350, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'both'})?.finished.then(() => { el.hidden = true; }, () => {});
    }

    /* Game events → spectacle */
    function event(e) {
      if (modal || !ensure()) return;
      measure(-1e9);
      const f = focus || {x: ow / 2, y: oh / 2, w: 100, h: 80}, rgb = TONES[e.tone] || TONES.cyan;
      if (e.kind === 'combo') { pulseScore(); return; }
      if (e.kind === 'rhythm') { judge(e); return; }
      callout(e.word, `${e.sub} · +${e.bonus} 游戏分`, e.tone, {big: e.kind === 'milestone' ? 1.15 : 1});
      if (isReduced()) return;
      const heavy = e.kind === 'milestone' || e.kind === 'boost' || e.kind === 'launch';
      burst(f.x, f.y, heavy ? 140 : 90, rgb, {speed: heavy ? 760 : 520, life: 1.1});
      ring(f.x, f.y, rgb, {max: heavy ? 1.6 : 1.1});
      ring(f.x, f.y, '255,255,255', {max: .8, life: .45, width: 3});
      if (e.kind === 'brake') { shake(.85); world && (world.state.warp = -.4); }
      else { shake(heavy ? 1 : .7); world && (world.state.warp = Math.max(world.state.warp, heavy ? 1 : .6)); }
      if (e.kind === 'milestone' || e.kind === 'boost') flash(e.tone, .9);
      else if (e.kind === 'brake') flash('red', .7);
      pulseScore();
    }
    function judge(e) {
      const el = q('#game-judge');
      if (el) {
        el.textContent = e.grade.toUpperCase(); el.dataset.grade = e.grade; el.hidden = false;
        stop('judge');
        animate('judge', el, [{opacity: 0, scale: '2.2'}, {opacity: 1, scale: '1', offset: .25}, {opacity: 1, offset: .7}, {opacity: 0, scale: '.9'}], {duration: 700, fill: 'both'})?.finished.then(() => { el.hidden = true; }, () => {});
      }
      if (isReduced()) return;
      const card = q('#sound-trend-open')?.getBoundingClientRect(), box = q('#cockpit')?.getBoundingClientRect();
      if (card && box && card.width) {
        const x = card.left - box.left + card.width / 2, y = card.top - box.top + card.height / 2;
        ring(x, y, e.grade === 'perfect' ? TONES.amber : TONES.cyan, {max: .5, life: .5, width: 5});
        burst(x, y, e.grade === 'perfect' ? 40 : 20, e.grade === 'perfect' ? TONES.amber : TONES.cyan, {speed: 300, life: .6});
      }
    }
    function pulseScore() {
      const el = q('#game-score');
      if (!el || isReduced()) return;
      stop('score');
      animate('score', el, [{scale: '1.35'}, {scale: '1'}], {duration: 380, easing: 'cubic-bezier(.3,1.6,.5,1)'});
    }
    function renderScore(summary) {
      const el = q('#game-score');
      if (!el) return;
      const score = el.querySelector?.('[data-score]'), combo = el.querySelector?.('[data-combo]');
      if (score) score.textContent = summary.score.toLocaleString('en-US');
      if (combo) combo.textContent = summary.combo > 1 ? `COMBO ×${summary.combo}` : 'COMBO —';
    }

    /* Speed: heat colour, impact scale on each change, aura and flames at speed. */
    function speedReading(text, {active = false} = {}) {
      const previous = lastSpeedText; lastSpeedText = text;
      const v = /^\d+$/.test(text) ? Number(text) : null;
      const h = active ? G.heat(v) : null;
      setVar('--heat-color', h ? h.css : 'rgb(240,248,255)');
      setVar('--heat', h ? h.level.toFixed(2) : '0');
      if (previous === null || previous === text || !active || v === null || isReduced()) return;
      stop('speed-hit');
      // Trail: the previous reading flies off BEHIND the new one, which is shown in full at once.
      const digits = q('.speed-digits');
      if (digits && /^\d+$/.test(previous || '')) {
        for (const old of [...temp].filter(el => el.classList.contains('speed-ghost'))) drop(old);
        const ghost = tempLayer('speed-value speed-ghost', digits, 'span'); ghost.textContent = previous;
        const up = v > Number(previous);
        animate('speed-hit', ghost, [{opacity: .55, translate: '0 0'}, {opacity: 0, translate: `0 ${up ? 38 : -38}%`}], {duration: 380, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'both'})?.finished.then(() => drop(ghost), () => drop(ghost));
      }
      const k = .06 + .14 * fx().callout;
      animate('speed-hit', q('.speed-digits'), [{scale: String(1 + k)}, {scale: '1'}], {duration: 260, easing: 'cubic-bezier(.2,1.4,.4,1)'});
    }

    /* Scene transitions: four kinds in rotation, 0.6–1 s. */
    function transition(kind = TRANSITIONS[transitionIndex++ % TRANSITIONS.length], label = '') {
      cancelTransition();
      if (!ensure() || isReduced()) return null;
      measure(-1e9);
      const cockpit = q('#cockpit'), tag = q('#game-transition');
      if (tag) { tag.textContent = label; tag.dataset.kind = kind; tag.hidden = false; animate('transition', tag, [{opacity: 0, scale: '1.8'}, {opacity: 1, scale: '1', offset: .3}, {opacity: 0, scale: '.9'}], {duration: 900, fill: 'both'})?.finished.then(() => { tag.hidden = true; }, () => {}); }
      if (kind === 'shatter') {
        // Translucent shards (≤0.42 alpha) burst outward from the centre.
        const cols = 7, rows = 4;
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
          const x = (i + .5) / cols * ow, y = (j + .5) / rows * oh, a = Math.atan2(y - oh / 2, x - ow / 2);
          shards.push({x, y, vx: Math.cos(a) * (500 + random() * 500), vy: Math.sin(a) * (400 + random() * 400) - 120, rot: 0, vr: (random() - .5) * 9, size: Math.max(ow / cols, oh / rows) * (.7 + random() * .5), life: .9, age: 0, hover: false, tone: random() > .5 ? TONES.cyan : TONES.magenta});
        }
        flash('white', .8); shake(.8);
      } else if (kind === 'glitch') {
        for (let i = 0; i < 14; i++) bars.push({y: random() * oh, h: 4 + random() * 26, dx: (random() - .5) * 120, life: .55 + random() * .2, age: 0, tone: random() > .5 ? TONES.magenta : TONES.cyan});
        animate('transition', cockpit, [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({translate: i === 7 ? '0 0' : `${((i * 37) % 19 - 9) * 1.4}px 0`, offset: i / 7})), {duration: 560, easing: 'steps(1,end)'});
        q('#app')?.classList.add('glitching');
        track('transition', cockpit?.animate?.([{opacity: 1}, {opacity: 1}], {duration: 600}))?.finished.then(() => q('#app')?.classList.remove('glitching'), () => q('#app')?.classList.remove('glitching'));
        shake(.5);
      } else if (kind === 'iris') {
        if (world) { world.state.reveal = 0; channels.set('iris', [{cancel() { world.state.reveal = 2; }}]); }
        ring(ow / 2, oh * .56, TONES.white, {max: 1.4, life: .8, width: 8});
      } else {
        if (world) world.state.warp = 1.4;
        animate('transition', cockpit, [{scale: '1.08 .9'}, {scale: '.97 1.04', offset: .4}, {scale: '1 1'}], {duration: 750, easing: 'cubic-bezier(.2,1.2,.3,1)'});
        burst(ow / 2, oh * .56, 160, TONES.white, {speed: 1100, life: .55, size: 1.6});
        shake(.6);
      }
      return kind;
    }
    function cancelTransition() { stop('transition'); stop('iris'); shards = shards.filter(s => s.hover); bars = []; q('#app')?.classList.remove('glitching'); const tag = q('#game-transition'); if (tag) tag.hidden = true; if (world && world.state.reveal < 2) world.state.reveal = 2; }

    /* Bullet time: slows to a freeze; resume rewinds briefly, then bursts. */
    function pause(on) {
      paused = !!on;
      const el = q('#game-paused'), app = q('#app');
      app?.classList.toggle('bullet-time', paused);
      stop('pause');
      if (paused) {
        scaleTarget = 0;
        if (el) { el.hidden = false; if (!isReduced()) animate('pause', el, [{opacity: 0, scale: '2.4'}, {opacity: 1, scale: '1'}], {duration: 900, easing: 'cubic-bezier(.1,.8,.2,1)', fill: 'both'}); }
        if (!isReduced() && ensure()) {
          measure(-1e9);
          for (let i = 0; i < 22; i++) shards.push({x: random() * ow, y: random() * oh, vx: (random() - .5) * 60, vy: (random() - .5) * 60, rot: random() * TAU, vr: (random() - .5), size: 10 + random() * 34, life: 1e9, age: 0, hover: true, phase: random() * TAU, tone: random() > .5 ? TONES.cyan : TONES.violet});
        }
        if (isReduced()) timeScale = 0;
      } else {
        if (el) el.hidden = true;
        shards = shards.filter(s => !s.hover);
        app?.classList.remove('bullet-time');
        if (isReduced()) { timeScale = scaleTarget = 1; return; }
        const t = now();
        rewindUntil = t + 340; burstUntil = t + 900; scaleTarget = 1;
        app?.classList.add('rewinding');
        track('pause', app?.animate?.([{opacity: 1}, {opacity: 1}], {duration: 340}))?.finished.then(() => {
          app?.classList.remove('rewinding');
          if (!paused) { measure(-1e9); if (focus) { burst(focus.x, focus.y, 120, TONES.cyan, {speed: 800}); ring(focus.x, focus.y, TONES.white, {max: 1.5}); } shake(.8); flash('white', .7); callout('GO!', '继续骑行 · 演示', 'cyan'); if (world) world.state.warp = 1.2; }
        }, () => app?.classList.remove('rewinding'));
      }
    }

    /* Per-frame update from the shared clock. */
    function frame(t, dt, next) {
      input = next || input;
      if (!ensure()) return;
      measure(t);
      const reduced = isReduced(), I = fx();
      // Bullet-time scale; data clocks are untouched.
      if (t < rewindUntil) timeScale = -2.6;
      else if (t < burstUntil) timeScale = 1 + 2.2 * ((burstUntil - t) / 560);
      else timeScale += (scaleTarget - timeScale) * (1 - Math.exp(-dt / (scaleTarget === 0 ? .28 : .12)));
      if (paused && Math.abs(timeScale) < .01) timeScale = 0;
      const sdt = dt * timeScale;
      // World
      const worldOn = I.world && world?.ok && input.page === 'cockpit' && input.view !== 'map';
      q('#app')?.classList.toggle('world-on', !!worldOn);
      if (worldOn) {
        const p = W.worldParams({mode: input.mode, scene: input.scene, speedKmh: input.speedKmh, accel: input.accel, energy: input.energy, soundValid: input.soundValid, turning: input.turning, active: input.active, intensity: I.bloom, reduced});
        world.state.warp += ((input.active ? 0 : 0) - world.state.warp) * (1 - Math.exp(-dt / .5));
        world.state.flash += (0 - world.state.flash) * (1 - Math.exp(-dt / .12));
        world.state.sat += ((paused ? .22 : 1) - world.state.sat) * (1 - Math.exp(-dt / .25));
        if (world.state.reveal < 2) world.state.reveal = Math.min(2, world.state.reveal + dt * 2.6);
        if (eco()) p.ca = 0;
        world.frame(reduced ? 0 : sdt, p);
      }
      // HUD CSS variables: chromatic split and bloom scale with |a| and speed.
      const sp = Number.isFinite(input.speedKmh) && input.active ? clamp(input.speedKmh / 110) : 0;
      const a = Number.isFinite(input.accel) && input.active ? Math.abs(input.accel) : 0;
      const ca = reduced || eco() ? 0 : clamp((a * .9 + sp * .5) * I.ca + (world?.state.warp || 0) * .5 * I.ca, 0, 2);
      setVar('--ca', (Math.round(ca * 10) / 10).toFixed(1));
      setVar('--bloom', (Math.round((reduced ? .2 : (.3 + sp * .7) * I.bloom) * 10) / 10).toFixed(1));
      // Shake
      const cockpit = q('#cockpit');
      trauma = Math.max(0, trauma - dt * 1.7);
      if (cockpit) {
        if (trauma > 0 && !reduced && !paused) {
          const amp = I.shake * trauma * trauma, k = t / 1000;
          cockpit.style.translate = `${(Math.sin(k * 71) + Math.sin(k * 43.1)) * .5 * amp}px ${(Math.cos(k * 63.7) + Math.sin(k * 51.3)) * .5 * amp}px`;
          cockpit.style.rotate = `${Math.sin(k * 37) * amp * .04}deg`;
        } else if (cockpit.style.translate) { cockpit.style.translate = ''; cockpit.style.rotate = ''; }
      }
      // Chase car: decorative lean only from the turn state, never a lean-angle value.
      const host = q('#chase-host');
      if (host) {
        const lean = reduced ? 0 : (input.turning ? -13 : 0) * I.callout;
        const cur = Number(host.dataset.lean || 0), nextLean = cur + (lean - cur) * (1 - Math.exp(-dt / .35));
        host.dataset.lean = nextLean.toFixed(2);
        const bob = reduced ? 0 : Math.sin((t / 1000) * (6 + sp * 18)) * (1 + sp * 3) * (paused ? 0 : 1);
        const rot = `${nextLean.toFixed(1)}deg`, tr = `-50% ${bob.toFixed(0)}px`;
        if (host.style.rotate !== rot) host.style.rotate = rot;
        if (host.style.translate !== tr) host.style.translate = tr;
      }
      drawOverlay(sdt, dt, t, sp, reduced);
    }
    function drawOverlay(sdt, dt, t, sp, reduced) {
      if (!ctx || !ow) return;
      const c = ctx;
      c.setTransform(odpr, 0, 0, odpr, 0, 0); c.clearRect(0, 0, ow, oh);
      if (reduced) { particles = []; rings = []; bars = []; shards = shards.filter(s => s.hover); return; }
      c.globalCompositeOperation = 'lighter';
      const active = input.active && !paused;
      // Flames / energy around the speed at high real speed.
      if (active && focus && sp > .5 && !eco() && random() < sp * fx().particles) {
        const a = random() * TAU, r = Math.max(focus.w, focus.h) * .62;
        particles.push({x: focus.x + Math.cos(a) * r, y: focus.y + Math.sin(a) * r * .7, vx: Math.cos(a) * 30, vy: -60 - random() * 140 * sp, life: .5 + random() * .4, age: 0, size: 2 + random() * 3 * sp, tone: sp > .75 ? '255,110,60' : '255,190,90', gravity: -80});
      }
      // Tail-light trails behind the chase car.
      if (active && carRect && input.mode === 'sport') {
        trails.push({x: carRect.x + carRect.w * (.5 + (random() - .5) * .08), y: carRect.y + carRect.h * .62, age: 0});
        if (trails.length > 40) trails.shift();
      }
      for (const tr of trails) tr.age += sdt;
      trails = trails.filter(tr => tr.age < .6 && tr.age >= 0);
      for (let i = 1; i < trails.length; i++) {
        const a = trails[i - 1], b = trails[i], f = 1 - b.age / .6, spread = 1 + b.age * 6;
        c.strokeStyle = `rgba(255,60,80,${(f * .55).toFixed(3)})`; c.lineWidth = 3 * f + 1;
        c.beginPath(); c.moveTo(ow / 2 + (a.x - ow / 2) * spread, a.y + a.age * 300); c.lineTo(ow / 2 + (b.x - ow / 2) * spread, b.y + b.age * 300); c.stroke();
      }
      for (const p of particles) { p.age += sdt; p.vy += (p.gravity || 0) * sdt; p.x += p.vx * sdt; p.y += p.vy * sdt; const damp = Math.exp(-Math.abs(sdt) * 1.6); p.vx *= damp; p.vy *= damp; }
      particles = particles.filter(p => p.age < p.life && p.age >= -.5);
      for (const p of particles) {
        const fade = 1 - Math.max(0, p.age) / p.life;
        c.strokeStyle = `rgba(${p.tone},${(fade * .9).toFixed(3)})`; c.lineWidth = p.size;
        c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - p.vx * .03, p.y - p.vy * .03); c.stroke();
      }
      for (const r of rings) r.age += sdt;
      rings = rings.filter(r => r.age < r.life && r.age >= 0);
      for (const r of rings) {
        const k = r.age / r.life, rad = Math.max(ow, oh) * r.max * (1 - Math.pow(1 - k, 3));
        c.strokeStyle = `rgba(${r.tone},${((1 - k) * .85).toFixed(3)})`; c.lineWidth = r.width * (1 - k) + 1;
        c.beginPath(); c.arc(r.x, r.y, rad, 0, TAU); c.stroke();
      }
      for (const b of bars) b.age += dt;
      bars = bars.filter(b => b.age < b.life);
      for (const b of bars) { c.fillStyle = `rgba(${b.tone},.28)`; c.fillRect(b.dx * Math.sin(b.age * 40), b.y, ow, b.h); }
      c.globalCompositeOperation = 'source-over';
      for (const s of shards) {
        if (s.hover) { s.age += dt; s.rot += s.vr * dt * .05; }
        else { s.age += sdt; s.x += s.vx * sdt; s.y += s.vy * sdt; s.vy += 900 * sdt; s.rot += s.vr * sdt; }
      }
      shards = shards.filter(s => s.age < s.life);
      for (const s of shards) {
        const fade = s.hover ? .32 : .42 * (1 - s.age / s.life), bobY = s.hover ? Math.sin(t / 900 + s.phase) * 3 : 0;
        c.save(); c.translate(s.x, s.y + bobY); c.rotate(s.rot);
        c.fillStyle = `rgba(${s.tone},${(fade * .55).toFixed(3)})`; c.strokeStyle = `rgba(255,255,255,${fade.toFixed(3)})`; c.lineWidth = 1;
        c.beginPath(); c.moveTo(-s.size * .5, -s.size * .3); c.lineTo(s.size * .45, -s.size * .45); c.lineTo(s.size * .2, s.size * .5); c.closePath(); c.fill(); c.stroke(); c.restore();
      }
    }

    /* Wrapped recap: one big number per screen, then a screenshot-ready card. */
    let wrapped = null;
    // ride.source: 'measured' (native GPS record) or simulated; labels follow the source.
    function wrappedRecap(ride, summary, {onClose = () => {}, native = false} = {}) {
      closeWrapped();
      const root = q('#wrapped');
      if (!root || !ride) return null;
      const measured = ride.source === 'measured';
      const fmtTime = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
      const scenes = [
        {kicker: 'THIS RIDE', title: '这一程', value: ride.distance / 1000, format: v => v.toFixed(2), unit: 'km', note: measured ? 'GPS 实测里程 · 本机记录' : '模拟里程 · 演示数据', tone: 'cyan'},
        {kicker: 'TIME ON ROAD', title: '在路上', value: ride.seconds, format: fmtTime, unit: '', note: measured ? '有效骑行时长 · 本机记录' : '有效演示时长', tone: 'violet'},
        {kicker: 'TOP SPEED', title: '最高速度', value: ride.maxSpeed, format: v => String(Math.round(v)), unit: 'km/h', note: measured ? '记录中的 GPS 最高速度' : '记录中的模拟速度 · 非实测', tone: 'amber'},
        {kicker: 'GAME EVENTS', title: '游戏事件', value: summary.events, format: v => String(Math.round(v)), unit: '次', note: `LAUNCH ${summary.counts.launch} · BOOST ${summary.counts.boost} · CORNER ${summary.counts.corner} · 里程碑 ${summary.counts.milestone} · 游戏分`, tone: 'magenta'},
        {kicker: 'MAX COMBO', title: '最高连击', value: summary.maxCombo, format: v => '×' + Math.round(v), unit: '', note: '平顺动作累积 · 游戏分', tone: 'cyan'},
      ];
      const state = {index: -1, root, scenes, summary, ride, timer: null, tally: null, onClose, measured};
      wrapped = state;
      root.hidden = false; root.dataset.reduced = String(isReduced()); root.dataset.native = String(!!native);
      q('#app')?.classList.add('wrapped-open');
      // Bind once: repeated recaps must not stack handlers (a double next() would skip scenes).
      if (root.dataset.bound !== 'true') {
        root.dataset.bound = 'true';
        root.querySelector?.('[data-wrapped-next]')?.addEventListener?.('click', () => next());
        root.querySelector?.('[data-wrapped-skip]')?.addEventListener?.('click', () => card());
        root.querySelector?.('[data-wrapped-close]')?.addEventListener?.('click', () => closeWrapped('done'));
        root.querySelector?.('[data-wrapped-detail]')?.addEventListener?.('click', () => closeWrapped('detail'));
      }
      if (isReduced()) card(); else next();
      return state;
    }
    function showScene(state, s) {
      const stage = state.root.querySelector('[data-wrapped-stage]');
      stage.replaceChildren();
      stage.dataset.tone = s.tone || 'cyan';
      const k = doc.createElement('span'); k.className = 'wrapped-kicker'; k.textContent = s.kicker;
      const t = doc.createElement('h2'); t.className = 'wrapped-title'; t.textContent = s.title;
      const n = doc.createElement('strong'); n.className = 'wrapped-number'; n.textContent = s.format(isReduced() ? s.value : 0);
      const u = doc.createElement('em'); u.className = 'wrapped-unit'; u.textContent = s.unit;
      const note = doc.createElement('small'); note.className = 'wrapped-note'; note.textContent = s.note + (isReduced() ? '' : ' · 汇总动画');
      stage.append(k, t, n, u, note);
      if (isReduced()) return;
      [k, t, n, u, note].forEach((el, i) => animate('wrapped', el, [{opacity: 0, translate: '0 60px', scale: i === 2 ? '.4' : '1'}, {opacity: 1, translate: '0 0', scale: i === 2 ? '1.08' : '1', offset: .7}, {opacity: 1, translate: '0 0', scale: '1'}], {duration: 700, delay: i * 90, easing: 'cubic-bezier(.2,1.2,.3,1)', fill: 'both'}));
      if (clock && M && s.value > 0) {
        n.dataset.transition = 'tally';
        state.tally = M.createTimeline(clock).add({at: 250, duration: 1100, update: p => { n.textContent = s.format(s.value * M.easing.out(p)); }, end: () => { n.textContent = s.format(s.value); delete n.dataset.transition; }, cancel: () => { n.textContent = s.format(s.value); delete n.dataset.transition; }}).play();
      }
      confetti(state, 70);
    }
    function confetti(state, n) {
      const c = state.root.querySelector('canvas');
      if (!c || isReduced()) return;
      state.pieces = (state.pieces || []).concat(Array.from({length: Math.round(n * fx().particles)}, () => ({x: random(), y: -.05 - random() * .3, vx: (random() - .5) * .3, vy: .2 + random() * .5, r: random() * TAU, vr: (random() - .5) * 10, hue: Math.floor(random() * 360), age: 0})));
      if (!state.confettiTask && clock) state.confettiTask = clock.add((tt, dt) => drawConfetti(state, dt));
    }
    function drawConfetti(state, dt) {
      const c = state.root.querySelector('canvas'), g = c?.getContext?.('2d');
      if (!g || wrapped !== state) return false;
      const w = c.clientWidth || 400, h = c.clientHeight || 700;
      if (c.width !== w) { c.width = w; c.height = h; }
      g.clearRect(0, 0, w, h);
      for (const p of state.pieces) { p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; }
      state.pieces = state.pieces.filter(p => p.y < 1.1 && p.age < 6);
      for (const p of state.pieces) { g.save(); g.translate(p.x * w, p.y * h); g.rotate(p.r); g.fillStyle = `hsl(${p.hue},95%,65%)`; g.fillRect(-5, -2.5, 10, 5); g.restore(); }
      if (!state.pieces.length) { state.confettiTask = null; return false; }
      return true;
    }
    function next() {
      const state = wrapped; if (!state) return;
      clearTimeout(state.timer); state.tally?.cancel(); stop('wrapped');
      state.index++;
      if (state.index >= state.scenes.length) { card(); return; }
      state.root.dataset.step = String(state.index + 1);
      showScene(state, state.scenes[state.index]);
      state.timer = setTimeout(next, 2300);
    }
    function card() {
      const state = wrapped; if (!state) return;
      clearTimeout(state.timer); state.tally?.cancel(); stop('wrapped');
      state.index = state.scenes.length; state.root.dataset.step = 'card';
      const stage = state.root.querySelector('[data-wrapped-stage]'), sm = state.summary, r = state.ride;
      stage.replaceChildren(); stage.dataset.tone = 'card';
      const cardEl = doc.createElement('article'); cardEl.className = 'wrapped-card';
      const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
      const rows = [['里程', (r.distance / 1000).toFixed(2) + ' km'], ['时长', fmt(r.seconds)], ['最高速度', Math.round(r.maxSpeed) + ' km/h'], ['游戏事件', String(sm.events)], ['最高连击', '×' + sm.maxCombo], ['节奏判定', `P ${sm.counts.perfect} · G ${sm.counts.great}`]];
      const mk = (tag, cls, text) => { const el = doc.createElement(tag); el.className = cls; if (text != null) el.textContent = text; return el; };
      const dl = mk('dl', 'card-grid');
      for (const [k, v] of rows) dl.append(mk('dt', '', k), mk('dd', '', v));
      cardEl.append(mk('span', 'card-kicker', 'MOTUO · RIDE CARD'), mk('div', 'card-rating', sm.rating), mk('div', 'card-score', sm.score.toLocaleString('en-US') + ' 游戏分'), dl,
        mk('p', 'card-note', '游戏评级与游戏分 · 演示，非驾驶评价；' + (state.measured ? '里程、速度来自本机实测记录。' : '里程、速度为模拟数据。')));
      stage.append(cardEl);
      if (!isReduced()) { animate('wrapped', cardEl, [{opacity: 0, transform: 'perspective(900px) rotateY(-80deg) scale(.6)'}, {opacity: 1, transform: 'perspective(900px) rotateY(8deg) scale(1.04)', offset: .7}, {opacity: 1, transform: 'none'}], {duration: 900, easing: 'cubic-bezier(.2,1,.3,1)', fill: 'both'}); confetti(state, 140); }
    }
    function closeWrapped(reason = 'done') {
      const state = wrapped; if (!state) return;
      wrapped = null;
      clearTimeout(state.timer); state.tally?.cancel(); stop('wrapped');
      state.confettiTask = null;
      state.root.hidden = true; state.root.querySelector?.('[data-wrapped-stage]')?.replaceChildren();
      q('#app')?.classList.remove('wrapped-open');
      state.onClose(reason);
    }

    function allowFlash() { return !modal && !isReduced() && fx().flash > 0 && flashes.allow(now()); }
    function cancelAll() {
      for (const ch of [...channels.keys()]) stop(ch);
      particles = []; rings = []; shards = []; trails = []; bars = []; trauma = 0;
      for (const el of [...temp]) drop(el);
      const cockpit = q('#cockpit'); if (cockpit) { cockpit.style.translate = ''; cockpit.style.rotate = ''; }
      q('#app')?.classList.remove('glitching', 'rewinding');
      for (const id of ['#game-callout', '#game-judge', '#game-transition']) { const el = q(id); if (el) el.hidden = true; }
      if (world) { world.state.warp = 0; world.state.flash = 0; world.state.reveal = 2; }
      if (ctx && ow) ctx.clearRect(0, 0, overlay.width, overlay.height);
      rewindUntil = burstUntil = 0; timeScale = paused ? 0 : 1; scaleTarget = paused ? 0 : 1;
    }
    // End of ride / reset: leave bullet time without the resume burst.
    function reset() {
      paused = false; cancelAll(); timeScale = scaleTarget = 1;
      const el = q('#game-paused'); if (el) el.hidden = true;
      q('#app')?.classList.remove('bullet-time', 'rewinding');
      lastSpeedText = null;
    }
    function debug() {
      return {channels: [...channels.keys()], temp: temp.size, particles: particles.length, rings: rings.length, shards: shards.length, bars: bars.length, trauma, timeScale, flashesInLastSecond: flashes.countIn(now()), world: !!world?.ok, wrapped: !!wrapped, wrappedStep: wrapped?.root.dataset.step || null};
    }
    return {frame, event, speedReading, reset, setModal, get modal() { return modal; }, transition, pause, wrappedRecap, nextWrapped: next, skipWrapped: card, closeWrapped, renderScore, flash, shake, allowFlash, cancelAll, debug, get world() { return world; }};
  }
  global.MotuoGameFX = Object.freeze({create, TRANSITIONS});
})(typeof window !== 'undefined' ? window : globalThis);
