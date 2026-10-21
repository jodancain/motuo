/* 干净的漫画着色（v3 第二版）：两遍渲染 + 一次合成。
 *  1) 反照率遍：每个网格换成无光照材质（原贴图；熊猫遮罩处直接输出平涂的主色/辅色），得到“颜色”。
 *  2) 光照遍：所有网格换成同一个白色 Phong（无贴图、无法线贴图），得到干净的“明暗”。
 *  3) 合成：明暗量化成 暗 / 中 / 高光 三阶；暗部用规则 45° Ben-Day 网点，高光为平涂纸色块；
 *     墨线取自深度、轮廓、光照折痕和强颜色边界——贴图细节不会进入色阶，也不再经 AgX 压灰。
 * v2 vehicle-comic.js 的单遍版直接对 PBR 结果量化，贴图与法线噪点会变成斑驳色块，故在 v3 替换。 */
import * as THREE from 'three';

export const COMIC_FRAGMENT = /* glsl */`
uniform sampler2D tAlbedo; uniform sampler2D tLight; uniform sampler2D tDepth;
uniform vec2 uTexel; uniform float uNear, uFar, uDot, uInkWidth, uImpact, uShadow, uHigh;
uniform vec3 uInk; uniform vec3 uPaper;
varying vec2 vUv;
float linDepth(vec2 uv){ return uNear + texture2D(tDepth,uv).x*(uFar-uNear); }
float luma(vec3 c){ return dot(c,vec3(.2126,.7152,.0722)); }
void main(){
  vec4 a0=texture2D(tAlbedo,vUv);
  // 轻度模糊反照率：去掉贴图高频噪点，保留贴花与分色。
  vec2 t=uTexel*1.5;
  vec3 alb=(a0.rgb*2.+texture2D(tAlbedo,vUv+vec2(t.x,0.)).rgb+texture2D(tAlbedo,vUv-vec2(t.x,0.)).rgb+texture2D(tAlbedo,vUv+vec2(0.,t.y)).rgb+texture2D(tAlbedo,vUv-vec2(0.,t.y)).rgb)/6.;
  float L=luma(texture2D(tLight,vUv).rgb);
  float d0=linDepth(vUv), la0=luma(a0.rgb);
  float depthEdge=0., lightEdge=0., albEdge=0., alphaEdge=0., alphaMax=a0.a;
  for(int i=0;i<8;i++){
    float ang=float(i)*.785398;
    vec2 o=vec2(cos(ang),sin(ang))*uTexel*uInkWidth;
    vec4 n=texture2D(tAlbedo,vUv+o);
    alphaMax=max(alphaMax,n.a); alphaEdge=max(alphaEdge,abs(n.a-a0.a));
    if(n.a>.5&&a0.a>.5){
      depthEdge=max(depthEdge,abs(linDepth(vUv+o)-d0));
      lightEdge=max(lightEdge,abs(luma(texture2D(tLight,vUv+o).rgb)-L));
      albEdge=max(albEdge,abs(luma(n.rgb)-la0));
    }
  }
  float edge=max(max(smoothstep(.025,.06,depthEdge),smoothstep(.12,.45,alphaEdge)),
                 max(smoothstep(.55,.8,lightEdge),smoothstep(.32,.5,albEdge)));
  // 三阶：暗 / 中 / 高光
  float sh=1.-step(uShadow,L), hi=step(uHigh,L);
  vec3 col=alb*mix(1.,.64,sh);
  vec2 g=mat2(.7071,-.7071,.7071,.7071)*gl_FragCoord.xy/uDot;
  float dotMask=step(length(fract(g)-.5),.3);
  col=mix(col,col*.42,sh*dotMask);
  col=mix(col,mix(col,uPaper,.62),hi);
  col=mix(col,uInk,edge);
  float bw=step(uShadow,L);
  col=mix(col,mix(uInk,uPaper,bw*(1.-edge)),uImpact);
  gl_FragColor=vec4(col,max(a0.a,edge*step(.01,alphaMax)));
  #include <colorspace_fragment>
}`;

