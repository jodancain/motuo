// This mask belongs only to the approved Suzuki atlas. Blue pigment identifies
// paint; neutral engine/seat pixels and red/white decals retain their source map.
// All colors sampled by the GPU are linear. No source texture is modified.
export const PAINT_MASK_VERSION = 'suzuki-blue-atlas-v1';

export function patchPaintShader(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
uniform vec3 motuoBodyColor;
uniform vec3 motuoAccentColor;
uniform float motuoPaintRoughness;
float motuoPaintMask = 0.0;
`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  vec3 pigment = sampledDiffuseColor.rgb;
  float blueShare = pigment.b / max(pigment.r + pigment.g + pigment.b, 0.0001);
  motuoPaintMask = smoothstep(0.47, 0.62, blueShare) * smoothstep(0.004, 0.024, pigment.b);
  // Lower atlas islands include the front cowl and tail-tip paint. Restrict
  // the accent to their original pigment instead of coloring neutral metal.
  // The source OBJ tiles UVs outside 0…1; match the repeat-wrapped texture.
  float detailMask = smoothstep(0.64, 0.68, fract(vMapUv.y));
  vec3 paintColor = mix(motuoBodyColor, motuoAccentColor, detailMask);
  float bakedShade = clamp(pow(max(pigment.b, 0.001) / 0.12, 0.32), 0.38, 1.08);
  diffuseColor.rgb = mix(diffuseColor.rgb, paintColor * bakedShade, motuoPaintMask);
#endif
`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, motuoPaintRoughness, motuoPaintMask);
`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.12, motuoPaintMask);
`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat *= motuoPaintMask;
#endif
`);
}

export function createMaskedPaint(THREE, original) {
  if (!original.map || !original.isMeshStandardMaterial) throw new Error('Suzuki paint mask requires the original textured material.');
  const material = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(material, original);
  material.defines = { ...material.defines, PHYSICAL: '' };
  const uniforms = {
    motuoBodyColor: { value: new THREE.Color('#f2f1ec') },
    motuoAccentColor: { value: new THREE.Color('#171b22') },
    motuoPaintRoughness: { value: 0.26 }
  };
  material.color.set('#ffffff');
  material.clearcoat = 0.8;
  material.clearcoatRoughness = 0.12;
  material.onBeforeCompile = shader => patchPaintShader(shader, uniforms);
  material.customProgramCacheKey = () => PAINT_MASK_VERSION;
  material.userData.paintMask = PAINT_MASK_VERSION;
  return {
    material,
    update({ bodyColor, accentColor, finish }) {
      uniforms.motuoBodyColor.value.set(bodyColor);
      uniforms.motuoAccentColor.value.set(accentColor);
      uniforms.motuoPaintRoughness.value = finish === 'satin' ? 0.62 : 0.26;
      material.clearcoat = finish === 'satin' ? 0.18 : 0.8;
      material.clearcoatRoughness = finish === 'satin' ? 0.35 : 0.12;
    }
  };
}
