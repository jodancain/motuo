#!/usr/bin/env python3
"""Prepare the user-supplied Suzuki 550 GSX R1000 OBJ as a private glTF 2.0 GLB.

Uses Python's standard library and macOS bsdtar only. It never runs scene files,
rewrites image pixels, or extracts archive-selected paths onto the filesystem.
Source JPEG bytes are embedded unchanged. The source is GSX-R1000, not GSX250R.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import struct
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ARCHIVE = ROOT / "C5913/Suzuki 550 GSX R1000[fbx,max,obj].rar"
DEFAULT_WORK = ROOT / ".private/model-work/suzuki-550-gsx-r1000/source"
DEFAULT_OUTPUT = ROOT / "prototypes/motuo-v2/assets/models/suzuki-gsx-r1000"
OBJ_NAME = "Suzuki_550_GSX_R1000.obj"
MTL_NAME = "Suzuki_550_GSX_R1000.mtl"
MATERIAL_NAMES = ["Bike", "Brake", "Chain", "Exhaust", "Glass", "Grips", "Mirrors", "Rim", "Tyre"]
# Display choices, not physical measurements recovered from the source materials.
PBR = {
    "Bike": (0.15, 0.36), "Brake": (0.8, 0.43), "Chain": (0.8, 0.48),
    "Exhaust": (0.85, 0.31), "Glass": (0.0, 0.12), "Grips": (0.0, 0.85),
    "Mirrors": (1.0, 0.12), "Rim": (0.65, 0.32), "Tyre": (0.0, 0.92),
}
WHEEL_MEMBERS = {
    "front": ["mesh2_da", "mesh4_da", "mesh6_da"],
    "rear": ["mesh1_da", "mesh3_da", "mesh7_da"],
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf8", "replace"))
    return result.stdout


def extract_sources(archive, work):
    """Select and flatten known model data; no archive path is ever restored."""
    records = []
    listing = command(["/usr/bin/bsdtar", "-tvf", str(archive)]).decode("utf8")
    for line in listing.splitlines():
        columns = line.split(None, 8)
        if len(columns) != 9 or not columns[4].isdigit() or not columns[0].startswith("-"):
            continue
        member = PurePosixPath(columns[8])
        if member.is_absolute() or ".." in member.parts:
            raise ValueError("Unsafe archive member: " + str(member))
        name = member.name
        if name in {OBJ_NAME, MTL_NAME, "master.mtl"} or re.fullmatch(r"mat[0-8]_[cn]\.jpg", name):
            records.append({"member": str(member), "name": name, "bytes": int(columns[4])})
    names = [record["name"] for record in records]
    expected = {OBJ_NAME, MTL_NAME, "master.mtl"} | {
        f"mat{index}_{channel}.jpg" for index in range(9) for channel in "cn"
    }
    if len(names) != len(set(names)) or set(names) != expected:
        raise ValueError("Source archive does not have exactly the expected OBJ, MTL and JPEG data")
    work.mkdir(parents=True, exist_ok=True)
    for record in records:
        # Selected basenames are a fixed allowlist without shell/glob metacharacters.
        data = command(["/usr/bin/bsdtar", "-xOf", str(archive), "*/" + record["name"]])
        if len(data) != record["bytes"]:
            raise ValueError("Archive member length mismatch: " + record["member"])
        (work / record["name"]).write_bytes(data)
        record["sha256"] = digest(data)
    return records


def jpeg_metadata(data):
    """Read dimensions from JPEG markers without decoding or altering pixels."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("Expected JPEG")
    position = 2
    while position < len(data):
        if data[position] != 255:
            position += 1
            continue
        while data[position] == 255:
            position += 1
        marker = data[position]
        position += 1
        if marker in [0xD8, 0xD9] or 0xD0 <= marker <= 0xD7:
            continue
        size = int.from_bytes(data[position:position + 2], "big")
        if size < 2 or position + size > len(data):
            raise ValueError("Malformed JPEG segment")
        if marker in [0xC0, 0xC1, 0xC2]:
            return {
                "width": int.from_bytes(data[position + 5:position + 7], "big"),
                "height": int.from_bytes(data[position + 3:position + 5], "big"),
                "components": data[position + 7],
            }
        position += size
    raise ValueError("JPEG has no supported image frame")


