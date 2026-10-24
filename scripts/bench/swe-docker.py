#!/usr/bin/env python3
"""SWE-bench Lite: agent 生成补丁 → Docker 官方评估。

两阶段流水线（标准 SWE-bench 协议）：
  Phase 1（本脚本）：agent 修 bug → git diff → predictions.jsonl
  Phase 2（swe-pipeline.sh）：swebench.harness.run_evaluation 只评估本批

用法: swe-docker.py <start> <count>
- 增量：跳过 OUT 里已有 instance_id 的实例
- 本批补丁同时写 swe-preds-batch.jsonl（Phase 2 单批评估用）
- 2 并发（瓶颈在远程 API，本地 git/agent 工作可重叠）
"""
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import time

REPO = "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-harness"
BENCH = "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-bench"
LITE = f"{BENCH}/swebench-lite"
REPOS = f"{BENCH}/swe-docker-repos"
CLI = f"{REPO}/packages/cli/dist/index.js"
OUT = f"{BENCH}/swe-predictions.jsonl"
BATCH_OUT = f"{BENCH}/swe-preds-batch.jsonl"
MODEL_TAG = "wudao-harness-glm5.3"

key = ""
with open(f"{REPO}/.env") as f:
    for line in f:
        m = re.match(r"WUDAO_API_KEY\s*=\s*(\S+)", line)
        if m:
            key = m.group(1)
            break

CHILD_ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("WUDAO_")},
    "WUDAO_NO_GATES": "1",
    "NO_COLOR": "1",
}


def load_instances():
    import pandas as pd
    df = pd.read_parquet(f"{LITE}/test.parquet")
    return df.to_dict("records")


def load_done():
    done = set()
    if os.path.exists(OUT):
        for line in open(OUT):
            try:
                done.add(json.loads(line)["instance_id"])
            except Exception:
                pass
    return done


def ensure_repo(repo_full, base_commit, iid):
    dest = f"{REPOS}/{iid}"
    if not os.path.isdir(dest):
        os.makedirs(REPOS, exist_ok=True)
        r = subprocess.run(["git", "clone", "-q", "--no-checkout",
                            f"https://github.com/{repo_full}.git", dest],
                           capture_output=True, timeout=3600)
        if r.returncode != 0:
            return None
    subprocess.run(["git", "-C", dest, "checkout", "-q", "-f", base_commit],
                   capture_output=True, timeout=600)
    return dest


def run_agent(inst, ws):
    ps = inst["problem_statement"][:4000]
    f2p = inst["FAIL_TO_PASS"] if isinstance(inst["FAIL_TO_PASS"], list) else []
    prompt = (
        f"修复以下 GitHub issue。仓库已检出在当前目录。\n\n"
        f"# Issue\n{ps}\n\n"
        f"# 目标\n改动相关源码（不碰测试文件）。这些测试应该从挂转绿：\n"
        + "\n".join(f2p[:15])
        + "\n\n只改源码，输出改动摘要。"
    )
    extra = []
    if os.environ.get("BENCH_PROVIDER"):
        extra += ["--provider", os.environ["BENCH_PROVIDER"]]
    if os.environ.get("BENCH_MODEL"):
        extra += ["--model", os.environ["BENCH_MODEL"]]
    agent_env = {**CHILD_ENV}
    if inst["repo"].startswith("django/"):
        agent_env["DJANGO_SETTINGS_MODULE"] = "tests.test_sqlite"
        agent_env["PYTHONPATH"] = ws
    try:
        subprocess.run(
            ["node", CLI, "--trust-workspace", "--no-tui", "--quiet", *extra, prompt],
            cwd=ws, env=agent_env, capture_output=True, text=True, timeout=1800,
        )
    except subprocess.TimeoutExpired:
        pass


def process(inst, label):
    """单实例：clone → agent → diff → 预测条目（或 None）。"""
    iid = inst["instance_id"]
    ws = ensure_repo(inst["repo"], inst["base_commit"], iid)
    if ws is None:
        print(f"[{label:3d}] {iid:44s} clone-fail", flush=True)
        return None
    t0 = time.time()
    run_agent(inst, ws)
    diff = subprocess.run(["git", "-C", ws, "diff"], capture_output=True, text=True, timeout=120).stdout
    # 清理 agent 痕迹（.wudao 目录不进 diff）
    subprocess.run(["git", "-C", ws, "checkout", "-q", "--", "."], capture_output=True)
    # 轨迹抢救：repo 每批后被清，先把 session ledger 拷到持久目录
    # （配 eval 判定 = RL 训练数据；export-trajectory.mjs 消费）
    import glob as _glob
    traj_dest = f"{BENCH}/swe-trajectories/{iid}"
    os.makedirs(traj_dest, exist_ok=True)
    for sf in _glob.glob(f"{ws}/.wudao/sessions/*.jsonl"):
        try:
            shutil.copy2(sf, f"{traj_dest}/{os.path.basename(sf)}")
        except OSError:
            pass
    wall = time.time() - t0
    if diff.strip():
        print(f"[{label:3d}] {iid:44s} patch={len(diff)}B {wall:.0f}s", flush=True)
        return {"instance_id": iid, "model_patch": diff, "model_name_or_path": MODEL_TAG}
    print(f"[{label:3d}] {iid:44s} no-diff {wall:.0f}s", flush=True)
    return None


def main():
    start, count = int(sys.argv[1]), int(sys.argv[2])
    insts = load_instances()[start : start + count]
    done = load_done()
    todo = [(start + i, inst) for i, inst in enumerate(insts)
            if inst["instance_id"] not in done]
    skipped = len(insts) - len(todo)
    if skipped:
        print(f"[skip] {skipped} 个实例已有预测，仅跑 {len(todo)} 个新实例", flush=True)
    preds = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
        futs = {ex.submit(process, inst, label): inst["instance_id"]
                for label, inst in todo}
        for fut in concurrent.futures.as_completed(futs):
            r = fut.result()
            if r:
                preds.append(r)
    # 追加写累积文件 + 覆盖写本批文件
    with open(OUT, "a") as f:
        for p in preds:
            f.write(json.dumps(p) + "\n")
    with open(BATCH_OUT, "w") as f:
        for p in preds:
            f.write(json.dumps(p) + "\n")
    total = sum(1 for _ in open(OUT))
    print(f"\n[SWE predictions] 本批 +{len(preds)} → 累计 {total} 条（{OUT}）", flush=True)


if __name__ == "__main__":
    main()
