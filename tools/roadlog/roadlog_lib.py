"""Read, verify and summarise Motuo roadlog packages (schema v1, see docs/ROADLOG_FORMAT.md).

Standard library only. pandas / pyarrow / matplotlib are optional and only used by export / examples.
"""
import bisect
import csv
import gzip
import hashlib
import io
import json
import math
import os
import statistics
from pathlib import Path

SCHEMA = "motuo.roadlog"
DEFAULT_ROOT = Path("~/Library/Mobile Documents/iCloud~cn~yundongyl~motuo/Documents/Roadlog").expanduser()
LOG_FILES = ("events", "device", "clock", "accessory", "index")
IMU_STREAMS = {"motion", "accel_raw", "gyro_raw", "mag_raw", "batched_accel", "batched_motion"}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def read_jsonl(path):
    """Complete lines only. Returns (records, has_partial_tail, bad_lines)."""
    path = Path(path)
    if not path.exists():
        return [], False, 0
    data = path.read_bytes()
    partial = bool(data) and not data.endswith(b"\n")
    lines = data.split(b"\n")
    if partial:
        lines = lines[:-1]
    records, bad = [], 0
    for line in lines:
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except ValueError:
            bad += 1
    return records, partial, bad


def parse_value(text):
    return float(text) if text != "" else None


class ClockMap:
    """t_mono (systemUptime s) → t_unix using the nearest clock.jsonl sample."""

    def __init__(self, records):
        pairs = sorted((r["t_mono"], r["t_unix"]) for r in records if "t_mono" in r and "t_unix" in r)
        self.mono = [p[0] for p in pairs]
        self.unix = [p[1] for p in pairs]

    def __bool__(self):
        return bool(self.mono)

    def to_unix(self, t):
        if not self.mono or t is None:
            return None
        i = bisect.bisect_left(self.mono, t)
        if i == len(self.mono) or (i > 0 and abs(self.mono[i - 1] - t) <= abs(self.mono[i] - t)):
            i -= 1
        return self.unix[i] + (t - self.mono[i])


class Package:
    def __init__(self, path):
        self.path = Path(path)
        self.name = self.path.name
        self._manifest = None

    # iCloud keeps not-yet-downloaded files as hidden ".<name>.icloud" placeholders on the Mac.
    def placeholders(self):
        return sorted(str(p.relative_to(self.path)) for p in self.path.rglob(".*.icloud"))

    def file(self, relative):
        return self.path / relative

    def placeholder_for(self, relative):
        p = self.path / relative
        return p.with_name("." + p.name + ".icloud")

    @property
    def manifest(self):
        if self._manifest is None:
            p = self.path / "manifest.json"
            if p.exists():
                try:
                    self._manifest = json.loads(p.read_text(encoding="utf-8"))
                except ValueError:
                    self._manifest = {}
        return self._manifest

    def state(self):
        """sealed | recovered | recording | incomplete-sync | not-downloaded | invalid"""
        m = self.manifest
        if m is None:
            if self.placeholder_for("manifest.json").exists():
                return "not-downloaded"
            return "incomplete-sync"
        if not m or m.get("schema") != SCHEMA:
            return "invalid"
        if self.placeholders():
            return "not-downloaded"
        missing = [c["file"] for c in self.all_entries() if not self.file(c["file"]).exists()]
        if missing:
            return "incomplete-sync"
        return m.get("status", "invalid")

    def all_entries(self):
        m = self.manifest or {}
        entries = []
        for stream in (m.get("streams") or {}).values():
            entries.extend(stream.get("chunks") or [])
        entries.extend(((m.get("audio") or {}).get("segments")) or [])
        return entries

    def streams(self):
        return (self.manifest or {}).get("streams") or {}

    def recorded_streams(self):
        return [k for k, v in sorted(self.streams().items()) if v.get("rows")]

    def clock(self):
        return ClockMap(read_jsonl(self.path / "clock.jsonl")[0])

    def jsonl(self, name):
        return read_jsonl(self.path / (name + ".jsonl"))[0]

    def read_stream(self, stream):
        """Returns (header, rows) with rows as lists of float|None, chunks concatenated in order."""
        info = self.streams().get(stream) or {}
        header, rows = None, []
        for chunk in sorted(info.get("chunks") or [], key=lambda c: c["seq"]):
            with gzip.open(self.file(chunk["file"]), "rt", encoding="utf-8", newline="") as f:
                reader = csv.reader(f)
                h = next(reader, None)
                header = header or h
                for r in reader:
                    rows.append([parse_value(v) for v in r])
        if header is None:
            header = [c["name"] for c in info.get("columns") or []]
        return header, rows

    def column(self, stream, name):
        header, rows = self.read_stream(stream)
        if name not in header:
            return [], []
        i = header.index(name)
        return [r[0] for r in rows], [r[i] for r in rows]