def parse_master(path):
    current = None
    mappings = {}
    for line in path.read_text().splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] == "newmtl":
            current = " ".join(fields[1:])
        elif fields[0] == "map_Kd":
            if current not in MATERIAL_NAMES or len(fields) != 2:
                raise ValueError("Unexpected source material mapping")
            filename = fields[1]
            if PurePosixPath(filename).name != filename:
                raise ValueError("Source texture path must be a flat local name")
            mappings[current] = filename
    if set(mappings) != set(MATERIAL_NAMES):
        raise ValueError("Missing source material mapping")
    return mappings


def parse_obj(path):
    positions, texcoords, normals = [], [], []
    objects, current, material = [], None, None

    def index(value, values):
        number = int(value)
        resolved = number - 1 if number > 0 else len(values) + number
        if number == 0 or not 0 <= resolved < len(values):
            raise ValueError("OBJ index out of bounds")
        return resolved

    with path.open() as stream:
        for line in stream:
            fields = line.split()
            if not fields or fields[0].startswith("#"):
                continue
            kind = fields[0]
            if kind in {"v", "vn", "vt"}:
                size = 2 if kind == "vt" else 3
                vector = tuple(float(value) for value in fields[1:size + 1])
                if len(vector) != size or not all(math.isfinite(value) for value in vector):
                    raise ValueError("Non-finite or incomplete OBJ attribute")
                {"v": positions, "vn": normals, "vt": texcoords}[kind].append(vector)
            elif kind == "o":
                current = {"name": " ".join(fields[1:]), "primitives": {}}
                objects.append(current)
            elif kind == "usemtl":
                material = " ".join(fields[1:])
                if material not in MATERIAL_NAMES:
                    raise ValueError("Unmapped OBJ material: " + material)
            elif kind == "f":
                if current is None or material is None:
                    raise ValueError("Face has no source object/material")
                face = []
                for token in fields[1:]:
                    pieces = token.split("/")
                    # The selected source contains complete v/vt/vn references.
                    if len(pieces) != 3 or not all(pieces):
                        raise ValueError("Expected explicit source position, UV and normal")
                    face.append((index(pieces[0], positions), index(pieces[1], texcoords), index(pieces[2], normals)))
                if len(face) < 3:
                    raise ValueError("OBJ face has fewer than three vertices")
                # The selected source is already triangular. This also handles convex polygon fans.
                triangles = current["primitives"].setdefault(material, [])
                triangles.extend((face[0], face[item], face[item + 1]) for item in range(1, len(face) - 1))
    if len(objects) != 17 or sum(len(p) for o in objects for p in o["primitives"].values()) != 52432:
        raise ValueError("Unexpected source mesh/triangle counts; review the new source before exporting")
    return positions, texcoords, normals, objects


def bounds(vectors):
    return {"min": [min(v[axis] for v in vectors) for axis in range(3)],
            "max": [max(v[axis] for v in vectors) for axis in range(3)]}


