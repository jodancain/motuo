/* Motuo procedural cockpit scenery. Decorative animation is not telemetry.
 * No sound output, network, vehicle estimation, timers, or retained canvas state.
 * Acoustic marks are enabled only by the caller's explicit inputValid flag.
 */
(function (scope) {
 'use strict';
 const PI=Math.PI,TAU=PI*2;
 const clamp=(v,min=0,max=1)=>Math.max(min,Math.min(max,Number.isFinite(v)?v:0));
 const num=(v,fallback=0)=>Number.isFinite(v)?v:fallback;
 const fract=v=>v-Math.floor(v);
 const palette={gravity:['70,220,255','231,70,237'],neon:['255,213,120','241,117,72'],spectrum:['89,227,255','152,105,255'],aurora:['188,125,255','255,104,207']};
 const rgba=(rgb,a)=>'rgba('+rgb+','+clamp(a)+')';
 function line(c,x1,y1,x2,y2,color,width=1){c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke();}
 function dot(c,x,y,r,color){c.fillStyle=color;c.beginPath();c.arc(x,y,r,0,TAU);c.fill();}
 function path(c,points,color,width=1,close=false){c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.moveTo(points[0],points[1]);for(let i=2;i<points.length;i+=2)c.lineTo(points[i],points[i+1]);if(close)c.closePath();c.stroke();}
 function halo(c,x,y,rx,ry,color,alpha){
  c.save();c.translate(x,y);c.scale(rx,ry);
  const g=c.createRadialGradient(0,0,0,0,0,1);g.addColorStop(0,rgba(color,alpha));g.addColorStop(.4,rgba(color,alpha*.4));g.addColorStop(1,rgba(color,0));
  c.fillStyle=g;c.beginPath();c.arc(0,0,1,0,TAU);c.fill();c.restore();
 }
 function arc(c,x,y,rx,ry,from,to,color,width){c.strokeStyle=color;c.lineWidth=width;c.beginPath();c.ellipse(x,y,rx,ry,0,from,to);c.stroke();}
 function sample(values,q){if(!values||!values.length)return 0;return num(values[Math.min(values.length-1,Math.max(0,Math.floor(q*(values.length-1))))]);}

 function floor(c,p,brightness){
  const {x,y,w,h,t,alpha}=p,cx=x+w*.5,hy=y+h*.72,by=y+h*.99;
  const g=c.createLinearGradient(0,hy,0,by);g.addColorStop(0,rgba('83,137,216',0));g.addColorStop(.7,rgba('83,137,216',brightness*alpha));g.addColorStop(1,rgba('83,137,216',0));
  for(let i=-7;i<=7;i++)line(c,cx+i*w*.012,hy,cx+i*w*.105,by,g,.6);
  for(let i=0;i<9;i++){const q=fract(i/9+t*.075);const py=hy+(by-hy)*q*q;line(c,x+w*(.36-q*.36),py,x+w*(.64+q*.36),py,g,.55);}
 }

 function daily(c,p){
  const {x,y,w,h,t,alpha,e,valid,wave}=p;
  halo(c,x+w*(.5+.07*Math.sin(t*1.05)),y+h*.58,w*.62,h*.65,'42,109,244',alpha*(.2+.045*Math.sin(t*1.3)));
  floor(c,p,.13);
  const baseline=y+h*.87;
  // Layered contour curves are an idle visual motif. Only the fine waveform is acoustic.
  const point=(u,layer)=>{
   const px=x+u*w,phase=t*1.15-layer*.13;
   const shift=(layer-7.5)*.009+Math.sin(phase)*.095;
   const width=.18+.022*Math.sin(t*.95+layer*.09);
   const peak=h*(.64+.075*Math.sin(t*1.45-layer*.17));
   const d=u-.5-shift,hill=Math.exp(-d*d/(2*width*width));
   const ripple=Math.sin(u*TAU*1.6-t*2.1+layer*.24)*h*.043*Math.sin(PI*u);
   return [px,baseline-hill*peak*(1-layer*.023)+ripple+(valid?sample(wave,u)*e*5:0)];
  };
  for(let layer=15;layer>=0;layer--){
   c.beginPath();
   for(let j=0;j<=96;j++){const v=point(j/96,layer);j?c.lineTo(v[0],v[1]):c.moveTo(v[0],v[1]);}
   const gradient=c.createLinearGradient(x,0,x+w,0);
   gradient.addColorStop(0,rgba('43,81,205',0));gradient.addColorStop(.21,rgba('55,124,252',alpha*(layer===0?.85:.19)));gradient.addColorStop(.47,rgba('142,221,255',alpha*(layer===0?1:.34)));gradient.addColorStop(.69,rgba('99,105,255',alpha*(layer===0?.8:.3)));gradient.addColorStop(1,rgba('114,69,213',0));
   c.strokeStyle=gradient;c.lineWidth=layer===0?2.2:layer%4===0?1.15:.65;c.stroke();
  }
  // Moving highlights reveal the wave's shape, rather than animating only tiny dots.
  for(let ribbon=0;ribbon<3;ribbon++){
   const layer=ribbon*4,head=fract(t*.13+ribbon*.31);
   for(let j=0;j<18;j++){
    const u=head-j*.006;if(u<0)continue;
    const a=point(u,layer),b=point(Math.max(0,u-.006),layer);
    line(c,a[0],a[1],b[0],b[1],rgba(ribbon===2?'170,155,255':'173,231,255',alpha*(1-j/18)*Math.sin(PI*u)*.8),2.8);
   }
  }
  // Light packets flow along the contour regardless of microphone permission.
  for(let i=0;i<20;i++){
   const layer=i%10,u=fract(i*.071+t*(.08+(i%3)*.014)),v=point(u,layer),fade=Math.sin(PI*u)*alpha;
   const tail=point(Math.max(0,u-.018),layer);
   line(c,tail[0],tail[1],v[0],v[1],rgba(i%3?'111,209,255':'191,143,255',fade*.75),1.8);
   dot(c,v[0],v[1],i%4===0?1.8:1,rgba('218,243,255',fade*.8));
  }
  if(valid){
   const gy=y+h*.88;
   for(let i=0;i<48;i++){const q=i/47,b=clamp(sample(p.spectrum,q));line(c,x+q*w,gy,x+q*w,gy-b*h*.075,rgba('159,226,255',alpha*(.18+b*.68)),Math.max(1,w/420));}
  }
 }

 function fan(c,p){
  const {x,y,w,h,t,alpha,e,valid,scene}=p;
  const col=palette[scene]||palette.neon,cx=x+w*.5,cy=y+h*.9,rx=w*.49,ry=Math.min(h*.79,w*.39),a0=PI*1.075,a1=PI*1.925;
  halo(c,cx,cy-h*.32,w*.6,h*.73,col[1],alpha*.12);
  floor(c,p,.075);
  // The rotating highlights are decorative orbital trails, separate from the acoustic scale.
  for(let ring=0;ring<4;ring++){
   const scale=.99-ring*.14,from=a0+(a1-a0)*fract(t*(.048+ring*.013)+ring*.23),to=Math.min(a1,from+.22+ring*.08);
   arc(c,cx,cy,rx*scale,ry*scale,a0,a1,rgba(col[ring%2],alpha*(ring===0?.23:.11)),ring===0?1.2:.65);
   arc(c,cx,cy,rx*scale,ry*scale,from,to,rgba(col[ring%2],alpha*.8),ring===0?2.7:1.2);
  }
  if(scene==='aurora'){
   for(let i=0;i<58;i++){
    const q=i/57,a=a0+(a1-a0)*q,rx1=Math.cos(a)*rx,ry1=Math.sin(a)*ry;
    const scan=.14+.3*Math.pow((1+Math.sin(t*.9-q*TAU*1.4))*.5,4);
    const audio=valid?clamp(sample(p.spectrum,q))*.44:0;
    const g=c.createLinearGradient(cx,cy,cx+rx1,cy+ry1);
    g.addColorStop(0,rgba(col[1],0));g.addColorStop(.45,rgba(col[1],alpha*(scan+audio)*.34));g.addColorStop(.89,rgba(col[0],alpha*(scan+audio)));g.addColorStop(1,rgba(col[0],0));
    line(c,cx+rx1*.12,cy+ry1*.12,cx+rx1,cy+ry1,g,Math.max(1.5,w*.006));
   }
  }else{
   for(let i=0;i<104;i++){
    const q=i/103,a=a0+(a1-a0)*q,co=Math.cos(a),si=Math.sin(a),major=i%8===0;
    line(c,cx+co*rx*(major?.71:.79),cy+si*ry*(major?.71:.79),cx+co*rx*.955,cy+si*ry*.955,rgba(col[q<.58?0:1],alpha*(major?.47:.23)),Math.max(.9,w/340));
    if(major)dot(c,cx+co*rx*1.047,cy+si*ry*1.047,1.1,rgba(col[0],alpha*.45));
    if(valid){const b=clamp(sample(p.spectrum,q)),extent=.79+b*.175;
     line(c,cx+co*rx*.79,cy+si*ry*.79,cx+co*rx*extent,cy+si*ry*extent,rgba(col[q<.58?0:1],alpha*(.24+b*.73)),Math.max(1.1,w/300));}
   }
  }
  for(let i=0;i<20;i++){
   const q=fract(i*.133+t*(.025+(i%4)*.01)),a=a0+(a1-a0)*q,r=.58+(i%4)*.125;
   dot(c,cx+Math.cos(a)*rx*r,cy+Math.sin(a)*ry*r,i%5===0?1.8:.9,rgba(i%2?col[0]:col[1],Math.sin(PI*q)*alpha*.8));
  }
  if(valid){
   const a=a0+(a1-a0)*e,co=Math.cos(a),si=Math.sin(a);
   line(c,cx+co*rx*.6,cy+si*ry*.6,cx+co*rx*.99,cy+si*ry*.99,rgba('246,249,255',alpha*.93),2);
   dot(c,cx+co*rx*1.025,cy+si*ry*1.025,2,rgba('246,249,255',alpha));
  }
 }

 function gravity(c,p){
  const {x,y,w,h,t,alpha,moving,motion}=p,cyan=palette.gravity[0],pink=palette.gravity[1];
  const cx=x+w*.5,hy=y+h*.34,depth=h*.67,turn=moving&&motion==='turn'?.065:0;
  const drive=moving?(motion==='accelerate'||motion==='launch'?1.45:motion==='brake'?.5:1):.45;
  const bend=q=>w*turn*q*q;
  const road=(q,lane)=>[cx+w*lane*q+bend(q),hy+depth*q*q];
  halo(c,cx,hy,w*.58,h*.62,cyan,alpha*.13);
  halo(c,cx+w*.2,hy+h*.2,w*.65,h*.65,pink,alpha*.075);
  // Abstract streets and energy gates: no geographic coordinates or route data.
  const roadFade=c.createLinearGradient(0,hy,0,hy+depth);roadFade.addColorStop(0,rgba(cyan,0));roadFade.addColorStop(.5,rgba(cyan,alpha*.23));roadFade.addColorStop(1,rgba(cyan,0));
  for(let lane=-5;lane<=5;lane++){
   c.strokeStyle=lane===-3?rgba(cyan,alpha*.67):lane===3?rgba(pink,alpha*.62):roadFade;c.lineWidth=Math.abs(lane)===3?1.8:.7;c.beginPath();
   for(let j=0;j<=28;j++){const q=j/28,v=road(q,lane*.14);j?c.lineTo(v[0],v[1]):c.moveTo(v[0],v[1]);}c.stroke();
  }
  for(let i=0;i<15;i++){
   const q=fract(i/15+t*.12*drive),v1=road(q,-.74),v2=road(q,.74),fade=Math.sin(PI*q);
   line(c,v1[0],v1[1],v2[0],v2[1],rgba(i%3?cyan:pink,alpha*fade*.2),.55+q*.55);
  }
  // Layered light architecture on both sides; near objects drift faster than distant ones.
  for(let side=-1;side<=1;side+=2)for(let i=0;i<16;i++){
   const q=.08+fract(i/16+t*.075*drive)*.89,shift=bend(q),col=side<0?cyan:pink;
   const bx=cx+side*w*(.5*q+.075)+shift,bottom=hy+depth*q*q*.67,top=hy-h*(.08+q*.43);
   const bw=w*(.014+q*.055),fade=Math.sin(PI*(q-.08)/.89)*alpha;
   c.fillStyle=rgba(side<0?'8,27,44':'29,13,38',fade*.42);c.beginPath();c.moveTo(bx,top);c.lineTo(bx+side*bw,top-h*.04*q);c.lineTo(bx+side*bw,bottom);c.lineTo(bx,bottom);c.closePath();c.fill();
   line(c,bx,top,bx,bottom,rgba(col,fade*.27),.75+q*.65);
   line(c,bx,top,bx+side*bw,top-h*.04*q,rgba(col,fade*.5),.8);
   const glint=fract(t*.27+i*.137);line(c,bx,top+(bottom-top)*glint,bx,top+(bottom-top)*Math.min(1,glint+.075),rgba(col,fade*.86),1.6);
   for(let k=1;k<=3;k++){const yy=top+(bottom-top)*k/5;line(c,bx+side*bw*.17,yy,bx+side*bw*.68,yy-h*.015*q,rgba(col,fade*.23),.7);}
  }
  for(let i=0;i<5;i++){
   const q=.13+fract(i/5+t*.064*drive)*.83,hw=w*(.52*q+.025),roof=hy-h*.36*q,bottom=hy+depth*q*q,shift=bend(q);
   const a=Math.sin(PI*(q-.13)/.83)*alpha*.34;
   path(c,[cx-hw+shift,bottom,cx-hw+shift,roof+h*.08*q,cx-hw*.78+shift,roof,cx+hw*.78+shift,roof,cx+hw+shift,roof+h*.08*q,cx+hw+shift,bottom],rgba(i%2?cyan:pink,a),.8+q*.8);
   line(c,cx-hw*.78+shift,roof,cx-hw*.27+shift,roof,rgba(cyan,a*1.8),1.9);
   line(c,cx+hw*.3+shift,roof,cx+hw*.78+shift,roof,rgba(pink,a*1.8),1.9);
  }
  for(let i=0;i<30;i++){
   const q=fract(i*.119+t*.18*drive),lane=(i%2?1:-1)*(.2+(i%7)*.065),v=road(q,lane),tail=road(Math.max(.015,q-.04-(moving?.025:0)),lane),fade=Math.sin(PI*q)*alpha;
   line(c,tail[0],tail[1],v[0],v[1],rgba(i%2?pink:cyan,fade*.68),.5+q*1.4);
   if(i%4===0)dot(c,v[0],v[1],.6+q,rgba('197,237,255',fade*.9));
  }
  // Acoustic traces are a distinct pair of rails. They do not drive the scenery clock.
  if(p.valid)for(let side=-1;side<=1;side+=2){
   c.strokeStyle=rgba(side<0?cyan:pink,alpha*(.45+p.e*.45));c.lineWidth=1.5;c.beginPath();
   for(let i=0;i<=80;i++){const q=.1+i/80*.88,v=road(q,side*.12);v[0]+=sample(p.wave,i/80)*p.e*w*.014*q;i?c.lineTo(v[0],v[1]):c.moveTo(v[0],v[1]);}c.stroke();
  }
 }

 function transient(c,p){
  if(!p.moving||p.frozen||p.eventAge<0||p.eventAge>1.65)return;
  const {x,y,w,h,alpha,motion,eventAge}=p,q=eventAge/1.65,fade=Math.pow(1-q,1.6)*alpha;
  if(motion==='launch'||motion==='accelerate'){
   const col=palette[p.scene]||palette.gravity,cx=x+w*.5,cy=y+h*.58;
   arc(c,cx,cy,w*(.14+q*.44),h*(.11+q*.37),PI*1.02,PI*1.98,rgba(col[0],fade*.75),2-q);
   arc(c,cx,cy,w*(.09+q*.42),h*(.08+q*.32),PI*1.04,PI*1.96,rgba(col[1],fade*.42),1.2);
   for(let i=0;i<18;i++){const a=PI*1.05+i/17*PI*.9,r=.23+q*.75;dot(c,cx+Math.cos(a)*w*.49*r,cy+Math.sin(a)*h*.56*r,1+q*.5,rgba(col[i%2],fade*.8));}
  }else if(motion==='brake'){
   arc(c,x+w*.5,y+h*.79,w*(.5-q*.2),h*(.65-q*.25),PI*1.07,PI*1.93,rgba('161,152,240',fade*.4),1.5);
  }
 }

 function draw(c,o){
  if(!c||!o)return;
  const width=Math.max(0,num(o.width)),height=Math.max(0,num(o.height)),f=o.field||{};
  const x=num(f.x),y=num(f.y),w=Math.max(0,num(f.width,width)),h=Math.max(0,num(f.height,height));
  if(width<=0||height<=0||w<=0||h<=0)return;
  const frozen=!!o.reduced||!!o.paused,valid=!!o.inputValid&&!frozen;
  const p={x,y,w,h,scene:o.scene||'gravity',t:frozen?0:num(o.time),frozen,valid,e:valid?clamp(o.energy):0,spectrum:valid?o.spectrum:null,wave:valid?o.wave:null,alpha:o.paused?.34:o.signalLost?.56:.9,moving:!!o.active&&!frozen&&!o.signalLost,motion:o.motion||'ready',eventAge:num(o.eventAge,99)};
  c.save();c.lineCap='round';c.lineJoin='round';c.globalAlpha=1;
  // Every call is a complete frame; transparent glows must never accumulate.
  c.clearRect(0,0,width,height);
  c.beginPath();c.rect(0,0,width,height);c.clip();
  if(o.mode==='daily')daily(c,p);else if(p.scene==='gravity')gravity(c,p);else fan(c,p);
  transient(c,p);
  // Soft contrast pockets keep type readable without cutting rectangular holes
  // through the scene. Existing DOM text remains outside this canvas entirely.
  if(Array.isArray(o.protectedRects))for(let i=0;i<Math.min(12,o.protectedRects.length);i++){
   const r=o.protectedRects[i];if(!r||!(num(r.width)>0&&num(r.height)>0))continue;
   const cx=num(r.x)+num(r.width)/2,cy=num(r.y)+num(r.height)/2;
   c.save();c.translate(cx,cy);c.scale(Math.max(18,num(r.width)*.84),Math.max(18,num(r.height)*.83));
   const shade=c.createRadialGradient(0,0,0,0,0,1);shade.addColorStop(0,'rgba(0,0,0,.95)');shade.addColorStop(.42,'rgba(0,0,0,.83)');shade.addColorStop(.7,'rgba(0,0,0,.36)');shade.addColorStop(1,'rgba(0,0,0,0)');
   c.fillStyle=shade;c.beginPath();c.arc(0,0,1,0,TAU);c.fill();c.restore();
  }
  c.restore();
 }
 scope.MotuoCockpitFX=Object.freeze({draw});
})(window);
