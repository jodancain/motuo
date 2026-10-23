#!/usr/bin/env python3
"""Motuo 路谱包工具：list | verify | summary | export.

默认目录：~/Library/Mobile Documents/iCloud~cn~yundongyl~motuo/Documents/Roadlog（App 放进 iCloud Drive 后自动同步到这台 Mac）。
用 --root 指向其他目录（例如从“文件”App/分享面板导出并解压的包）。格式规格见 docs/ROADLOG_FORMAT.md。
"""
import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import roadlog_lib as rl  # noqa: E402

OUT_DEFAULT = Path(__file__).resolve().parent / "out"


def human(n):
    if n is None:
        return "—"
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1000 or unit == "GB":
            return "%.1f %s" % (n, unit) if unit != "B" else "%d B" % n
        n /= 1000.0


def local_time(iso):
    if not iso:
        return "—"
    try:
        t = dt.datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
        return t.astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return iso


def root_hint(root):
    print("没有找到路谱目录：%s" % root, file=sys.stderr)
    print("可能原因：App 还没有完成过真实骑行、iCloud 尚未同步到这台 Mac、或这一版 App 没有 iCloud 能力（仅本地保存）。", file=sys.stderr)
    print("可以用 --root 指向导出/解压的目录。", file=sys.stderr)


def cmd_list(args):
    root = Path(args.root).expanduser()
    packages = rl.find_packages(root)
    if not packages:
        root_hint(root) if not root.exists() else print("目录为空：%s" % root)
        return 0 if root.exists() else 2
    rows = []
    for p in packages:
        m = p.manifest or {}
        size = sum(f.stat().st_size for f in p.path.rglob("*") if f.is_file())
        rows.append({"package": p.name, "startLocal": local_time(m.get("startedAtUTC")), "startUTC": m.get("startedAtUTC"),
                     "durationS": m.get("durationS"), "simulated": m.get("simulated"), "state": p.state(), "bytes": size,
                     "streams": len(p.recorded_streams()) if m else 0, "placeholders": len(p.placeholders())})
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    print("%-60s %-16s %8s %-16s %9s %4s" % ("包", "开始（本地）", "时长", "状态", "大小", "流"))
    for r in rows:
        dur = "%dm%02ds" % divmod(int(r["durationS"]), 60) if r["durationS"] is not None else "—"
        state = r["state"] + (" SIM" if r["simulated"] else "")
        print("%-60s %-16s %8s %-16s %9s %4d" % (r["package"], r["startLocal"], dur, state, human(r["bytes"]), r["streams"]))
        if r["placeholders"]:
            print("    %d 个文件尚未从 iCloud 下载：brctl download \"%s\"" % (r["placeholders"], root / r["package"]))
    return 0


def cmd_verify(args):
    packages = rl.resolve(args.packages, args.root, args.all)
    if not packages:
        root_hint(args.root)
        return 2
    results = [rl.verify(p) for p in packages]
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print("%s  %s  (%s)" % ("OK  " if r["ok"] else "FAIL", r["package"], r["state"]))
            for p in r["problems"]:
                print("    ✗ " + p)
            for w in r["warnings"]:
                print("    ! " + w)
    return 0 if all(r["ok"] for r in results) else 1


