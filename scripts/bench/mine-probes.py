#!/usr/bin/env python3
"""探针挖掘器（基准×探针弧）：扫全部 poly-runs 的 probe-audit.jsonl，
产出问题清单——模型面（错误/重试/时延分布）、工具面（慢调用 Top/错误/
重复模式）、异常指纹聚类。行业基准不做的分析面。"""
import json
import glob
import os
from collections import Counter, defaultdict

RUNS = os.environ.get("BENCH_DIR", "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-bench") + "/poly-runs"

model_calls = []
tool_calls = []
per_ex = {}
for audit in sorted(glob.glob(f"{RUNS}/*/.wudao/probe-audit.jsonl")):
    ex = audit.split("/")[-3]
    rows = []
    for line in open(audit):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        rows.append(e)
        if e["name"] == "model.call":
            model_calls.append((ex, e))
        elif e["name"] == "tool.finish":
            tool_calls.append((ex, e))
    per_ex[ex] = len(rows)

print(f"=== 扫描面：{len(per_ex)} 个工作区，{len(model_calls)} 次模型调用，{len(tool_calls)} 次工具调用 ===\n")

# ① 模型面
lat = sorted(e["data"].get("latencyMs", 0) for _, e in model_calls)
if lat:
    n = len(lat)
    print(f"模型时延: p50={lat[n//2]}ms p90={lat[int(n*0.9)]}ms p99={lat[int(n*0.99)]}ms max={lat[-1]}ms")
errs = [(ex, e) for ex, e in model_calls if not e["data"].get("ok")]
retries = [(ex, e) for ex, e in model_calls if e["data"].get("retry", 0) > 0]
err_kinds = Counter(str(e["data"].get("error"))[:60] for _, e in errs)
print(f"模型错误 {len(errs)} 次：{dict(err_kinds)}")
print(f"梯子重试 {len(retries)} 次")

# ② 工具面
by_tool = defaultdict(lambda: {"n": 0, "ms": 0, "err": 0, "max": 0})
for _, e in tool_calls:
    d = e["data"]
    r = by_tool[d.get("name", "?")]
    r["n"] += 1
    r["ms"] += d.get("dur", 0)
    r["max"] = max(r["max"], d.get("dur", 0))
    if not d.get("ok"):
        r["err"] += 1
print("\n工具画像（按累计时延）：")
for name, r in sorted(by_tool.items(), key=lambda kv: -kv[1]["ms"])[:10]:
    print(f"  {name:18s} ×{r['n']:4d}  累计{r['ms']/1000:8.1f}s  max={r['max']/1000:6.1f}s  err={r['err']}")

# ③ 慢调用 Top
slow = sorted(tool_calls, key=lambda te: -te[1]["data"].get("dur", 0))[:8]
print("\n最慢单次工具调用：")
for ex, e in slow:
    print(f"  {e['data'].get('dur',0)/1000:7.1f}s  {e['data'].get('name')}  @{ex}")

# ④ 模型调用密度（每题调用数分布——多余回合=效率指纹）
per_calls = Counter(ex for ex, _ in model_calls)
dist = Counter(per_calls.values())
print(f"\n每题模型调用数分布：{dict(sorted(dist.items()))}")
heavy = sorted(per_calls.items(), key=lambda kv: -kv[1])[:5]
print(f"最重题：{heavy}")

# ⑤ 工具错误聚类
tool_errs = Counter((e["data"].get("name"), str(e["data"].get("error"))[:50]) for _, e in tool_calls if not e["data"].get("ok"))
if tool_errs:
    print(f"\n工具错误聚类：{dict(tool_errs)}")