def find_packages(root=DEFAULT_ROOT):
    root = Path(root).expanduser()
    if not root.exists():
        return []
    if (root / "manifest.json").exists() or (root / "session.json").exists():
        return [Package(root)]
    return [Package(p) for p in sorted(root.iterdir()) if p.is_dir() and not p.name.startswith(".")]


def resolve(names, root=DEFAULT_ROOT, all_=False):
    if all_ or not names:
        return find_packages(root)
    out = []
    for n in names:
        p = Path(n).expanduser()
        if not p.exists():
            p = Path(root).expanduser() / n
        out.append(Package(p))
    return out


# --------------------------------------------------------------------------------------------- verify

def verify(pkg):
    """Returns {"ok": bool, "problems": [...], "warnings": [...]}."""
    problems, warnings = [], []
    m = pkg.manifest
    if m is None:
        state = pkg.state()
        problems.append("manifest.json 缺失（%s：iCloud 可能尚未同步完，或包未封好）" % state)
        return {"package": pkg.name, "ok": False, "state": state, "problems": problems, "warnings": warnings}
    if m.get("schema") != SCHEMA or m.get("schemaVersion") != 1:
        problems.append("不是 schema v1 路谱包：%r/%r" % (m.get("schema"), m.get("schemaVersion")))
    # 1.1 起有 schemaMinor；1.0 包没有该字段。任何 minor 都按 v1 读取。
    for name, info in sorted((m.get("streams") or {}).items()):
        if info.get("clockSuspect") or (name == "abs_altitude" and (info.get("tStart") or 0) > 1e8):
            warnings.append("%s: 时间戳不在单调时钟上（schema 1.0 的 CMAbsoluteAltitude 用了 2001 参考日期），该流的 t_mono 不可与其他流对齐" % name)
    sha_file = pkg.path / "manifest.sha256"
    if not sha_file.exists():
        problems.append("缺少 manifest.sha256")
    elif sha_file.read_text().split()[0] != sha256_file(pkg.path / "manifest.json"):
        problems.append("manifest.sha256 与 manifest.json 不符")
    if m.get("status") not in ("sealed", "recovered"):
        problems.append("包状态为 %r（未封包）" % m.get("status"))
    if m.get("status") == "recovered":
        warnings.append("包在 App 被终止后恢复：最后不足一秒的数据可能缺失")
    for p in sorted(pkg.path.rglob("*.csv.part")):
        warnings.append("残留未封块 %s（App 未完成恢复；数据不在 manifest 中）" % p.relative_to(pkg.path))
    for p in pkg.placeholders():
        problems.append("文件尚未从 iCloud 下载：%s（brctl download 或在 Finder 中下载）" % p)

    for name, info in sorted(pkg.streams().items()):
        columns = [c["name"] for c in info.get("columns") or []]
        last_t, rows_total = None, 0
        for chunk in sorted(info.get("chunks") or [], key=lambda c: c["seq"]):
            path = pkg.file(chunk["file"])
            if not path.exists():
                where = "（尚未下载）" if pkg.placeholder_for(chunk["file"]).exists() else ""
                problems.append("%s: 缺少 %s%s" % (name, chunk["file"], where))
                continue
            if path.stat().st_size != chunk.get("bytes"):
                problems.append("%s: %s 字节数 %d ≠ manifest %s" % (name, chunk["file"], path.stat().st_size, chunk.get("bytes")))
            if sha256_file(path) != chunk.get("sha256"):
                problems.append("%s: %s SHA-256 不符" % (name, chunk["file"]))
                continue
            try:
                raw = gzip.decompress(path.read_bytes())
            except (OSError, EOFError) as e:
                problems.append("%s: %s 无法完整解压：%s" % (name, chunk["file"], e))
                continue
            if chunk.get("uncompressed_bytes") is not None and len(raw) != chunk["uncompressed_bytes"]:
                problems.append("%s: %s 解压长度不符" % (name, chunk["file"]))
            reader = csv.reader(io.StringIO(raw.decode("utf-8")))
            header = next(reader, [])
            if header != columns:
                problems.append("%s: %s 表头与 manifest 列定义不一致" % (name, chunk["file"]))
            n, first, last = 0, None, None
            for r in reader:
                if len(r) != len(header):
                    problems.append("%s: %s 第 %d 行列数 %d ≠ %d" % (name, chunk["file"], n + 2, len(r), len(header)))
                    break
                t = float(r[0])
                if last_t is not None and t < last_t:
                    problems.append("%s: t_mono 倒退（%s 第 %d 行）" % (name, chunk["file"], n + 2))
                    break
                last_t = t
                first = t if first is None else first
                last = t
                n += 1
            if n != chunk.get("rows"):
                problems.append("%s: %s 行数 %d ≠ manifest %s" % (name, chunk["file"], n, chunk.get("rows")))
            if first is not None and (abs(first - chunk["t_start"]) > 1e-5 or abs(last - chunk["t_end"]) > 1e-5):
                problems.append("%s: %s 时间范围与 manifest 不符" % (name, chunk["file"]))
            rows_total += n
        if rows_total != (info.get("rows") or 0) and not any(name in p for p in problems):
            problems.append("%s: 总行数 %d ≠ manifest %s" % (name, rows_total, info.get("rows")))

    for seg in ((m.get("audio") or {}).get("segments")) or []:
        path = pkg.file(seg["file"])
        if not path.exists():
            problems.append("音频缺少 %s" % seg["file"])
        elif sha256_file(path) != seg.get("sha256") or path.stat().st_size != seg.get("bytes"):
            problems.append("音频 %s 校验不符" % seg["file"])
        elif seg.get("recovered"):
            warnings.append("音频 %s 在终止后恢复，可能无法播放" % seg["file"])

    index, partial, bad = read_jsonl(pkg.path / "index.jsonl")
    if partial or bad:
        warnings.append("index.jsonl 有未写完/损坏的行（%d）" % (bad + int(partial)))
    listed = {(c["file"], c["sha256"]) for c in pkg.all_entries()}
    for entry in index:
        if (entry.get("file"), entry.get("sha256")) not in listed:
            problems.append("index.jsonl 的 %s 不在 manifest 中" % entry.get("file"))
    if len(index) != len(listed):
        problems.append("index.jsonl 条目数 %d ≠ manifest %d" % (len(index), len(listed)))

    for name, info in sorted((m.get("files") or {}).items()):
        path = pkg.path / info["file"]
        if not path.exists():
            problems.append("缺少 %s" % info["file"])
            continue
        if sha256_file(path) != info.get("sha256"):
            problems.append("%s SHA-256 与 manifest 不符" % info["file"])
        if info["file"].endswith(".jsonl"):
            _, partial, bad = read_jsonl(path)
            if partial:
                warnings.append("%s 末尾有未写完的一行（已忽略）" % info["file"])
            if bad:
                problems.append("%s 有 %d 行无法解析" % (info["file"], bad))
    return {"package": pkg.name, "ok": not problems, "state": pkg.state(), "problems": problems, "warnings": warnings}