def cmd_summary(args):
    packages = rl.resolve(args.packages, args.root, args.all)
    if not packages:
        root_hint(args.root)
        return 2
    results = [rl.summary(p) for p in packages]
    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0
    for s in results:
        print("== %s  [%s%s]" % (s["package"], s["state"], " · 模拟数据" if s.get("simulated") else ""))
        print("   %s → %s  时长 %s s  设备 %s iOS %s  App %s (%s)" % (
            local_time(s.get("startedAtUTC")), local_time(s.get("endedAtUTC")), "%.0f" % (s.get("durationS") or 0),
            (s.get("device") or {}).get("model"), (s.get("device") or {}).get("systemVersion"),
            (s.get("app") or {}).get("version"), (s.get("app") or {}).get("build")))
        if s.get("gps"):
            g = s["gps"]
            print("   GPS 里程 %.2f km · 最高 %.1f km/h · 平均 %.1f km/h · 海拔 %s · %d 个定位点" % (
                g["distanceM"] / 1000, g["maxSpeedKmh"] or 0, g["meanSpeedKmh"] or 0,
                "—" if not g["altitudeRangeM"] else "%.0f–%.0f m" % tuple(g["altitudeRangeM"]), g["fixes"]))
            print("   （%s）" % g["distanceRule"])
        if s.get("barometer") and s["barometer"]["relativeAltitudeRangeM"]:
            print("   气压相对高度 %.1f–%.1f m" % tuple(s["barometer"]["relativeAltitudeRangeM"]))
        print("   %-20s %-11s %-9s %8s %9s %9s %9s %9s" % ("流", "状态", "来源", "行数", "目标Hz", "实测Hz", "p95间隔", "最大间隔"))
        for name, st in (s.get("streams") or {}).items():
            fmt = lambda v, f="%.1f": "—" if v is None else f % v
            print("   %-20s %-11s %-9s %8s %9s %9s %9s %9s" % (name, st["status"], st["source"], st["rows"] or 0, fmt(st.get("requestedHz"), "%g"),
                  fmt(st.get("hzOverall")), fmt(st.get("p95IntervalS"), "%.3fs"), fmt(st.get("maxIntervalS"), "%.2fs")))
            if st.get("reason") and not st.get("rows"):
                print("      └ %s" % st["reason"])
        gaps = s.get("gaps") or {}
        print("   缺口：manifest %d 个，工具检测 %d 个" % (len(gaps.get("manifest", [])), len(gaps.get("detected", []))))
        for g in gaps.get("detected", [])[:8]:
            print("      %s %.1f s（%s）" % (g["stream"], g["durationS"], g["reason"]))
        for d in s.get("degradations") or []:
            print("   降级 L%s %s（剩余 %s）" % (d.get("level"), d.get("action"), human(d.get("freeBytes"))))
        ev = s.get("events") or {}
        print("   事件：%s" % ", ".join("%s×%d" % kv for kv in sorted((ev.get("byType") or {}).items())))
        if ev.get("signalKinds"):
            print("   推断事件：%s" % ", ".join("%s×%d" % kv for kv in sorted(ev["signalKinds"].items())))
        dl = s.get("deviceLog") or {}
        if dl.get("battery"):
            print("   电量 %.0f%% → %.0f%% · 热状态 %s" % (dl["battery"][0] * 100, dl["battery"][1] * 100, "/".join(dl["thermalStates"]) or "—"))
        vol = s.get("dataVolume") or {}
        print("   数据量 %s，约 %s/小时" % (human(vol.get("totalBytes")), human(vol.get("bytesPerHourEstimate"))))
    return 0


def cmd_export(args):
    packages = rl.resolve(args.packages, args.root, args.all)
    if not packages:
        root_hint(args.root)
        return 2
    streams = [s for s in args.streams.split(",") if s] if args.streams else None
    for p in packages:
        result = rl.export(p, args.out, args.format, streams)
        print("%s → %s（%s，%d 个文件）" % (p.name, result["dir"], result["format"], len(result["files"])))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=str(rl.DEFAULT_ROOT), help="路谱目录（默认 iCloud Drive 中的 Motuo/Roadlog）")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list", help="列出骑行包")
    p.add_argument("--json", action="store_true")
    for name, helptext in (("verify", "校验 manifest、块校验和、gzip、表头、行数、时间单调"), ("summary", "每次骑行摘要")):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("packages", nargs="*", help="包目录或包名（默认全部）")
        p.add_argument("--all", action="store_true")
        p.add_argument("--json", action="store_true")
    p = sub.add_parser("export", help="合并导出为 Parquet（有 pyarrow）或 CSV")
    p.add_argument("packages", nargs="*")
    p.add_argument("--all", action="store_true")
    p.add_argument("--out", default=str(OUT_DEFAULT))
    p.add_argument("--format", choices=["auto", "parquet", "csv"], default="auto")
    p.add_argument("--streams", help="逗号分隔，默认全部有数据的流")
    args = parser.parse_args(argv)
    return {"list": cmd_list, "verify": cmd_verify, "summary": cmd_summary, "export": cmd_export}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
