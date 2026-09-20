import test from 'node:test';
import assert from 'node:assert/strict';
import { disposeTree } from '../vehicle-resources.js';

const resource = fields => ({ ...fields, disposals: 0, dispose() { this.disposals++; } });
const bitmap = () => ({
  [Symbol.toStringTag]: 'ImageBitmap', closes: 0,
  close() { this.closes++; },
});
const tree = (...objects) => ({ traverse(visit) { objects.forEach(visit); } });

test('shared geometries, materials, textures, and bitmap storage release once per owned tree', () => {
  const image = bitmap();
  const texture = resource({ isTexture: true, source: { data: image }, image });
  const material = resource({ map: texture, normalMap: texture });
  const geometry = resource();
  const shadow = resource();
  disposeTree(tree(
    { geometry, material, shadow },
    { geometry, material: [material, material], shadow },
  ), [material]);
  assert.equal(geometry.disposals, 1);
  assert.equal(material.disposals, 1);
  assert.equal(texture.disposals, 1);
  assert.equal(shadow.disposals, 1);
  assert.equal(image.closes, 1);
});

test('separate cloned textures release their common bitmap after both GPU textures', () => {
  const image = bitmap(), order = [];
  image.close = () => { image.closes++; order.push('bitmap'); };
  const original = resource({ isTexture: true, source: { data: image } });
  const clone = resource({ isTexture: true, image });
  for (const [name, texture] of [['original', original], ['clone', clone]]) {
    texture.dispose = () => { texture.disposals++; order.push(name); texture.source = null; texture.image = null; };
  }
  const detached = resource({ map: original });
  const rendered = resource({ map: clone });
  disposeTree(tree({ material: rendered }), [detached, detached]);
  assert.equal(detached.disposals, 1, 'source material removed from the scene is still released');
  assert.equal(rendered.disposals, 1);
  assert.equal(original.disposals, 1);
  assert.equal(clone.disposals, 1);
  assert.equal(image.closes, 1);
  assert.equal(order.at(-1), 'bitmap');
  assert.deepEqual(new Set(order.slice(0, -1)), new Set(['original', 'clone']));
});

test('ordinary canvas and image sources are not closed or resized', () => {
  const canvas = {
    [Symbol.toStringTag]: 'HTMLCanvasElement', width: 128, height: 64,
    getContext() {}, close() { assert.fail('canvas must not be treated as an ImageBitmap'); },
  };
  const offscreen = { [Symbol.toStringTag]: 'OffscreenCanvas', width: 32, height: 32 };
  const image = { [Symbol.toStringTag]: 'HTMLImageElement', src: 'texture.jpg' };
  const textures = [canvas, offscreen, image].map(data => resource({ isTexture: true, source: { data }, image: data }));
  disposeTree(tree({ material: resource({ map: textures[0], normalMap: textures[1], emissiveMap: textures[2] }) }));
  assert.ok(textures.every(texture => texture.disposals === 1));
  assert.deepEqual([canvas.width, canvas.height, offscreen.width, offscreen.height], [128, 64, 32, 32]);
  assert.equal(image.src, 'texture.jpg');
});

test('array image sources deduplicate bitmaps and tolerate material-free scene nodes', () => {
  const first = bitmap(), second = bitmap();
  const texture = resource({ isTexture: true, source: { data: [first, second, first] }, image: [second] });
  const detached = resource({ map: texture });
  disposeTree(tree({}, { material: [null] }), [null, detached]);
  assert.equal(first.closes, 1);
  assert.equal(second.closes, 1);
  assert.equal(texture.disposals, 1);
  assert.equal(detached.disposals, 1);
});