# --------------------------------------------------------------------------------------------- summary

def haversine(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


DISTANCE_RULE = "相邻 GPS 点 haversine 求和；跳过 h_acc_m 缺失或 > 50 m 的点，以及间隔 > 10 s 或隐含速度 > 70 m/s 的段"


def gps_distance(header, rows):
    idx = {n: i for i, n in enumerate(header)}
    total, prev = 0.0, None
    for r in rows:
        lat, lon, acc = r[idx["lat"]], r[idx["lon"]], r[idx["h_acc_m"]]
        if lat is None or lon is None or acc is None or acc > 50:
            continue
        if prev is not None:
            dt = r[0] - prev[0]
            d = haversine(prev[1], prev[2], lat, lon)
            if 0 < dt <= 10 and d / dt <= 70:
                total += d
        prev = (r[0], lat, lon)
    return total


def interval_stats(times):
    if len(times) < 2:
        return {"medianIntervalS": None, "hzFromMedian": None, "p95IntervalS": None, "maxIntervalS": None, "hzOverall": None}
    d = sorted(b - a for a, b in zip(times, times[1:]))
    med = statistics.median(d)
    p95 = d[min(len(d) - 1, int(math.ceil(0.95 * len(d))) - 1)]
    span = times[-1] - times[0]
    return {"medianIntervalS": med, "hzFromMedian": (1 / med) if med > 0 else None, "p95IntervalS": p95, "maxIntervalS": d[-1],
            "hzOverall": (len(times) - 1) / span if span > 0 else None}


def detect_gaps(stream, times, paused):
    """Spec rule: IMU spacing > max(5×median, 0.5 s), location > 3 s; spans overlapping a pause are reported as paused."""
    if len(times) < 2:
        return []
    if stream in IMU_STREAMS:
        med = statistics.median(b - a for a, b in zip(times, times[1:]))
        limit = max(5 * med, 0.5)
    elif stream == "location":
        limit = 3.0
    else:
        return []
    gaps = []
    for a, b in zip(times, times[1:]):
        if b - a > limit:
            reason = "paused" if any(ps <= b and pe >= a for ps, pe in paused) else ("gps_lost" if stream == "location" else "sensor_stall")
            gaps.append({"stream": stream, "tStart": a, "tEnd": b, "durationS": b - a, "reason": reason})
    return gaps


def summary(pkg):
    m = pkg.manifest or {}
    out = {"package": pkg.name, "state": pkg.state(), "rideId": m.get("rideId"), "simulated": m.get("simulated"),
           "provenance": m.get("provenance"), "startedAtUTC": m.get("startedAtUTC"), "endedAtUTC": m.get("endedAtUTC"),
           "durationS": m.get("durationS"), "device": m.get("device"), "app": m.get("app"), "vehicle": m.get("vehicle")}
    if not m:
        return out
    paused = [(g.get("tStart"), g.get("tEnd")) for g in m.get("gaps") or [] if g.get("reason") == "paused" and g.get("tStart") is not None]
    streams, detected = {}, []
    for name, info in sorted(pkg.streams().items()):
        entry = {"status": info.get("status"), "source": info.get("source"), "rows": info.get("rows"), "requestedHz": info.get("requestedHz"),
                 "manifestHz": info.get("measuredHz"), "reason": info.get("reason")}
        if info.get("rows"):
            header, rows = pkg.read_stream(name)
            times = [r[0] for r in rows]
            entry.update(interval_stats(times))
            entry["bytes"] = sum(c.get("bytes", 0) for c in info.get("chunks") or [])
            detected += detect_gaps(name, times, paused)
            if name == "location":
                idx = {n: i for i, n in enumerate(header)}
                speeds = [r[idx["speed_mps"]] for r in rows if r[idx["speed_mps"]] is not None]
                alts = [r[idx["alt_m"]] for r in rows if r[idx["alt_m"]] is not None]
                out["gps"] = {"distanceM": gps_distance(header, rows), "distanceRule": DISTANCE_RULE,
                              "maxSpeedKmh": max(speeds) * 3.6 if speeds else None,
                              "meanSpeedKmh": statistics.mean(speeds) * 3.6 if speeds else None,
                              "altitudeRangeM": [min(alts), max(alts)] if alts else None, "fixes": len(rows)}
            if name == "altimeter":
                rel = [r[1] for r in rows if r[1] is not None]
                out["barometer"] = {"relativeAltitudeRangeM": [min(rel), max(rel)] if rel else None}
        streams[name] = entry
    out["streams"] = streams
    out["gaps"] = {"manifest": m.get("gaps") or [], "detected": detected}
    out["degradations"] = m.get("degradations") or []
    events = pkg.jsonl("events")
    counts, kinds = {}, {}
    for e in events:
        counts[e.get("type")] = counts.get(e.get("type"), 0) + 1
        if e.get("type") == "signal_event":
            kinds[e.get("kind")] = kinds.get(e.get("kind"), 0) + 1
    out["events"] = {"byType": counts, "signalKinds": kinds}
    out["schema"] = "%s %s.%s" % (m.get("schema"), m.get("schemaVersion"), m.get("schemaMinor", 0))
    # 1.1：App 推断的车辆状态（vehicle_state 流，10 Hz）。占比按行数；均为推断，不是测量。
    if (m.get("streams") or {}).get("vehicle_state", {}).get("rows"):
        header, rows = pkg.read_stream("vehicle_state")
        idx = {n: i for i, n in enumerate(header)}
        names = {"engine": ["unknown", "off", "idle", "running", "revving"],
                 "motion": ["stopped", "launching", "accelerating", "cruising", "braking", "hardBraking", "coasting"]}
        share = {}
        for field, labels in names.items():
            values = [int(r[idx[field]]) for r in rows if r[idx[field]] is not None]
            share[field] = {labels[v]: round(values.count(v) / len(values), 3) for v in sorted(set(values)) if 0 <= v < len(labels)} if values else {}
        corners = [e for e in events if e.get("type") == "vehicle_corner"]
        out["vehicleState"] = {"source": m["streams"]["vehicle_state"].get("source"), "rows": len(rows), "share": share,
                               "corners": {"left": sum(1 for c in corners if c.get("dir") == "left"), "right": sum(1 for c in corners if c.get("dir") == "right")},
                               "suspectedShift": sum(1 for e in events if e.get("type") == "vehicle_suspectedShift")}
    device = pkg.jsonl("device")
    battery = [d.get("battery_level") for d in device if isinstance(d.get("battery_level"), (int, float))]
    out["deviceLog"] = {"records": len(device), "battery": [battery[0], battery[-1]] if battery else None,
                        "thermalStates": sorted({d.get("thermal_state") for d in device if d.get("thermal_state")})}
    vol = m.get("dataVolume") or {}
    out["dataVolume"] = {"totalBytes": vol.get("totalBytes"), "bytesPerHourEstimate": vol.get("bytesPerHourEstimate")}
    return out


# --------------------------------------------------------------------------------------------- export

def export(pkg, out_dir, fmt="auto", streams=None):
    """One table per stream with an added t_unix column (clock.jsonl mapping), plus events/device."""
    out_dir = Path(out_dir) / pkg.name
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        import pyarrow as pa  # noqa: F401
        import pyarrow.parquet as pq
        have_arrow = True
    except ImportError:
        have_arrow = False
    if fmt == "auto":
        fmt = "parquet" if have_arrow else "csv"
    if fmt == "parquet" and not have_arrow:
        raise SystemExit("需要 pyarrow 才能导出 Parquet：python3 -m pip install pyarrow（或用 --format csv）")
    clock = pkg.clock()
    written = []
    for name in streams or pkg.recorded_streams():
        header, rows = pkg.read_stream(name)
        if not rows:
            continue
        cols = list(header)
        has_unix = "t_unix" in cols
        if not has_unix:
            cols.insert(1, "t_unix")
            rows = [[r[0], clock.to_unix(r[0])] + r[1:] for r in rows]
        if fmt == "parquet":
            table = pa.table({c: [r[i] for r in rows] for i, c in enumerate(cols)})
            path = out_dir / (name + ".parquet")
            pq.write_table(table, path)
        else:
            path = out_dir / (name + ".csv")
            with open(path, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(cols)
                for r in rows:
                    w.writerow(["" if v is None else repr(v) for v in r])
        written.append(str(path))
    for log in ("events", "device", "accessory"):
        records = pkg.jsonl(log)
        if not records:
            continue
        keys = sorted({k for r in records for k in r})
        path = out_dir / (log + ".csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            for r in records:
                w.writerow({k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v) for k, v in r.items()})
        written.append(str(path))
    (out_dir / "manifest.json").write_text(json.dumps(pkg.manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"format": fmt, "files": written, "dir": str(out_dir)}
