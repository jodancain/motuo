# Three.js vendored subset

Pinned version: **Three.js r186 / npm `three@0.186.0`**. The local `three.core.js` declares `REVISION = '186'`. This directory holds browser modules and the MIT license; it does not require installing the npm package to serve the prototype.

Official sources:

- [Three.js repository, r186](https://github.com/mrdoob/three.js/tree/r186)
- [npm package, 0.186.0](https://www.npmjs.com/package/three/v/0.186.0)
- [npm distribution archive](https://registry.npmjs.org/three/-/three-0.186.0.tgz)
- [MIT license](LICENSE), copyright 2010–2026 Three.js authors

The selected files map to the upstream package as follows:

| Local path | Package path |
| --- | --- |
| `three.module.js` | `build/three.module.js` |
| `three.core.js` | `build/three.core.js` |
| `addons/controls/OrbitControls.js` | `examples/jsm/controls/OrbitControls.js` |
| `addons/loaders/GLTFLoader.js` | `examples/jsm/loaders/GLTFLoader.js` |
| `addons/utils/BufferGeometryUtils.js` | `examples/jsm/utils/BufferGeometryUtils.js` |
| `addons/utils/SkeletonUtils.js` | `examples/jsm/utils/SkeletonUtils.js` |
| `addons/environments/RoomEnvironment.js` | `examples/jsm/environments/RoomEnvironment.js` |
| `LICENSE` | `LICENSE` |

The application import map resolves `three` to the local ES module. Addons retain their normal imports; `GLTFLoader` uses `BufferGeometryUtils`, while the scene may use `OrbitControls`, `RoomEnvironment` and `SkeletonUtils` for interaction, lighting and model instances.

Keep the MIT copyright and permission notice when redistributing this subset. This software license does **not** license motorcycle meshes, brand marks or reference screenshots; model provenance is tracked separately in `assets/models/road-sportbike.manifest.json`.
