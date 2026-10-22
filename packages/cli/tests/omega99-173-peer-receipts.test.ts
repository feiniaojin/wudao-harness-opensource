// ω99-173 — peer 域回执中文化：源接线钉（readFileSync 直读源，166/170 系
// 范式）。三组：peer/runtime.ts 挂起族（held/批准/拒绝/过期四面）/
// runtime.ts 拦截与故障族（评审拦截×2+注册表+收件箱四面）/ peer/inbound.ts
// 设置警告三面。插值/${} 结构逐字保留；负钉落笔前已 grep 两 src 注释层+
// 活码层复核：`incoming peer`/`peer registry unavailable`/`peer inbox
// failed`/`held from`/`awaiting approval`/`expected accept|hold|refuse`/
// `): expected` 均零表外命中，按 brief §三原形落笔，无需收窄，此处披露。
// 同类钉披露：tests/omega99-78-teams-send-validation.test.ts:4 注释层提及
// "blocked by review"（其活钉 :91 已在 ω99-170 演进为中文），非断言宿主，
// 本弧不触。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const runtimeSrc = readFileSync(new URL("../src/peer/runtime.ts", import.meta.url), "utf8") as string;
const inboundSrc = readFileSync(new URL("../src/peer/inbound.ts", import.meta.url), "utf8") as string;

describe("ω99-173 A — peer/runtime.ts 挂起族回执四面中文化", () => {
  it("挂起/等待批准/批准投递/拒绝/过期丢弃回执为中文（正钉；插值结构逐字）", () => {
    expect(runtimeSrc).toContain("📬 来自 ${msg.senderName} 的 peer 消息已挂起（${peerShortId(msg.senderId)}，层级 ${msg.senderTier}）——等待批准");
    expect(runtimeSrc).toContain("已挂起");
    expect(runtimeSrc).toContain("等待批准");
    expect(runtimeSrc).toContain("已批准——投递中");
    expect(runtimeSrc).toContain("的挂起消息已拒绝");
    expect(runtimeSrc).toContain("已过期（dialogExpiry）——已丢弃");
  });

  it("旧英文回执归零（负钉）", () => {
    expect(runtimeSrc).not.toContain("held from");
    expect(runtimeSrc).not.toContain("awaiting approval");
    expect(runtimeSrc).not.toContain("— delivering");
  });
});

describe("ω99-173 B — peer/runtime.ts 拦截与故障族回执四面中文化", () => {
  it("评审拦截×2/注册表不可用/收件箱启动失败回执为中文（正钉；同式插值逐字）", () => {
    expect(runtimeSrc).toContain("🛡 来自 ${senderName} 的 peer 消息被评审拦截——已拒绝");
    expect(runtimeSrc).toContain("🛡 来自 ${frame.by} 的 peer 回报被评审拦截——已拒绝");
    expect(runtimeSrc).toContain("⚠️ peer 注册表不可用：${err instanceof Error ? err.message : String(err)}——消息保持仅本地");
    expect(runtimeSrc).toContain("⚠️ peer 收件箱启动失败：${err instanceof Error ? err.message : String(err)}——消息接收已停用");
    expect(runtimeSrc).toContain("被评审拦截");
  });

  it("旧英文回执归零（负钉；grep 已复核注释层零命中，原形落笔）", () => {
    expect(runtimeSrc).not.toContain("incoming peer");
    expect(runtimeSrc).not.toContain("peer registry unavailable");
    expect(runtimeSrc).not.toContain("peer inbox failed");
  });
});

describe("ω99-173 C — peer/inbound.ts 设置警告三面中文化", () => {
  it("三层设置警告为中文（正钉；路径字面与枚举值 accept|hold|refuse 保留）", () => {
    expect(inboundSrc).toContain("⚠️ peerInbound（全局）：应为 accept|hold|refuse——已忽略");
    expect(inboundSrc).toContain("⚠️ .wudao/settings.json 的 peerInbound：应为 accept|hold|refuse——已忽略");
    expect(inboundSrc).toContain("⚠️ .wudao/settings.local.json 的 peerInbound：应为 accept|hold|refuse——已忽略");
  });

  it("旧英文警告归零（负钉；窄形 ): expected 避路径误伤）", () => {
    expect(inboundSrc).not.toContain("expected accept|hold|refuse");
    expect(inboundSrc).not.toContain("): expected");
  });
});
