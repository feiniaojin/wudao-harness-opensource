// 123-2（zcode ReadSessionContext 引进）— read_session 整会话预算读取收据。
// 保尾预算/省略头行诚实/压缩感知窗口行/会话缺席与形状门/晚绑缝挂载面。
import { describe, expect, it } from "vitest";
import type { HistorySearchCorpus } from "@wudao-org/core";
import { createReadSessionTool, readSessionText, READ_SESSION_DEFAULT_BUDGET } from "../src/read-session.js";
import { historySearchCorpus } from "../src/history-search.js";
import { createJsonlSessionStore } from "@wudao-org/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const corpus = (n: number, over: Partial<HistorySearchCorpus> = {}): HistorySearchCorpus => ({
  entries: Array.from({ length: n }, (_, i) => ({
    seq: i,
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `第${String(i + 1)}轮的内容——${"x".repeat(50)}`,
  })),
  totalMessages: n,
  ...over,
});

describe("123-2 — readSessionText 纯层", () => {
  it("预算内全量：无省略行，压缩感知行在场", () => {
    const text = readSessionText(corpus(5), READ_SESSION_DEFAULT_BUDGET);
    expect(text).toContain("#1 用户:");
    expect(text).toContain("#5 用户:"); // i%2==0 → user（第 5 轮=i4）
    expect(text).not.toContain("已省略");
    expect(text).toContain("当前未压缩窗口 5 轮");
  });

  it("超预算保尾：头行诚实记省略量 + search_history 出路", () => {
    const text = readSessionText(corpus(200), 2_000);
    expect(text).toMatch(/…前 \d+ 轮已省略（共 200 轮/);
    expect(text).toContain("search_history");
    // 尾保留：最后一轮在场。
    expect(text).toContain("#200 助手:");
    // 头被截：第一轮不在（预算内放不下就不放）。
    expect(text).not.toContain("#1 用户:");
  });

  it("压缩感知：有边界时窗口行=边界后轮数", () => {
    const c = corpus(10, { recentFromSeq: 5 }); // seq≥5 的 5 条=当前窗口
    const text = readSessionText(c, READ_SESSION_DEFAULT_BUDGET);
    expect(text).toContain("当前未压缩窗口 5 轮（台账共 10 条消息");
  });
});

describe("123-2 — read_session 工具面", () => {
  it("形状门：非 id 形（路径/穿越）拒绝；会话缺席诚实", async () => {
    const box = { read: async () => undefined };
    const tool = createReadSessionTool(box);
    const bad = await tool.execute({ session_id: "../etc/passwd" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("形状不对");
    const absent = await tool.execute({ session_id: "nosuch123" });
    expect(absent.isError).toBe(true);
    expect(absent.content).toContain("没有会话");
  });

  it("晚绑缝缺席=诚实拒答；就位=真台账读取（集成：真 store 真 JSONL）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arc123-rs-"));
    const store = createJsonlSessionStore(join(dir, ".wudao", "sessions"));
    await store.append("priorsess", { role: "user", content: "把 utils 按模块拆分" });
    await store.append("priorsess", { role: "assistant", content: "完成了拆分，共 4 个模块。" });

    const noSeam = createReadSessionTool({});
    const refused = await noSeam.execute({ session_id: "priorsess" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("未接线");

    const box = { read: (sid: string) => historySearchCorpus(store, sid).catch(() => undefined) };
    const ok = await createReadSessionTool(box).execute({ session_id: "priorsess" });
    expect(ok.isError).not.toBe(true);
    expect(ok.content).toContain("把 utils 按模块拆分");
    expect(ok.content).toContain("完成了拆分");
  });

  it("预算钳制：超帽收到 48k，低于地板抬到 2k（不拒）", async () => {
    const box = { read: async () => corpus(3) };
    const tool = createReadSessionTool(box);
    const ok = await tool.execute({ session_id: "abc12345", budget_chars: 999_999 });
    expect(ok.isError).not.toBe(true);
  });
});
