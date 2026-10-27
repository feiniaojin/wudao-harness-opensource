#!/usr/bin/env python3
"""GAIA 基准跑分器（text-only 子集，127 题 validation）。

协议：每题给 agent 完整工具面（web_fetch/shell/read_file/browser），
让 agent 自由推理+浏览+计算，判分=最终答案与 Final answer 精确匹配
（GAIA 官方口径：大小写/标点不敏感的归一匹配）。

用法: gaia.py <start> <count>
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

REPO = "~/xdev/github/wudao-harness-project/wudao-harness"
BENCH = "~/xdev/github/wudao-harness-project/wudao-bench"
RUNS = f"{BENCH}/gaia-runs"
CLI = f"{REPO}/packages/cli/dist/index.js"
DATA = f"{BENCH}/gaia-validation.parquet"

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


def normalize(s):
    """GAIA 官方判分归一（大小写/标点/空白/冠词不敏感）。"""
    if not isinstance(s, str):
        return str(s)
    s = s.strip().lower()
    s = re.sub(r"^(the|a|an)\s+", "", s)
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def extract_answer(text):
    """从 agent 最终回答里提取最终答案（找 FINAL ANSWER: 标记或最后一段）。"""
    m = re.search(r"FINAL ANSWER:\s*(.+?)(?:\n|$)", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    # 回退=最后非空行
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return lines[-1] if lines else ""


def load_tasks():
    import pandas as pd
    df = pd.read_parquet(DATA)
    return df.to_dict("records")


def run_task(task, idx):
    tid = str(task["task_id"])
    ws = f"{RUNS}/{tid}"
    shutil.rmtree(ws, ignore_errors=True)
    os.makedirs(ws, exist_ok=True)
    q = task["Question"]
    prompt = (
        f"回答以下问题。你可以使用 web_fetch 获取网页、shell 执行命令、read_file 读文件。"
        f"先用 shell 的 curl 精确定位答案来源（curl -s URL | grep -i 关键词），确认来源后再深挖。"
        f"如果某个搜索路径超过 3 步还没找到答案，换一个搜索策略或用已有信息做最佳猜测。"
        f"始终确保在超时前把答案写入 answer.txt\n"
        f"推理过程自由展开（在对话里写），但最终必须创建 answer.txt 文件，文件内容只写最终答案本身——一个数字/名称/日期/短语，不要任何解释文字、标点符号或推理过程。例如：如果答案是 0.1777，answer.txt 内容就是 0.1777，不是「搜索结果已经给出了论文中的计算过程...」。\n\n"
        f"问题：{q}\n"
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
    except subprocess.TimeoutExpired:
        # 超时被 kill 前 agent 可能已写出答案，仍尝试读 answer.txt / 会话回退
        pass
    # 答案走文件（stdout 被 run 尾巴污染——实证 review 行被当答案）
    ans_file = f"{ws}/answer.txt"
    ans = open(ans_file).read().strip() if os.path.exists(ans_file) else ""
    if not ans:
        # 回退：从最后一条 assistant 消息提取 FINAL ANSWER 行
        import glob
        for f in sorted(glob.glob(f"{ws}/.wudao/sessions/*.jsonl"), key=os.path.getmtime):
            for line in open(f):
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("role") == "assistant" and d.get("content"):
                    cand = extract_answer(d["content"])
                    if cand:
                        ans = cand
    ans = ans.strip() if ans else ""
    wall = time.time() - t0
    gt = str(task["Final answer"])
    ok = normalize(ans) == normalize(gt)
    return {"id": tid, "ok": ok, "level": task["Level"], "got": ans[:80], "want": gt[:80],
            "wall_s": round(wall, 1)}


def main():
    start, count = int(sys.argv[1]), int(sys.argv[2])
    tasks = load_tasks()[start : start + count]
    results = []
    for i, t in enumerate(tasks):
        r = run_task(t, start + i)
        results.append(r)
        mark = "✓" if r["ok"] else "✗"
        print(f"[{start+i+1:3d}] L{r['level']} {mark} {r['id'][:12]} got={r['got'][:40]} want={r['want'][:40]} {r['wall_s']}s", flush=True)
    n = len(results)
    p = sum(1 for r in results if r["ok"])
    by_level = {}
    for r in results:
        by_level.setdefault(r["level"], []).append(r["ok"])
    level_stats = {f"L{k}": f"{sum(v)}/{len(v)}" for k, v in sorted(by_level.items())}
    print(f"\n[GAIA validation] pass {p}/{n} = {p/n*100:.1f}% | 分级: {level_stats}")
    with open(f"{BENCH}/gaia-results-{start}-{start+count}.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
