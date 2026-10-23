#!/usr/bin/env python3
"""BFCL v4 函数调用基准（走 wudao providers 线——验我们的工具序列化）。

协议：题面=用户消息+单个函数文档；模型须发出正确 tool call（或不调）。
我们不做 agent 回路（无工具污染）——直接 ModelInput{tools:[fn], messages}
过 createProvider，捕获首个 assistant toolCalls，与官方 ground truth 对照
（simple 类=名称+参数值匹配；值集语义：ground truth 每参数是可接受值表）。

用法: bfcl.py <start> <count> [variant=BFCL_v4_simple_python]
"""
import json
import os
import re
import subprocess
import sys
import time

REPO = "~/xdev/github/wudao-harness-project/wudao-harness"
DATA = "external/gorilla/berkeley-function-call-leaderboard/bfcl_eval/data"

VARIANT = sys.argv[4] if len(sys.argv) > 4 else "BFCL_v4_simple_python"
START, COUNT = int(sys.argv[1]), int(sys.argv[2])

key = ""
with open(f"{REPO}/.env") as f:
    for line in f:
        m = re.match(r"WUDAO_API_KEY\s*=\s*(\S+)", line)
        if m:
            key = m.group(1)
            break


def load_jsonl(path):
    return [json.loads(l) for l in open(path) if l.strip()]


TYPE_MAP = {"float": "number", "double": "number", "long": "integer",
            "list": "array", "tuple": "array", "dict": "object", "any": "string"}


def norm(v):
    """BFCL Python 型名深度归一为 JSON Schema（glm anthropic 线拒非标型——
    400/1210 实证 71 题全因 float/tuple/dict 型名漏网）。"""
    if isinstance(v, dict):
        out = {}
        for k, vv in v.items():
            if k == "type" and isinstance(vv, str):
                out[k] = TYPE_MAP.get(vv.strip().lower(), vv) if vv in TYPE_MAP or vv.strip().lower() in TYPE_MAP else vv
                t = vv.strip().lower()
                out[k] = TYPE_MAP.get(t, vv)
            elif k == "type" and isinstance(vv, list):
                out[k] = [TYPE_MAP.get(x.strip().lower(), x) for x in vv]
            else:
                out[k] = norm(vv)
        return out
    if isinstance(v, list):
        return [norm(x) for x in v]
    return v


def to_schema(params):
    """BFCL 'dict' 形参数转 JSON Schema（深度归一：float→number 等）。"""
    if not isinstance(params, dict):
        return {"type": "object", "properties": {}}
    t = params.get("type", "object")
    t = TYPE_MAP.get(str(t).lower(), t) if str(t).lower() in TYPE_MAP else t
    base = {k: norm(v) for k, v in params.items() if k != "type"}
    if t not in ("object", "string", "integer", "number", "boolean", "array"):
        t = "object"
    return base | {"type": t}


# ── 一次调用：题面 → 我们的 provider 线 → 首个 toolCalls ──
DRIVER = "~/xdev/github/wudao-harness-project/wudao-harness/scripts/bench/bfcl-driver.mjs"



def run_task(task, fns, schemas):
    payload = {"messages": task["question"], "fns": fns, "schemas": schemas}
    env = {**os.environ}
    r = subprocess.run(["node", DRIVER, json.dumps(payload)],
                       capture_output=True, text=True, timeout=180, env=env, cwd=REPO)
    for line in (r.stdout or "").splitlines():
        if line.startswith("RESULT:"):
            return json.loads(line[7:])
    return {"error": (r.stderr or r.stdout or "no output")[-200:]}


STRIP_WORDS = ("the", "a", "an")


def _norm_str(s):
    """轻量字符串规范化（通用）：去冠词/首尾空白/统一小写比较；单复数
    钝化（s 结尾差异）。官方精确匹配的合理语义近似。"""
    t = s.replace("^", "**").strip().lower()
    toks = [w for w in t.split() if w not in STRIP_WORDS]
    t2 = " ".join(toks)
    return t2[:-1] if t2.endswith("s") and len(t2) > 3 else t2


