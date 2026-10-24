#!/usr/bin/env python3
"""Aider polyglot 多语言 harness-mode runner（逐语言冲顶弧）。

语言参数化：BENCH_LANG=python|go|rust|cpp|java python3 polyglot-multi.py <count> [offset]
每题完整 agent 回路（读题→改实现→自行跑测试→迭代），判分=该语言测试
运行器的用例计数（aider 口径），探针/经济学同 JS 跑分器。
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
LANG = os.environ.get("BENCH_LANG", "python")
SRC = f"{BENCH}/polyglot/{LANG}/exercises/practice"
RUNS = f"{BENCH}/poly-{LANG}-runs"
CLI = f"{REPO}/packages/cli/dist/index.js"

key = os.environ.get("WUDAO_BENCH_KEY", "")
if not key:
    with open(f"{REPO}/.env") as f:
        for line in f:
            m = re.match(r"WUDAO_API_KEY\s*=\s*(\S+)", line)
            if m:
                key = m.group(1)
                break

CHILD_ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("WUDAO_")},
    **({} if os.environ.get("BENCH_PROVIDER") else {"WUDAO_API_KEY": key}),
    "WUDAO_NO_GATES": "1",
    **({"WUDAO_PROBE": os.environ["WUDAO_PROBE"]} if os.environ.get("WUDAO_PROBE") else {}),
    "NO_COLOR": "1",
}

# 每语言：题内准备、测试命令、用例计数解析。
import glob as _glob


def lang_setup(ws):
    """题内语言准备（依赖安装等）。"""
    if LANG == "javascript":
        subprocess.run(["npm", "install", "--no-audit", "--no-fund", "--silent"], cwd=ws, capture_output=True, timeout=240)


def enable_all_tests(ws):
    """Exercism 各语言的 skip 形态启用（python/cpp 无 skip；go/rust/java 按需）。"""
    if LANG == "javascript":
        for fn in os.listdir(ws):
            if fn.endswith(".spec.js"):
                p = f"{ws}/{fn}"
                s = open(p).read().replace("xtest(", "test(").replace("xit(", "it(")
                open(p, "w").write(s)


def test_cmd(ws):
    if LANG == "python":
        return ["python3", "-m", "pytest", "-q", "--tb=no"]
    if LANG == "go":
        return ["go", "test", "-v", "./..."]
    if LANG == "rust":
        return ["cargo", "test", "--quiet"]
    if LANG == "cpp":
        # 构建（桩上编译错=预期失败面）+ 若构建成功则直跑 catch2 二进制取汇总
        # ctest 优先（带 add_test 的题）；无 add_test 的题直跑 build 根的测试二进制
        return ["bash", "-c", "mkdir -p build && cd build && cmake .. >/dev/null 2>&1 && make >/dev/null 2>&1 && (ctest -V 2>&1; if ctest -N 2>/dev/null | grep -q 'Total Tests: 0'; then find . -maxdepth 1 -type f -perm -111 ! -name 'cmake_*' -exec {} \; 2>&1; fi) || true"]
    if LANG == "java":
        return ["./gradlew", "test", "--console=plain", "-q"]
    raise SystemExit(f"unknown lang {LANG}")


def parse_counts(out):
    """从测试运行器输出解析 (passed, failed)。"""
    if LANG == "python":
        p = re.findall(r"(\d+) passed", out)
        f = re.findall(r"(\d+) failed", out)
        return (int(p[-1]) if p else 0, int(f[-1]) if f else 0)
    if LANG == "go":
        return (len(re.findall(r"--- PASS", out)), len(re.findall(r"--- FAIL", out)))
    if LANG == "rust":
        p = f = 0
        for m in re.findall(r"test result: (\w+)\. (\d+) passed; (\d+) failed", out):
            f = f + int(m[2])
            p = p + int(m[1])
        return (p, f)
    if LANG == "cpp":
        # catch2 汇总行："All tests passed (N assertions)" 或 "X of Y assertions failed"
        all_ok = re.search(r"All tests passed \((\d+) assertions? in (\d+) test cases?\)", out)
        if all_ok:
            return (int(all_ok.group(2)), 0)
        all_ok2 = re.search(r"All tests passed \((\d+) assertion", out)
        if all_ok2:
            return (int(all_ok2.group(1)), 0)
        failed = re.search(r"(\d+) of (\d+) assertions? failed", out)
        if failed:
            return (int(failed.group(2)) - int(failed.group(1)), int(failed.group(1)))
        return (0, 0)
    if LANG == "java":
        return (0, 0)  # 由 junit_xml_counts 兜底（gradle 不列 PASSED 行）
    return (0, 0)


def junit_xml_counts(ws):
    """JUnit XML 汇总（java/gradle）：testsuite testcase 数 + failure/error 数。"""
    import xml.etree.ElementTree as ET
    p = f = 0
    for xf in _glob.glob(f"{ws}/build/test-results/test/*.xml"):
        try:
            root = ET.parse(xf).getroot()
        except Exception:
            continue
        for tc in root.iter("testcase"):
            p += 1
            if tc.find("failure") is not None or tc.find("error") is not None:
                f += 1
    return (p - f, f)


def impl_files(ws):
    """题的实现文件（提示词用）。"""
    if LANG == "python":
        return [f for f in os.listdir(ws) if f.endswith(".py") and not f.endswith("_test.py")]
    if LANG == "go":
        return [f for f in os.listdir(ws) if f.endswith(".go") and not f.endswith("_test.go") and f != "cases_test.go"]
    if LANG == "rust":
        return sorted(_glob.glob(f"{ws}/src/**/*.rs", recursive=True))
    if LANG == "cpp":
        return [f for f in os.listdir(ws) if f.endswith((".cpp", ".h")) and not "test" in f]
    if LANG == "java":
        return sorted(_glob.glob(f"{ws}/src/main/java/**/*.java", recursive=True))
    return []


def build_prompt(name, ws):
    files = impl_files(ws)
    verify = {
        "python": "python3 -m pytest -q",
        "go": "go test ./...",
        "rust": "cargo test",
        "cpp": "cmake+make+ctest（build 目录里构建后跑测试）",
        "java": "./gradlew test",
    }[LANG]
    return (
        f"完成 Exercism 练习「{name}」（{LANG}）。需求说明在 .docs/instructions.md（先读它）。\n\n"
        f"契约：把 {'、'.join(files)} 里的桩实现成真实现；测试文件可以读但不要改。"
        f"用 `{verify}` 自行验证，直到全部通过。不要改测试和构建配置。"
    )


def summarize_probe(path):
    if not os.path.exists(path):
        return None
    mc = {"calls": 0, "latency_ms": 0, "errors": 0}
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
            if not d.get("ok"):
                mc["errors"] += 1
                anomalies.append(f"model.err:{str(d.get('error'))[:60]}")
        elif e.get("name") == "tool.finish":
            n = d.get("name", "?")
            row = tools_by.setdefault(n, {"n": 0, "ms": 0, "err": 0})
            row["n"] += 1
            row["ms"] += d.get("dur", 0)
            if not d.get("ok"):
                row["err"] += 1
    top = sorted(tools_by.items(), key=lambda kv: -kv[1]["ms"])[:6]
    return {"model": mc, "tools_top": [{"name": k, **v} for k, v in top], "anomalies": anomalies[:12]}


def latest_session_id(ws):
    """工作区最新会话 id（resume 重试用）。"""
    d = f"{ws}/.wudao/sessions"
    if not os.path.isdir(d):
        return None
    ids = sorted(
        (f for f in os.listdir(d) if f.endswith(".jsonl")),
        key=lambda f: os.path.getmtime(f"{d}/{f}"),
    )
    return ids[-1][:-6] if ids else None


def run_exercise(name):
    src = f"{SRC}/{name}"
    ws = f"{RUNS}/{name}"
    shutil.rmtree(ws, ignore_errors=True)
    shutil.copytree(src, ws)
    enable_all_tests(ws)
    os.makedirs(f"{ws}/.wudao", exist_ok=True)
    with open(f"{ws}/.wudao/settings.json", "w") as f:
        json.dump({"probe": {"auditFile": ".wudao/probe-audit.jsonl"}}, f)
    lang_setup(ws)
    prompt = build_prompt(name, ws)
    t0 = time.time()
    extra = []
    if os.environ.get("BENCH_PROVIDER"):
        extra += ["--provider", os.environ["BENCH_PROVIDER"]]
    if os.environ.get("BENCH_MODEL"):
        extra += ["--model", os.environ["BENCH_MODEL"]]
    def run_agent(args_prompt, resume=None):
        cmd = ["node", CLI, "--trust-workspace", "--no-tui", "--quiet", *extra]
        if resume is not None:
            cmd += ["--resume", resume]
        cmd.append(args_prompt)
        try:
            subprocess.run(cmd, cwd=ws, env=CHILD_ENV, capture_output=True, text=True, timeout=1200)
            return 0
        except subprocess.TimeoutExpired:
            return -1

    def run_tests():
        try:
            r = subprocess.run(test_cmd(ws), cwd=ws, capture_output=True, text=True, timeout=300)
            return r.stdout + r.stderr
        except subprocess.TimeoutExpired as e:
            return (e.stdout or "") + "\n(tests-timeout)"

    retries = int(os.environ.get("BENCH_RETRIES", "1"))
    exit_code = run_agent(prompt)
    out = run_tests()
    passed, failed = parse_counts(out)
    if LANG == "java" and (passed + failed) == 0:
        passed, failed = junit_xml_counts(ws)
    # 冲顶重试轮：未全绿 → resume 原会话带失败上下文再战（真实用户迭代流）。
    for round_i in range(retries):
        if failed == 0 and passed > 0:
            break
        sid = latest_session_id(ws)
        if sid is None:
            break
        tail = "\n".join(l for l in out.splitlines() if ("FAIL" in l or "failed" in l))
        retry_prompt = "测试还没全过（%d 过 / %d 挂）。失败摘要：\n%s\n\n继续修到全部通过，不要改测试文件。" % (passed, failed, tail)
        exit_code = run_agent(retry_prompt, resume=sid)
        out = run_tests()
        passed, failed = parse_counts(out)
        if LANG == "java" and (passed + failed) == 0:
            passed, failed = junit_xml_counts(ws)
    wall = time.time() - t0
    if LANG == "java" and (passed + failed) == 0:
        passed, failed = junit_xml_counts(ws)
    econ = {"wall_s": round(wall, 1), "exit": exit_code, "retries_used": retries if failed == 0 and passed > 0 else None}
    probe = summarize_probe(f"{ws}/.wudao/probe-audit.jsonl")
    if probe:
        econ["probe"] = probe
    total = passed + failed
    return {"id": name, "passed": passed, "failed": failed, "ratio": round(passed / total, 3) if total else 0.0, **econ}


def main():
    count = int(sys.argv[1])
    offset = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    names = sorted(os.listdir(SRC))[offset : offset + count]
    results = []
    for i, name in enumerate(names):
        r = run_exercise(name)
        results.append(r)
        ok = "✓全过" if r["failed"] == 0 and r["passed"] > 0 else f"{r['passed']}/{r['passed']+r['failed']}"
        print(f"[{i+1:2d}] {name:30s} {ok:10s} {r['wall_s']}s", flush=True)
    tp = sum(r["passed"] for r in results)
    tf = tp + sum(r["failed"] for r in results)
    full = sum(1 for r in results if r["failed"] == 0 and r["passed"] > 0)
    print(f"\n[{LANG}] 全过 {full}/{len(results)} 题；用例通过率 {tp}/{tf} = {tp/tf*100:.1f}%" if tf else "no tests")
    with open(f"{BENCH}/poly-{LANG}-results-{offset}-{offset+count}.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