export function createComicPass(renderer) {
  const opts = {type: THREE.HalfFloatType, depthBuffer: true};
  const albedo = new THREE.WebGLRenderTarget(2, 2, opts), light = new THREE.WebGLRenderTarget(2, 2, opts);
  albedo.depthTexture = new THREE.DepthTexture(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {tAlbedo: {value: albedo.texture}, tLight: {value: light.texture}, tDepth: {value: albedo.depthTexture},
      uTexel: {value: new THREE.Vector2(.5, .5)}, uNear: {value: .1}, uFar: {value: 100}, uDot: {value: 5}, uInkWidth: {value: 2},
      uImpact: {value: 0}, uShadow: {value: .42}, uHigh: {value: 1.18},
      uInk: {value: new THREE.Color(0x0b0a12)}, uPaper: {value: new THREE.Color(0xfff8ea)}},
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }',
    fragmentShader: COMIC_FRAGMENT, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene(); postScene.add(quad);
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2();
  /* passes.albedo() / passes.light() 负责把网格切换到对应材质。 */
  function render(scene, camera, passes, {impact = 0} = {}) {
    renderer.getDrawingBufferSize(size);
    for (const t of [albedo, light]) if (t.width !== size.x || t.height !== size.y) t.setSize(size.x, size.y);
    material.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    const pr = renderer.getPixelRatio();
    material.uniforms.uDot.value = 5.5 * pr; material.uniforms.uInkWidth.value = 1.7 * pr;
    material.uniforms.uNear.value = camera.near; material.uniforms.uFar.value = camera.far;
    material.uniforms.uImpact.value = impact;
    passes.albedo(); renderer.setRenderTarget(albedo); renderer.clear(); renderer.render(scene, camera);
    passes.light(); renderer.setRenderTarget(light); renderer.clear(); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.clear(); renderer.render(postScene, postCamera);
  }
  function dispose() { albedo.dispose(); light.dispose(); albedo.depthTexture?.dispose(); material.dispose(); quad.geometry.dispose(); }
  return {render, dispose, uniforms: material.uniforms};
}

/* 反照率材质：原贴图无光照；熊猫遮罩（与 shared/vehicle-paint.js 同一判定）处输出平涂车漆色，
 * 不再乘以贴图里的烘焙明暗，避免白车被压成灰色斑块。 */
export function createAlbedoMaterial(original, paintUniforms = null) {
  const m = new THREE.MeshBasicMaterial({map: original.map || null, color: original.color ? original.color.clone() : new THREE.Color('#fff'),
    transparent: !!original.transparent, opacity: original.opacity ?? 1, side: original.side ?? THREE.FrontSide, alphaTest: original.alphaTest || 0});
  if (paintUniforms) {
    m.color.set('#ffffff');
    m.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, paintUniforms);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform vec3 motuoBodyColor; uniform vec3 motuoAccentColor;`).replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  vec3 pigment = sampledDiffuseColor.rgb;
  float blueShare = pigment.b / max(pigment.r + pigment.g + pigment.b, 0.0001);
  float paintMask = smoothstep(0.47, 0.62, blueShare) * smoothstep(0.004, 0.024, pigment.b);
  float detailMask = smoothstep(0.64, 0.68, fract(vMapUv.y));
  vec3 paintColor = mix(motuoBodyColor, motuoAccentColor, detailMask);
  // v3 漫画平涂扩展（仅 2D 漫画渲染；v2 写实遮罩不变）：同一车壳贴图上，
  // 亮的中性色（白/银整流罩）也取主色，黑色件保持黑色，让整车配色一眼可辨。
  float lum = dot(pigment, vec3(.2126,.7152,.0722));
  float sat = max(max(pigment.r,pigment.g),pigment.b) - min(min(pigment.r,pigment.g),pigment.b);
  float neutral = 1. - smoothstep(.06, .14, sat);
  // 贴图值为线性空间：银色整流罩约 0.03–0.4，黑色机械件 < 0.02（保持原样，即熊猫的黑）。
  float fairing = neutral * smoothstep(.03, .07, lum) * (1. - paintMask);
  vec3 c = mix(diffuseColor.rgb, paintColor, paintMask);
  c = mix(c, motuoBodyColor * (.92 + .08 * smoothstep(.07, .4, lum)), fairing);
  diffuseColor.rgb = c;
#endif`);
    };
    m.customProgramCacheKey = () => 'motuo-v3-albedo-paint';
  }
  return m;
}
