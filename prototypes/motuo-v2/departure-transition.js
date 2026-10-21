/* Shared-element departure: measure before layout, animate after layout.
 * All motion is visual. Recording and sensor clocks never wait for it.
 * FLIP concept: https://aerotwist.com/blog/flip-your-animations/
 */
(function (global) {
  'use strict';
  const DURATION = 1150;          // vehicle exit; the 3D wheel spin uses the same length
  const MAX_TOTAL = 1600;         // every layer (delay + duration) finishes inside this
  // Cinematic departure (standard/extreme intensity): black → headlight → charge →
  // impact flash → HUD slams in → world opens. Skippable; still ends inside 3 s.
  const CINE = Object.freeze({bike: 1500, impact: 1150, slam: 1250, total: 3000});
  const EASING = 'cubic-bezier(.22,.7,.18,1)';
  // Shared rhythm when motion-kit is present; otherwise the original fixed curve.
  const kit = () => global.MotuoMotion || null;
  const spring = (name, maxMs, fallback) => {
    const k = kit();
    if (!k) return {duration: fallback, easing: EASING};
    const t = k.springTiming(name, {maxMs, minMs: Math.min(maxMs, 300)});
    return {duration: t.duration, easing: t.easing};
  };
  const rectOf = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? {left:r.left,top:r.top,width:r.width,height:r.height} : null;
  };
  // getBoundingClientRect includes contain's letterboxing; animate the image's
  // actual aspect-ratio rectangle, so orientation changes never squash the bike.
  function imageRect(el) {
    const r = rectOf(el);
    if (!r || !el.complete || !el.naturalWidth || !el.naturalHeight) return null;
    const scale = Math.min(r.width/el.naturalWidth,r.height/el.naturalHeight);
    const width=el.naturalWidth*scale,height=el.naturalHeight*scale;
    return {left:r.left+(r.width-width)/2,top:r.top+(r.height-height)/2,width,height};
  }
  function create(doc = document, {onSettled=()=>{},getVehicle=()=>null,allowFlash=()=>true} = {}) {
    let revision=0, animations=[], ghost=null, cockpit=null, liveVehicle=null, originalHost=null, layers=[];
    const query = selector => doc.querySelector(selector);
    function cancel() {
      const wasActive=animations.length>0||ghost!==null||cockpit!==null||layers.length>0;
      revision++;
      for(const animation of animations) animation.cancel();
      animations=[];
      if(liveVehicle){liveVehicle.stopDeparture();if(originalHost)liveVehicle.mount(originalHost);}
      liveVehicle=null;originalHost=null;
      ghost?.remove();ghost=null;
      for(const layer of layers) layer.remove();
      layers=[];
      cockpit?.classList.remove('departing','cine','cine-hold');cockpit=null;
      query('#app')?.classList.remove('cine-active');
      if(wasActive)onSettled();
    }
    function capture() {
      cancel();
      const stage=query('#cockpit');
      if (!stage || stage.hidden || query('#app').classList.contains('reduced-effects')) return null;
      const photo=query('.vehicle-render img');
      const viewer=getVehicle();
      const visible=stage.classList.contains('vehicle-rest')&&!stage.classList.contains('map-focus');
      const live=visible&&viewer?{viewer,host:viewer.canvas.parentNode}:null;
      const bike=visible?(live?rectOf(viewer.canvas):imageRect(photo)):null;
      const surfaces=['#sound-trend-open','#accel-meter','.music','.page-head','.bottom','.vehicle-title'];
      return {
        bike,live,src:photo?.currentSrc||photo?.src,
        speed:rectOf(query('#speed')),
        surfaces:surfaces.map(selector=>({selector,rect:rectOf(query(selector))})).filter(item=>item.rect)
      };
    }
    function animate(el,frames,options={}) {
      if (!el?.animate) return;
      const animation=el.animate(frames,{duration:DURATION,easing:EASING,fill:'both',...options});
      // Cancellation is routine on pause, resize, background, or another start.
      animation.finished.catch(()=>{});
      animations.push(animation);
    }
    // Light-only layers: a sweep wipe, a shock ring at the speed, and the energy arc
    // drawing on. They add light over an already visible HUD; nothing fades in twice.
    function decorate(snapshot,speedRect) {
      const k=kit(),stage=cockpit,box=rectOf(stage);if(!k||!box)return;
      const add=className=>{const el=doc.createElement('div');el.className=className;el.setAttribute('aria-hidden','true');stage.append(el);layers.push(el);return el;};
      const sweep=add('departure-sweep');
      animate(sweep,[{transform:'translateX(-120%) skewX(-18deg)'},{transform:'translateX(260%) skewX(-18deg)'}],{duration:760,delay:140,easing:k.easing.sweep.css});
      if(speedRect){
        const ring=add('departure-ring'),size=Math.max(speedRect.width,speedRect.height)*1.25;
        Object.assign(ring.style,{left:(speedRect.left-box.left+speedRect.width/2-size/2)+'px',top:(speedRect.top-box.top+speedRect.height/2-size/2)+'px',width:size+'px',height:size+'px'});
        animate(ring,[{transform:'scale(.25)',opacity:.95},{transform:'scale(2.6)',opacity:0}],{duration:820,delay:380,easing:k.easing.out.css});
      }
      const arc=query('#energy-arc'),draw=spring('glide',900,900);
      animate(arc,[{strokeDashoffset:'970'},{strokeDashoffset:arc?.style?.strokeDashoffset||'650'}],{duration:draw.duration,delay:200,easing:draw.easing});
    }
    function layer(className,parent,tag='div'){const el=doc.createElement(tag);el.className=className;el.setAttribute('aria-hidden','true');parent.append(el);layers.push(el);return el;}
    // The speed stays above every cinematic layer (cockpit is raised over the black
    // backdrop and the bike), so the reading is never hidden.
    function cinematic(snapshot,run) {
      const k=kit(),box=rectOf(cockpit);
      query('#app')?.classList.add('cine-active');cockpit.classList.add('cine','cine-hold');
      const pop=k.springTiming('pop',{maxMs:700,minMs:600}),glide=spring('glide',900,900);
      const backdrop=layer('cine-backdrop',doc.body);
      animate(backdrop,[{opacity:0},{opacity:1,offset:.1},{opacity:1,offset:.78},{opacity:0}],{duration:CINE.impact+350,easing:'linear'});
      const hold=animations.at(-1);
      hold?.finished.then(()=>{if(run===revision)cockpit?.classList.remove('cine-hold');},()=>{});
      // Headlight ignition: one flash (rate-limited with every other flash on the page).
      const b=snapshot.bike;
      if(b&&allowFlash()){
        const flare=layer('cine-flare',backdrop);
        Object.assign(flare.style,{left:(b.left+b.width*.62)+'px',top:(b.top+b.height*.42)+'px'});
        animate(flare,[{opacity:0,transform:'translate(-50%,-50%) scale(.2)'},{opacity:1,transform:'translate(-50%,-50%) scale(1.4)',offset:.35},{opacity:0,transform:'translate(-50%,-50%) scale(2.2)'}],{duration:520,delay:220,easing:k.easing.out.css});
      }
      if(allowFlash()){
        const white=layer('cine-white',backdrop);
        animate(white,[{opacity:0},{opacity:.85,offset:.12},{opacity:0}],{duration:420,delay:CINE.impact-40,easing:'linear'});
      }
      const skip=layer('cine-skip',doc.body,'button');skip.textContent='跳过 ›';skip.removeAttribute('aria-hidden');skip.setAttribute('aria-label','跳过出发动画');
      const skipNow=()=>skipAll(run);skip.addEventListener?.('click',skipNow);backdrop.addEventListener?.('pointerdown',skipNow);
      const word=layer('cine-word',cockpit);word.textContent='ROLL OUT';
      animate(word,[{opacity:0,transform:'translate(-50%,0) scale(4)'},{opacity:1,transform:'translate(-50%,0) scale(.94)',offset:.22},{opacity:1,transform:'translate(-50%,0) scale(1.03)',offset:.72},{opacity:0,transform:'translate(-50%,0) scale(1.7)'}],{duration:1400,delay:880,easing:'cubic-bezier(.2,.9,.2,1)'});
      const last=rectOf(query('#speed'));
      if(last&&box){
        const ring=layer('cine-shock',cockpit),size=Math.max(last.width,last.height);
        Object.assign(ring.style,{left:(last.left-box.left+last.width/2-size/2)+'px',top:(last.top-box.top+last.height/2-size/2)+'px',width:size+'px',height:size+'px'});
        animate(ring,[{transform:'scale(.3)',opacity:0},{transform:'scale(.4)',opacity:1,offset:.04},{transform:'scale(7)',opacity:0}],{duration:760,delay:CINE.impact,easing:k.easing.out.css});
      }
      // World opens like an iris once the bike has passed the camera.
      for(const sel of ['#game-world','#fx-canvas'])animate(query(sel),[{clipPath:'circle(0% at 50% 56%)',opacity:1},{clipPath:'circle(75% at 50% 56%)',opacity:1}],{duration:800,delay:CINE.impact-50,easing:k.easing.inOut.css});
      let order=0;
      for(const item of snapshot.surfaces){
        const el=query(item.selector);if(!el)continue;
        if(item.selector==='.vehicle-title'){animate(el,[{opacity:1},{opacity:0}],{duration:300});continue;}
        // HUD slams in with overshoot, staggered like hits landing.
        animate(el,[{transform:'translateY(-70px) scale(1.7)',opacity:0},{transform:'translateY(8px) scale(.9)',opacity:1,offset:.42},{transform:'translateY(-3px) scale(1.04)',opacity:1,offset:.7},{transform:'none',opacity:1}],{duration:pop.duration,easing:'cubic-bezier(.2,.8,.3,1)',delay:CINE.slam+k.stagger(order++,snapshot.surfaces.length,{step:70,maxTotal:300})});
      }
      const speed=query('#speed'),wrapper=query('#speed-flight'),parent=rectOf(wrapper),first=snapshot.speed;
      if(first&&last&&parent){
        const scale=first.height/last.height;
        const dx=first.left+first.width/2-parent.left-(last.left+last.width/2-parent.left)*scale;
        const dy=first.top+first.height/2-parent.top-(last.top+last.height/2-parent.top)*scale;
        animate(wrapper,[{transformOrigin:'0 0',transform:`translate(${dx}px,${dy}px) scale(${scale})`,opacity:1},{transformOrigin:'0 0',transform:'none',opacity:1}],{duration:glide.duration,easing:glide.easing,delay:250});
      }
      animate(query('.speed-digits'),[{scale:'1'},{scale:'1.45',offset:.25},{scale:'1'}],{duration:620,delay:CINE.impact,easing:k.easing.out.css});
      if(b){
        ghost=doc.createElement('div');ghost.className='departure-vehicle departure-charge';ghost.setAttribute('aria-hidden','true');
        Object.assign(ghost.style,{left:b.left+'px',top:b.top+'px',width:b.width+'px',height:b.height+'px'});
        doc.body.append(ghost);
        if(snapshot.live){
          liveVehicle=snapshot.live.viewer;originalHost=snapshot.live.host;ghost.classList.add('departure-live');
          liveVehicle.mount(ghost);liveVehicle.setInteractive(false);liveVehicle.startDeparture(CINE.bike);
        }else{const image=doc.createElement('img');image.src=snapshot.src;image.alt='';ghost.append(image);}
        // Crouch, rev, then lunge at the camera and past it.
        animate(ghost,[{offset:0,transform:'translate(0,0) scale(1)',opacity:1},{offset:.22,transform:'translate(-10px,5px) scale(.96)',opacity:1},{offset:.32,transform:'translate(-6px,3px) scale(.98)',opacity:1},{offset:.62,transform:'translate(6%,10%) scale(1.5)',opacity:1},{offset:.76,transform:'translate(14%,28%) scale(3.1)',opacity:.85},{offset:.84,transform:'translate(18%,40%) scale(4.4)',opacity:0},{offset:1,transform:'translate(18%,40%) scale(4.4)',opacity:0}],{duration:CINE.bike,easing:'cubic-bezier(.5,0,.7,1)'});
      }
      animate(query('.vehicle-floor'),[{opacity:1},{opacity:0}],{duration:650});
      animate(query('.vehicle-orbit'),[{opacity:1},{opacity:0}],{duration:650});
    }
    // Skip jumps every layer to its end state; normal completion then cleans up.
    function skipAll(run){if(run!==revision)return;for(const a of [...animations])try{a.finish();}catch{a.cancel();}}
    function play(snapshot,{reduced=false,cinematic:cine=false}={}) {
      cancel();
      if (!snapshot || reduced || !query('#speed-flight')?.animate) return;
      const run=revision;
      cockpit=query('#cockpit');cockpit.classList.remove('assembling');cockpit.classList.add('departing');
      if(cine&&kit()){
        cinematic(snapshot,run);
        Promise.all(animations.map(a=>a.finished.catch(()=>{}))).then(()=>{if(run===revision)cancel();});
        return;
      }
      const k=kit(),surfaceTiming=spring('glide',820,780),speedTiming=spring('glide',980,900);
      let order=0;
      for(const item of snapshot.surfaces) {
        const el=query(item.selector),last=rectOf(el);if(!last)continue;
        const first=item.rect,title=item.selector==='.vehicle-title';
        // The speed uses a separate wrapper; these surfaces have no base transform.
        const scale=item.selector==='.bottom'||item.selector==='.page-head'?false:true;
        const sx=scale?first.width/last.width:1,sy=scale?first.height/last.height:1;
        const from=`translate(${first.left-last.left}px,${first.top-last.top}px) scale(${sx},${sy})`;
        // Staggered by 40 ms (≤200 ms total). Held at the old bounds while waiting, so nothing jumps.
        const delay=k&&!title?k.stagger(order++,snapshot.surfaces.length,{step:40,maxTotal:200}):0;
        animate(el,[{transformOrigin:'0 0',transform:from,opacity:1},{transformOrigin:'0 0',transform:title?'translate(0,-6px)':'none',opacity:title?0:1}],title?{duration:550}:{duration:surfaceTiming.duration,easing:surfaceTiming.easing,delay});
      }
      const speed=query('#speed'),wrapper=query('#speed-flight'),last=rectOf(speed),parent=rectOf(wrapper),first=snapshot.speed;
      if(first&&last&&parent){
        const scale=first.height/last.height;
        const dx=first.left+first.width/2-parent.left-(last.left+last.width/2-parent.left)*scale;
        const dy=first.top+first.height/2-parent.top-(last.top+last.height/2-parent.top)*scale;
        animate(wrapper,[{transformOrigin:'0 0',transform:`translate(${dx}px,${dy}px) scale(${scale})`},{transformOrigin:'0 0',transform:'none'}],{duration:speedTiming.duration,easing:speedTiming.easing});
      }
      if(snapshot.bike){
        const b=snapshot.bike;
        ghost=doc.createElement('div');ghost.className='departure-vehicle';ghost.setAttribute('aria-hidden','true');
        Object.assign(ghost.style,{left:b.left+'px',top:b.top+'px',width:b.width+'px',height:b.height+'px'});
        doc.body.append(ghost);
        if(snapshot.live){
          liveVehicle=snapshot.live.viewer;originalHost=snapshot.live.host;
          ghost.classList.add('departure-live');
          liveVehicle.mount(ghost);liveVehicle.setInteractive(false);liveVehicle.startDeparture(DURATION);
        }else{
          const image=doc.createElement('img');image.src=snapshot.src;image.alt='';ghost.append(image);
        }
        animate(ghost,[{offset:0,transform:'translate(0,0) scale(1)',opacity:1},{offset:.16,transform:'translate(2px,-1px) scale(1)',opacity:1},{offset:.62,transform:'translate(14px,-8px) scale(.99)',opacity:.42},{offset:1,transform:'translate(24px,-16px) scale(.98)',opacity:0}]);
      }
      if(k){
        // Camera push: the world behind the HUD settles from 1.12× while it brightens.
        const push=spring('smooth',1000,1000);
        animate(query('#fx-canvas'),[{opacity:snapshot.bike ? .22 : 1,scale:'1.12'},{opacity:1,scale:'1'}],{duration:1000,easing:push.easing});
        decorate(snapshot,last);
      }else animate(query('#fx-canvas'),[{opacity:snapshot.bike ? .22 : 1},{opacity:1}],{duration:1000});
      animate(query('.vehicle-floor'),[{opacity:1},{opacity:0}],{duration:650});
      animate(query('.vehicle-orbit'),[{opacity:1},{opacity:0}],{duration:650});
      const pending=animations.map(a=>a.finished.catch(()=>{}));
      Promise.all(pending).then(()=>{if(run===revision)cancel();});
    }
    return Object.freeze({capture,play,cancel,skip:()=>skipAll(revision),get active(){return cockpit!==null;}});
  }
  global.MotuoDeparture=Object.freeze({create,duration:DURATION,maxTotal:MAX_TOTAL,cinematic:CINE});
})(window);
