#!/usr/bin/env python3
"""134 — GAIA validation 第二模型臂（MiniMax-M3）runner.
用法: python3 gaia_minimax_runner.py [--limit N] [--start IDX]
输出: wudao-bench/gaia-minimax-results.json
"""
import json, os, subprocess, sys, time

BENCH = "~/xdev/github/wudao-harness-project/wudao-bench"
WUDAO = "~/xdev/github/wudao-harness-project/wudao-harness/packages/cli/dist/index.js"
PARQUET = os.path.join(BENCH, "gaia-validation.parquet")
PROGRESS = os.path.join(BENCH, "gaia-minimax-progress")
OUT = os.path.join(BENCH, "gaia-minimax-results.json")

def normalize(s):
    return str(s or "").strip().lower().rstrip(".,!?;:")

def main():
    import pandas as pd
    df = pd.read_parquet(PARQUET)

    # Parse args
    limit = float("inf")
    start = 0
    args = sys.argv[1:]
    if "--limit" in args:
        limit = int(args[args.index("--limit") + 1])
    if "--start" in args:
        start = int(args[args.index("--start") + 1])

    df = df.iloc[start:start + int(limit)] if limit != float("inf") else df.iloc[start:]
    total = len(df)
    print(f"GAIA MiniMax-M3: {total} tasks (start={start})")

    os.makedirs(PROGRESS, exist_ok=True)
    results = {}
    done = 0

    for _, row in df.iterrows():
        tid = row["task_id"]
        question = row["Question"]
        want = row["Final answer"]
        level = int(row["Level"])

        pf = os.path.join(PROGRESS, f"{tid}.json")
        if os.path.exists(pf):
            with open(pf) as f:
                results[tid] = json.load(f)
            done += 1
            continue

        # Run wudao with MiniMax-M3
        t0 = time.time()
        got, ok, err = "", False, ""
        try:
            env = {k: v for k, v in os.environ.items()
                   if k not in ("WUDAO_API_KEY", "WUDAO_BASE_URL", "WUDAO_MODEL")}
            proc = subprocess.run(
                ["node", WUDAO, "--provider", "minimax-code", "--model", "MiniMax-M3", "--answer-only", "--quiet", "--print", question],
                capture_output=True, text=True, timeout=600, env=env, cwd="/tmp",
            )
            # Extract last non-empty line
            import re
            ansi = re.compile(r"\x1b\[[0-9;]*m")
            clean = [ansi.sub("", l).rstrip() for l in proc.stdout.split("\n")]
            # 答案在最后一条 system_note 之后、第一条缓存/计时/review 行之前
            skip_start = ("system_note", "EXTREMELY", "superpowers", "mcp server",
                         "workspace not", "session:", "模型：", "⚠️", "---")
            skip_end = ("缓存", "耗时", "🧠", "review:", "回合净变更", "git ", "wudao:")
            answer_lines = []
            in_answer = False
            for l in clean:
                ls = l.strip()
                if not in_answer:
                    if any(s in ls[:60] for s in skip_start):
                        continue
                    if ls:
                        in_answer = True
                if in_answer:
                    if any(s in ls[:20] for s in skip_end):
                        break
                    if ls:
                        answer_lines.append(ls)
            got = " ".join(answer_lines).strip()
        except subprocess.TimeoutExpired:
            err = "timeout"
        except Exception as e:
            err = str(e)
        wall = time.time() - t0

        ok = normalize(got) == normalize(want)
        rec = {"id": tid, "ok": ok, "level": level, "got": got[:200],
               "want": str(want), "wall_s": round(wall, 1)}
        if err:
            rec["error"] = err
        results[tid] = rec
        with open(pf, "w") as f:
            json.dump(rec, f)
        done += 1

        passed = sum(1 for r in results.values() if r.get("ok"))
        print(f"  {done}/{total} {tid[:8]} L{level} {'✓' if ok else '✗'} "
              f"got={got[:25]!r} want={str(want)[:25]!r} ({wall:.0f}s) "
              f"[{passed}/{done} = {passed/done*100:.1f}%]", flush=True)

    with open(OUT, "w") as f:
        json.dump(results, f, indent=2)
    total_n = len(results)
    passed = sum(1 for r in results.values() if r.get("ok"))
    print(f"\nGAIA MiniMax-M3: {passed}/{total_n} = "
          f"{(passed/total_n*100):.1f}% Pass@1" if total_n else "no results")
    print(f"Results: {OUT}")

if __name__ == "__main__":
    main()
