/* Motuo game world: one full-screen procedural WebGL shader behind the HUD.
 * Five worlds (daily light waves + four sport themes). Visual only: inputs are the
 * page's already-validated readings, mapped by worldParams(); nothing is read back.
 */
(function (global) {
  'use strict';
  const THEMES = Object.freeze({daily: 0, gravity: 1, neon: 2, spectrum: 3, aurora: 4});
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));

  // Pure mapping from page state to shader inputs; unknown readings become calm, not fake.
  function worldParams({mode = 'daily', scene = 'gravity', speedKmh = null, accel = null, energy = 0, soundValid = false, turning = false, active = false, intensity = 1, reduced = false} = {}) {
    const speed = Number.isFinite(speedKmh) && active ? clamp(speedKmh / 110) : 0;
    const a = Number.isFinite(accel) && active ? clamp(accel / 2, -1, 1) : 0;
    return {
      theme: mode === 'sport' ? (THEMES[scene] ?? 1) : 0,
      speed, accel: a,
      energy: soundValid ? clamp(energy) : 0,
      turn: turning && active ? 1 : 0,
      // Travel rate: idle drift even at rest, then strongly super-linear toward "warp".
      rate: reduced ? 0 : .35 + speed * speed * 6 * intensity + speed * 1.5,
      ca: reduced ? 0 : clamp((Math.abs(a) * 1.4 + speed * .6) * intensity, 0, 1.4),
      intensity: reduced ? .35 : intensity,
    };
  }

  const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FRAG = `precision mediump float;
uniform vec2 uRes;uniform float uTime,uTravel,uSpeed,uAccel,uEnergy,uTurn,uWarp,uFlash,uTheme,uInt,uSat,uReveal,uCA;
float h1(float n){return fract(sin(n*127.1)*43758.5453);}
float h2(vec2 p){return fract(sin(dot(p,vec2(41.3,289.1)))*45758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h2(i),h2(i+vec2(1,0)),f.x),mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
float line(float x,float w){return exp(-abs(x)/w);}
vec3 tunnel(vec2 p,float z0,float sides,vec3 ca,vec3 cb){
  float r=length(p),a=atan(p.y,p.x);
  float hexr=r;
  if(sides>0.){float s=6.2831/sides;float aa=mod(a+s*.5,s)-s*.5;hexr=r*cos(aa)/cos(s*.5);}
  float z=.32/max(hexr,.02)+z0;
  float ring=line(fract(z*1.6)-.5,.035+.02*uEnergy);
  float rib=line(fract(a/6.2831*24.+z*.05)-.5,.02);
  float cell=step(.5,fract(floor(z*1.6)*.5));
  vec3 c=mix(ca,cb,cell)*ring*(1.5+uEnergy*2.)+mix(cb,ca,cell)*rib*.55;
  float streak=step(.93-uSpeed*.25,h1(floor(a*48.)))*line(fract(z*.45+h1(floor(a*48.)*3.1))-.5,.06+uSpeed*.25);
  c+=vec3(.85,.95,1.)*streak*(.25+uSpeed*1.8);
  float fog=smoothstep(.0,.55,hexr);
  return c*fog+cb*.05*(1.-fog)*(1.+uSpeed*6.);
}
vec3 highway(vec2 p,float z0){
  vec3 c;
  if(p.y>-.02){
    float y=p.y;vec3 sky=mix(vec3(1.,.42,.18),vec3(.16,.04,.22),smoothstep(0.,.55,y));
    float sun=smoothstep(.23,.22,length(p-vec2(0.,.12)));sun*=step(.5,fract((p.y-.12)*28.+uTime*.6))*.6+.4;
    float mount=step(y,.05+.07*noise(vec2(p.x*4.+uTravel*.02,1.)))*.85;
    c=sky+vec3(1.,.75,.3)*sun*(1.-mount);c=mix(c,vec3(.08,.02,.08),mount);
    float rays=pow(max(0.,cos(atan(p.x,y-.12)*14.+uTime*.4)),18.)*smoothstep(.9,.0,y)*(.2+uEnergy);
    c+=vec3(1.,.6,.25)*rays*.35;
  }else{
    float d=-p.y,z=.18/d,x=p.x*z;
    float gz=line(fract(z+z0)-.5,.05*z),gx=line(fract(x*1.2)-.5,.025*z);
    float road=step(abs(x),.9),lane=line(abs(x)-.0,.02*z)*step(.5,fract(z*2.+z0*2.));
    c=vec3(1.,.45,.15)*(gz+gx)*(.9+uEnergy)*exp(-d*1.2)+vec3(1.,.85,.5)*lane*road*1.4;
    c+=vec3(.12,.03,.05)*road;
    c*=smoothstep(.0,.06,d);c+=vec3(1.,.4,.2)*exp(-d*30.)*.8;
  }
  return c;
}
vec3 aurora(vec2 p,float z0){
  vec3 c=vec3(.02,.0,.06);
  if(p.y>-.02){
    for(int i=0;i<3;i++){float fi=float(i);
      float band=p.y-.15-fi*.11-.06*sin(p.x*3.+uTime*.5+fi*2.)-.05*fbm(vec2(p.x*2.+uTime*.1,fi));
      c+=mix(vec3(.75,.3,1.),vec3(1.,.35,.8),fi*.5)*line(band,.03+.02*uEnergy)*(.45+uEnergy*.8);}
    float city=step(p.y,.06*step(.4,h1(floor(p.x*22.)))+.03*h1(floor(p.x*40.)));
    c=mix(c,vec3(.03,.0,.07)+vec3(.9,.6,1.)*step(.82,h2(floor(p*vec2(160.,90.))))*.6,city);
  }else{
    float d=-p.y,z=.16/d,x=p.x*z;
    c+=vec3(.7,.25,1.)*line(fract(z+z0)-.5,.04*z)*exp(-d*1.3)*.9;
    float side=abs(x)-1.3;float pillar=step(0.,side)*line(fract(z*.7+z0*.7)-.5,.04*z)*exp(-d);
    c+=vec3(1.,.4,.9)*pillar*2.;
    c+=vec3(.5,.2,.9)*line(abs(x)-.05,.03*z)*step(.5,fract(z*2.+z0*2.));
  }
  float beam=pow(max(0.,1.-abs(fract(p.x*1.5+uTime*.05)-.5)*8.),3.)*smoothstep(-.1,.8,p.y);
  return c+vec3(.8,.4,1.)*beam*(.15+uSpeed*.5);
}
vec3 waves(vec2 p){
  vec2 q=p*1.6;float t=uTime*(.25+uSpeed*.8);
  vec2 w=vec2(fbm(q+vec2(t,0.)),fbm(q+vec2(0.,t*.8)+3.));
  float f=fbm(q+w*(1.6+uEnergy*2.+uSpeed)+vec2(t*.5,-t*.3));
  float crest=line(fract(f*5.+t*.4)-.5,.05+.06*uEnergy);
  vec3 c=mix(vec3(.02,.05,.16),vec3(.1,.35,.95),smoothstep(.3,.8,f));
  c+=vec3(.55,.85,1.)*crest*(.35+uSpeed*.9+uEnergy*.8)*smoothstep(-.6,.3,-p.y+.2);
  c+=vec3(.5,.35,1.)*pow(f,4.)*(.6+uEnergy);
  return c;
}
vec3 scene(vec2 p,float z0){
  if(uTheme<.5)return waves(p);
  if(uTheme<1.5)return tunnel(p,z0,0.,vec3(.25,.9,1.),vec3(1.,.25,.95));
  if(uTheme<2.5)return highway(p,z0);
  if(uTheme<3.5)return tunnel(p,z0,6.,vec3(.55,.95,1.),vec3(.35,.45,1.));
  return aurora(p,z0);
}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;vec2 p=(gl_FragCoord.xy-uRes*vec2(.5,.56))/uRes.y;
  p.x+=uTurn*.12*(p.y+.4);p=mat2(cos(uTurn*.08),-sin(uTurn*.08),sin(uTurn*.08),cos(uTurn*.08))*p;
  float warp=uWarp+uSpeed*uSpeed*.6;
  vec2 pz=p*(1.-warp*.18);
  vec3 c;
  if(uTheme<.5){c=waves(pz);}else{
    float ca=uCA*.012+warp*.006,blur=.06*(uSpeed+uWarp)*uInt;
    // Depth blur and chromatic split: three samples along the travel axis.
    c=vec3(scene(pz*(1.+ca),uTravel+blur).r,scene(pz,uTravel).g,scene(pz*(1.-ca),uTravel-blur).b);
    c+=scene(pz,uTravel+blur*2.)*.35;c/=1.2;
  }
  float r=length(p);
  float streaks=uTheme<.5?0.:pow(h1(floor(atan(p.y,p.x)*90.)),40.)*smoothstep(.15,.9,r)*(uSpeed*1.5+uWarp*2.);
  c+=vec3(.9,.97,1.)*streaks;
  c=c/(1.+c*.45)*1.25;
  float l=dot(c,vec3(.3,.59,.11));c=mix(vec3(l),c,uSat);
  float vig=smoothstep(1.25,.25+.08*sin(uTime*1.7)*uInt,r*(1.+abs(uAccel)*.5));
  c*=mix(1.,vig,.85);
  c*=.92+.08*step(.5,fract(gl_FragCoord.y*.5));
  c+=vec3(1.)*uFlash*.75;
  float iris=smoothstep(uReveal,uReveal-.04,r);c*=iris;c+=vec3(.6,.95,1.)*line(r-uReveal,.01)*step(uReveal,1.6)*1.5;
  gl_FragColor=vec4(c,1.);
}`;

  function create(canvas, {scaleFor = () => .75} = {}) {
    let gl = null, prog = null, loc = {}, lost = false, w = 0, h = 0;
    const state = {travel: 0, time: 0, warp: 0, flash: 0, sat: 1, reveal: 2, params: worldParams()};
    function init() {
      try { gl = canvas.getContext('webgl', {antialias: false, alpha: false, premultipliedAlpha: false, powerPreference: 'high-performance'}); } catch { gl = null; }
      if (!gl) return false;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const at = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      for (const n of ['uRes', 'uTime', 'uTravel', 'uSpeed', 'uAccel', 'uEnergy', 'uTurn', 'uWarp', 'uFlash', 'uTheme', 'uInt', 'uSat', 'uReveal', 'uCA']) loc[n] = gl.getUniformLocation(prog, n);
      return true;
    }
    let ok = false;
    try { ok = init(); } catch (error) { ok = false; global.console?.warn?.('[motuo] world shader unavailable', error?.message); }
    canvas.addEventListener?.('webglcontextlost', e => { e.preventDefault(); lost = true; });
    canvas.addEventListener?.('webglcontextrestored', () => { lost = false; try { ok = init(); } catch { ok = false; } });
    function size() {
      const r = canvas.getBoundingClientRect(), s = scaleFor();
      const nw = Math.max(2, Math.round(r.width * s)), nh = Math.max(2, Math.round(r.height * s));
      if (nw !== w || nh !== h) { w = nw; h = nh; canvas.width = w; canvas.height = h; }
    }
    // dtScaled carries bullet time (0 frozen, negative rewinds); data clocks never use it.
    function frame(dtScaled, params) {
      state.params = params;
      state.time += dtScaled;
      state.travel += dtScaled * params.rate;
      if (!ok || lost || !gl) return false;
      size();
      gl.viewport(0, 0, w, h);
      const P = params, u = (n, v) => gl.uniform1f(loc[n], v);
      gl.uniform2f(loc.uRes, w, h);
      u('uTime', state.time); u('uTravel', state.travel); u('uSpeed', P.speed); u('uAccel', P.accel); u('uEnergy', P.energy);
      u('uTurn', P.turn); u('uWarp', state.warp); u('uFlash', state.flash); u('uTheme', P.theme); u('uInt', P.intensity);
      u('uSat', state.sat); u('uReveal', state.reveal); u('uCA', P.ca);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    }
    return {frame, state, get ok() { return ok && !lost; }, size,
      dispose() { gl?.getExtension('WEBGL_lose_context')?.loseContext(); ok = false; }};
  }
  global.MotuoWorld = Object.freeze({create, worldParams, THEMES, FRAG});
})(typeof window !== 'undefined' ? window : globalThis);
