#!/usr/bin/env node
// RL/SFT 轨迹导出器（研究弧 #6 落地，纯旁路读 session ledger，零改内核）。
// 把 .wudao/sessions/*.jsonl（append-only 会话账本）转成训练侧可用的
// episode 轨迹 JSONL + episode 指标汇总——喂 verl 类 RL 框架或做 SFT 样本。
//
// M24 姿势：只读账本文件，不碰任何请求字节，零缓存代价。
//
// 用法:
//   node scripts/dev/export-trajectory.mjs <session.jsonl | 目录>... [--out out.jsonl]
//                                           [--reward-map rewards.json]
//   rewards.json: {"<episode-id 或 task-id>": 0/1/分数, ...} —— 与外部判分
//   （基准结果）对齐后注入 reward 字段；找不到的 episode reward=null。

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const OUT = flagValue("--out");
const REWARD_MAP_PATH = flagValue("--reward-map");
const REWARDS = REWARD_MAP_PATH ? JSON.parse(fs.readFileSync(REWARD_MAP_PATH, "utf8")) : {};
const flagIdx = new Set([args.indexOf("--out"), args.indexOf("--reward-map")].filter((i) => i >= 0));
const inputs = args.filter((_, i) => !flagIdx.has(i) && args[i - 1] !== "--out" && args[i - 1] !== "--reward-map");

if (!inputs.length) {
  console.error("用法: export-trajectory.mjs <session.jsonl | 目录>... [--out out.jsonl] [--reward-map rewards.json]");
  process.exit(2);
}

function collectFiles(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  const out = [];
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const sub = path.join(p, e.name);
    if (e.isDirectory()) out.push(...collectFiles(sub));
    else if (e.name.endsWith(".jsonl")) out.push(sub);
  }
  return out;
}

const files = [...new Set(inputs.flatMap(collectFiles))];

function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function exportEpisode(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(parseLine).filter(Boolean);
  const meta = { file: path.basename(file) };
  const msgs = [];
  for (const d of lines) {
    if (d.type) { // 元记录（wudao_meta/model_change/session_name/workspace_root/run_stats_receipt）
      const key = d.type;
      meta[key] = d.data ?? d.model ?? d.name ?? d.root ?? null;
      continue;
    }
    if (d.role) msgs.push(d);
  }
  // run_stats_receipt 是人类可读文本（"耗时 3m05s · 模型 2m43s · 工具 21.6s (10 次)"）
  // ——正则回填为结构化计时（兼容 10.5s 纯秒与 3m05s 分钟两种格式），训练侧直接可用。
  let timing = null;
  if (typeof meta.run_stats_receipt === "object" && meta.run_stats_receipt?.text) {
    const t = meta.run_stats_receipt.text;
    const dur = (label) => {
      const m = t.match(new RegExp(label + "\\s*([\\d.]*m?[\\d.]*s)"));
      if (!m) return null;
      const mm = m[1].match(/^(?:(\d+)m)?([\d.]+)s$/);
      return mm ? (mm[1] ? +mm[1] * 60 : 0) + +mm[2] : null;
    };
    const cnt = t.match(/\((\d+)\s*次\)/);
    const wall = dur("耗时"), model = dur("模型"), tool = dur("工具");
    if (wall != null) timing = { wall_s: wall, model_s: model, tool_s: tool, tool_calls: cnt ? +cnt[1] : null };
  }
  // 组装 step：assistant 行 + 与其 toolCallId 配对的 tool 结果行
  const byCallId = new Map();
  for (const m of msgs) if (m.role === "tool") byCallId.set(m.toolCallId, m);
  const steps = [];
  for (const m of msgs) {
    if (m.role !== "assistant") continue;
    const calls = m.toolCalls ?? [];
    const obs = calls.map((c) => {
      const r = byCallId.get(c.id) ?? {};
      return { name: r.name ?? c.name, is_error: Boolean(r.isError), content: String(r.content ?? "") };
    });
    steps.push({
      role: "assistant",
      reasoning: String(m.reasoning ?? ""),
      content: String(m.content ?? ""),
      tool_calls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
      stop_reason: m.stopReason ?? null,
      obs,
      metrics: {
        reasoning_chars: String(m.reasoning ?? "").length,
        content_chars: String(m.content ?? "").length,
        obs_chars: obs.reduce((a, o) => a + o.content.length, 0),
        n_tools: calls.length,
        n_errors: obs.filter((o) => o.is_error).length,
        // usage 注入位：ledger 不落 token 用量（在探针/run_stats 侧），
        // 训练侧需要时由外部 join 补齐。
        usage: null,
      },
    });
  }
  const firstUser = msgs.find((m) => m.role === "user");
  const episode = {
    episode_id: path.basename(file, ".jsonl"),
    meta,
    prompt: firstUser ? String(firstUser.content ?? "") : "",
    steps,
    episode_metrics: {
      n_turns: steps.length,
      n_tool_calls: steps.reduce((a, s) => a + s.metrics.n_tools, 0),
      n_errors: steps.reduce((a, s) => a + s.metrics.n_errors, 0),
      total_reasoning_chars: steps.reduce((a, s) => a + s.metrics.reasoning_chars, 0),
      total_obs_chars: steps.reduce((a, s) => a + s.metrics.obs_chars, 0),
      final_stop_reason: steps.at(-1)?.stop_reason ?? null,
      ...(timing ? { timing } : {}),
    },
    reward: REWARDS[path.basename(file, ".jsonl")] ?? null,
  };
  return episode;
}

const episodes = files.map(exportEpisode);
const payload = episodes.map((e) => JSON.stringify(e)).join("\n") + "\n";
if (OUT) {
  fs.writeFileSync(OUT, payload);
  console.error(`[traj] ${episodes.length} episodes → ${OUT}`);
} else {
  process.stdout.write(payload);
}
// 汇总打到 stderr（stdout 保持纯数据）
const tot = episodes.reduce((a, e) => a + e.episode_metrics.n_tool_calls, 0);
const err = episodes.reduce((a, e) => a + e.episode_metrics.n_errors, 0);
const rewarded = episodes.filter((e) => e.reward != null);
console.error(`[traj] 指标: ${episodes.length} episodes | ${tot} tool calls | ${err} errors |` +
  (rewarded.length ? ` reward 已对齐 ${rewarded.length}/${episodes.length}` : " reward 未对齐"));