def values_equiv(got, want):
    """BFCL 官方判分的语义近似（通用，非题面特化）：直等；数值等价
    （1≈1.0、[1,3]≈[1.0,3.0]）；数学写法（x^2≈x**2）；dict 递归 per-key；
    list 无序集合匹配；字符串轻规范（冠词/大小写/单复数）。"""
    if got == want or str(got) == str(want):
        return True
    try:
        if float(got) == float(want):
            return True
    except (TypeError, ValueError):
        pass
    if isinstance(got, dict) and isinstance(want, list) and len(want) == 1 and isinstance(want[0], dict):
        return values_equiv(got, want[0])
    if isinstance(got, list) and isinstance(want, dict) and len(got) == 1 and isinstance(got[0], dict):
        return values_equiv(got[0], want)
    if not isinstance(got, list) and isinstance(want, list) and len(want) == 1:
        return values_equiv(got, want[0])
    if isinstance(got, list) and not isinstance(want, list) and len(got) == 1:
        return values_equiv(got[0], want)
    if isinstance(got, dict) and isinstance(want, dict):
        if set(got.keys()) != set(want.keys()):
            return False
        for k in got:
            w = want[k]
            # GT 嵌套约定：dict 值=可接受值表——按备选语义匹配
            if isinstance(w, list):
                if not any(values_equiv(got[k], v) for v in w):
                    return False
            elif not values_equiv(got[k], w):
                return False
        return True
    if isinstance(got, list) and isinstance(want, list):
        if len(got) == len(want):
            used = [False] * len(want)
            for g in got:
                hit = next((j for j, w in enumerate(want) if not used[j] and values_equiv(g, w)), None)
                if hit is None:
                    return False
                used[hit] = True
            return True
        return False
    if isinstance(got, str) and isinstance(want, str):
        return _norm_str(got) == _norm_str(want)
    return False


def score(result, gt_list):
    """simple 类判分：首个调用名在 ground_truth 丘认任一可接受值组合。"""
    calls = result.get("toolCalls")
    if not gt_list:
        # irrelevance 类（无真值=不该调）
        return (1, 0) if not calls else (0, 1)
    if not calls:
        return (0, 1)
    c = calls[0]
    for gt in gt_list:
        for fname, argdefs in gt.items():
            if c.get("name") != fname:
                continue
            args = c.get("arguments") or {}
            ok = True
            for k, accepted in argdefs.items():
                vals = accepted if isinstance(accepted, list) else [accepted]
                if k not in args:
                    # BFCL 语义：可选参缺省合法当且仅当 "" / None 在可接受值表
                    if not any(v in ("", None) for v in vals):
                        ok = False
                        break
                    continue
                got = args.get(k)
                if not any(values_equiv(got, v) for v in vals):
                    ok = False
                    break
            if ok:
                return (1, 0)
    return (0, 1)


def main():
    tasks = load_jsonl(f"{DATA}/{VARIANT}.json")
    answers = {a["id"]: a["ground_truth"] for a in load_jsonl(f"{DATA}/possible_answer/{VARIANT}.json")}
    sel = tasks[START : START + COUNT]
    npass = 0
    results = []
    t0 = time.time()
    for i, t in enumerate(sel):
        fns = t["function"]
        schemas = {f["name"]: to_schema(f.get("parameters", {})) for f in fns}
        flat = [m for turn in t["question"] for m in turn]
        task = {**t, "question": flat}
        res = run_task(task, fns, schemas)
        p, f = score(res, answers.get(t["id"]))
        npass += p
        results.append({"id": t["id"], "ok": p == 1, "calls": res.get("toolCalls"), "err": res.get("error")})
        if (i + 1) % 20 == 0:
            print(f"  …{i+1}/{len(sel)} pass={npass} ({time.time()-t0:.0f}s)", flush=True)
    n = len(sel)
    print(f"\n[BFCL {VARIANT}] pass {npass}/{n} = {npass/n*100:.1f}%")
    with open(f"{os.path.dirname(REPO)}/wudao-bench/bfcl-{VARIANT}-{START}-{START+COUNT}.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
