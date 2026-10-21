/* Motuo 2D bike layer: manga-style effects and playful gestures around the shared
 * 3D/2D bike canvas. Pure decoration — poses never show a lean angle, throttle or
 * any value; the long-press start is guarded by a full charge plus a cancellable
 * confirmation, and the original start button stays.
 */
(function (global) {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  /* Long-press start state machine (testable, no DOM).
   * idle → charging (press) → armed (held ≥ fullMs) → confirming (released while armed)
   * → started after confirmMs unless cancelled. Short release = rev; movement = drag. */
  function createChargeMachine({fullMs = 1100, confirmMs = 1800, moveTolerance = 22, canStart = () => true} = {}) {
    let state = 'idle', since = 0, pressAt = 0, startable = false;
    const api = {
      get state() { return state; },
      progress(t) { return state === 'charging' ? clamp((t - since) / fullMs) : state === 'armed' || state === 'confirming' ? 1 : 0; },
      countdown(t) { return state === 'confirming' ? Math.max(0, confirmMs - (t - since)) : 0; },
      press(t) { if (state !== 'idle') return null; state = 'charging'; since = pressAt = t; startable = !!canStart(); return 'charge'; },
      move(distance) { if ((state === 'charging' || state === 'armed') && distance > moveTolerance) { state = 'idle'; return 'drag'; } return null; },
      tick(t) {
        if (state === 'charging' && t - since >= fullMs) { state = 'armed'; return startable ? 'armed' : 'armed-dash'; }
        if (state === 'confirming') {
          if (!canStart()) { state = 'idle'; return 'cancel'; }
          if (t - since >= confirmMs) { state = 'idle'; return 'start'; }
        }
        return null;
      },
      release(t) {
        if (state === 'charging') { state = 'idle'; return t - pressAt < 260 ? 'rev' : 'fizzle'; }
        if (state === 'armed') {
          if (!startable || !canStart()) { state = 'idle'; return 'dash'; }
          state = 'confirming'; since = t; return 'confirm';
        }
        return null;
      },
      cancel() { if (state === 'idle') return null; state = 'idle'; return 'cancel'; },
    };
    return api;
  }

  const WORDS = {rev: ['轰——！', 'VROOM'], dash: ['嗖——！', 'GO!!'], drift: ['吱——！', 'DRIFT'], wheelie: ['轰！！', 'WHEELIE'], brake: ['吱——！', 'BRAKE'], corner: ['嗖', 'LEAN'], milestone: ['轰！', 'BOOM']};

  function create(doc = global.document, {clock = null, isReduced = () => false, intensity = () => ({particles: 1, shake: 15, callout: 1}), tier = () => clock?.tier || 'normal',
    getCanvas = () => null, allowFlash = () => false, canStart = () => false, onStart = () => {}, win = global} = {}) {
    const q = s => doc.querySelector(s);
    const random = rng(23);
    const fx = () => intensity();
    const eco = () => tier() === 'eco';
    let ctx = null, cw = 0, ch = 0, dpr = 1, rect = null, measuredAt = -1e9;
    let parts = [], words = [], lines = [], skids = [], modal = false, task = null;
    const pose = {sx: 1, sy: 1, rot: 0, ty: 0, tx: 0, trail: 0, target: {sx: 1, sy: 1, rot: 0, ty: 0, tx: 0}, until: 0};
    let impactUntil = 0, drag = null, rideInput = {};
    const machine = createChargeMachine({canStart});
    const now = () => global.performance.now();

    function ensure() {
      const c = q('#bike-fx');
      if (!c) return false;
      if (!ctx) ctx = c.getContext?.('2d') || null;
      const w = win.innerWidth || 800, h = win.innerHeight || 600, r = Math.min(win.devicePixelRatio || 1, eco() ? 1 : 1.5);
      if (w !== cw || h !== ch || r !== dpr) { cw = w; ch = h; dpr = r; c.width = Math.round(w * r); c.height = Math.round(h * r); }
      return !!ctx;
    }
    function bikeRect(t) {
      if (t - measuredAt < 250 && rect) return rect;
      measuredAt = t;
      const canvas = getCanvas();
      const r = canvas?.parentNode?.getBoundingClientRect?.();
      rect = r && r.width > 4 ? {x: r.left, y: r.top, w: r.width, h: r.height, chase: canvas.parentNode.id === 'chase-host'} : null;
      return rect;
    }
    // Anchors in the bike rectangle: rear view (chase) vs. the standby 3/4 view.
    const anchor = (r, k) => {
      const map = r.chase ? {exhaust: [.62, .7], rear: [.5, .92], front: [.5, .6], center: [.5, .6]} : {exhaust: [.2, .6], rear: [.27, .9], front: [.78, .88], center: [.5, .6]};
      const [ax, ay] = map[k]; return [r.x + r.w * ax, r.y + r.h * ay];
    };
    function ensureTask() { if (!task && clock) task = clock.add((t, dt) => frame(t, dt)); }
    const budget = n => Math.round(n * (fx().particles ?? 1) * (eco() ? .4 : 1));

    /* Emitters */
    function flame(r, n = 26, power = 1) {
      const [x, y] = anchor(r, 'exhaust'), dir = r.chase ? Math.PI / 2 : Math.PI;
      for (let i = 0; i < budget(n); i++) parts.push({kind: 'flame', x, y, vx: Math.cos(dir + (random() - .5) * .5) * (180 + random() * 260) * power, vy: Math.sin(dir + (random() - .5) * .5) * (120 + random() * 160) * power - 30, life: .25 + random() * .25, age: 0, size: 6 + random() * 10 * power});
      for (let i = 0; i < budget(n * .5); i++) parts.push({kind: 'smoke', x, y, vx: Math.cos(dir) * (40 + random() * 60) + (random() - .5) * 40, vy: -20 - random() * 50, life: .9 + random() * .8, age: 0, size: 10 + random() * 16});
    }
    function sparks(r, n = 30, from = 'rear') {
      const [x, y] = anchor(r, from);
      for (let i = 0; i < budget(n); i++) { const a = Math.PI + (random() - .5) * 1.4; parts.push({kind: 'spark', x, y, vx: Math.cos(a) * (220 + random() * 420) * (random() > .5 ? 1 : -1), vy: -120 - random() * 260, life: .35 + random() * .4, age: 0, size: 1.5 + random() * 1.5}); }
    }
    function debris(r, n = 12) {
      const [x, y] = anchor(r, 'rear');
      for (let i = 0; i < budget(n); i++) parts.push({kind: 'debris', x, y, vx: (random() - .5) * 500, vy: -180 - random() * 320, life: .8, age: 0, size: 3 + random() * 5, rot: random() * TAU, vr: (random() - .5) * 18});
    }
    function word(r, kind, {big = 1} = {}) {
      const pair = WORDS[kind] || WORDS.rev, text = pair[Math.floor(random() * pair.length)];
      const [x, y] = anchor(r, 'center');
      const side = random() > .5 ? 1 : -1;
      // Riding: beside the chase car at mid-height, below the giant event callout band.
      const wx = r.chase ? x + side * r.w * (.62 + random() * .12) : x + side * r.w * (.28 + random() * .14);
      const wy = r.chase ? Math.max(ch * .48, y + r.h * (random() * .15 - .05)) : y - r.h * (.35 + random() * .2);
      words.push({text, x: clamp(wx, 70, Math.max(70, cw - 70)), y: wy, rot: (random() - .5) * .5, life: 1, age: 0, big: big * (.9 + random() * .3) * (r.chase ? .8 : 1)});
      if (words.length > 4) words.shift();
    }
    function focusLines(r, life = .5, count = 60) { lines.push({kind: 'focus', r: {...r}, life, age: 0, count: budget(count), seed: random()}); }
    function speedLines(life = .6, dir = 1) { lines.push({kind: 'speed', life, age: 0, count: budget(46), dir, seed: random()}); }
    function impactFrame() {
      if (isReduced() || modal || !allowFlash()) return false;
      const el = q('#impact-frame'); if (!el) return false;
      el.hidden = false; impactUntil = now() + 70;
      return true;
    }
    function setPose(next, ms = 450) { Object.assign(pose.target, {sx: 1, sy: 1, rot: 0, ty: 0, tx: 0, ...next}); pose.until = now() + ms; }

    /* Gesture reactions (standby / garage only). */
    function react(kind) {
      if (modal) return;
      const r = bikeRect(-1e9);
      ensureTask();
      if (!r) return;
      if (isReduced()) return;
      if (kind === 'rev') { flame(r, 30); word(r, 'rev'); setPose({sx: 1.04, sy: .95, rot: -1.5}, 220); ring(r, 1); }
      if (kind === 'dash' || kind === 'start-dash') { flame(r, 60, 1.6); sparks(r, 40); debris(r); word(r, 'dash', {big: 1.3}); speedLines(.8); setPose({tx: r.w * 1.4, sx: 1.25, sy: .82, rot: -6}, 360); pose.trail = 1; impactFrame(); }
      if (kind === 'drift') { sparks(r, 34, 'rear'); word(r, 'drift'); skidMark(r); pose.trail = 1; }
    }
    let rings = [];
    function ring(r, power) { const [x, y] = anchor(r, 'center'); rings.push({x, y, age: 0, life: .55, power}); }
    function skidMark(r) { const [x, y] = anchor(r, 'rear'); skids.push({x, y, len: r.w * (.4 + random() * .4), age: 0, life: 1.6}); }

    /* Ride poses, synced with game events. */
    function event(e) {
      if (modal || isReduced() || !e) return;
      const r = bikeRect(-1e9); ensureTask(); if (!r) return;
      if (e.kind === 'launch' || e.kind === 'boost') { setPose({rot: -9, ty: -r.h * .06, sx: .96, sy: 1.08}, 750); flame(r, 50, 1.4); word(r, 'wheelie', {big: 1.2}); speedLines(.9); }
      else if (e.kind === 'brake') { setPose({rot: 6, ty: r.h * .05, sx: 1.06, sy: .9}, 600); sparks(r, 46, 'front'); word(r, 'brake'); skidMark(r); }
      else if (e.kind === 'corner') { focusLines(r, .9, 80); word(r, 'corner'); pose.trail = .8; }
      else if (e.kind === 'milestone') { impactFrame(); focusLines(r, .7, 90); flame(r, 40, 1.3); debris(r, 18); word(r, 'milestone', {big: 1.4}); }
    }

    function bind(host, {startable = false} = {}) {
      if (!host || host.dataset?.bikeBound) return;
      if (host.dataset) host.dataset.bikeBound = 'true';
      const local = startable ? machine : createChargeMachine({canStart: () => false});
      host.addEventListener?.('pointerdown', ev => {
        if (rideInput.active) return;            // riding: gestures disabled
        if (local.press(now())) { drag = {x: ev.clientX, y: ev.clientY, lx: ev.clientX, lt: now(), host, local, vx: 0}; renderCharge(local); ensureTask(); }
      });
      host.addEventListener?.('pointermove', ev => {
        if (!drag || drag.host !== host) return;
        const t = now(), dt = Math.max(1, t - drag.lt), vx = (ev.clientX - drag.lx) / dt * 1000;
        drag.vx = drag.vx * .6 + vx * .4; drag.lx = ev.clientX; drag.lt = t;
        const moved = Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y);
        if (local.move(moved) === 'drag') renderCharge(local);
        if (local.state === 'idle') {
          // Drag: lean with the gesture, trail behind, drift when flicked hard.
          pose.target.rot = clamp(drag.vx * .012, -16, 16); pose.target.tx = clamp((ev.clientX - drag.x) * .15, -40, 40); pose.until = t + 260;
          pose.trail = Math.max(pose.trail, clamp(Math.abs(drag.vx) / 1600));
          if (Math.abs(drag.vx) > 1500 && (!drag.drifted || t - drag.drifted > 500)) { drag.drifted = t; react('drift'); }
        }
      });
      const end = (ev, cancelled) => {
        if (!drag || drag.host !== host) return;
        const result = cancelled ? local.cancel() : local.release(now());
        drag = null;
        if (result === 'rev') react('rev');
        else if (result === 'dash') react('dash');
        else if (result === 'confirm') react('start-dash');
        renderCharge(local);
      };
      host.addEventListener?.('pointerup', ev => end(ev, false));
      host.addEventListener?.('pointercancel', ev => end(ev, true));
      host.addEventListener?.('pointerleave', ev => { if (local.state === 'charging' || local.state === 'armed') end(ev, true); });
    }
    function cancelCharge() { const r = machine.cancel(); renderCharge(machine); return r; }
    q('[data-charge-cancel]')?.addEventListener?.('click', () => cancelCharge());

    function renderCharge(m, t = now()) {
      const el = q('#bike-charge'); if (!el) return;
      const text = el.querySelector?.('[data-charge-text]');
      const st = m.state;
      el.hidden = st === 'idle' || (st === 'charging' && m.progress(t) < .15);
      el.dataset.state = st;
      if (text) text.textContent = st === 'charging' ? `蓄力 ${Math.round(m.progress(t) * 100)}% · 继续按住` : st === 'armed' ? '蓄力已满 · 松开出发 · 移开手指取消' : st === 'confirming' ? `即将出发 ${Math.ceil(m.countdown(t) / 1000)} · 点“取消”停止` : '';
      const cancelBtn = el.querySelector?.('[data-charge-cancel]');
      if (cancelBtn) cancelBtn.hidden = st !== 'confirming';
    }

    /* Per-frame: machine timing, pose easing, particles. */
    function frame(t, dt) {
      // Machine ticks (shared cockpit machine and any active local one).
      for (const m of new Set([machine, drag?.local].filter(Boolean))) {
        const r = m.tick(t);
        if (r === 'start') { renderCharge(m, t); onStart(); }
        else if (r) renderCharge(m, t);
        else if (m.state === 'charging' || m.state === 'confirming') renderCharge(m, t);
      }
      const reduced = isReduced();
      const canvas = getCanvas();
      // Pose: event targets decay back to neutral; riding adds squash/stretch from |a|.
      if (t > pose.until) Object.assign(pose.target, {sx: 1, sy: 1, rot: drag ? pose.target.rot : 0, ty: 0, tx: drag ? pose.target.tx : 0});
      const a = rideInput.active && Number.isFinite(rideInput.accel) ? clamp(rideInput.accel / 2, -1, 1) : 0;
      const charge = machine.progress(t) || (drag?.local?.progress(t) || 0);
      const k = 1 - Math.exp(-dt / .09);
      const tgt = {sx: pose.target.sx * (1 + a * .05) * (1 + charge * .05), sy: pose.target.sy * (1 - Math.abs(a) * .04) * (1 - charge * .1), rot: pose.target.rot, ty: pose.target.ty + charge * 6, tx: pose.target.tx};
      for (const key of ['sx', 'sy', 'rot', 'ty', 'tx']) pose[key] += ((reduced ? (key[0] === 's' ? 1 : 0) : tgt[key]) - pose[key]) * k;
      pose.trail = Math.max(0, pose.trail - dt * 1.6);
      if (charge > 0 && !reduced) { pose.rot += Math.sin(t / 22) * charge * .6; if (random() < charge * .5) { const r = bikeRect(t); if (r) sparks(r, 2); } }
      if (canvas?.style) {
        canvas.style.setProperty('--bike-sx', pose.sx.toFixed(3)); canvas.style.setProperty('--bike-sy', pose.sy.toFixed(3));
        canvas.style.setProperty('--bike-rot', pose.rot.toFixed(2) + 'deg'); canvas.style.setProperty('--bike-ty', pose.ty.toFixed(1) + 'px'); canvas.style.setProperty('--bike-tx', pose.tx.toFixed(1) + 'px');
        canvas.style.setProperty('--trail', (pose.trail * 40).toFixed(1));
        canvas.classList?.toggle('bike-trail', pose.trail > .05 && !reduced);
      }
      if (impactUntil && t > impactUntil) { impactUntil = 0; const el = q('#impact-frame'); if (el) el.hidden = true; }
      if (!ensure()) return keepAlive(t);
      const c = ctx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cw, ch);
      if (reduced) { parts = []; words = []; lines = []; skids = []; rings = []; return keepAlive(t); }
      const r = bikeRect(t);
      // Charge ring.
      if (charge > 0 && r) {
        const [x, y] = anchor(r, 'center'), rad = Math.max(r.w, r.h) * .42;
        c.lineWidth = 6; c.strokeStyle = '#ffffff22'; c.beginPath(); c.arc(x, y, rad, 0, TAU); c.stroke();
        c.strokeStyle = charge >= 1 ? '#ffd23f' : '#5ff0ff'; c.lineWidth = 6 + charge * 4; c.shadowColor = c.strokeStyle; c.shadowBlur = 18;
        c.beginPath(); c.arc(x, y, rad, -Math.PI / 2, -Math.PI / 2 + TAU * charge); c.stroke(); c.shadowBlur = 0;
      }
      // Manga lines.
      for (const L of lines) L.age += dt;
      lines = lines.filter(L => L.age < L.life);
      for (const L of lines) {
        const f = 1 - L.age / L.life, g = rng(Math.floor(L.seed * 1e6));
        if (L.kind === 'focus') {
          const cx = L.r.x + L.r.w / 2, cy = L.r.y + L.r.h * .55, R = Math.hypot(cw, ch);
          c.fillStyle = `rgba(10,10,16,${(.55 * f).toFixed(3)})`;
          for (let i = 0; i < L.count; i++) { const a = g() * TAU, w = .004 + g() * .012, inner = R * (.32 + g() * .18); c.beginPath(); c.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner); c.lineTo(cx + Math.cos(a - w) * R, cy + Math.sin(a - w) * R); c.lineTo(cx + Math.cos(a + w) * R, cy + Math.sin(a + w) * R); c.fill(); }
        } else {
          c.strokeStyle = `rgba(255,255,255,${(.6 * f).toFixed(3)})`;
          for (let i = 0; i < L.count; i++) { const y = g() * ch, len = cw * (.15 + g() * .35), x = ((g() + L.age * 2.4 * L.dir) % 1) * (cw + len) - len; c.lineWidth = .8 + g() * 2.2; c.beginPath(); c.moveTo(x, y); c.lineTo(x + len, y); c.stroke(); }
        }
      }
      // Skid marks.
      for (const s of skids) s.age += dt;
      skids = skids.filter(s => s.age < s.life);
      for (const s of skids) { c.strokeStyle = `rgba(20,20,24,${(.55 * (1 - s.age / s.life)).toFixed(3)})`; c.lineWidth = 7; c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x - s.len, s.y + 4); c.stroke(); }
      // Particles.
      const paused = rideInput.paused || modal;
      for (const p of parts) {
        if (paused) continue;
        p.age += dt; p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.kind === 'spark' || p.kind === 'debris') p.vy += 900 * dt;
        if (p.kind === 'smoke') { p.size += dt * 30; p.vx *= .97; }
        if (p.kind === 'debris') p.rot += p.vr * dt;
      }
      parts = parts.filter(p => p.age < p.life);
      if (parts.length > 500) parts.splice(0, parts.length - 500);
      for (const p of parts) {
        const f = 1 - p.age / p.life;
        if (p.kind === 'smoke') { c.fillStyle = `rgba(150,150,165,${(.28 * f).toFixed(3)})`; c.beginPath(); c.arc(p.x, p.y, p.size, 0, TAU); c.fill(); }
      }
      c.globalCompositeOperation = 'lighter';
      for (const p of parts) {
        const f = 1 - p.age / p.life;
        if (p.kind === 'flame') { const grad = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size); grad.addColorStop(0, `rgba(180,230,255,${f.toFixed(3)})`); grad.addColorStop(.35, `rgba(255,170,60,${(f * .9).toFixed(3)})`); grad.addColorStop(1, 'rgba(255,60,20,0)'); c.fillStyle = grad; c.beginPath(); c.arc(p.x, p.y, p.size, 0, TAU); c.fill(); }
        else if (p.kind === 'spark') { c.strokeStyle = `rgba(255,220,120,${f.toFixed(3)})`; c.lineWidth = p.size; c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x - p.vx * .025, p.y - p.vy * .025); c.stroke(); }
      }
      c.globalCompositeOperation = 'source-over';
      for (const p of parts) if (p.kind === 'debris') { c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.fillStyle = '#16161d'; c.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * .6); c.restore(); }
      for (const g of rings) g.age += dt;
      rings = rings.filter(g => g.age < g.life);
      for (const g of rings) { const k2 = g.age / g.life; c.strokeStyle = `rgba(95,240,255,${(1 - k2).toFixed(3)})`; c.lineWidth = 5 * (1 - k2) + 1; c.beginPath(); c.arc(g.x, g.y, 30 + k2 * 160 * g.power, 0, TAU); c.stroke(); }
      // Onomatopoeia: stroked comic lettering that pops and drifts.
      for (const w of words) if (!paused) w.age += dt;
      words = words.filter(w => w.age < w.life);
      for (const w of words) {
        const k2 = w.age / w.life, pop = k2 < .15 ? .4 + k2 / .15 * .8 : 1.2 - (k2 - .15) * .25, size = 44 * w.big * pop * (fx().callout ?? 1);
        c.save(); c.translate(w.x, w.y - k2 * 30); c.rotate(w.rot); c.globalAlpha = k2 > .75 ? (1 - k2) / .25 : 1;
        c.font = `${Math.round(size)}px "MotuoHan","MotuoDisplay",sans-serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
        c.lineWidth = Math.max(4, size * .16); c.strokeStyle = '#0a0a12'; c.strokeText(w.text, 0, 0);
        const fill = c.createLinearGradient(0, -size / 2, 0, size / 2); fill.addColorStop(0, '#fff7c2'); fill.addColorStop(.55, '#ffd23f'); fill.addColorStop(1, '#ff6a2b');
        c.fillStyle = fill; c.fillText(w.text, 0, 0); c.restore();
      }
      return keepAlive(t);
    }
    function keepAlive(t) {
      const busy = parts.length || words.length || lines.length || skids.length || rings.length || drag || machine.state !== 'idle' || pose.trail > 0 || t < pose.until + 400 || impactUntil || rideInput.active;
      if (!busy) { task = null; if (ctx) ctx.clearRect(0, 0, cw * dpr, ch * dpr); return false; }
      return true;
    }
    function frameInput(input) { rideInput = input || {}; if (rideInput.active) { if (machine.state !== 'idle') cancelCharge(); ensureTask(); } }
    function setModal(on) { modal = !!on; if (modal && machine.state !== 'idle') cancelCharge(); }
    function cancelAll() {
      parts = []; words = []; lines = []; skids = []; rings = []; drag = null; pose.trail = 0; impactUntil = 0;
      Object.assign(pose.target, {sx: 1, sy: 1, rot: 0, ty: 0, tx: 0});
      const el = q('#impact-frame'); if (el) el.hidden = true;
      cancelCharge();
      if (ctx) ctx.clearRect(0, 0, cw * dpr, ch * dpr);
    }
    function debug() { return {state: machine.state, parts: parts.length, words: words.length, lines: lines.length, trail: pose.trail, pose: {...pose, target: undefined}, task: !!task, impact: !!impactUntil}; }
    return {bind, event, react, frame, frameInput, setModal, cancelAll, cancelCharge, impactFrame, debug, machine};
  }
  global.MotuoBikeFX = Object.freeze({create, createChargeMachine, WORDS});
})(typeof window !== 'undefined' ? window : globalThis);
