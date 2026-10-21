/* 主角：大尺寸 2D 漫画摩托。
 * GLB（GSX-R1000 近似外观）用正交侧视相机实时渲染 + 漫画后期，12fps 步进（“一拍二”）；
 * 车轮转动用模型自带的前/后轮轴节点。GLB 未就绪或失败时显示 2D 矢量漫画车，绝不白屏。
 * 姿态（抬头、点头、甩尾、冲刺）全部是装饰，不输出任何数值。
 */
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createMaskedPaint} from '../shared/vehicle-paint.js';
import {disposeTree} from '../shared/vehicle-resources.js';
import {createComicPass, createAlbedoMaterial} from './comic-pass.js';
import {drawVectorBike, BIKE_POINTS} from './bike-vector.js';
import {bikeMapping} from '../core/layout.js';

export {BIKE_POINTS};
const HALF = 1.05; // 模型展示长度 2.1 的一半

export {bikeMapping};

// 绕接地点俯仰：负角 = 抬头（绕后轮），正角 = 点头（绕前轮）。
export function pitchOffset(theta) {
  const pz = theta < 0 ? BIKE_POINTS.rearContact[2] : BIKE_POINTS.frontContact[2];
  return {y: pz * Math.sin(theta), z: pz - pz * Math.cos(theta)};
}

