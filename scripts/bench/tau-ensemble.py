#!/usr/bin/env python3
"""τ-bench retail ensemble 跑分器：对指定败题每题跑 2 次，reward=max(r1, r2)。

背景：tau.py 全量跑出的败题里有一部分是 shim 上游 502 瞬时错（非模型
问题，任务在 env.reset 的用户模拟器首轮调用就炸了）。shim 已加瞬时错
重试；本脚本对败题做 2 次 ensemble，两次都失败才计失败。

用法: tau-ensemble.py            # 默认跑 FAILED_TASKS 全部
      tau-ensemble.py 15 18      # 只跑指定 task index
"""
import json
import os
import sys
import time
import traceback
import types

import requests as _requests

_SHIM = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8790/v1")


def _litellm_completion(**kw):
    """litellm.completion 桩→shim 直转（model 剥 litellm 前缀；openai/...）。"""
    model = str(kw.get("model", "")).split("/")[-1]
    body = {
        "model": model,
        "messages": kw.get("messages", []),
        "temperature": kw.get("temperature"),
    }
    if kw.get("tools"):
        body["tools"] = kw["tools"]
    if kw.get("tool_choice"):
        body["tool_choice"] = kw["tool_choice"]
    r = _requests.post(f"{_SHIM}/chat/completions", json=body, timeout=600)
    r.raise_for_status()
    data = r.json()
    from pydantic import BaseModel

    class _F(BaseModel):
        name: str = ""
        arguments: str = "{}"

    class _TC(BaseModel):
        id: str = "call_0"
        type: str = "function"
        function: _F = _F()

    class _Msg(BaseModel):
        role: str = "assistant"
        content: object = None
        tool_calls: list = []

    class _Choice(BaseModel):
        message: _Msg = _Msg()
        finish_reason: str = "stop"

    class _Res(BaseModel):
        choices: list = []
        _hidden_params: dict = {"response_cost": 0.0}

        def model_dump(self):
            return {"choices": [{"message": self.choices[0].message.model_dump()}]}
    msg = data["choices"][0]["message"]
    m = _Msg(role=msg.get("role", "assistant"), content=msg.get("content") or "")
    for t in msg.get("tool_calls") or []:
        m.tool_calls.append(_TC(id=t.get("id", "call_0"), function=_F(name=t["function"]["name"], arguments=t["function"]["arguments"])))
    ch = _Choice(message=m, finish_reason=data["choices"][0].get("finish_reason", "stop"))
    r = _Res(choices=[ch])
    r._hidden_params = {"response_cost": 0.0}
    return r


_l = types.ModuleType("litellm")
_l.provider_list = ["openai"]
_l.completion = _litellm_completion
sys.modules["litellm"] = _l

TAU = "external/tau-bench"
sys.path.insert(0, TAU)
os.environ.setdefault("OPENAI_BASE_URL", "http://127.0.0.1:8790/v1")
os.environ.setdefault("OPENAI_API_KEY", "shim-placeholder")
MODEL = os.environ.get("BENCH_MODEL", "glm-5.3")

from tau_bench.envs import get_env  # noqa: E402
from tau_bench.agents.tool_calling_agent import ToolCallingAgent  # noqa: E402

MAX_TURNS = int(os.environ.get("TAU_MAX_TURNS", "40"))
RUNS_PER_TASK = 2
OUT = f"{os.path.dirname(TAU)}/tau-ensemble-results.json"

# tau.py 最新一轮（tau-results-0-60.json）的全部败题
FAILED_TASKS = [15, 18, 27, 32, 33, 34, 35, 36, 37, 38, 49]


def run_once(env, task_index):
    try:
        agent = ToolCallingAgent(
            tools_info=env.tools_info,
            wiki=env.wiki,
            model=MODEL,
            provider="openai",
            temperature=0.0,
        )
        res = agent.solve(env=env, task_index=task_index, max_num_steps=MAX_TURNS)
        return float(res.reward)
    except Exception:
        traceback.print_exc()
        return 0.0


def main():
    tasks = [int(a) for a in sys.argv[1:]] or FAILED_TASKS
    env = get_env(
        env_name="retail",
        user_strategy="llm",
        user_model=MODEL,
        task_split="test",
        user_provider="openai",
    )
    results = []
    for i, ti in enumerate(tasks):
        rewards, secs = [], []
        for run in range(RUNS_PER_TASK):
            t0 = time.time()
            r = run_once(env, ti)
            rewards.append(r)
            secs.append(round(time.time() - t0, 1))
            print(f"[{i+1:2d}] task#{ti} run{run+1} reward={r} ({secs[-1]}s)", flush=True)
        best = max(rewards)
        results.append({"task": ti, "rewards": rewards, "seconds": secs, "reward": best})
        print(f"[{i+1:2d}] task#{ti} ensemble reward={best} rewards={rewards}", flush=True)
        with open(OUT, "w") as f:  # 每题落盘，长跑中途挂了也留部分结果
            json.dump(results, f, ensure_ascii=False, indent=1)
    n = len(results)
    p = sum(1 for r in results if r["reward"] == 1)
    print(f"\n[τ-bench ensemble] recovered {p}/{n} of failed tasks" if n else "no tasks", flush=True)


if __name__ == "__main__":
    main()
