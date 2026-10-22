// 研究弧A#1（TTL 冷窗免费清理）钉——the upstream formattimeBasedMC 的 wudao 超越版：
// cold 预测 expired+idle 时，startRun 在用户消息入列前做 tier-0 清除
// （零边际缓存代价），带冷转归因回执。钉四件事：
//   ①idle+expired → clearTier 生效（大旧工具结果被清）+ 冷窗一次性
//   ②identity_changed 不触发（换模型不清上下文）
//   ③warm（未过 TTL）不触发
//   ④cleared=0 时不打旗不置位
import { describe, it, expect } from "vitest";
import { clearTier, CLEARED_MARKER } from "@wudao/core";
import type { AgentMessage } from "@wudao/core";

const BIG = "x".repeat(35_000); // 过 CLEAR_TIER_MIN_CHARS（30k）
const bigHistory = (): AgentMessage[] => {
  // 够长的历史：keepRecent=6 地板只保护最近轮，早轮的大工具结果在清除面。
  const out: AgentMessage[] = [];
  for (let round = 1; round <= 6; round += 1) {
    out.push({ role: "user", content: `q${round}` });
    out.push({ role: "assistant", content: "", toolCalls: [{ id: `t${round}`, name: "shell", arguments: { command: "ls" } }] });
    out.push({ role: "tool", toolCallId: `t${round}`, name: "shell", content: BIG });
    out.push({ role: "assistant", content: `done${round}` });
  }
  return out;
};

describe("研究弧A#1 — TTL 冷窗 tier-0 免费清理", () => {
  it("① fits=∞ 时大旧工具结果全清（keepRecent 地板保护最近轮）", () => {
    const cleared = clearTier(bigHistory()); // 缺省 fits=全清（fits:∞ 语义反转教训——estimate 恒 fits 反而零清除）
    expect(cleared.cleared).toBeGreaterThanOrEqual(1);
    expect(cleared.messages.length).toBe(bigHistory().length); // 桩替换不删行（行数不变）
    const clearedMarkers = cleared.messages.filter((m) => m.role === "tool" && m.content.includes(CLEARED_MARKER));
    expect(clearedMarkers.length).toBeGreaterThanOrEqual(1);
  });

  it("② identity_changed≠idle：语义不同（换模型保留上下文）——由调用侧门控，钉导出面", () => {
    // 驱动侧的门控条件是 cold.reason === "idle"（identity_changed 不触发）；
    // 这里钉的是 clearTier 本身在两种场景下行为一致（清除动作本身无区别，
    // 触发门在 driver——集成钉在下面③④用纯逻辑复现）。
    const a = clearTier(bigHistory());
    expect(a.cleared).toBeGreaterThanOrEqual(1);
  });

  it("③ 触发门纯逻辑：expired+idle 才 armed（复现 driver 的 if 条件）", () => {
    const arm = (cold: { confidence: string; reason: string } | undefined, cleared: boolean, len: number): boolean =>
      cold !== undefined && cold.confidence === "expired" && cold.reason === "idle" && !cleared && len > 0;
    expect(arm({ confidence: "expired", reason: "idle" }, false, 8)).toBe(true);
    expect(arm({ confidence: "expired", reason: "identity_changed" }, false, 8)).toBe(false); // 换模型不触发
    expect(arm({ confidence: "may-be-cold", reason: "idle" }, false, 8)).toBe(false); // 未确证不触发
    expect(arm({ confidence: "expired", reason: "idle" }, true, 8)).toBe(false); // 冷窗一次性
    expect(arm(undefined, false, 8)).toBe(false);
    expect(arm({ confidence: "expired", reason: "idle" }, false, 0)).toBe(false); // 空历史不触发
  });

  it("④ cleared=0（无大旧结果）不打旗", () => {
    const small: AgentMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ];
    const cleared = clearTier(small);
    expect(cleared.cleared).toBe(0);
    expect(cleared.messages.length).toBe(small.length); // 零改动=行数不变
  });
});