export function createBike({glCanvas, vecCanvas, modelURL, onStatus = () => {}}) {
  const pose = {pitch: 0, yaw: 0, dz: 0, dy: 0, squash: 1, shake: 0, impact: 0};
  const appearance = {bodyColor: '#f2f1ec', accentColor: '#171b22', finish: 'gloss'};
  let mode = 'vector', L = null, cssW = 1, cssH = 1, dpr = 1, wheelAngle = 0;
  let renderer = null, comic = null, scene = null, camera = null, root = null, yawG = null, pitchG = null, model = null;
  let front = null, rear = null, envTarget = null, disposed = false;
  const painted = new Map();
  // 两遍材质：albedo（颜色）与 light（干净明暗）；pbr 保留原材质以便需要时恢复。
  const meshes = [], paintUniforms = {motuoBodyColor: {value: null}, motuoAccentColor: {value: null}};
  let lightMat = null;
  const passes = {albedo: () => { for (const m of meshes) m.mesh.material = m.albedo; }, light: () => { for (const m of meshes) m.mesh.material = m.light; }};
  const v2 = vecCanvas.getContext('2d');

  function status(s, msg, extra = {}) { try { onStatus({status: s, message: msg, ...extra}); } catch { /* 观察者错误不影响渲染 */ } }

  function layout(nextL, w, h, pixelRatio) {
    L = nextL; cssW = w; cssH = h; dpr = pixelRatio;
    for (const c of [glCanvas, vecCanvas]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px'; }
    if (renderer) { renderer.setPixelRatio(dpr); renderer.setSize(w, h, false); fitCamera(camera, L, w, h); }
  }
  function fitCamera(cam, lay, w, h) {
    const m = bikeMapping(lay);
    cam.left = (0 - lay.bike.rearX) / m.ppu - HALF; cam.right = (w - lay.bike.rearX) / m.ppu - HALF;
    cam.top = lay.bike.ground / m.ppu; cam.bottom = -(h - lay.bike.ground) / m.ppu;
    cam.updateProjectionMatrix();
  }
  function applyPose(p = pose) {
    if (!root) return;
    const off = pitchOffset(p.pitch);
    pitchG.rotation.x = p.pitch; pitchG.position.set(0, off.y, off.z);
    yawG.rotation.y = p.yaw;
    const jitter = p.shake ? (Math.random() - .5) * p.shake * .02 : 0;
    root.position.set(0, p.dy + Math.abs(jitter) * .5, p.dz + jitter);
    root.scale.set(1, 1 / Math.sqrt(p.squash), p.squash);
  }
  function setPaint(next = {}) {
    Object.assign(appearance, next);
    for (const pp of painted.values()) pp.update(appearance);
    paintUniforms.motuoBodyColor.value?.set(appearance.bodyColor);
    paintUniforms.motuoAccentColor.value?.set(appearance.accentColor);
    // 亮面：高光点小而亮；缎面：高光更宽更弱。
    if (lightMat) { lightMat.shininess = appearance.finish === 'satin' ? 6 : 48; lightMat.specular.set(appearance.finish === 'satin' ? '#262626' : '#5a5a5a'); }
  }
  function spin(rad) { wheelAngle = (wheelAngle + rad) % (Math.PI * 2); }

  function render() {
    if (disposed || !L) return;
    if (mode === 'glb') {
      applyPose();
      front.rotation.x = rear.rotation.x = wheelAngle;
      comic.render(scene, camera, passes, {impact: pose.impact});
    } else {
      v2.setTransform(dpr, 0, 0, dpr, 0, 0);
      v2.clearRect(0, 0, cssW, cssH);
      drawVectorBike(v2, bikeMapping(L), pose, appearance, wheelAngle);
    }
  }

  // 已知车体点在当前姿态下的屏幕坐标（CSS px），供烟、火焰、火花、轮速圈定位。
  const tmp = new THREE.Vector3();
  function point(name) {
    const p = BIKE_POINTS[name]; if (!p || !L) return {x: 0, y: 0};
    const m = bikeMapping(L);
    if (mode === 'glb' && root) {
      applyPose(); root.updateMatrixWorld(true);
      tmp.set(p[0], p[1], p[2]).applyMatrix4(pitchG.matrixWorld);
      return {x: m.sx(tmp.z), y: m.sy(tmp.y)};
    }
    // 矢量车：同样的俯仰 + 冲刺偏移（甩尾以水平压缩近似）。
    const off = pitchOffset(pose.pitch), c = Math.cos(pose.pitch), s = Math.sin(pose.pitch);
    const y = p[1] * c - p[2] * s + off.y + pose.dy, z = (p[1] * s + p[2] * c + off.z) * Math.cos(pose.yaw) + pose.dz;
    return {x: m.sx(z), y: m.sy(y)};
  }

  /* 漫画页用：按给定版式与姿态重绘一张车（2D canvas 拷贝）。 */
  function snapshot(w, h, lay, p = pose) {
    const out = document.createElement('canvas');
    out.width = Math.round(w); out.height = Math.round(h);
    const g = out.getContext('2d');
    if (mode === 'glb') {
      const prevSize = new THREE.Vector2(); renderer.getSize(prevSize);
      const prevRatio = renderer.getPixelRatio();
      renderer.setPixelRatio(1); renderer.setSize(w, h, false);
      fitCamera(camera, lay, w, h);
      applyPose(p); front.rotation.x = rear.rotation.x = wheelAngle;
      comic.render(scene, camera, passes, {impact: 0});
      g.drawImage(glCanvas, 0, 0, w, h);
      renderer.setPixelRatio(prevRatio); renderer.setSize(prevSize.x, prevSize.y, false);
      fitCamera(camera, L, cssW, cssH); applyPose(pose);
    } else {
      drawVectorBike(g, bikeMapping(lay), p, appearance, wheelAngle);
    }
    return out;
  }

  async function init() {
    status('loading', '正在装载漫画摩托…');
    try {
      renderer = new THREE.WebGLRenderer({canvas: glCanvas, alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance'});
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      comic = createComicPass(renderer);
      scene = new THREE.Scene();
      camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 30);
      camera.position.set(-10, 0, 0); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);
      // 光照遍只用于明暗分阶：主光从镜头侧上前方打来，补光很弱，阴影面清楚。
      scene.add(new THREE.HemisphereLight('#ffffff', '#202020', 1.1));
      const key = new THREE.DirectionalLight('#ffffff', 3.2); key.position.set(-4, 6, 3); scene.add(key);
      const rim = new THREE.DirectionalLight('#ffffff', .8); rim.position.set(2, 2, -5); scene.add(rim);
      lightMat = new THREE.MeshPhongMaterial({color: '#ffffff', specular: '#5a5a5a', shininess: 48});
      paintUniforms.motuoBodyColor.value = new THREE.Color(); paintUniforms.motuoAccentColor.value = new THREE.Color();
      root = new THREE.Group(); yawG = new THREE.Group(); pitchG = new THREE.Group();
      root.add(yawG); yawG.add(pitchG); scene.add(root);
      if (L) { renderer.setPixelRatio(dpr); renderer.setSize(cssW, cssH, false); fitCamera(camera, L, cssW, cssH); }
      const res = await fetch(new URL(modelURL, document.baseURI));
      if (!res.ok) throw new Error(`模型请求失败（HTTP ${res.status}）`);
      const gltf = await new GLTFLoader().parseAsync(await res.arrayBuffer(), new URL('.', new URL(modelURL, document.baseURI)).href);
      if (disposed) { disposeTree(gltf.scene); return; }
      model = gltf.scene;
      model.traverse(o => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const next = mats.map(mat => {
          const role = mat.userData?.vehicleRole ?? o.userData?.vehicleRole;
          if (role !== 'paint-mask' || !mat.map) return mat;
          if (!painted.has(mat)) painted.set(mat, createMaskedPaint(THREE, mat));
          return painted.get(mat).material;
        });
        o.material = Array.isArray(o.material) ? next : next[0];
        const src = Array.isArray(o.material) ? o.material[0] : o.material;
        const isPaint = (mats[0].userData?.vehicleRole ?? o.userData?.vehicleRole) === 'paint-mask' && !!mats[0].map;
        meshes.push({mesh: o, pbr: o.material, albedo: createAlbedoMaterial(isPaint ? mats[0] : src, isPaint ? paintUniforms : null), light: lightMat});
      });
      front = model.getObjectByName('front-wheel-pivot'); rear = model.getObjectByName('rear-wheel-pivot');
      if (!front || !rear) throw new Error('模型缺少车轮轴节点');
      pitchG.add(model);
      setPaint(appearance);
      mode = 'glb';
      glCanvas.hidden = false; vecCanvas.hidden = true;
      glCanvas.dataset.mode = 'glb';
      status('ready', 'GLB 漫画渲染就绪', {masks: painted.size});
    } catch (error) {
      mode = 'vector'; glCanvas.hidden = true; vecCanvas.hidden = false;
      status('fallback', `已改用 2D 矢量漫画车：${error?.message || error}`);
    }
  }
  // GLB 未就绪时两张画布都不显示（页面显示 LOADING 卡片）；8s 仍未就绪才先用矢量车顶上，失败则立即回退。
  glCanvas.hidden = true; vecCanvas.hidden = true;
  setTimeout(() => { if (mode !== 'glb' && !disposed) vecCanvas.hidden = false; }, 8000);
  const ready = init();
  return {
    ready, layout, render, setPaint, spin, point, snapshot, pose,
    get mode() { return mode; }, get appearance() { return {...appearance}; },
    dispose() { disposed = true; for (const m of meshes) { m.albedo.dispose(); m.mesh.material = m.pbr; } lightMat?.dispose(); if (model) disposeTree(model, [...painted.values()].map(p => p.material)); envTarget?.dispose(); comic?.dispose(); renderer?.dispose(); },
  };
}
