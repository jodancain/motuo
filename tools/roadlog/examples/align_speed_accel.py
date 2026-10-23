#!/usr/bin/env python3
"""示例：对齐 GPS 速度与 IMU 纵向加速度，画速度 / 加速度 / 高度 / 声学能量曲线。

结论均为**估计**：手机在车上的“前进方向”由最小二乘从数据里推断（GPS 速度差分 ≈ w · user_acc），
不是测量值；GPS 速度约 1 Hz、有自身误差。没有 matplotlib 时输出 CSV 与文字结论。

    python3 tools/roadlog/examples/align_speed_accel.py <包目录> [--out PNG]
"""
import argparse
import csv
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import roadlog_lib as rl  # noqa: E402

G = 9.80665


def solve3(a, b):
    """Gaussian elimination for a 3×3 system; None when singular."""
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(3):
        p = max(range(c, 3), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-12:
            return None
        m[c], m[p] = m[p], m[c]
        for r in range(3):
            if r != c:
                f = m[r][c] / m[c][c]
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    return [m[i][3] / m[i][i] for i in range(3)]


def pearson(x, y):
    n = len(x)
    if n < 3:
        return None
    mx, my = sum(x) / n, sum(y) / n
    sx = math.sqrt(sum((v - mx) ** 2 for v in x))
    sy = math.sqrt(sum((v - my) ** 2 for v in y))
    return None if sx == 0 or sy == 0 else sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy)


def analyse(pkg):
    h, loc = pkg.read_stream("location")
    gps = []
    if loc:
        i_t, i_v = 0, h.index("speed_mps")
        pts = [(r[i_t], r[i_v]) for r in loc if r[i_v] is not None]
        for (t1, v1), (t2, v2) in zip(pts, pts[1:]):
            if 0.5 <= t2 - t1 <= 3:
                gps.append((t1, t2, (v2 - v1) / (t2 - t1)))
    hm, motion = pkg.read_stream("motion")
    imu_t = [r[0] for r in motion]
    acc = [(r[1] * G, r[2] * G, r[3] * G) for r in motion] if motion else []
    # 1 s means of user acceleration over each GPS interval (the window the GPS difference describes).
    import bisect
    pairs = []
    for t1, t2, a in gps:
        lo, hi = bisect.bisect_left(imu_t, t1), bisect.bisect_right(imu_t, t2)
        if hi - lo >= 10:
            n = hi - lo
            mean = tuple(sum(v[k] for v in acc[lo:hi]) / n for k in range(3))
            pairs.append(((t1 + t2) / 2, a, mean))
    result = {"gpsIntervals": len(gps), "pairs": len(pairs), "forward": None, "correlation": None}
    if len(pairs) >= 10:
        ata = [[sum(p[2][i] * p[2][j] for p in pairs) for j in range(3)] for i in range(3)]
        atb = [sum(p[2][i] * p[1] for p in pairs) for i in range(3)]
        w = solve3(ata, atb)
        if w:
            norm = math.sqrt(sum(x * x for x in w))
            unit = [x / norm for x in w]
            proj = [sum(u * a for u, a in zip(unit, p[2])) for p in pairs]
            result.update(forward=unit, scale=norm, correlation=pearson(proj, [p[1] for p in pairs]))
            result["series"] = [(p[0], p[1], pr) for p, pr in zip(pairs, proj)]
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("package")
    ap.add_argument("--out", help="PNG 路径（默认 <包名>-align.png，放在 tools/roadlog/out/）")
    a = ap.parse_args()
    pkg = rl.Package(Path(a.package).expanduser())
    if not pkg.manifest:
        sys.exit("不是完整的路谱包（缺 manifest.json）：%s" % pkg.path)
    out = Path(a.out) if a.out else Path(__file__).resolve().parents[1] / "out" / (pkg.name + "-align.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    r = analyse(pkg)
    print("【估计，非测量】%s" % pkg.name)
    print("GPS 速度差分区间 %d 个，可与 IMU 对齐 %d 个" % (r["gpsIntervals"], r["pairs"]))
    if r["forward"]:
        print("推断的手机“前进方向”（设备坐标单位向量）: x=%.3f y=%.3f z=%.3f · 相关系数 r=%.3f" % (*r["forward"], r["correlation"] or float("nan")))
    else:
        print("数据不足以估计前进方向（需要 ≥10 个 GPS 区间且 IMU 有数据）")
    t0 = (pkg.manifest.get("clock") or {}).get("start", {}).get("t_mono") or 0
    loc_t, speed = pkg.column("location", "speed_mps")
    _, gps_alt = pkg.column("location", "alt_m")
    baro_t, baro = pkg.column("altimeter", "rel_alt_m")
    ac_t, rms = pkg.column("acoustic", "rms_dbfs")
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.rcParams["font.sans-serif"] = ["PingFang SC", "Hiragino Sans GB", "Arial Unicode MS", "Noto Sans CJK SC", "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
    except ImportError:
        csv_path = out.with_suffix(".csv")
        with open(csv_path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["t_rel_s", "gps_accel_mps2", "imu_forward_accel_mps2_estimated"])
            for t, ag, ai in r.get("series", []):
                w.writerow([round(t - t0, 3), ag, ai])
        print("未安装 matplotlib，已输出 %s（python3 -m pip install matplotlib 后可画图）" % csv_path)
        return 0
    fig, ax = plt.subplots(4, 1, figsize=(11, 10), sharex=True)
    rel = lambda ts: [t - t0 for t in ts]
    ax[0].plot(rel(loc_t), [v * 3.6 if v is not None else float("nan") for v in speed], lw=1)
    ax[0].set_ylabel("GPS 速度 km/h")
    if r.get("series"):
        s = r["series"]
        ax[1].plot([x[0] - t0 for x in s], [x[1] for x in s], label="GPS 速度差分", lw=1)
        ax[1].plot([x[0] - t0 for x in s], [x[2] for x in s], label="IMU 投影（估计前进方向）", lw=1)
        ax[1].legend(loc="upper right", fontsize=8)
    else:
        ax[1].text(0.5, 0.5, "无数据", transform=ax[1].transAxes, ha="center")
    ax[1].set_ylabel("纵向加速度 m/s^2")
    if baro:
        ax[2].plot(rel(baro_t), baro, label="气压相对高度", lw=1)
    if any(v is not None for v in gps_alt):
        base = next(v for v in gps_alt if v is not None)
        ax[2].plot(rel(loc_t), [v - base if v is not None else float("nan") for v in gps_alt], label="GPS 海拔（相对首点）", lw=1)
    if baro or gps_alt:
        ax[2].legend(loc="upper right", fontsize=8)
    else:
        ax[2].text(0.5, 0.5, "无数据", transform=ax[2].transAxes, ha="center")
    ax[2].set_ylabel("高度 m")
    if rms:
        ax[3].plot(rel(ac_t), rms, lw=0.5)
    else:
        ax[3].text(0.5, 0.5, "无数据（麦克风未开启）", transform=ax[3].transAxes, ha="center")
    ax[3].set_ylabel("声学 RMS dBFS")
    ax[3].set_xlabel("骑行时间 s")
    fig.suptitle("%s%s" % (pkg.name, " · 模拟数据" if pkg.manifest.get("simulated") else ""), fontsize=9)
    fig.tight_layout()
    fig.savefig(out, dpi=110)
    print("已输出 %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
