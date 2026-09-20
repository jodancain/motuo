// The caller owns this whole scene and its detached source materials. Texture
// clones may share an ImageBitmap even when they are separate GPU textures.
export function disposeTree(root, extraMaterials = []) {
  const geometries = new Set();
  const materials = new Set([...extraMaterials].filter(Boolean));
  const textures = new Set();
  const shadows = new Set();
  const bitmaps = new Set();

  function collectBitmap(image) {
    if (Array.isArray(image)) {
      image.forEach(collectBitmap);
      return;
    }
    if (!image || typeof image.close !== 'function') return;
    // The tag also recognizes a bitmap created in another window. Do not close
    // HTMLCanvasElement, OffscreenCanvas, HTMLImageElement, or arbitrary sources.
    const isBitmap = (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap)
      || Object.prototype.toString.call(image) === '[object ImageBitmap]';
    if (isBitmap) bitmaps.add(image);
  }

  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.shadow) shadows.add(object.shadow);
    const attached = object.material;
    for (const material of attached ? Array.isArray(attached) ? attached : [attached] : []) {
      if (material) materials.add(material);
    }
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
  }
  // Capture image references before dispose listeners can clear a texture's source.
  for (const texture of textures) {
    collectBitmap(texture.source?.data);
    collectBitmap(texture.image);
  }

  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => texture.dispose());
  shadows.forEach(shadow => shadow.dispose?.());
  // All users have released their GPU resources before the shared CPU image closes.
  bitmaps.forEach(bitmap => bitmap.close());
}
