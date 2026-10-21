/* 2D comic look for the 3D bike (non-photorealistic post pass).
 * The scene still renders with its real materials (paint, masked panda livery),
 * then one full-screen pass turns it into cel bands, ink outlines, halftone shadows
 * and flat highlight blocks. Paint changes therefore stay live in 2D.
 */
import * as THREE from 'three';

export const COMIC_FRAGMENT = /* glsl */`
uniform sampler2D tColor; uniform sampler2D tDepth;
uniform vec2 uTexel; uniform float uNear, uFar, uDot, uInkWidth;
uniform vec3 uInk;
varying vec2 vUv;
float linDepth(vec2 uv){ float z=texture2D(tDepth,uv).x*2.-1.; return (2.*uNear*uFar)/(uFar+uNear-z*(uFar-uNear)); }
float luma(vec3 c){ return dot(c,vec3(.2126,.7152,.0722)); }
void main(){
  vec4 c=texture2D(tColor,vUv);
  float d0=linDepth(vUv), l0=luma(c.rgb);
  float depthEdge=0., colorEdge=0., alphaMax=c.a, alphaEdge=0.;
  // Ink: depth creases, colour boundaries and the silhouette against the HUD.
  for(int i=0;i<8;i++){
    float a=float(i)*.785398;
    vec2 o=vec2(cos(a),sin(a))*uTexel*uInkWidth;
    vec4 n=texture2D(tColor,vUv+o);
    float dn=linDepth(vUv+o);
    if(n.a>.5&&c.a>.5) depthEdge=max(depthEdge,abs(dn-d0)/max(d0,.001));
    colorEdge=max(colorEdge,abs(luma(n.rgb)-l0));
    alphaMax=max(alphaMax,n.a);
    alphaEdge=max(alphaEdge,abs(n.a-c.a));
  }
  float edge=max(max(smoothstep(.015,.05,depthEdge),smoothstep(.18,.38,colorEdge)*step(.5,c.a)),smoothstep(.15,.5,alphaEdge));
  // Cel bands keep the hue (so the livery colour survives) and flatten the light.
  // Bands are chosen in perceptual (gamma) space, then applied in linear light.
  float lp=pow(max(l0,0.),1./2.2);
  float bandP=lp<.14?.07:lp<.38?.3:lp<.66?.6:.93;
  vec3 col=c.rgb*(pow(bandP,2.2)/max(l0,.002));
  col=min(col,vec3(1.6));
  // Flat highlight blocks.
  col=mix(col,vec3(1.,.98,.94),step(.8,lp)*.6);
  // Halftone dots in the shadow side, screen-space and rotated 45°.
  vec2 g=mat2(.7071,-.7071,.7071,.7071)*gl_FragCoord.xy/uDot;
  float dotR=length(fract(g)-.5);
  float shade=1.-smoothstep(.12,.42,lp);
  col*=1.-.55*step(dotR,shade*.48)*step(.5,c.a);
  float a=max(c.a,edge*step(.01,alphaMax));
  col=mix(col,uInk,edge);
  gl_FragColor=vec4(col,a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createComicPass(renderer) {
  const target = new THREE.WebGLRenderTarget(2, 2, {type: THREE.HalfFloatType, depthBuffer: true});
  target.depthTexture = new THREE.DepthTexture(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {tColor: {value: target.texture}, tDepth: {value: target.depthTexture}, uTexel: {value: new THREE.Vector2(.5, .5)},
      uNear: {value: .1}, uFar: {value: 100}, uDot: {value: 5}, uInkWidth: {value: 2.2}, uInk: {value: new THREE.Color(0x07080d)}},
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }',
    fragmentShader: COMIC_FRAGMENT,
    transparent: true, depthTest: false, depthWrite: false, toneMapped: true,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const postScene = new THREE.Scene(); postScene.add(quad);
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const size = new THREE.Vector2();
  function render(scene, camera) {
    renderer.getDrawingBufferSize(size);
    if (target.width !== size.x || target.height !== size.y) {
      target.setSize(size.x, size.y);
      material.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
      material.uniforms.uDot.value = 4.5 * renderer.getPixelRatio();
      material.uniforms.uInkWidth.value = 1.6 * renderer.getPixelRatio();
    }
    material.uniforms.uNear.value = camera.near; material.uniforms.uFar.value = camera.far;
    renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, camera);
    renderer.setRenderTarget(null); renderer.clear(); renderer.render(postScene, postCamera);
  }
  function dispose() { target.dispose(); target.depthTexture?.dispose(); material.dispose(); quad.geometry.dispose(); }
  return {render, dispose};
}
