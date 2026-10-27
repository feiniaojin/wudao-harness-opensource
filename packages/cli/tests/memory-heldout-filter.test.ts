// 借鉴弧 C2（a reference project C4）— 盲 held-out 在记忆精化入口的过滤：带 heldout
// 标签的条目不进 /refine 的 overview（模型连 id 都拿不到）、不进 Dream 的
// 未处理批与 ground-truth 嵌入、不计入 due-gate 计数；无标签条目行为与
// pre-C2 字节相同（既有 dream/refine 套件继续钉住这一点）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput } from "@wudao/core";
import { openMemoryStore, HELDOUT_MEMORY_TAG, isHeldOutEntry } from "../src/memory/index.js";
import { buildDreamPrompt, dreamUnprocessedCount, renderDreamLedgerEmbed } from "../src/memory/dream.js";
import { planRefinement, renderRefineOverview } from "../src/memory/index.js";
import type { MemoryEntry } from "../src/memory/store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-heldout-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function entry(id: string, seq: number, tags: readonly string[] = []): MemoryEntry {
  return {
    id,
    kind: "harness",
    content: `${id} 的内容——一条普通工程记忆`,
    scope: "project",
    tags: [...tags],
    created: "2026-09-15T00:00:00.000Z",
    hits: 0,
    status: "active",
    seq,
  };
}

/** Capture every ModelInput the proposer receives. */
function capturingModel(): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    model: {
      async generate(input: ModelInput) {
        inputs.push(input);
        return { role: "assistant", content: JSON.stringify({ summary: "no changes needed", edits: [] }) };
      },
    },
  };
}

describe("heldout 标记", () => {
  it("isHeldOutEntry keys on the exact tag; untagged entries pass", () => {
    expect(isHeldOutEntry(entry("a", 1, [HELDOUT_MEMORY_TAG]))).toBe(true);
    expect(isHeldOutEntry(entry("a", 1, ["eval", HELDOUT_MEMORY_TAG]))).toBe(true);
    expect(isHeldOutEntry(entry("a", 1, ["heldout-ish"]))).toBe(false);
    expect(isHeldOutEntry(entry("a", 1, []))).toBe(false);
  });
});

describe("/refine 入口过滤", () => {
  it("heldout 条目不进 overview、不可被 update/delete 指认", async () => {
    const store = await openMemoryStore(dir);
    const sealed = await store.write({ kind: "harness", content: "det-42 的盲测结果说明 X 不如 Y", tags: [HELDOUT_MEMORY_TAG], forcePending: false });
    const normal = await store.write({ kind: "harness", content: "常规教训：构建前先清 dist", tags: [], forcePending: false });
    expect(sealed.ok).toBe(true);
    expect(normal.ok).toBe(true);

    const entries = await store.load();
    const overview = renderRefineOverview(entries);
    expect(overview).toContain("常规教训"); // 无标签条目照常可见
    expect(overview).not.toContain("盲测结果"); // 密封条目不可见
    // overview 不可见 = 模型提案里指认它的 id 会被 applyRefinement 拒绝
    // （update/delete MUST cite an existing id from the overview），纯函数面：
    const filtered = entries.filter((e) => !isHeldOutEntry(e));
    expect(filtered.some((e) => e.id === sealed.entry!.id)).toBe(false);
  });

  it("planRefinement 的模型调用里没有 heldout 条目内容", async () => {
    const store = await openMemoryStore(dir);
    await store.write({ kind: "harness", content: "SEALED-BLIND-MARKER-XYZ 从盲测看出的结论", tags: [HELDOUT_MEMORY_TAG], forcePending: false });
    await store.write({ kind: "harness", content: "VISIBLE-NORMAL-MARKER 常规教训", tags: [], forcePending: false });
    const cap = capturingModel();
    await planRefinement(cap.model, [], store);
    expect(cap.inputs).toHaveLength(1);
    const prompt = cap.inputs[0]!.messages[0]!.content as string;
    expect(prompt).toContain("VISIBLE-NORMAL-MARKER");
    expect(prompt).not.toContain("SEALED-BLIND-MARKER");
  });
});

describe("Dream 入口过滤", () => {
  const cursor = { lastSeq: 0, lastRunOk: true, lastRunAt: "2026-09-15T00:00:00.000Z" };

  it("heldout 条目不进批、不进 ground-truth 嵌入", () => {
    const entries = [entry("n1", 1), entry("s1", 2, [HELDOUT_MEMORY_TAG]), entry("n2", 3)];
    const dream = buildDreamPrompt({ entries, cursor });
    expect(dream).toBeDefined();
    expect(dream!.prompt).toContain("n1 的内容");
    expect(dream!.prompt).toContain("n2 的内容");
    expect(dream!.prompt).not.toContain("s1 的内容"); // 批里没有
    expect(dream!.prompt).not.toContain("## Current ledger (ground truth)\ns1"); // 嵌入里也没有（上面的批断言已覆盖正文，这里补嵌入段）
    // lastSeq 取自 seq 批（越过密封条目）——游标不被密封条目阻塞
    expect(dream!.lastSeq).toBe(3);
  });

  it("全密封批 → 不出模型调用（undefined），due-gate 也不为它们点火", () => {
    const entries = [entry("s1", 1, [HELDOUT_MEMORY_TAG]), entry("s2", 2, [HELDOUT_MEMORY_TAG])];
    expect(buildDreamPrompt({ entries, cursor })).toBeUndefined();
    expect(dreamUnprocessedCount(entries, cursor)).toBe(0);
    // 混合时计数只数无标签条目
    expect(dreamUnprocessedCount([...entries, entry("n1", 3)], cursor)).toBe(1);
  });

  it("ground-truth 嵌入直接调用也过滤（视图自身强制，不靠调用方）", () => {
    const entries = [entry("n1", 1), entry("s1", 2, [HELDOUT_MEMORY_TAG])];
    const embed = renderDreamLedgerEmbed(entries);
    expect(embed).toContain("n1 的内容");
    expect(embed).not.toContain("s1 的内容");
    // 全密封 → 嵌入为空串视图
    expect(renderDreamLedgerEmbed([entry("s2", 3, [HELDOUT_MEMORY_TAG])])).toBe("(empty)");
  });

  it("无标签时行为与 pre-C2 相同（回归面）", () => {
    const entries = [entry("n1", 1), entry("n2", 2)];
    const dream = buildDreamPrompt({ entries, cursor });
    expect(dream!.prompt).toContain("n1 的内容");
    expect(dream!.lastSeq).toBe(2);
    expect(dreamUnprocessedCount(entries, cursor)).toBe(2);
  });
});
