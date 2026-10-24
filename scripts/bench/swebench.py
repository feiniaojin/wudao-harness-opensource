#!/usr/bin/env python3
"""SWE-bench Lite attempt 式跑分器（无 docker 本地线）。

协议（attempt 模式）：每实例 = 目标 repo 检出 base_commit → agent 拿
problem_statement 修 → git diff 为提交补丁 → 对照 gold patch 的
FAIL_TO_PASS 测试（本地跑 pytest）判 resolved。无 docker：用本地
python3 + 仓库自带测试环境（每 repo 一次性 pip install -e .）。
环境失败/依赖编译失败的实例 = 跳过并如实记 skipped。

用法: swebench.py <start> <count>
"""
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
RUNS = f"{BENCH}/swe-runs"
REPOS = f"{BENCH}/swe-repos"
CLI = f"{REPO}/packages/cli/dist/index.js"

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


def ensure_repo(repo_full, base_commit, instance_id=""):
    """目标 repo：每实例独立目录（共享 clone 的 venv 绑定旧 commit——
    pip install -e . 指向 checkout 时的源码，换 commit 后包失效）。"""
    suffix = f"--{instance_id}" if instance_id else ""
    dest = f"{REPOS}/{repo_full.replace('/', '__')}{suffix}"
    if not os.path.isdir(dest):
        os.makedirs(REPOS, exist_ok=True)
        r = subprocess.run(["git", "clone", "-q", "--no-checkout", f"https://github.com/{repo_full}.git", dest],
                           capture_output=True, timeout=1800)
        if r.returncode != 0:
            return None
    # 检出 base（detached，--no-checkout 克隆后首次 checkout）
    subprocess.run(["git", "-C", dest, "checkout", "-q", "-f", base_commit], capture_output=True, timeout=600)
    env_stamp = f"{dest}/.wudao-env-{base_commit[:10]}"
    venv = f"{dest}/.venv-bench"
    if not os.path.exists(env_stamp):
        if not os.path.exists(f"{venv}/bin/python"):
            subprocess.run([sys.executable, "-m", "venv", venv], capture_output=True, timeout=300)
        # pip 安装结果必须核验（失败不盖戳——astropy 老依赖链装不上要如实
        # 记 env-fail，django 系成功才放行）；失败重试一次。
        for attempt in range(2):
            r = subprocess.run([f"{venv}/bin/pip", "install", "-q", "-e", ".", "pytest"],
                               cwd=dest, capture_output=True, timeout=2400)
            if r.returncode == 0:
                break
        if r.returncode != 0:
            return None
        open(env_stamp, "w").write("ok")
    return dest


def parse_f2p(raw):
    if isinstance(raw, list):
        return raw
    try:
        v = json.loads(raw)
        return v if isinstance(v, list) else []
    except Exception:
        return []


def run_tests(repo_dir, test_cmd_prefix):
    """跑 FAIL_TO_PASS 集里的测试，返回 (pass_ids, fail_ids)。"""
    pass_ids, fail_ids = [], []
    return pass_ids, fail_ids


def run_instance(inst, idx):
    iid = inst["instance_id"]
    ws = ensure_repo(inst["repo"], inst["base_commit"], inst["instance_id"])
    if ws is None:
        return {"id": iid, "status": "env-fail"}
    f2p = parse_f2p(inst["FAIL_TO_PASS"])
    ps = inst["problem_statement"][:4000]
    prompt = (
        f"修复以下 GitHub issue（仓库已检出在当前目录，测试环境 .venv-bench）。\n\n"
        f"# Issue\n{ps}\n\n"
        f"# 要求\n改动相关源码（不碰测试文件）使下面这些测试从挂转绿：\n"
        + "\n".join(f2p[:20])
        + "\n\n用 .venv-bench/bin/python -m pytest <测试路径> -x -q 自行验证。修完输出改动摘要。"
    )
    t0 = time.time()
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
    wall = time.time() - t0
    diff = subprocess.run(["git", "-C", ws, "diff"], capture_output=True, text=True, timeout=120).stdout
    # 逐测试验证
    passed = failed = 0
    vpy = f"{ws}/.venv-bench/bin/python"
    test_env = {**os.environ}
    if inst["repo"].startswith("django/"):
        test_env["DJANGO_SETTINGS_MODULE"] = "tests.test_sqlite"
        test_env["PYTHONPATH"] = ws
    for t in f2p:
        r = subprocess.run([vpy, "-m", "pytest", t, "-q", "--no-header"], cwd=ws, capture_output=True, text=True, timeout=600, env=test_env)
        if r.returncode == 0:
            passed += 1
        else:
            failed += 1
    return {"id": iid, "status": "attempted", "passed": passed, "failed": failed,
            "diff_bytes": len(diff), "wall_s": round(wall, 1)}


def main():
    start, count = int(sys.argv[1]), int(sys.argv[2])
    insts = load_instances()[start : start + count]
    results = []
    for i, inst in enumerate(insts):
        try:
            r = run_instance(inst, start + i)
        except Exception as e:
            r = {"id": inst["instance_id"], "status": f"error:{type(e).__name__}"}
        results.append(r)
        print(f"[{start+i+1:3d}] {r['id'][:44]:46s} {r['status']:10s} "
              f"{r.get('passed','')}/{r.get('passed',0)+r.get('failed',0)} {r.get('wall_s','')}s", flush=True)
    att = [r for r in results if r["status"] == "attempted"]
    resolved = [r for r in att if r.get("failed") == 0 and r.get("passed", 0) > 0]
    print(f"\n[SWE-bench Lite attempt] 实例 {len(results)}；环境就绪 {len(att)}；"
          f"resolved {len(resolved)}（F2P 全绿）")
    with open(f"{BENCH}/swe-results-{start}-{start+count}.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
