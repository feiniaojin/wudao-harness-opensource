#!/usr/bin/env python3
"""HumanEval harness-mode runner for wudao-harness.

行业基准适配器（永续迭代 v8 基准弧）：每题走完整 agent 回路——
读题（user message）→ agent 用 write_file 写 solution.py → 本脚本以
官方 canonical tests 判分（隔离 python3 子进程，10s 帽）——同时从会话
JSONL 采集经济学数据（run_stats_receipt + 工具调用计数），这是行业
基准不测的维度。

用法: run-bench.py <start> <count>   （题号区间采样）
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BENCH = os.environ.get("BENCH_DIR", "external/humaneval")
CLI = f"{REPO}/packages/cli/dist/index.js"
TAG = os.environ.get("BENCH_TAG", "ds")
RUNS = f"{BENCH}/runs-{TAG}"

# Child env: 显式携带 dev key（/tmp 无 .env 可走，避免 no-key）。
key = os.environ.get("WUDAO_BENCH_KEY", "")
if not key:
    with open(f"{REPO}/.env") as f:
        for line in f:
            m = re.match(r"WUDAO_API_KEY\s*=\s*(\S+)", line)
            if m:
                key = m.group(1)
                break
if not key and not os.environ.get("BENCH_PROVIDER"):
    sys.exit("no key (WUDAO_BENCH_KEY / .env)")

CHILD_ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("WUDAO_")},
    # 跨 provider 对照时 env key 会盖凭证文件——只在缺省 deepseek 下注入；
    # glm/kimi/minimax 各自的 key 走 ~/.wudao/.credentials.yaml。
    **({} if os.environ.get("BENCH_PROVIDER") else {"WUDAO_API_KEY": key}),
    "WUDAO_NO_GATES": "1",
    "NO_COLOR": "1",
}


def load_tasks():
    rows = [json.loads(l) for l in open(f"{BENCH}/HumanEval.jsonl")]
    return rows


def build_prompt(task):
    return (
        "在当前目录的 solution.py 文件里实现下面的 Python 函数（保持函数名与签名不变，"
        "完整实现 docstring 描述的契约）。只写实现本身，不要写测试代码，不要修改其他文件。\n\n"
        "```python\n" + task["prompt"] + "```\n"
    )


def judge(task, sol_path):
    """官方 canonical 判分（隔离 python3，10s 帽）。返回 (ok, err_kind)。"""
    try:
        harness = (
            open(sol_path).read()
            + "\n\n"
            + task["test"]
            + f"\ncheck({task['entry_point']})\nprint('PASS')\n"
        )
        r = subprocess.run(
            ["python3", "-c", harness],
            cwd=os.path.dirname(sol_path),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode == 0 and "PASS" in r.stdout:
            return True, None
        return False, (r.stderr.strip().splitlines() or ["runtime"])[-1][:80]
    except subprocess.TimeoutExpired:
        return False, "timeout"


def run_task(task, idx):
    tid = task["task_id"].replace("/", "_")
    ws = f"{RUNS}/{tid}"
    shutil.rmtree(ws, ignore_errors=True)
    os.makedirs(ws, exist_ok=True)
    extra = []
    if os.environ.get("BENCH_PROVIDER"):
        extra += ["--provider", os.environ["BENCH_PROVIDER"]]
    if os.environ.get("BENCH_MODEL"):
        extra += ["--model", os.environ["BENCH_MODEL"]]
    prompt = build_prompt(task)
    t0 = time.time()

    def invoke(effort=None):
        cmd = ["node", CLI, "--trust-workspace", "--no-tui", "--quiet", *extra]
        if effort is not None:
            cmd += ["--reasoning-effort", effort]
        cmd.append(prompt)
        shutil.rmtree(f"{ws}/.wudao", ignore_errors=True)
        return subprocess.run(cmd, cwd=ws, env=CHILD_ENV, capture_output=True, text=True, timeout=300)

    proc = invoke()
    wall = time.time() - t0
    sol = f"{ws}/solution.py"
    ok, err_kind = (False, "no-file") if not os.path.exists(sol) else judge(task, sol)
    # 通用兜底层（任务无关）：
    # ① reasoning 烧穿（stop=length 零产出/无文件）→ 降思考档重跑
    # ② 文件在但判分挂 → fresh 重跑（effort none，模型重读题面）
    if not ok:
        proc = invoke(effort="none")
        if os.path.exists(sol):
            ok, err_kind = judge(task, sol)
    wall = time.time() - t0
    econ = {"wall_s": round(wall, 1), "tool_calls": 0, "receipt": None, "exit": proc.returncode}
    sess_dir = f"{ws}/.wudao/sessions"
    if os.path.isdir(sess_dir):
        for fn in os.listdir(sess_dir):
            if not fn.endswith(".jsonl"):
                continue
            for line in open(f"{sess_dir}/{fn}"):
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("role") == "tool":
                    econ["tool_calls"] += 1
                if d.get("type") == "run_stats_receipt":
                    econ["receipt"] = d.get("data", {}).get("text", "")
    return {"id": task["task_id"], "ok": ok, "err": err_kind, **econ}


def main():
    start, count = int(sys.argv[1]), int(sys.argv[2])
    tasks = load_tasks()[start : start + count]
    results = []
    for i, t in enumerate(tasks):
        try:
            r = run_task(t, start + i)
        except subprocess.TimeoutExpired:
            r = {"id": t["task_id"], "ok": False, "err": "agent-timeout"}
        results.append(r)
        mark = "✓" if r["ok"] else f"✗ {r['err']}"
        print(f"[{start+i+1:3d}] {t['task_id']:24s} {mark:20s} {r['wall_s']}s tools={r['tool_calls']}", flush=True)
    npass = sum(1 for r in results if r["ok"])
    print(f"\npass@1 (n={len(results)}): {npass}/{len(results)} = {npass/len(results)*100:.1f}%")
    with open(f"{BENCH}/results-{TAG}-{start}-{start+count}.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
