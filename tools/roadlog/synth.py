#!/usr/bin/env python3
"""Generate synthetic Motuo roadlog packages (schema v1, provenance "simulated") for tests and demos.

Same layout as the iOS writer (docs/ROADLOG_FORMAT.md). Optional faults reproduce what a Mac can encounter:
  bad_sha, half_jsonl, missing_chunk, part_left, no_manifest, icloud_placeholder
"""
import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import random
import uuid
from pathlib import Path

T = ("t_mono", "s", "ProcessInfo.systemUptime 秒")
TU = ("t_unix", "s", "原始墙钟时间")
XYZ = lambda unit, what: [(a, unit, what + " " + a) for a in "xyz"]
MOTION = [T] + [("user_acc_" + a, "g", "") for a in "xyz"] + [("gravity_" + a, "g", "") for a in "xyz"] + \
    [("rot_" + a, "rad/s", "") for a in "xyz"] + [("q_" + a, "1", "") for a in "wxyz"] + [("mag_" + a, "uT", "") for a in "xyz"] + \
    [("mag_accuracy", "int", ""), ("heading_deg", "deg", "")]
STREAMS = {
    "motion": ("measured", 100, MOTION), "accel_raw": ("measured", 100, [T] + XYZ("g", "accel")),
    "gyro_raw": ("measured", 100, [T] + XYZ("rad/s", "gyro")), "mag_raw": ("measured", 50, [T] + XYZ("uT", "mag")),
    "batched_accel": ("measured", 800, [T] + XYZ("g", "accel")), "batched_motion": ("measured", 200, MOTION),
    "altimeter": ("measured", None, [T, ("rel_alt_m", "m", ""), ("pressure_kpa", "kPa", "")]),
    "abs_altitude": ("measured", None, [T, ("altitude_m", "m", ""), ("accuracy_m", "m", ""), ("precision_m", "m", "")]),
    "location": ("measured", 1, [T, TU, ("lat", "deg", ""), ("lon", "deg", ""), ("alt_m", "m", ""), ("ellipsoidal_alt_m", "m", ""),
                                 ("h_acc_m", "m", ""), ("v_acc_m", "m", ""), ("speed_mps", "m/s", ""), ("speed_acc_mps", "m/s", ""),
                                 ("course_deg", "deg", ""), ("course_acc_deg", "deg", ""), ("floor", "int", ""),
                                 ("sim_by_software", "0/1", ""), ("from_accessory", "0/1", "")]),
    "heading": ("measured", None, [T, TU, ("magnetic_deg", "deg", ""), ("true_deg", "deg", ""), ("accuracy_deg", "deg", ""),
                                   ("raw_x", "uT", ""), ("raw_y", "uT", ""), ("raw_z", "uT", "")]),
    "acoustic": ("measured", None, [T, ("rms_dbfs", "dBFS", ""), ("peak_dbfs", "dBFS", ""), ("clipped", "0/1", "")] +
                 [("band_%02d" % i, "dBFS", "") for i in range(16)]),
    "inferred_imu_speed": ("inferred", None, [T, ("speed_mps", "m/s", ""), ("uncertainty_mps", "m/s", ""), ("anchor_age_s", "s", "")]),
    "inferred_signal": ("inferred", 1, [T, ("longitudinal_trend", "int", ""), ("turn_direction", "1", ""),
                                        ("acceleration_intensity", "1", ""), ("rotation_intensity", "1", "")]),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def iso(unix):
    return dt.datetime.fromtimestamp(unix, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def fmt(v, col):
    if v is None:
        return ""
    if col in ("t_mono", "t_unix"):
        return "%.6f" % v
    if col in ("lat", "lon"):
        return "%.8f" % v
    return "%.7g" % v


def speed_kmh(t):
    c = t % 150
    return 0 if c < 10 else (c - 10) * 3 if c < 30 else 60 + 8 * math.sin(c / 9) if c < 120 else max(0, 60 * (1 - (c - 120) / 30))


def generate(root, seconds=600, start_unix=1792656000.0, mono0=10000.0, rates=None, audio=False, tunnel=(300, 310), seed=7, faults=()):
    rnd = random.Random(seed)
    if tunnel and seconds <= tunnel[1] + 1:
        tunnel = None
    rates = dict({"motion": 100, "accel_raw": 100, "gyro_raw": 100, "mag_raw": 50, "acoustic": 47, "heading": 5}, **(rates or {}))
    ride = str(uuid.UUID(int=rnd.getrandbits(128))).upper()
    name = dt.datetime.fromtimestamp(start_unix, dt.timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ") + "_" + ride
    pkg = Path(root) / name
    (pkg / "streams").mkdir(parents=True, exist_ok=True)
    rows = {k: [] for k in STREAMS}
    lat, lon = 31.2304, 121.4737
    for s in range(seconds):
        kmh = speed_kmh(s)
        for name_, hz in (("motion", rates["motion"]), ("accel_raw", rates["accel_raw"]), ("gyro_raw", rates["gyro_raw"]), ("mag_raw", rates["mag_raw"])):
            for i in range(int(hz)):
                t = mono0 + s + i / hz
                if name_ == "motion":
                    u = s + i / hz
                    accel = (speed_kmh(u + 0.05) - speed_kmh(u - 0.05)) / 0.1 / 3.6 / 9.80665  # forward = device y in this synthetic mount
                    rows[name_].append([t, rnd.gauss(0, 0.02), accel + rnd.gauss(0, 0.02), rnd.gauss(0, 0.02), 0, -0.995, -0.1,
                                        rnd.gauss(0, 0.05), rnd.gauss(0, 0.05), rnd.gauss(0, 0.02), 0.99, 0.01, 0.02, 0.1,
                                        22, -3, -40, 2, (t * 3) % 360])
                else:
                    rows[name_].append([t, rnd.gauss(0, 0.03), rnd.gauss(-1 if name_ == "accel_raw" else 0, 0.03), rnd.gauss(0, 0.03)])
        rows["altimeter"].append([mono0 + s + 0.3, 3 * math.sin(s / 60), 101.2 - 0.036 * math.sin(s / 60)])
        rows["abs_altitude"].append([mono0 + s + 0.5, 12 + 3 * math.sin(s / 60), 4, 0.5])
        rows["inferred_signal"].append([mono0 + s + 0.7, 1 if 0 < kmh < 60 else 0, 0.2 * math.sin(s / 7), min(1, kmh / 100), 0.1])
        for i in range(int(rates["heading"])):
            t = mono0 + s + i / rates["heading"]
            rows["heading"].append([t, start_unix + (t - mono0), (t * 3) % 360, None, 15, 20, -5, -40])
        for i in range(int(rates["acoustic"])):
            level = -30 + kmh / 4
            rows["acoustic"].append([mono0 + s + i / rates["acoustic"], level + rnd.gauss(0, 1), level + 9, 0] +
                                    [level - 3 * abs(b - 4) + rnd.gauss(0, 1) for b in range(16)])
        if not (tunnel and tunnel[0] <= s < tunnel[1]):
            lat += kmh / 3.6 / 111320 * 0.8
            lon += kmh / 3.6 / 95000 * 0.6
            rows["location"].append([mono0 + s + 0.95, start_unix + s + 0.95, lat, lon, 12 + 3 * math.sin(s / 60), 21 + 3 * math.sin(s / 60),
                                     4 + rnd.random(), 6, speed_kmh(s + 0.95) / 3.6, 0.5, 37, 5, None, 0, 0])
    index, chunks_by = [], {}
    for stream, data in rows.items():
        if not data:
            continue
        cols = [c[0] for c in STREAMS[stream][2]]
        (pkg / "streams" / stream).mkdir(parents=True, exist_ok=True)
        seq, start = 0, 0
        while start < len(data):
            end = start
            while end < len(data) and data[end][0] - data[start][0] < 60:
                end += 1
            seq += 1
            buf = io.StringIO()
            buf.write(",".join(cols) + "\n")
            for r in data[start:end]:
                buf.write(",".join(fmt(v, c) for v, c in zip(r, cols)) + "\n")
            raw = buf.getvalue().encode()
            gz = gzip.compress(raw, mtime=0)
            rel = "streams/%s/%06d.csv.gz" % (stream, seq)
            (pkg / rel).write_bytes(gz)
            entry = {"type": "chunk", "stream": stream, "seq": seq, "file": rel, "rows": end - start, "t_start": data[start][0],
                     "t_end": data[end - 1][0], "bytes": len(gz), "uncompressed_bytes": len(raw), "sha256": sha(gz), "recovered": False}
            index.append(entry)
            chunks_by.setdefault(stream, []).append({k: v for k, v in entry.items() if k != "type"})
            start = end
    if audio:
        (pkg / "audio").mkdir(exist_ok=True)
        data = bytes(rnd.getrandbits(8) for _ in range(4096))
        (pkg / "audio/0001.m4a").write_bytes(data)
        index.append({"type": "audio", "seq": 1, "file": "audio/0001.m4a", "t_start": mono0, "t_end": mono0 + seconds,
                      "bytes": len(data), "sha256": sha(data), "recovered": False})

    def jsonl(name_, records):
        (pkg / (name_ + ".jsonl")).write_text("".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in records))

    clock = [{"type": "clock", "source": "app", "reason": "start" if s == 0 else "periodic", "t_mono": mono0 + s, "t_unix": start_unix + s}
             for s in range(0, seconds, 10)] + [{"type": "clock", "source": "app", "reason": "end", "t_mono": mono0 + seconds, "t_unix": start_unix + seconds}]
    events = [{"type": "ride_start", "source": "app", "t_mono": mono0, "t_unix": start_unix}]
    events += [{"type": "signal_event", "source": "simulated", "kind": "suspectedShift", "confidence": 0.45, "t_mono": mono0 + s, "t_unix": start_unix + s}
               for s in range(20, seconds, 75)]
    gaps = []
    if tunnel and rows["location"]:
        before = max(r[0] for r in rows["location"] if r[0] < mono0 + tunnel[0])
        after = min(r[0] for r in rows["location"] if r[0] >= mono0 + tunnel[1])
        gap = {"type": "gap", "source": "app", "stream": "location", "t_start": before, "t_end": after, "t_mono": after,
               "t_unix": start_unix + after - mono0, "reason": "gps_lost"}
        events.append(gap)
        gaps.append({"stream": "location", "tStart": before, "tEnd": after, "reason": "gps_lost"})
    for st in ("batched_accel", "batched_motion"):
        events.append({"type": "stream_status", "source": "app", "stream": st, "status": "unsupported", "reason": "iPhone 无 CMBatchedSensorManager",
                       "t_mono": mono0, "t_unix": start_unix})
    events.append({"type": "ride_finish", "source": "app", "t_mono": mono0 + seconds, "t_unix": start_unix + seconds})
    jsonl("clock", clock)
    jsonl("events", events)
    jsonl("device", [{"type": "device", "source": "simulated", "reason": "periodic", "t_mono": mono0 + s, "t_unix": start_unix + s,
                      "battery_level": round(0.8 - s / 6000, 4), "thermal_state": "nominal", "app_state": "active"} for s in range(0, seconds, 30)])
    jsonl("accessory", [{"type": "none", "source": "app", "t_mono": mono0, "t_unix": start_unix}])
    jsonl("index", index)
    session = {"schema": "motuo.roadlog", "schemaVersion": 1, "packageId": name, "rideId": ride, "provenance": "simulated",
               "startedAtUnix": start_unix, "app": {"bundleId": "cn.yundongyl.motuo", "version": "synthetic", "build": "0"},
               "device": {"model": "synthetic", "systemName": "iOS", "systemVersion": "-", "isSimulator": True},
               "vehicle": {"make": "Suzuki", "model": "GSX250R"}, "calibration": None,
               "settings": {"roadlogEnabled": True, "rawAudioEnabled": audio, "requestedRatesHz": {k: v for k, v in rates.items()}},
               "capabilities": {"batchedSensorManager": {"accelerometerSupported": False, "deviceMotionSupported": False}}}
    (pkg / "session.json").write_text(json.dumps(session, ensure_ascii=False, indent=2, sort_keys=True))
    (pkg / "README.md").write_text("# Motuo 路谱包（合成）\n")
    files = {}
    for n in ("events", "device", "clock", "accessory", "index"):
        data = (pkg / (n + ".jsonl")).read_bytes()
        files[n] = {"file": n + ".jsonl", "lines": data.count(b"\n"), "bytes": len(data), "sha256": sha(data)}
    data = (pkg / "session.json").read_bytes()
    files["session"] = {"file": "session.json", "lines": data.count(b"\n"), "bytes": len(data), "sha256": sha(data)}
    streams = {}
    for k, (source, hz, cols) in STREAMS.items():
        ch = chunks_by.get(k, [])
        n = sum(c["rows"] for c in ch)
        t0 = min((c["t_start"] for c in ch), default=None)
        t1 = max((c["t_end"] for c in ch), default=None)
        status = "recorded" if ch else ("unsupported" if k.startswith("batched") else "unavailable")
        streams[k] = {"source": "simulated", "status": status, "reason": None if ch else "合成包未生成该流", "requestedHz": rates.get(k, hz),
                      "measuredHz": (n - 1) / (t1 - t0) if n > 1 and t1 > t0 else None, "rows": n, "tStart": t0, "tEnd": t1,
                      "columns": [{"name": c[0], "unit": c[1], "description": c[2]} for c in cols], "frame": "synthetic", "chunks": ch}
    total = sum(f.stat().st_size for f in pkg.rglob("*") if f.is_file())
    manifest = {"schema": "motuo.roadlog", "schemaVersion": 1, "packageId": name, "rideId": ride, "status": "sealed", "provenance": "simulated",
                "simulated": True, "startedAtUTC": iso(start_unix), "endedAtUTC": iso(start_unix + seconds), "durationS": float(seconds),
                "clock": {"monotonicBase": "ProcessInfo.systemUptime seconds", "mappingFile": "clock.jsonl", "samples": len(clock),
                          "start": {"t_mono": mono0, "t_unix": start_unix}, "end": {"t_mono": mono0 + seconds, "t_unix": start_unix + seconds}},
                "app": session["app"], "device": session["device"], "vehicle": session["vehicle"], "settings": session["settings"],
                "calibration": None, "capabilities": session["capabilities"], "streams": streams, "files": files,
                "audio": {"rawEnabled": audio, "codec": "AAC-LC mono", "bitrate": 32000, "sampleRate": 16000,
                          "segments": [{k: v for k, v in e.items() if k != "type"} for e in index if e["type"] == "audio"]},
                "gaps": gaps, "degradations": [], "integrity": {"algorithm": "SHA-256", "chunksVerified": True, "problems": []},
                "manifestRebuilt": False, "dataVolume": {"totalBytes": total, "uncompressedBytes": None, "bytesPerHourEstimate": total / seconds * 3600},
                "upload": {"target": "synthetic"}}
    data = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True).encode()
    (pkg / "manifest.json").write_bytes(data)
    (pkg / "manifest.sha256").write_text("%s  manifest.json\n" % sha(data))
    apply_faults(pkg, faults)
    return pkg


def apply_faults(pkg, faults):
    for fault in faults:
        if fault == "bad_sha":
            p = pkg / "streams/motion/000001.csv.gz"
            data = bytearray(p.read_bytes()); data[-10] ^= 0xFF; p.write_bytes(bytes(data))
        elif fault == "half_jsonl":
            with open(pkg / "events.jsonl", "a") as f:
                f.write('{"type":"trunc')
        elif fault == "missing_chunk":
            (pkg / "streams/gyro_raw/000002.csv.gz").unlink()
        elif fault == "part_left":
            (pkg / "streams/motion/000099.csv.part").write_text("t_mono\n1\n")
        elif fault == "no_manifest":
            (pkg / "manifest.json").unlink(); (pkg / "manifest.sha256").unlink()
        elif fault == "icloud_placeholder":
            p = pkg / "streams/accel_raw/000003.csv.gz"
            p.unlink(); (p.parent / ".000003.csv.gz.icloud").write_bytes(b"bplist00")
        else:
            raise ValueError("unknown fault " + fault)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seconds", type=int, default=600)
    ap.add_argument("--audio", action="store_true")
    ap.add_argument("--fault", action="append", default=[])
    a = ap.parse_args()
    print(generate(a.out, seconds=a.seconds, audio=a.audio, faults=a.fault))


if __name__ == "__main__":
    main()
