#!/usr/bin/env python3
"""τ-bench retail 跑分器（wudao provider 线经 OpenAI shim 接入）。

协议=官方：ToolCallingAgent + LLM 用户模拟器在 env 对话；reward=动作
序列+DB 态+输出。模型全部走 127.0.0.1:8790 shim → buildRunPlan →
createProvider（glm-code 带 claude-code:headers persona）。

用法: tau.py <start> <count>
"""
import json
import os
import sys
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

TAU = "/Users/qinyujie/xdev/github/wudao-harness-project/wudao-bench/tau-bench"
sys.path.insert(0, TAU)
os.environ.setdefault("OPENAI_BASE_URL", "http://127.0.0.1:8790/v1")
os.environ.setdefault("OPENAI_API_KEY", "shim-placeholder")
MODEL = os.environ.get("BENCH_MODEL", "glm-5.3")

from tau_bench.envs import get_env  # noqa: E402
from tau_bench.agents.tool_calling_agent import ToolCallingAgent  # noqa: E402

MAX_TURNS = int(os.environ.get("TAU_MAX_TURNS", "30"))


def main():
    start, count = int(sys.argv[1]), int(sys.argv[2])
    env = get_env(
        env_name="retail",
        user_strategy="llm",
        user_model=MODEL,
        task_split="test",
        user_provider="openai",
    )
    sel = list(range(start, min(start + count, len(env.tasks))))
    results = []
    import traceback
    for i, ti in enumerate(sel):
        try:
            agent = ToolCallingAgent(
                tools_info=env.tools_info,
                wiki=env.wiki,
                model=MODEL,
                provider="openai",
                temperature=0.0,
            )
            res = agent.solve(env=env, task_index=ti, max_num_steps=MAX_TURNS)
            reward = res.reward
        except Exception:
            reward = 0.0
            traceback.print_exc()
        results.append({"task": ti, "reward": reward})
        print(f"[{i+1:3d}] task#{ti} reward={reward}", flush=True)
    n = len(results)
    p = sum(1 for r in results if r["reward"] == 1)
    print(f"\n[τ-bench retail] pass {p}/{n} = {p/n*100:.1f}%" if n else "no tasks")
    with open(f"{os.path.dirname(TAU)}/tau-results-{start}-{start+count}.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
