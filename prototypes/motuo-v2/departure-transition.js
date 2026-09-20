/* Shared-element departure: measure before layout, animate after layout.
 * All motion is visual. Recording and sensor clocks never wait for it.
 * FLIP concept: https://aerotwist.com/blog/flip-your-animations/
 */
(function (global) {
  'use strict';
  const DURATION = 1150;
  const EASING = 'cubic-bezier(.22,.7,.18,1)';
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
  function create(doc = document, {onSettled=()=>{}} = {}) {
    let revision=0, animations=[], ghost=null, cockpit=null;
    const query = selector => doc.querySelector(selector);
    function cancel() {
      const wasActive=animations.length>0||ghost!==null||cockpit!==null;
      revision++;
      for(const animation of animations) animation.cancel();
      animations=[];
      ghost?.remove();ghost=null;
      cockpit?.classList.remove('departing');cockpit=null;
      if(wasActive)onSettled();
    }
    function capture() {
      cancel();
      const stage=query('#cockpit');
      if (!stage || stage.hidden || query('#app').classList.contains('reduced-effects')) return null;
      const photo=query('.vehicle-render img');
      const bike=stage.classList.contains('vehicle-rest')&&!stage.classList.contains('map-focus')?imageRect(photo):null;
      const surfaces=['#sound-trend-open','#accel-meter','.music','.page-head','.bottom','.vehicle-title'];
      return {
        bike,src:photo?.currentSrc||photo?.src,
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
    function play(snapshot,{reduced=false}={}) {
      cancel();
      if (!snapshot || reduced || !query('#speed-flight')?.animate) return;
      const run=revision;
      cockpit=query('#cockpit');cockpit.classList.remove('assembling');cockpit.classList.add('departing');
      for(const item of snapshot.surfaces) {
        const el=query(item.selector),last=rectOf(el);if(!last)continue;
        const first=item.rect,title=item.selector==='.vehicle-title';
        // The speed uses a separate wrapper; these surfaces have no base transform.
        const scale=item.selector==='.bottom'||item.selector==='.page-head'?false:true;
        const sx=scale?first.width/last.width:1,sy=scale?first.height/last.height:1;
        const from=`translate(${first.left-last.left}px,${first.top-last.top}px) scale(${sx},${sy})`;
        animate(el,[{transformOrigin:'0 0',transform:from,opacity:1},{transformOrigin:'0 0',transform:title?'translate(0,-6px)':'none',opacity:title?0:1}],{duration:title?550:780});
      }
      const speed=query('#speed'),wrapper=query('#speed-flight'),last=rectOf(speed),parent=rectOf(wrapper),first=snapshot.speed;
      if(first&&last&&parent){
        const scale=first.height/last.height;
        const dx=first.left+first.width/2-parent.left-(last.left+last.width/2-parent.left)*scale;
        const dy=first.top+first.height/2-parent.top-(last.top+last.height/2-parent.top)*scale;
        animate(wrapper,[{transformOrigin:'0 0',transform:`translate(${dx}px,${dy}px) scale(${scale})`},{transformOrigin:'0 0',transform:'none'}],{duration:900});
      }
      if(snapshot.bike){
        const b=snapshot.bike;
        ghost=doc.createElement('div');ghost.className='departure-vehicle';ghost.setAttribute('aria-hidden','true');
        Object.assign(ghost.style,{left:b.left+'px',top:b.top+'px',width:b.width+'px',height:b.height+'px'});
        const image=doc.createElement('img');image.src=snapshot.src;image.alt='';ghost.append(image);doc.body.append(ghost);
        animate(ghost,[{offset:0,transform:'translate(0,0) scale(1)',opacity:1},{offset:.16,transform:'translate(2px,-1px) scale(1)',opacity:1},{offset:.62,transform:'translate(14px,-8px) scale(.99)',opacity:.42},{offset:1,transform:'translate(24px,-16px) scale(.98)',opacity:0}]);
      }
      animate(query('#fx-canvas'),[{opacity:snapshot.bike ? .22 : 1},{opacity:1}],{duration:1000});
      animate(query('.vehicle-floor'),[{opacity:1},{opacity:0}],{duration:650});
      animate(query('.vehicle-orbit'),[{opacity:1},{opacity:0}],{duration:650});
      const pending=animations.map(a=>a.finished.catch(()=>{}));
      Promise.all(pending).then(()=>{if(run===revision)cancel();});
    }
    return Object.freeze({capture,play,cancel});
  }
  global.MotuoDeparture=Object.freeze({create,duration:DURATION});
})(window);