def build_glb(work, display_length, normal_scale):
    positions, texcoords, normals, objects = parse_obj(work / OBJ_NAME)
    original_bounds = bounds(positions)
    scale = display_length / (original_bounds["max"][2] - original_bounds["min"][2])
    origin = [(original_bounds["min"][0] + original_bounds["max"][0]) / 2,
              original_bounds["min"][1],
              (original_bounds["min"][2] + original_bounds["max"][2]) / 2]

    def transform(value):
        return [(value[axis] - origin[axis]) * scale for axis in range(3)]

    gltf = {
        "asset": {"version": "2.0", "generator": "Motuo private OBJ-to-GLB preparation v1",
                  "extras": {"sourceModel": "Suzuki 550 GSX R1000", "vehicleIdentity": "GSX-R1000 visual asset, not GSX250R",
                             "license": "User-supplied source; no redistribution license asserted"}},
        "scene": 0, "scenes": [{"name": "Suzuki GSX-R1000", "nodes": []}],
        "nodes": [], "meshes": [], "materials": [], "images": [], "textures": [],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "accessors": [], "bufferViews": [], "buffers": [],
    }
    binary = bytearray()

    def view(data, target=None):
        binary.extend(b"\x00" * (-len(binary) % 4))
        result = {"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)}
        if target is not None:
            result["target"] = target
        index = len(gltf["bufferViews"])
        gltf["bufferViews"].append(result)
        binary.extend(data)
        return index

    def accessor(values, width, kind, component, target, include_bounds=False):
        flat = [number for row in values for number in row] if width > 1 else values
        data = struct.pack("<" + ("f" if component == 5126 else "I") * len(flat), *flat)
        result = {"bufferView": view(data, target), "componentType": component,
                  "count": len(values), "type": kind}
        if include_bounds:
            result.update(bounds(values))
        gltf["accessors"].append(result)
        return len(gltf["accessors"]) - 1

    texture_metadata = []
    source_mapping = parse_master(work / "master.mtl")
    for name in MATERIAL_NAMES:
        diffuse_name = source_mapping[name]
        normal_name = diffuse_name.replace("_c.jpg", "_n.jpg")
        texture_indices = {}
        size_by_kind = {}
        for kind, filename in [("baseColor", diffuse_name), ("normal", normal_name)]:
            data = (work / filename).read_bytes()
            metadata = jpeg_metadata(data)
            size_by_kind[kind] = (metadata["width"], metadata["height"])
            image_index = len(gltf["images"])
            gltf["images"].append({"name": filename, "bufferView": view(data), "mimeType": "image/jpeg"})
            texture_indices[kind] = len(gltf["textures"])
            gltf["textures"].append({"name": filename, "sampler": 0, "source": image_index})
            texture_metadata.append({"file": filename, "material": name, "usage": kind,
                                     "bytes": len(data), "sha256": digest(data), **metadata,
                                     "imageIndex": image_index, "pixelsModified": False})
        if size_by_kind["baseColor"] != size_by_kind["normal"]:
            raise ValueError("Base and normal texture dimensions disagree for " + name)
        metallic, roughness = PBR[name]
        role = "paint-mask" if name == "Bike" else "fixed"
        gltf["materials"].append({
            "name": name,
            "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                                    "baseColorTexture": {"index": texture_indices["baseColor"]},
                                    "metallicFactor": metallic, "roughnessFactor": roughness},
            "normalTexture": {"index": texture_indices["normal"], "scale": normal_scale},
            "alphaMode": "OPAQUE", "doubleSided": name == "Glass",
            "extras": {"vehicleRole": role, "sourceMaterial": name,
                       "sourceBaseColor": diffuse_name, "sourceNormal": normal_name,
                       "normalConvention": "Tangent-space appearance verified; green-channel convention unverified",
                       "pbrFactors": "Art-directed display settings, not source-measured parameters",
                       "paintPolicy": "Only a reviewed texture mask may recolor Bike; all other texels remain fixed"
                       if name == "Bike" else "Never recolor through vehicle paint controls"},
        })

    mesh_metadata = []
    total_render_vertices = 0
    for source_object in objects:
        name = source_object["name"]
        primitives = []
        source_indices = set()
        triangle_count = 0
        for material, triangles in source_object["primitives"].items():
            lookup, output_positions, output_uvs, output_normals, indices = {}, [], [], [], []
            for triangle in triangles:
                for vertex in triangle:
                    source_indices.add(vertex[0])
                    if vertex not in lookup:
                        lookup[vertex] = len(output_positions)
                        output_positions.append(transform(positions[vertex[0]]))
                        uv = texcoords[vertex[1]]
                        output_uvs.append((uv[0], 1 - uv[1]))
                        normal = normals[vertex[2]]
                        magnitude = math.sqrt(sum(component * component for component in normal))
                        if magnitude < 1e-10:
                            raise ValueError("Source normal has zero length")
                        output_normals.append(tuple(component / magnitude for component in normal))
                    indices.append(lookup[vertex])
            primitives.append({
                "attributes": {
                    "POSITION": accessor(output_positions, 3, "VEC3", 5126, 34962, True),
                    "NORMAL": accessor(output_normals, 3, "VEC3", 5126, 34962),
                    "TEXCOORD_0": accessor(output_uvs, 2, "VEC2", 5126, 34962),
                },
                "indices": accessor(indices, 1, "SCALAR", 5125, 34963),
                "material": MATERIAL_NAMES.index(material), "mode": 4,
            })
            total_render_vertices += len(output_positions)
            triangle_count += len(triangles)
        original = bounds([positions[index] for index in source_indices])
        converted = bounds([transform(positions[index]) for index in source_indices])
        materials = list(source_object["primitives"])
        role = "paint-mask" if materials == ["Bike"] else "fixed"
        wheel = next((key for key, members in WHEEL_MEMBERS.items() if name in members), None)
        extras = {"vehicleRole": role, "sourceObject": name, "sourceMaterials": materials,
                  "originalBounds": original, "displayBounds": converted, "triangleCount": triangle_count}
        if wheel:
            extras["wheelGroup"] = wheel
        gltf["meshes"].append({"name": name, "primitives": primitives, "extras": extras})
        gltf["nodes"].append({"name": name, "mesh": len(gltf["meshes"]) - 1, "extras": extras})
        gltf["scenes"][0]["nodes"].append(len(gltf["nodes"]) - 1)
        mesh_metadata.append({"name": name, "materials": materials, "vehicleRole": role,
                              "wheelGroup": wheel, "triangles": triangle_count,
                              "originalBounds": original, "displayBounds": converted})

    wheels = {}
    wheel_nodes = []
    for side, names in WHEEL_MEMBERS.items():
        tyre_mesh = next(m for m in mesh_metadata if m["name"] == names[0])
        b = tyre_mesh["originalBounds"]
        original_pivot = [(b["min"][axis] + b["max"][axis]) / 2 for axis in range(3)]
        wheels[side] = {"members": names, "originalPivot": original_pivot,
                        "displayPivot": transform(original_pivot), "axis": [1, 0, 0],
                        "basis": "Tyre bounding-box center; visual pivot, not suspension kinematics"}
        pivot = transform(original_pivot)
        children = [index for index, node in enumerate(gltf["nodes"]) if node["name"] in names]
        for index in children:
            gltf["nodes"][index]["translation"] = [-value for value in pivot]
            gltf["scenes"][0]["nodes"].remove(index)
        wheel_node = len(gltf["nodes"])
        gltf["nodes"].append({"name": side + "-wheel-pivot", "translation": pivot, "children": children,
                              "extras": {"vehicleRole": "fixed", "wheelGroup": side,
                                         "animationPurpose": "Decorative departure motion; not measured wheel speed"}})
        gltf["scenes"][0]["nodes"].append(wheel_node)
        wheel_nodes.append(wheel_node)
        wheels[side]["pivotNode"] = wheel_node
    # Quarter-turn keys avoid shortest-path interpolation collapsing a full turn.
    spin_times = [0, 0.25, 0.5, 0.75, 1]
    spin_rotations = [(math.sin(math.pi * time), 0, 0, math.cos(math.pi * time)) for time in spin_times]
    spin_input = accessor(spin_times, 1, "SCALAR", 5126, None)
    gltf["accessors"][spin_input].update({"min": [0], "max": [1]})
    spin_output = accessor(spin_rotations, 4, "VEC4", 5126, None)
    gltf["animations"] = [{
        "name": "wheel-roll", "samplers": [{"input": spin_input, "output": spin_output, "interpolation": "LINEAR"}],
        "channels": [{"sampler": 0, "target": {"node": index, "path": "rotation"}} for index in wheel_nodes],
        "extras": {"source": "Motuo-authored visual animation", "durationSeconds": 1,
                   "meaning": "One decorative revolution around +X; unrelated to measured vehicle speed or RPM"},
    }]
    gltf["scenes"][0]["extras"] = {"upAxis": "+Y", "forwardAxis": "+Z", "wheelAxle": "+X", "wheels": wheels}
    binary.extend(b"\x00" * (-len(binary) % 4))
    gltf["buffers"] = [{"byteLength": len(binary)}]
    json_bytes = json.dumps(gltf, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    json_bytes += b" " * (-len(json_bytes) % 4)
    total_length = 12 + 8 + len(json_bytes) + 8 + len(binary)
    glb = struct.pack("<4sII", b"glTF", 2, total_length)
    glb += struct.pack("<I4s", len(json_bytes), b"JSON") + json_bytes
    glb += struct.pack("<I4s", len(binary), b"BIN\0") + binary
    return glb, {
        "originalBounds": original_bounds, "displayBounds": bounds([transform(v) for v in positions]),
        "normalization": {"upAxis": "+Y", "forwardAxis": "+Z", "sourceOrigin": origin,
                          "uniformScale": scale, "displayLength": display_length,
                          "units": "Display metres; length chosen for presentation, not measured vehicle dimensions",
                          "uvTransform": "(u, v) -> (u, 1-v) to convert OBJ image origin to glTF",
                          "normalTransform": "Source directions retained and normalized; no green-channel image edit"},
        "sourceVertices": len(positions), "renderVertices": total_render_vertices,
        "triangles": 52432, "meshes": len(objects), "materials": len(MATERIAL_NAMES),
        "nodes": len(gltf["nodes"]), "animations": [{"name": "wheel-roll", "durationSeconds": 1,
            "source": "Motuo-authored visual departure animation", "measurement": False}],
        "meshSummary": mesh_metadata, "wheels": wheels,
        "materialSummary": [{"name": m["name"], "index": i, "vehicleRole": m["extras"]["vehicleRole"],
                             "baseColor": m["extras"]["sourceBaseColor"], "normal": m["extras"]["sourceNormal"],
                             "metallicFactor": m["pbrMetallicRoughness"]["metallicFactor"],
                             "roughnessFactor": m["pbrMetallicRoughness"]["roughnessFactor"],
                             "normalScale": normal_scale} for i, m in enumerate(gltf["materials"])],
        "textures": texture_metadata,
    }


def verify_glb(data, manifest):
    """Verify byte layout, finite attributes, indices, source image hashes and roles."""
    magic, version, size = struct.unpack_from("<4sII", data)
    if (magic, version, size) != (b"glTF", 2, len(data)):
        raise ValueError("Invalid GLB header")
    json_size, json_kind = struct.unpack_from("<I4s", data, 12)
    gltf = json.loads(data[20:20 + json_size])
    binary_header = 20 + json_size
    binary_size, binary_kind = struct.unpack_from("<I4s", data, binary_header)
    binary = data[binary_header + 8:]
    if json_kind != b"JSON" or binary_kind != b"BIN\0" or binary_size != len(binary):
        raise ValueError("Invalid GLB chunks")
    for view in gltf["bufferViews"]:
        if view["byteOffset"] % 4 or view["byteOffset"] + view["byteLength"] > len(binary):
            raise ValueError("Unaligned or out-of-range buffer view")
    for item in gltf["accessors"]:
        view = gltf["bufferViews"][item["bufferView"]]
        values = binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]]
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[item["type"]]
        if len(values) != item["count"] * width * 4:
            raise ValueError("Accessor length mismatch")
        if item["componentType"] == 5126 and not all(math.isfinite(v[0]) for v in struct.iter_unpack("<f", values)):
            raise ValueError("Non-finite GLB attribute")
    triangle_count = 0
    for mesh in gltf["meshes"]:
        for primitive in mesh["primitives"]:
            count = gltf["accessors"][primitive["attributes"]["POSITION"]]["count"]
            item = gltf["accessors"][primitive["indices"]]
            view = gltf["bufferViews"][item["bufferView"]]
            values = binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]]
            if item["count"] % 3 or any(v[0] >= count for v in struct.iter_unpack("<I", values)):
                raise ValueError("Triangle indices out of range")
            triangle_count += item["count"] // 3
    if triangle_count != 52432 or len(gltf["meshes"]) != 17 or len(gltf["materials"]) != 9:
        raise ValueError("Source topology was not preserved")
    for index, material in enumerate(gltf["materials"]):
        expected_role = "paint-mask" if index == 0 else "fixed"
        if material["name"] != MATERIAL_NAMES[index] or material["extras"]["vehicleRole"] != expected_role:
            raise ValueError("Material role mismatch")
    for source in manifest["textures"]:
        image = gltf["images"][source["imageIndex"]]
        view = gltf["bufferViews"][image["bufferView"]]
        image_bytes = binary[view["byteOffset"]:view["byteOffset"] + view["byteLength"]]
        if digest(image_bytes) != source["sha256"]:
            raise ValueError("Source JPEG bytes changed")
    if len(gltf["nodes"]) != 19 or gltf["animations"][0]["name"] != "wheel-roll":
        raise ValueError("Expected 17 source nodes and two animated wheel pivots")
    for wheel in manifest["wheels"].values():
        parent = gltf["nodes"][wheel["pivotNode"]]
        child_names = [gltf["nodes"][index]["name"] for index in parent["children"]]
        if set(child_names) != set(wheel["members"]):
            raise ValueError("Wheel pivot contains an incorrect mesh")
        for child in parent["children"]:
            if any(abs(a + b) > 1e-9 for a, b in zip(parent["translation"], gltf["nodes"][child]["translation"])):
                raise ValueError("Wheel reparenting changed the rest geometry position")
    return {"header": "valid", "topology": "preserved", "sourceImages": "18 byte-identical JPEGs",
            "materialRoles": "9 explicit roles", "indicesAndAttributes": "finite and in bounds",
            "wheelAnimation": "Two fixed-role wheel pivots; original rest transforms preserved"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--display-length", type=float, default=2.1)
    parser.add_argument("--normal-scale", type=float, default=0.35)
    args = parser.parse_args()
    if not math.isfinite(args.display_length) or args.display_length <= 0:
        raise ValueError("Display length must be positive and finite")
    if not math.isfinite(args.normal_scale) or not 0 <= args.normal_scale <= 1:
        raise ValueError("Normal scale must be between zero and one")
    records = extract_sources(args.archive, args.work_dir)
    model, metadata = build_glb(args.work_dir, args.display_length, args.normal_scale)
    manifest = {
        "schemaVersion": 1, "name": "Suzuki 550 GSX R1000 (user-provided visual model)",
        "file": "model.glb", "sourceArchive": args.archive.name,
        "sourceArchiveBytes": args.archive.stat().st_size, "sourceArchiveSHA256": file_digest(args.archive),
        "sourceFiles": records, "sha256": digest(model), "bytes": len(model),
        "createdDate": "2026-09-20", "generator": "scripts/prepare-suzuki-model.py",
        "license": "User-provided asset; original publication/redistribution license not asserted",
        "distribution": "Private local runtime only; keep model, textures and archive out of Git/public delivery",
        "identity": "GSX-R1000 family appearance, explicitly not an exact GSX250R asset",
        "imagePolicy": "Original JPEG bytes embedded unchanged; no pixel generation, recoloring or recompression",
        "normalMapStatus": "Blue-purple tangent-space map appearance verified on mat0_n; green-channel convention unverified",
        **metadata,
    }
    manifest["verification"] = verify_glb(model, manifest)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "model.glb").write_bytes(model)
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"model": str(args.output_dir / "model.glb"), "bytes": len(model),
                      "sha256": manifest["sha256"], "triangles": metadata["triangles"],
                      "meshes": metadata["meshes"], "materials": metadata["materials"],
                      "verification": manifest["verification"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
