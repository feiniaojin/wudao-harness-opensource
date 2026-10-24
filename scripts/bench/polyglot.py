#!/usr/bin/env python3
"""Aider polyglot (JS 子集) harness-mode runner for wudao-harness.

口径对齐 aider 基准：xtest 全部启用；agent 可自行读题/改实现/跑测试
（真 coding-agent 回路）；判分=该题测试通过率（aider 的 headline 指标是
全部练习的测试通过百分比）。经济学数据同 HumanEval 跑分器。

用法: run-poly.py <count> [offset]
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BENCH = os.environ.get("BENCH_DIR", "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-bench")
SRC = f"{BENCH}/polyglot/javascript/exercises/practice"
RUNS = f"{BENCH}/poly-runs"
CLI = f"{REPO}/packages/cli/dist/index.js"

key = os.environ.get("WUDAO_BENCH_KEY", "")
if not key:
    with open(f"{REPO}/.env") as f:
        for line in f:
            m = re.match(r"WUDAO_API_KEY\s*=\s*(\S+)", line)
            if m:
                key = m.group(1)
                break
if not key:
    sys.exit("no key (WUDAO_BENCH_KEY / .env)")

CHILD_ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("WUDAO_")},
    # 跨 provider 对照时不注 env key——各家的 key 走凭证文件（env 会盖）。
    **({} if os.environ.get("BENCH_PROVIDER") else {"WUDAO_API_KEY": key}),
    "WUDAO_NO_GATES": "1",
    # 探针开关透传（on 时每工作区 probe-audit.jsonl 落遥测）。
    **({"WUDAO_PROBE": os.environ["WUDAO_PROBE"]} if os.environ.get("WUDAO_PROBE") else {}),
    "NO_COLOR": "1",
}


def enable_xtests(ws):
    for fn in os.listdir(ws):
        if fn.endswith(".spec.js"):
            p = f"{ws}/{fn}"
            s = open(p).read().replace("xtest(", "test(").replace("xit(", "it(")
            open(p, "w").write(s)


def jest_counts(ws):
    try:
        r = subprocess.run(
            ["npx", "jest", "--json", "--silent"],
            cwd=ws, capture_output=True, text=True, timeout=180,
        )
        out = json.loads(r.stdout)
        passed = failed = 0
        for suite in out.get("testResults", []):
            for a in suite.get("assertionResults", []):
                if a.get("status") == "passed":
                    passed += 1
                elif a.get("status") in ("failed",):
                    failed += 1
        return passed, failed
    except Exception as e:
        return 0, f"err:{type(e).__name__}"


def summarize_probe(path):
    """聚合一题的探针 JSONL：模型面（调用/时延/令牌/缓存/重试/错）+
    工具面（按名计数+累计时延 Top）+ 异常清单（失败/重试/超慢）。"""
    if not os.path.exists(path):
        return None
    mc = {"calls": 0, "latency_ms": 0, "tokens_in": 0, "tokens_out": 0, "cache_hit": 0, "retries": 0, "errors": 0}
    tools_by = {}
    anomalies = []
    for line in open(path):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        d = e.get("data", {})
        if e.get("name") == "model.call":
            mc["calls"] += 1
            mc["latency_ms"] += d.get("latencyMs", 0)
            mc["tokens_in"] += d.get("tokensIn", 0)
            mc["tokens_out"] += d.get("tokensOut", 0)
            mc["cache_hit"] += d.get("cacheHitTokens", 0)
            mc["retries"] += d.get("retry", 0)
            if not d.get("ok"):
                mc["errors"] += 1
                anomalies.append(f"model.err:{str(d.get('error'))[:60]}")
            if d.get("retry", 0) > 0:
                anomalies.append(f"model.retry x{d['retry']}")
        elif e.get("name") == "tool.finish":
            n = d.get("name", "?")
            row = tools_by.setdefault(n, {"n": 0, "ms": 0, "err": 0})
            row["n"] += 1
            row["ms"] += d.get("dur", 0)
            if not d.get("ok"):
                row["err"] += 1
                anomalies.append(f"tool.err:{n} {str(d.get('error'))[:50]}")
            if d.get("dur", 0) > 20000:
                anomalies.append(f"tool.slow:{n} {d['dur']}ms")
    top = sorted(tools_by.items(), key=lambda kv: -kv[1]["ms"])[:6]
    return {
        "model": mc,
        "cache_pct": round(mc["cache_hit"] / mc["tokens_in"] * 100, 1) if mc["tokens_in"] else None,
        "tools_top": [{"name": k, **v} for k, v in top],
        "anomalies": anomalies[:12],
    }


def run_exercise(name):
    src = f"{SRC}/{name}"
    ws = f"{RUNS}/{name}"
    shutil.rmtree(ws, ignore_errors=True)
    shutil.copytree(src, ws)
    enable_xtests(ws)
    # 探针审计（WUDAO_PROBE=on 时生效）：每工作区独立 JSONL。
    os.makedirs(f"{ws}/.wudao", exist_ok=True)
    with open(f"{ws}/.wudao/settings.json", "w") as f:
        json.dump({"probe": {"auditFile": ".wudao/probe-audit.jsonl"}}, f)
    # 依赖就位：jest + @exercism babel preset（npm 缓存暖后 ~5s）
    subprocess.run(
        ["npm", "install", "--no-audit", "--no-fund", "--silent"],
        cwd=ws, capture_output=True, timeout=240,
    )
    impl = f"{name}.js"
    docs = f"{ws}/.docs/instructions.md"
    instructions = open(docs).read() if os.path.exists(docs) else "(见 spec 文件)"
    prompt = (
        f"完成 Exercism 练习「{name}」（JavaScript）。需求说明：\n\n{instructions}\n\n"
        f"契约：在 {impl} 里实现全部要求的函数/类（骨架已给，把 throw 的桩换成真实现）；"
        f"{name}.spec.js 是测试（已启用全部用例，可以读但不要改）。"
        "用 `npx jest` 自行验证，直到全部通过。不要改测试文件和配置。"
    )
    t0 = time.time()
    extra = []
    if os.environ.get("BENCH_PROVIDER"):
        extra += ["--provider", os.environ["BENCH_PROVIDER"]]
    if os.environ.get("BENCH_MODEL"):
        extra += ["--model", os.environ["BENCH_MODEL"]]
    try:
        proc = subprocess.run(
            ["node", CLI, "--trust-workspace", "--no-tui", "--quiet", *extra, prompt],
            cwd=ws, env=CHILD_ENV, capture_output=True, text=True, timeout=900,
        )
        exit_code = proc.returncode
    except subprocess.TimeoutExpired:
        exit_code = -1
    wall = time.time() - t0
    passed, failed = jest_counts(ws)
    econ = {"wall_s": round(wall, 1), "tool_calls": 0, "exit": exit_code}
    probe = summarize_probe(f"{ws}/.wudao/probe-audit.jsonl")
    if probe:
        econ["probe"] = probe
    sess_dir = f"{ws}/.wudao/sessions"
    if os.path.isdir(sess_dir):
        for fn in os.listdir(sess_dir):
            if fn.endswith(".jsonl"):
                for line in open(f"{sess_dir}/{fn}"):
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if d.get("role") == "tool":
                        econ["tool_calls"] += 1
    total = passed + (failed if isinstance(failed, int) else 0)
    ratio = passed / total if total else 0.0
    return {"id": name, "passed": passed, "failed": failed, "ratio": round(ratio, 3), **econ}


def main():
    count = int(sys.argv[1])
    offset = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    names = sorted(os.listdir(SRC))[offset : offset + count]
    results = []
    for i, name in enumerate(names):
        r = run_exercise(name)
        results.append(r)
        ok = "✓全过" if isinstance(r["failed"], int) and r["failed"] == 0 and r["passed"] > 0 else f"{r['passed']}/{r['passed']+r['failed'] if isinstance(r['failed'],int) else '?'}"
        print(f"[{i+1:2d}] {name:28s} {ok:8s} {r['wall_s']}s tools={r['tool_calls']}", flush=True)
    tp = sum(r["passed"] for r in results if isinstance(r.get("failed"), int))
    tf = tp + sum(r["failed"] for r in results if isinstance(r.get("failed"), int))
    print(f"\n测试通过率（aider 口径）: {tp}/{tf} = {tp/tf*100:.1f}%" if tf else "no tests ran")
    with open(f"{BENCH}/poly-results-{offset}-{offset+count}.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
