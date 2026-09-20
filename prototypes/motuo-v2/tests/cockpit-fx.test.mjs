import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Rendering contracts only; neither visual fidelity nor physical-device FPS.
const source=readFileSync(new URL('../cockpit-fx.js',import.meta.url),'utf8');
const sandbox={window:{}};vm.runInNewContext(source,sandbox);
const renderer=sandbox.window.MotuoCockpitFX;
function record(options={}){
 const calls=[];let gradientId=0;
 const context=new Proxy({globalAlpha:1,lineWidth:1}, {
  get(target,key){
   if(key in target)return target[key];
   if(key==='measureText')return text=>({width:String(text).length*6});
   if(key==='createLinearGradient'||key==='createRadialGradient')return (...args)=>{
    assert.ok(args.every(Number.isFinite),'gradient coordinates are finite');
    const id=++gradientId;calls.push([key,...args]);
    return {id,addColorStop(offset,color){assert.ok(Number.isFinite(offset)&&offset>=0&&offset<=1);calls.push(['stop',id,offset,color]);}};
   };
   return (...args)=>{for(const x of args)if(typeof x==='number')assert.ok(Number.isFinite(x),`${String(key)} coordinate must be finite`);calls.push([key,...args]);};
  },
  set(target,key,value){target[key]=value;if(typeof value==='number')assert.ok(Number.isFinite(value));calls.push(['set',key,typeof value==='object'?value.id:value]);return true;}
 });
 renderer.draw(context,{width:844,height:300,field:{x:205,y:28,width:420,height:165},protectedRects:[{x:45,y:60,width:150,height:150}],mode:'sport',scene:'gravity',time:4,reduced:false,paused:false,active:true,motion:'cruise',signalLost:false,energy:0,spectrum:Array(24).fill(0),wave:Array(80).fill(0),inputValid:false,eventAge:4,themeAge:4,...options});
 assert.ok(calls.length<25000,'per-frame canvas command budget remains bounded');
 return JSON.stringify(calls);
}
for(const scene of ['gravity','neon','spectrum','aurora']){
 test(`${scene}: finite portrait and landscape drawing with all motion states`,()=>{
  for(const [width,height] of [[844,300],[343,480],[1134,550]])for(const motion of ['ready','stop','launch','accelerate','cruise','load','turn','brake','gps']){
   record({scene,width,height,field:{x:width*.2,y:25,width:width*.6,height:height*.55},motion,inputValid:true,energy:.7,spectrum:Array(24).fill(.6),wave:Array.from({length:80},(_,i)=>Math.sin(i*.2)),signalLost:motion==='gps',eventAge:.6});
  }
 });
}
test('decoration keeps moving without turning on sound input',()=>{
 for(const scene of ['gravity','neon','spectrum','aurora'])assert.notEqual(record({scene,time:3}),record({scene,time:4}));
 assert.notEqual(record({mode:'daily',time:3}),record({mode:'daily',time:4}));
});
test('each frame clears previous transparent glows before drawing',()=>{
 for(const scene of ['gravity','neon','spectrum','aurora']){
  const calls=JSON.parse(record({scene}));
  const clearIndex=calls.findIndex(call=>call[0]==='clearRect');
  const paintIndex=calls.findIndex(call=>['fill','stroke','fillRect'].includes(call[0]));
  assert.ok(clearIndex>=0&&clearIndex<paintIndex,'old pixels must be cleared before any new paint');
  assert.deepEqual(calls[clearIndex],['clearRect',0,0,844,300]);
 }
});
test('invalid input ignores stale acoustic values',()=>{
 for(const scene of ['gravity','neon','spectrum','aurora'])assert.equal(record({scene}),record({scene,energy:1,spectrum:Array(24).fill(1),wave:Array(80).fill(.9)}));
});
test('reduced motion freezes clock, acoustic deformation and event bursts',()=>{
 for(const scene of ['gravity','neon','spectrum','aurora']){
  const base={scene,reduced:true,inputValid:true,motion:'launch'};
  assert.equal(record({...base,time:2,eventAge:.1,themeAge:.1}),record({...base,time:80,eventAge:5,themeAge:5,energy:1,spectrum:Array(24).fill(1),wave:Array(80).fill(.9)}));
 }
});
test('pause does not respond to incoming sound or replay motion bursts',()=>{
 for(const scene of ['gravity','neon','spectrum','aurora']){
  const base={scene,paused:true,inputValid:true,motion:'launch'};
  assert.equal(record({...base,eventAge:.1}),record({...base,eventAge:3,energy:1,spectrum:Array(24).fill(1)}));
 }
});
