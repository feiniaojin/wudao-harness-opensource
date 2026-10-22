#!/usr/bin/env python3
"""τ-bench retail 败题取证跑：单跑指定题并落盘完整会话。

与 tau-ensemble.py 同构（同 litellm 桩、同 MAX_TURNS=40、temperature=0），
区别仅：
- OPENAI_BASE_URL 指向取证 shim（8791，带 SHIM_TRACE 落盘）
- 包一层 env.step 记录每个动作的 observation/reward/done
- 落盘 SolveResult.messages（agent 侧全对话）+ 动作日志 + reward_info

用法: tau-forensics.py 18 34 38 49
"""
import json
import os
import sys
import time
import traceback
import types

import requests as _requests

_SHIM = os.environ.get("OPENAI_BASE_URL", "http://127.0.0.1:8791/v1")


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
os.environ.setdefault("OPENAI_BASE_URL", "http://127.0.0.1:8791/v1")
os.environ.setdefault("OPENAI_API_KEY", "shim-placeholder")
MODEL = os.environ.get("BENCH_MODEL", "glm-5.3")

from tau_bench.envs import get_env  # noqa: E402
from tau_bench.agents.tool_calling_agent import ToolCallingAgent  # noqa: E402

MAX_TURNS = int(os.environ.get("TAU_MAX_TURNS", "40"))
OUTDIR = "/tmp/tau-forensics"
os.makedirs(OUTDIR, exist_ok=True)


def run_once(env, task_index):
    step_log = []
    state = {"done_seen": False}
    orig_step = env.step

    def logged_step(action):
        resp = orig_step(action)
        # done 之后的 self.step 调用来自 calculate_reward() 的 GT 回放，不是 agent 行为
        step_log.append({
            "action": action.name,
            "kwargs": action.kwargs,
            "observation": resp.observation,
            "reward": resp.reward,
            "done": resp.done,
            "source": resp.info.source,
            "gt_replay": state["done_seen"],
        })
        if resp.done:
            state["done_seen"] = True
        return resp

    env.step = logged_step
    try:
        agent = ToolCallingAgent(
            tools_info=env.tools_info,
            wiki=env.wiki,
            model=MODEL,
            provider="openai",
            temperature=0.0,
        )
        res = agent.solve(env=env, task_index=task_index, max_num_steps=MAX_TURNS)
        return float(res.reward), res, step_log
    finally:
        env.step = orig_step


def main():
    tasks = [int(a) for a in sys.argv[1:]] or [18, 34, 38, 49]
    env = get_env(
        env_name="retail",
        user_strategy="llm",
        user_model=MODEL,
        task_split="test",
        user_provider="openai",
    )
    for ti in tasks:
        t0 = time.time()
        try:
            reward, res, step_log = run_once(env, ti)
        except Exception:
            traceback.print_exc()
            print(f"task#{ti} CRASHED", flush=True)
            continue
        # 序列化 messages（tool_calls 里的 dict 直接 json 化）
        msgs = []
        for m in res.messages:
            mm = dict(m)
            if mm.get("tool_calls"):
                mm["tool_calls"] = [dict(tc) for tc in mm["tool_calls"]]
            msgs.append(mm)
        info = res.info if isinstance(res.info, dict) else res.info.model_dump()
        out = {
            "task": ti,
            "reward": reward,
            "seconds": round(time.time() - t0, 1),
            "instruction": (env.tasks[ti].get("instruction") if isinstance(env.tasks[ti], dict) else getattr(env.tasks[ti], "instruction", "")),
            "n_agent_steps": sum(1 for s in step_log if not s.get("gt_replay")),
            "reward_info": info.get("reward_info"),
            "steps": step_log,
            "messages": msgs,
        }
        path = f"{OUTDIR}/task-{ti}.json"
        with open(path, "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=1, default=str)
        print(f"task#{ti} reward={reward} steps={len(step_log)} ({out['seconds']}s) -> {path}", flush=True)


if __name__ == "__main__":
    main()
