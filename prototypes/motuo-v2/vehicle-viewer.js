import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createMaskedPaint } from './vehicle-paint.js?v=suzuki-20260920';
import { disposeTree } from './vehicle-resources.js';
import { createComicPass } from './vehicle-comic.js';

// A real mesh viewer. Its presentation animation never consumes vehicle telemetry.
export function createVehicleViewer({ host, modelURL, onStatus = () => {} }) {
  if (!host?.appendChild) throw new TypeError('Vehicle viewer requires a DOM host.');
  const canvas = document.createElement('canvas');
  canvas.className = 'vehicle-webgl-canvas';
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none';
  canvas.setAttribute('aria-label', '三维摩托车；拖动旋转，滚轮或双指缩放');
  canvas.tabIndex = 0;
  canvas.dataset.state = canvas.dataset.renderState = 'loading';
  canvas.dataset.yaw = '0';
  canvas.dataset.paint = 'unavailable';
  canvas.dataset.frame = '0';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 60);
  const vehicle = new THREE.Group();
  vehicle.name = 'MotuoVehiclePresentation';
  scene.add(vehicle);
  const abort = new AbortController();
  const editable = { paint: new Set(), accent: new Set() };
  const maskedPaint = new Map();
  const sourceMaterials = new Set();
  const appearance = { bodyColor: '#ecece7', accentColor: '#171a1d', finish: 'gloss' };
  const focus = new THREE.Vector3(0, 0.55, 0);
  const size = new THREE.Vector3(1, 1, 2.1);
  const fitPoints = [];
  const orbitFits = new Map();
  let currentHost = null;
  let renderer = null;
  let controls = null;
  let environmentTarget = null;
  let contact = null;
  let floor = null;
  let frameRequest = 0;
  // '2d' = comic post pass (default), '3d' = the original PBR look.
  let renderStyle = '2d', comic = null;
  // Render on the page's shared motion clock when present: one rAF for the HUD and 3D.
  const frameClock = globalThis.MotuoMotion?.sharedClock?.() || null;
  let lastFrame = 0;
  let frameCount = 0;
  let sizeKey = '';
  let active = true;
  let interactive = true;
  let autoRotate = false;
  let dragging = false;
  let interactionUntil = 0;
  let loaded = false;
  let disposed = false;
  let failed = false;
  let contextLost = false;
  let departure = null;
  let currentView = 'hero';
  let meshCount = 0;
  let fittedVisibleHost = false;
  let animationMixer = null;
  let wheelAction = null;
  const observer = new ResizeObserver(resize);

  function notify(status, message, details = {}) {
    if (disposed) return;
    try { onStatus({ status, message, ...details }); } catch { /* Observer errors must not break rendering. */ }
  }

  function updateReadback() {
    const state = disposed ? 'disposed' : failed || contextLost ? 'error' : !loaded ? 'loading' : departure ? 'departing' : active ? 'ready' : 'inactive';
    canvas.dataset.state = canvas.dataset.renderState = state;
    canvas.dataset.active = String(active);
    canvas.dataset.interactive = String(interactive);
    canvas.dataset.yaw = controls ? THREE.MathUtils.radToDeg(controls.getAzimuthalAngle()).toFixed(2) : '0';
    canvas.dataset.paint = editable.paint.size || maskedPaint.size ? appearance.bodyColor : 'unavailable';
    canvas.dataset.accent = editable.accent.size || maskedPaint.size ? appearance.accentColor : 'unavailable';
    canvas.dataset.finish = appearance.finish;
    canvas.dataset.paintMaterials = String(editable.paint.size + maskedPaint.size);
    canvas.dataset.accentMaterials = String(editable.accent.size + maskedPaint.size);
    canvas.dataset.paintMask = maskedPaint.size ? 'suzuki-blue-atlas-v1' : 'none';
    canvas.dataset.meshes = String(meshCount);
    canvas.dataset.frame = String(frameCount);
  }

  function canRender() {
    return !disposed && !failed && !contextLost && renderer && !document.hidden && (active || departure);
  }

  function wake() {
    if (!frameRequest && canRender()) frameRequest = frameClock ? frameClock.requestFrame(frame) : requestAnimationFrame(frame);
  }

  function cancelFrame() {
    if (frameRequest) { if (frameClock) frameClock.cancelFrame(frameRequest); else cancelAnimationFrame(frameRequest); }
    frameRequest = 0;
    lastFrame = 0;
  }

  function resize() {
    if (!renderer || disposed || !currentHost) return;
    const rect = currentHost.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const nextKey = `${width}:${height}:${dpr}`;
    const oldAspect = camera.aspect;
    if (nextKey === sizeKey && (!loaded || fittedVisibleHost)) return;
    if (nextKey !== sizeKey) {
      sizeKey = nextKey;
      if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    if (loaded && !fittedVisibleHost) {
      fittedVisibleHost = true;
      setView(currentView);
    } else if (loaded && !departure && Math.abs(camera.aspect - oldAspect) > 0.01) {
      // Preserve the chosen viewing direction and zoom relative to the fitted vehicle.
      // Never change framing while the shared canvas is in a departure transition.
      const offset = camera.position.clone().sub(controls.target);
      const direction = offset.clone().normalize();
      const oldFit = fitForView(direction, oldAspect);
      const newFit = fitForView(direction, camera.aspect);
      controls.maxDistance = Math.max(newFit * 2.3, 8);
      const distance = THREE.MathUtils.clamp(offset.length() * newFit / oldFit, controls.minDistance, controls.maxDistance);
      camera.position.copy(controls.target).add(offset.setLength(distance));
      controls.update();
    }
    wake();
  }

  function mount(nextHost) {
    if (disposed) return;
    if (!nextHost?.appendChild) throw new TypeError('Vehicle viewer requires a DOM host.');
    if (nextHost === currentHost && canvas.parentNode === nextHost) return;
    observer.disconnect();
    currentHost = nextHost;
    nextHost.appendChild(canvas);
    observer.observe(nextHost);
    resize();
    wake();
  }

  function controlsEnabled() {
    if (!controls) return;
    controls.enabled = active && interactive && loaded && !departure && !contextLost && !failed;
    controls.autoRotate = autoRotate && active && loaded && !departure;
  }

  function setActive(value) {
    if (disposed) return;
    active = !!value;
    controlsEnabled();
    updateReadback();
    if (active || departure) wake();
    else cancelFrame();
  }

  function setInteractive(value) {
    interactive = !!value;
    canvas.tabIndex = interactive ? 0 : -1;
    controlsEnabled();
    updateReadback();
  }

  function materialRole(material, mesh) {
    const explicit = material.userData?.vehicleRole ?? material.userData?.role ?? mesh.userData?.vehicleRole ?? mesh.userData?.role;
    if (typeof explicit === 'string') {
      if (explicit === 'paint-mask') return 'paint-mask';
      if (/^(paint|body|fairing|bodycolor)$/i.test(explicit)) return 'paint';
      if (/^(trim|accent|guard|accentcolor)$/i.test(explicit)) return 'accent';
      return null;
    }
    // The current CC0 asset supplies these exact roles, including wheel accent pieces.
    if (/^paint$/i.test(material.name)) return 'paint';
    if (/^(trim|accent)$/i.test(material.name)) return 'accent';
    if (/^(rubber|alloy|steel|glass|white)$/i.test(material.name)) return null;
    const name = `${material.name || ''} ${mesh.name || ''}`;
    // Unknown rubber, glass and mechanical surfaces retain their imported materials.
    if (/tire|tyre|rubber|glass|windscreen|brake|disc|chain|engine|seat|wheel|rim|light|exhaust/i.test(name)) return null;
    if (/trim|accent|guard|belly|under.?cowl|lower.?panel/i.test(name)) return 'accent';
    if (/paint|body|fairing|blue/i.test(name)) return 'paint';
    return null;
  }

  function setAppearance(next = {}) {
    if (disposed) return;
    for (const key of ['bodyColor', 'accentColor']) {
      if (typeof next[key] === 'string' && /^#[0-9a-f]{6}$/i.test(next[key])) appearance[key] = next[key].toLowerCase();
    }
    if (next.finish === 'satin' || next.finish === 'gloss') appearance.finish = next.finish;
    for (const paint of maskedPaint.values()) paint.update(appearance);
    for (const [role, materials] of Object.entries(editable)) {
      for (const material of materials) {
        material.color?.set(role === 'paint' ? appearance.bodyColor : appearance.accentColor);
        if (material.isMeshStandardMaterial) {
          material.metalness = role === 'paint' ? 0.18 : 0.12;
          material.roughness = appearance.finish === 'satin' ? 0.62 : role === 'paint' ? 0.24 : 0.38;
          if (material.isMeshPhysicalMaterial) {
            material.clearcoat = appearance.finish === 'satin' ? 0.2 : 0.9;
            material.clearcoatRoughness = appearance.finish === 'satin' ? 0.35 : 0.075;
          }
        }
      }
    }
    updateReadback();
    wake();
  }

  function setRenderStyle(style = '2d') {
    renderStyle = style === '3d' ? '3d' : '2d';
    canvas.dataset.renderStyle = comic ? renderStyle : '3d';
    interactionUntil = performance.now() + 120;
    wake();
  }

  function setAutoRotate(value) {
    const starting = !!value && !autoRotate;
    autoRotate = !!value;
    controlsEnabled();
    if (starting && loaded && controls && !departure) {
      const offset = camera.position.clone().sub(controls.target);
      const distance = Math.max(offset.length(), fitForView(offset.clone().normalize()));
      controls.maxDistance = Math.max(distance * 2.3, 8);
      camera.position.copy(controls.target).add(offset.setLength(distance));
      controls.update();
    }
    wake();
  }

  function fitForView(direction, aspect = camera.aspect) {
    if (!autoRotate || !fitPoints.length) return fitDistance(direction, aspect);
    const key = `${direction.y.toFixed(3)}:${aspect.toFixed(3)}`;
    if (orbitFits.has(key)) return orbitFits.get(key);
    const horizontal = Math.sqrt(Math.max(0, 1 - direction.y ** 2));
    const orbitDirection = new THREE.Vector3();
    let distance = 0;
    // A fixed orbit radius prevents camera pumping while keeping mirrors and
    // wheels inside the frame throughout a full turn. Cache on aspect/elevation.
    for (let degree = 0; degree < 360; degree += 10) {
      const angle = THREE.MathUtils.degToRad(degree);
      orbitDirection.set(Math.sin(angle) * horizontal, direction.y, Math.cos(angle) * horizontal);
      distance = Math.max(distance, fitDistance(orbitDirection, aspect));
    }
    distance *= 1.02;
    orbitFits.set(key, distance);
    return distance;
  }

  function fitDistance(direction, aspect = camera.aspect) {
    const view = direction.clone().normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, view).normalize();
    const up = new THREE.Vector3().crossVectors(view, right).normalize();
    const tanVertical = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanHorizontal = tanVertical * Math.max(aspect, 0.1);
    let distance = 0;
    // Fit the real silhouette, including mirrors, instead of empty box corners.
    // Detailed bikes have large empty regions above the wheels; box fitting made
    // the approved model unnecessarily tiny in the shallow riding stage.
    const points = fitPoints.length ? fitPoints : [
      new THREE.Vector3(-size.x / 2, 0, -size.z / 2),
      new THREE.Vector3(size.x / 2, size.y, size.z / 2)
    ];
    const corner = new THREE.Vector3();
    for (const point of points) {
      corner.copy(point).sub(focus);
      const towardCamera = corner.dot(view);
      const projected = Math.max(Math.abs(corner.dot(right)) / tanHorizontal, Math.abs(corner.dot(up)) / tanVertical);
      distance = Math.max(distance, towardCamera + projected * 1.12, towardCamera + camera.near * 3);
    }
    return Math.max(distance, 0.5);
  }

  function setView(view = 'hero') {
    if (disposed || !controls) return;
    const directions = {
      hero: [1.5, 0.48, 1.25], front: [0, 0.3, 1.7],
      side: [1.7, 0.3, 0], rear: [-1.15, 0.55, -1.5],
      // Chase cam for the sport world: straight behind, slightly above (decorative).
      chase: [0.02, 0.36, -1.75]
    };
    if (!directions[view]) return;
    stopDeparture();
    currentView = view;
    const direction = new THREE.Vector3(...directions[view]).normalize();
    const distance = fitForView(direction);
    controls.target.copy(focus);
    camera.position.copy(focus).addScaledVector(direction, distance);
    controls.minDistance = Math.max(0.35, size.length() * 0.25);
    controls.maxDistance = Math.max(distance * 2.3, 8);
    controls.update();
    controls.saveState();
    interactionUntil = performance.now() + 250;
    updateReadback();
    wake();
  }

  function resetView() { setView('hero'); }

  // A factor greater than one zooms in; no model geometry or measurement is changed.
  function zoom(factor) {
    if (!controls || disposed || !Number.isFinite(factor) || factor <= 0 || departure) return;
    const offset = camera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(offset.length() / factor, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
    interactionUntil = performance.now() + 300;
    updateReadback();
    wake();
  }

  function startDeparture(durationMs = 1150) {
    if (!loaded || disposed || failed || contextLost) return;
    stopDeparture();
    departure = {
      started: performance.now(), duration: THREE.MathUtils.clamp(Number(durationMs) || 1150, 200, 4000),
      position: vehicle.position.clone(), rotation: vehicle.rotation.clone(),
      camera: camera.position.clone(), target: controls.target.clone(), hiddenAt: null
    };
    if (wheelAction) { animationMixer.stopAllAction(); wheelAction.reset().play(); }
    controlsEnabled();
    updateReadback();
    wake();
  }

  function stopDeparture() {
    if (!departure) return;
    vehicle.position.copy(departure.position);
    vehicle.rotation.copy(departure.rotation);
    camera.position.copy(departure.camera);
    controls?.target.copy(departure.target);
    departure = null;
    animationMixer?.stopAllAction();
    delete canvas.dataset.departure;
    controlsEnabled();
    controls?.update();
    updateReadback();
    if (!active) cancelFrame();
    else wake();
  }

  function animateDeparture(now) {
    const progress = Math.min(1, Math.max(0, (now - departure.started) / departure.duration));
    const smooth = progress * progress * (3 - 2 * progress);
    vehicle.position.copy(departure.position);
    vehicle.position.z += smooth * 0.42;
    vehicle.position.y += Math.sin(progress * Math.PI) * 0.025;
    vehicle.rotation.copy(departure.rotation);
    vehicle.rotation.y += smooth * 0.12;
    vehicle.rotation.z -= Math.sin(progress * Math.PI) * 0.025;
    const toward = departure.target.clone().sub(departure.camera);
    camera.position.copy(departure.camera).addScaledVector(toward, smooth * 0.075);
    controls.target.copy(departure.target);
    controls.target.z += smooth * 0.12;
    camera.lookAt(controls.target);
    // Use only the asset's authored wheel-roll clip, unrelated to GPS or inferred speed.
    if (wheelAction) animationMixer.setTime(smooth * wheelAction.getClip().duration * 0.28);
    canvas.dataset.departure = progress.toFixed(3);
  }

  function frame(now) {
    frameRequest = 0;
    if (!canRender()) return;
    const moving = departure || autoRotate || dragging || now < interactionUntil;
    const interval = 1000 / (moving ? 60 : 30);
    if (!lastFrame || now - lastFrame >= interval - 0.6) {
      const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 1 / 60;
      lastFrame = now;
      if (departure) animateDeparture(now);
      else controls?.update(dt);
      if (renderStyle === '2d' && comic) comic.render(scene, camera); else renderer.render(scene, camera);
      frameCount += 1;
      updateReadback();
    }
    wake();
  }

  function visibilityChanged() {
    if (document.hidden) {
      if (departure) departure.hiddenAt = performance.now();
      cancelFrame();
    } else {
      if (departure?.hiddenAt !== null && departure?.hiddenAt !== undefined) {
        departure.started += performance.now() - departure.hiddenAt;
        departure.hiddenAt = null;
      }
      resize();
      wake();
    }
  }

  function lost(event) {
    event.preventDefault();
    contextLost = true;
    cancelFrame();
    controlsEnabled();
    updateReadback();
    notify('error', '三维画布暂时不可用，请重新加载车辆视图。', { reason: 'webgl-context-lost' });
  }

  function interactionStarted() {
    dragging = true;
    interactionUntil = performance.now() + 500;
    wake();
  }

  function interactionEnded() {
    dragging = false;
    interactionUntil = performance.now() + 600;
    wake();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    abort.abort();
    cancelFrame();
    observer.disconnect();
    document.removeEventListener('visibilitychange', visibilityChanged);
    canvas.removeEventListener('webglcontextlost', lost);
    controls?.removeEventListener('start', interactionStarted);
    controls?.removeEventListener('end', interactionEnded);
    controls?.dispose();
    animationMixer?.stopAllAction();
    if (animationMixer) animationMixer.uncacheRoot(animationMixer.getRoot());
    departure = null;
    disposeTree(scene, sourceMaterials);
    environmentTarget?.dispose();
    comic?.dispose(); comic = null;
    renderer?.dispose();
    canvas.remove();
    updateReadback();
  }

  function createStage() {
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = shadowCanvas.height = 128;
    const ctx = shadowCanvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(64, 64, 5, 64, 64, 63);
      gradient.addColorStop(0, 'rgba(0,0,0,.7)');
      gradient.addColorStop(0.5, 'rgba(0,0,0,.25)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 128);
      contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(shadowCanvas), transparent: true, opacity: 0.5, depthWrite: false
      }));
      contact.rotation.x = -Math.PI / 2;
      contact.position.y = -0.007;
      scene.add(contact);
    }
    floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity: 0.23, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.01;
    floor.receiveShadow = true;
    scene.add(floor);
    scene.add(new THREE.HemisphereLight('#f2f5ff', '#2c3038', 0.65));
    const key = new THREE.DirectionalLight('#fff9f0', 3.2);
    key.position.set(3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.1, far: 14 });
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.015;
    scene.add(key);
    const fill = new THREE.DirectionalLight('#dbe7ff', 1.05);
    fill.position.set(-3, 2, 3);
    scene.add(fill);
    const rim = new THREE.DirectionalLight('#e2e9ff', 1.6);
    rim.position.set(-2, 4, -4);
    scene.add(rim);
  }

  async function initialize() {
    try {
      notify('loading', '正在加载三维摩托车…');
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.AgXToneMapping;
      renderer.toneMappingExposure = 1.02;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      try { comic = createComicPass(renderer); } catch { comic = null; }
      canvas.dataset.renderStyle = comic ? renderStyle : '3d';
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.075;
      controls.enablePan = false;
      controls.rotateSpeed = 0.72;
      controls.zoomSpeed = 0.85;
      controls.minPolarAngle = 0.12;
      controls.maxPolarAngle = Math.PI * 0.49;
      controls.autoRotateSpeed = 0.55;
      controls.addEventListener('start', interactionStarted);
      controls.addEventListener('end', interactionEnded);
      controlsEnabled();
      const room = new RoomEnvironment();
      const pmrem = new THREE.PMREMGenerator(renderer);
      try { environmentTarget = pmrem.fromScene(room, 0.04); }
      finally { room.dispose(); pmrem.dispose(); }
      scene.environment = environmentTarget.texture;
      scene.environmentIntensity = 0.58;
      createStage();
      mount(host);
      setView('hero');
      const url = new URL(modelURL, document.baseURI);
      const response = await fetch(url, { signal: abort.signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）`);
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) throw new Error('模型文件为空');
      if (disposed) throw new Error('Vehicle viewer disposed');
      const gltf = await new GLTFLoader().parseAsync(buffer, new URL('.', url).href);
      if (disposed) { disposeTree(gltf.scene); throw new Error('Vehicle viewer disposed'); }
      if (contextLost) { disposeTree(gltf.scene); throw new Error('三维画布已中断，请重新加载车辆视图。'); }
      const normalized = new THREE.Group();
      normalized.add(gltf.scene);
      const bounds = new THREE.Box3().setFromObject(normalized);
      const sourceSize = bounds.getSize(new THREE.Vector3());
      const longest = Math.max(sourceSize.x, sourceSize.y, sourceSize.z);
      if (!Number.isFinite(longest) || longest <= 0) {
        disposeTree(gltf.scene);
        throw new Error('模型不包含可显示的三维几何');
      }
      normalized.scale.setScalar(2.1 / longest);
      const fitted = new THREE.Box3().setFromObject(normalized);
      const center = fitted.getCenter(new THREE.Vector3());
      normalized.position.set(-center.x, -fitted.min.y, -center.z);
      fitted.getSize(size);
      focus.set(0, size.y * 0.48, 0);
      normalized.updateMatrixWorld(true);
      normalized.traverse(object => {
        if (!object.isMesh) return;
        const positions = object.geometry.getAttribute('position');
        for (let i = 0; i < positions.count; i++) {
          fitPoints.push(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld));
        }
        meshCount += 1;
        object.castShadow = true;
        object.receiveShadow = true;
        const source = Array.isArray(object.material) ? object.material : [object.material];
        const materials = source.map(material => {
          const role = materialRole(material, object);
          if (!role) return material;
          sourceMaterials.add(material);
          if (role === 'paint-mask') {
            if (!maskedPaint.has(material)) maskedPaint.set(material, createMaskedPaint(THREE, material));
            return maskedPaint.get(material).material;
          }
          const copy = role === 'paint' && material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial
            ? new THREE.MeshPhysicalMaterial() : material.clone();
          if (copy.isMeshPhysicalMaterial && !material.isMeshPhysicalMaterial) {
            THREE.MeshStandardMaterial.prototype.copy.call(copy, material);
            copy.defines = { ...copy.defines, PHYSICAL: '' };
          }
          editable[role].add(copy);
          return copy;
        });
        object.material = Array.isArray(object.material) ? materials : materials[0];
      });
      if (!meshCount) { disposeTree(normalized, sourceMaterials); throw new Error('模型没有可渲染网格'); }
      vehicle.add(normalized);
      const wheelClip = gltf.animations.find(clip => clip.name === 'wheel-roll');
      if (wheelClip) {
        animationMixer = new THREE.AnimationMixer(gltf.scene);
        wheelAction = animationMixer.clipAction(wheelClip);
        wheelAction.setLoop(THREE.LoopRepeat, Infinity);
      }
      if (contact) contact.scale.set(size.x * 1.4, size.z * 1.2, 1);
      loaded = true;
      setAppearance(appearance);
      setView(currentView);
      controlsEnabled();
      resize();
      const details = { meshCount, editableMaterials: { paint: editable.paint.size + maskedPaint.size, accent: editable.accent.size + maskedPaint.size }, dimensions: size.toArray(), source: 'glb', wheelAnimation: !!wheelAction };
      canvas.dataset.model = 'suzuki-gsx-r1000';
      canvas.dataset.wheelAnimation = String(!!wheelAction);
      notify('ready', details.editableMaterials.paint ? '三维车辆已就绪，可旋转、缩放和编辑颜色。' : '三维车辆已就绪，可旋转和缩放；当前模型尚未标记可编辑漆面。', details);
      wake();
      return details;
    } catch (error) {
      if (!disposed) {
        failed = true;
        cancelFrame();
        controlsEnabled();
        updateReadback();
        notify('error', error instanceof Error ? error.message : '三维车辆加载失败。', { reason: 'model-load-failed' });
      }
      throw error;
    }
  }

  document.addEventListener('visibilitychange', visibilityChanged);
  canvas.addEventListener('webglcontextlost', lost);
  const ready = initialize();
  // Keep disposal-before-await from producing an unhandled rejection; callers still receive the rejection.
  ready.catch(() => {});
  return { canvas, ready, mount, setActive, setInteractive, setAppearance, setRenderStyle, setAutoRotate, resetView, setView, zoom, startDeparture, stopDeparture, dispose };
}
