import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../vendor/three/three.module.js';
import { createMaskedPaint, patchPaintShader, PAINT_MASK_VERSION } from '../vehicle-paint.js';

// Use the bundled renderer's real material classes/chunks. This checks material
// ownership and generated shader contracts, not GPU compilation or atlas accuracy.
function makeOriginal() {
  return new THREE.MeshStandardMaterial({
    map: new THREE.Texture({ label: 'original color pixels' }),
    normalMap: new THREE.Texture({ label: 'original normal pixels' }),
    roughness: 0.36, metalness: 0.15,
  });
}
function compileHook(paint) {
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  paint.material.onBeforeCompile(shader);
  return shader;
}

test('mask hooks match bundled physical shader ordering and preserve source sampling', () => {
  const original = makeOriginal(), paint = createMaskedPaint(THREE, original), shader = compileHook(paint);
  const hooks = ['common', 'map_fragment', 'roughnessmap_fragment', 'metalnessmap_fragment', 'lights_physical_fragment'];
  for (const name of hooks) {
    const token = `#include <${name}>`;
    assert.equal(THREE.ShaderLib.physical.fragmentShader.split(token).length, 2, `renderer supplies one ${name} hook`);
    assert.equal(shader.fragmentShader.split(token).length, 2, `patch retains ${name}`);
  }
  assert.match(THREE.ShaderChunk.map_fragment, /vec4 sampledDiffuseColor = texture2D\( map, vMapUv \)/);
  assert.ok(shader.fragmentShader.indexOf('vec3 pigment = sampledDiffuseColor.rgb') > shader.fragmentShader.indexOf('#include <map_fragment>'));
  assert.ok(shader.fragmentShader.indexOf('motuoPaintMask = smoothstep') < shader.fragmentShader.indexOf('#include <roughnessmap_fragment>'));
  assert.ok(shader.fragmentShader.indexOf('roughnessFactor = mix') < shader.fragmentShader.indexOf('#include <lights_physical_fragment>'));
  assert.ok(shader.fragmentShader.indexOf('metalnessFactor = mix') < shader.fragmentShader.indexOf('#include <lights_physical_fragment>'));
  assert.ok(shader.fragmentShader.indexOf('material.clearcoat *= motuoPaintMask') > shader.fragmentShader.indexOf('#include <lights_physical_fragment>'));
  assert.ok(shader.fragmentShader.indexOf('material.clearcoat *= motuoPaintMask') < shader.fragmentShader.indexOf('#include <lights_fragment_begin>'));
  assert.match(shader.fragmentShader, /mix\(diffuseColor\.rgb, paintColor \* bakedShade, motuoPaintMask\)/);
  assert.equal(paint.material.customProgramCacheKey(), PAINT_MASK_VERSION);
});

