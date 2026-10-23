#!/usr/bin/env python3
"""Plot a replay-report series (tools/vehicle-state/replay-report.mjs output) — speed, longitudinal G, yaw with detected and
reference corners, state bands. Inputs hold only estimator outputs and speed (no positions).

usage: python3 tools/vehicle-state/plot-replay.py <series-*.json> <out.png>   (needs matplotlib)
"""
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

for name in ["PingFang SC", "Heiti SC", "Hiragino Sans GB", "Arial Unicode MS"]:
    if any(name in f.name for f in font_manager.fontManager.ttflist):
        plt.rcParams["font.family"] = name
        break
plt.rcParams["axes.unicode_minus"] = False

src, out = sys.argv[1], sys.argv[2]
d = json.load(open(src))
s, ev, ref = d["series"], d["events"], d.get("reference") or {}
t = s["t"]
fig, ax = plt.subplots(5, 1, figsize=(15, 15), sharex=True, gridspec_kw={"height_ratios": [2, 1.4, 1.6, 1, 1]})
spd = [None if v is None else v * 3.6 for v in s["speed"]]
ax[0].plot(t, spd, color="#1f77b4", lw=1.2, label="估计器使用的速度（GPS）")
brakes = [e for e in ev if e["type"] == "state" and e["field"] == "motion"]
cur = None
for e in brakes:
    if cur and e["to"] not in ("braking", "hardBraking"):
        ax[0].axvspan(cur[0], e["t"], color="#d62728" if cur[1] == "hardBraking" else "#ff9896", alpha=.35, lw=0); cur = None
    if not cur and e["to"] in ("braking", "hardBraking"):
        cur = (e["t"], e["to"])
    elif cur and e["to"] == "hardBraking":
        cur = (cur[0], "hardBraking")
for e in ev:
    if e["type"] == "suspectedShift":
        ax[0].axvline(e["t"], color="#ff7f0e", lw=.8, ls="--")
ax[0].set_ylabel("km/h"); ax[0].set_title("速度（红区 = 推断的刹车段，深红 = 急刹；橙虚线 = 疑似换挡，低置信度）"); ax[0].legend(loc="upper right")
ax[1].plot(t, s["longG"], color="#2ca02c", lw=.8); ax[1].axhline(0, color="k", lw=.5)
ax[1].set_ylabel("g"); ax[1].set_title("纵向加速度（推断：GPS 斜率 + 安装轴收敛后的 IMU 补充）")
ax[2].plot(t, s["yaw"], color="#9467bd", lw=.8, label="偏航角速度（绕真实竖直轴，二级低通）")
for e in ev:
    if e["type"] == "corner":
        ax[2].axvspan(e["start"], e["end"], color="#17becf" if e["dir"] == "left" else "#e377c2", alpha=.3, lw=0)
for r in ref.get("corners") or []:
    ax[2].axvline(r, color="k", lw=1, ls=":")
ax[2].axhline(0, color="k", lw=.5); ax[2].set_ylabel("°/s")
ax[2].set_title("转弯：青 = 检测到的左弯，粉 = 右弯；黑点线 = 人工参考弯（未给方向）"); ax[2].legend(loc="upper right")
codes = {"engine": ["unknown", "off", "idle", "running", "revving"], "motion": ["stopped", "launching", "accelerating", "cruising", "coasting", "braking", "hardBraking"]}
for i, field in enumerate(["engine", "motion"]):
    labels = codes[field]
    ax[3 + i].scatter(t, [labels.index(v) if v in labels else -1 for v in s[field]], s=1.5, color="#333")
    ax[3 + i].set_yticks(range(len(labels))); ax[3 + i].set_yticklabels(labels); ax[3 + i].set_title({"engine": "发动机推断", "motion": "运动推断"}[field])
for a in [ref.get("stops") or [], [ref.get("redLight")] if ref.get("redLight") else []]:
    for w in a:
        for k in (0, 3, 4):
            ax[k].axvspan(w[0], w[1], color="#bbbbbb", alpha=.18, lw=0)
ax[-1].set_xlabel("回放开始后秒数（灰区 = 参考静止 / 红灯段）")
fig.tight_layout(); fig.savefig(out, dpi=110)
print(out)