test('generated mask selects blue pigment and rejects neutral, red, white, and near-black samples', () => {
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  patchPaintShader(shader, {});
  // Evaluate the actual generated scalar GLSL expression with GLSL built-ins.
  // No copy of the mask thresholds/formula lives in this test.
  const scalar = shader.fragmentShader.match(/float blueShare = ([\s\S]*?);\s*motuoPaintMask = ([\s\S]*?);/);
  assert.ok(scalar, 'generated shader provides the sampled-pigment mask');
  const evaluate = new Function('pigment', 'max', 'smoothstep', `const blueShare = ${scalar[1]}; return ${scalar[2]};`);
  const smoothstep = (edge0, edge1, value) => {
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  const mask = pigment => evaluate(pigment, Math.max, smoothstep);
  const blue = new THREE.Color('#0641b5');
  assert.ok(mask(blue) > 0.99);
  for (const color of ['#ffffff', '#cccccc', '#606060', '#111111', '#ff1212']) {
    assert.equal(mask(new THREE.Color(color)), 0, `${color} keeps source pigment`);
  }
  assert.equal(mask({ r: 0, g: 0, b: 0.0002 }), 0, 'dark noise does not become colored paint');
  assert.equal(mask({ r: 0, g: 0, b: 0 }), 0, 'black remains finite and unselected');
});

test('accent atlas selection repeats for negative and multi-tile UV coordinates', () => {
  const shader = { uniforms: {}, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  patchPaintShader(shader, {});
  const expression = shader.fragmentShader.match(/float detailMask = ([^;]+);/);
  assert.ok(expression, 'generated shader provides the atlas-detail mask');
  const evaluate = new Function('vMapUv', 'fract', 'smoothstep', `return ${expression[1]};`);
  const fract = value => value - Math.floor(value);
  const smoothstep = (edge0, edge1, value) => {
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  const mask = y => evaluate({ y }, fract, smoothstep);
  // OBJ UVs above 1 become negative after glTF's 1-v conversion. The
  // diffuse sampler repeats them; the accent region must repeat identically.
  assert.equal(mask(0.77), 1);
  assert.equal(mask(0.2), 0);
  for (const tile of [-3, -2, -1, 0, 1, 2, 12]) {
    assert.equal(mask(0.77 + tile), 1, `accent survives tile ${tile}`);
    assert.equal(mask(0.2 + tile), 0, `body stays outside accent in tile ${tile}`);
  }
});

test('appearance updates touch shader uniforms without replacing textures or globally tinting the atlas', () => {
  const original = makeOriginal(), originalColor = original.color.clone();
  original.userData = { vehicleRole: 'paint-mask', source: 'approved atlas' };
  const paint = createMaskedPaint(THREE, original), material = paint.material, shader = compileHook(paint);
  assert.equal(material.defines.PHYSICAL, '', 'copying Standard fields must retain the Physical shader macro');
  const bodyUniform = shader.uniforms.motuoBodyColor, accentUniform = shader.uniforms.motuoAccentColor;
  const colorPixels = original.map.image, normalPixels = original.normalMap.image;
  paint.update({ bodyColor: '#d41f32', accentColor: '#4a35a2', finish: 'satin' });
  assert.equal(material.map, original.map);
  assert.equal(material.normalMap, original.normalMap);
  assert.equal(material.map.image, colorPixels);
  assert.equal(material.normalMap.image, normalPixels);
  assert.ok(material.color.equals(new THREE.Color('#ffffff')), 'atlas color is not globally multiplied by selected paint');
  assert.ok(original.color.equals(originalColor));
  assert.equal(original.roughness, 0.36);
  assert.equal(original.metalness, 0.15);
  assert.equal(material.roughness, original.roughness, 'unmasked roughness remains original');
  assert.equal(material.metalness, original.metalness, 'unmasked metalness remains original');
  assert.equal(original.userData.paintMask, undefined, 'source metadata remains untouched');
  assert.equal(shader.uniforms.motuoBodyColor, bodyUniform);
  assert.equal(shader.uniforms.motuoAccentColor, accentUniform);
  assert.ok(bodyUniform.value.equals(new THREE.Color('#d41f32')));
  assert.ok(accentUniform.value.equals(new THREE.Color('#4a35a2')));
  assert.equal(shader.uniforms.motuoPaintRoughness.value, 0.62);
  assert.ok(material.clearcoat > 0);
  paint.update({ bodyColor: '#f2f1ec', accentColor: '#171b22', finish: 'gloss' });
  assert.equal(shader.uniforms.motuoPaintRoughness.value, 0.26);
  assert.ok(material.color.equals(new THREE.Color('#ffffff')));
});

test('viewer material dispatch excludes fixed mechanical materials and shares the masked Bike material', () => {
  const source = readFileSync(new URL('../vehicle-viewer.js', import.meta.url), 'utf8');
  const roleStart = source.indexOf('  function materialRole('), roleEnd = source.indexOf('\n  function setAppearance(', roleStart);
  assert.ok(roleStart >= 0 && roleEnd > roleStart);
  const materialRole = vm.runInNewContext(`(${source.slice(roleStart, roleEnd).trim()})`);
  const traversal = source.match(/normalized\.traverse\(object => \{([\s\S]*?)\n      \}\);/);
  assert.ok(traversal, 'extract the production material-dispatch callback');
  const masked = new Map(), editable = { paint: new Set(), accent: new Set() }, sourceMaterials = new Set(), calls = [], fitPoints = [];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  const callback = new Function('THREE', 'materialRole', 'createMaskedPaint', 'maskedPaint', 'editable', 'sourceMaterials', 'fitPoints',
    `let meshCount = 0; return object => {${traversal[1]}};`)(THREE, materialRole, (...args) => {
    calls.push(args[1]); return createMaskedPaint(...args);
  }, masked, editable, sourceMaterials, fitPoints);
  const bike = makeOriginal(); bike.name = 'Bike'; bike.userData.vehicleRole = 'paint-mask';
  const first = new THREE.Mesh(geometry, bike), second = new THREE.Mesh(geometry, bike);
  const fixed = ['Brake', 'Chain', 'Exhaust', 'Glass', 'Grips', 'Mirrors', 'Rim', 'Tyre'].map(name => {
    const material = makeOriginal(); material.name = name; material.userData.vehicleRole = 'fixed';
    // A misleading mesh name cannot override the explicit fixed material role.
    const object = new THREE.Mesh(geometry, material);
    object.name = 'blue body fairing'; object.userData.vehicleRole = 'paint-mask';
    callback(object);
    assert.equal(object.material, material, name);
    return material;
  });
  callback(first); callback(second);
  assert.deepEqual(calls, [bike]);
  assert.equal(first.material, second.material);
  assert.notEqual(first.material, bike);
  assert.equal(masked.size, 1);
  assert.equal(editable.paint.size + editable.accent.size, 0, 'masked material is excluded from global material.color updates');
  assert.deepEqual([...sourceMaterials], [bike]);
  assert.ok(fixed.every(material => material.onBeforeCompile === THREE.Material.prototype.onBeforeCompile));
  assert.equal(fitPoints.length, 30, 'production traversal receives real geometry and world matrices');
});

test('missing original texture or non-PBR material fails without modifying source', () => {
  const untextured = new THREE.MeshStandardMaterial(), flat = new THREE.MeshBasicMaterial({ map: new THREE.Texture() });
  assert.throws(() => createMaskedPaint(THREE, untextured), /original textured material/);
  assert.throws(() => createMaskedPaint(THREE, flat), /original textured material/);
  assert.equal(untextured.map, null);
  assert.ok(flat.isMeshBasicMaterial);
});
