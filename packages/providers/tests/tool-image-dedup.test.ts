// 借鉴弧 β1 — adjacent byte-dedup inside the ω99-138/244 keep-K window
// (the upstream 682b973b32, digest-b C2): the window bounds COUNT, not REDUNDANCE —
// a static capture→act→capture loop fills all K slots with byte-identical
// frames. The projection seam now hashes each window member's transient data
// URL (sha256(mime+bytes), the upstream's exact key) and collapses every identical
// ADJACENT run to its NEWEST frame; older duplicates render a FIXED note
// (literal-pinned), with the omission streak capped at 2. USER images and
// non-adjacent duplicates never take the note; the JSONL keeps every ref
// (append-only — projection never rewrites history).
import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider } from "../src/index.js";
import { sameImageKeepVerdicts } from "../src/openai-images.js";
import type { ProviderConfig } from "../src/index.js";

const DEDUP_NOTE = "[截图未变：本帧与相邻截图逐字节相同，已省略图片——保留帧即当前屏幕状态]";
const KEEP_K_STUB = "[更早的截图已略：仅保留最近 3 张]";

const ref = (id: string) => ({
  kind: "image" as const,
  attachmentId: id,
  mediaType: "image/png",
  byteLength: 3,
});

const visionConfig = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  apiKey: "k",
  baseURL: "https://x/v1",
  model: "glm-4v-plus",
  ...over,
});

function captureFetch(): { fetch: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
  }) as unknown as typeof fetch;
  return { fetch, bodies };
}

/** Content-keyed resolver: `content` maps attachmentId → base64 payload, so
 *  DISTINCT ids can carry IDENTICAL bytes (two captures of a static screen
 *  are two store entries with equal content — the dedup's real trigger). */
function contentResolver(
  content: Record<string, string>,
  resolved: string[] = [],
): { resolveDataUrl: (r: { attachmentId: string; mediaType: string }) => Promise<string> } {
  return {
    resolveDataUrl: async (r) => {
      resolved.push(r.attachmentId);
      return `data:${r.mediaType};base64,${content[r.attachmentId] ?? r.attachmentId}`;
    },
  };
}

/** The interleaved shot → look history of N tool screenshots (ids shot-1…N;
 *  each shot's CONTENT comes from the resolver's `content` map, so distinct
 *  ids can carry identical bytes). */
function shotsWith(count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 1; i <= count; i += 1) {
    out.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "screen_capture", arguments: {} }] });
    out.push({ role: "tool", toolCallId: `c${i}`, name: "screen_capture", content: `shot ${i}`, images: [{ kind: "image", ref: ref(`shot-${i}`) }] });
  }
  return out;
}

/** All synthetic tool-image carriers of one request body, in wire order. */
const carriersOf = (body: Record<string, unknown>): Record<string, unknown>[][] =>
  (body["messages"] as Record<string, unknown>[])
    .filter((m) => m["role"] === "user" && Array.isArray(m["content"]))
    .map((m) => m["content"] as Record<string, unknown>[])
    .filter((parts) => (parts[0] as { text?: string })?.text === "Attached image(s) from tool result:");

const imageParts = (carriers: Record<string, unknown>[][]): Record<string, unknown>[] =>
  carriers.flat().filter((p) => p["type"] === "image_url");

describe("借鉴弧 β1 — 纯走查：newest→oldest 相邻去重判定（策略本体直测）", () => {
  it("[A] 单帧 → 保留", () => {
    expect(sameImageKeepVerdicts(["a"], 2)).toEqual([true]);
  });

  it("[A,A] 相邻对 → 只留最新一帧（older=note）", () => {
    expect(sameImageKeepVerdicts(["a", "a"], 2)).toEqual([false, true]);
  });

  it("[A,A,A] 静态三连 → 最新一帧 + 两条 note（streak 到 2=cap）", () => {
    expect(sameImageKeepVerdicts(["a", "a", "a"], 2)).toEqual([false, false, true]);
  });

  it("[A,A,A,A] 四连 → 第 4 帧后再锚一张（连击上限 2 防过时——K 加宽后的形状）", () => {
    expect(sameImageKeepVerdicts(["a", "a", "a", "a"], 2)).toEqual([true, false, false, true]);
  });

  it("[A,B,A] 非相邻相同 → 全保留（去重只看相邻）", () => {
    expect(sameImageKeepVerdicts(["a", "b", "a"], 2)).toEqual([true, true, true]);
  });

  it("[A,A,B,A,A] 两段各自坍缩，互不传染", () => {
    expect(sameImageKeepVerdicts(["a", "a", "b", "a", "a"], 2)).toEqual([false, true, true, false, true]);
  });

  it("omitCap=0 → 永不省略（cap 是策略旋钮，非硬编码）", () => {
    expect(sameImageKeepVerdicts(["a", "a", "a"], 0)).toEqual([true, true, true]);
  });
});

describe("借鉴弧 β1 — 投影缝：keep-K 窗口内相邻截图逐字节去重", () => {
  it("静态三连（3 张逐字节相同）→ 只最新一张 image_url，两张旧帧=固定 note；窗口成员全部参与哈希", async () => {
    const cap = captureFetch();
    const resolved: string[] = [];
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: contentResolver({ "shot-1": "QUFB", "shot-2": "QUFB", "shot-3": "QUFB" }, resolved),
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "watch" }, ...shotsWith(3)],
      tools: [],
    });
    const carriers = carriersOf(cap.bodies[0]!);
    expect(carriers).toHaveLength(3);
    expect(carriers[0]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "text", text: DEDUP_NOTE },
    ]);
    expect(carriers[1]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "text", text: DEDUP_NOTE },
    ]);
    expect(carriers[2]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUFB" } },
    ]);
    // 哈希源=窗口成员的瞬时 data URL：三张都解析过（K 次，预算外零解析）。
    expect(resolved.sort()).toEqual(["shot-1", "shot-2", "shot-3"]);
  });

  it("[A,A,B] 相邻对坍缩到较新一帧：A2 与 B 都上，A1=note（同图只留最新一帧的引用）", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: contentResolver({ "shot-1": "QUFB", "shot-2": "QUFB", "shot-3": "QkI" }),
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "watch" }, ...shotsWith(3)],
      tools: [],
    });
    const carriers = carriersOf(cap.bodies[0]!);
    expect(carriers[0]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "text", text: DEDUP_NOTE },
    ]);
    expect(carriers[1]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUFB" } },
    ]);
    expect(carriers[2]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QkI" } },
    ]);
  });

  it("[A,B,A] 非相邻相同 → 三张全上，零 note（相邻性是必要条件）", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: contentResolver({ "shot-1": "QUFB", "shot-2": "QkI", "shot-3": "QUFB" }),
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "watch" }, ...shotsWith(3)],
      tools: [],
    });
    const carriers = carriersOf(cap.bodies[0]!);
    expect(imageParts(carriers)).toHaveLength(3);
    expect(JSON.stringify(carriers)).not.toContain("截图未变");
  });

  it("静态四连：窗口滑动+去重叠加——最旧一张走 keep-K 桩，窗内两张=note，最新一张上；优先级桩≠note 逐字钉", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: contentResolver({ "shot-1": "QUFB", "shot-2": "QUFB", "shot-3": "QUFB", "shot-4": "QUFB" }),
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "watch" }, ...shotsWith(4)],
      tools: [],
    });
    const carriers = carriersOf(cap.bodies[0]!);
    expect(carriers).toHaveLength(4);
    expect(carriers[0]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "text", text: KEEP_K_STUB },
    ]);
    expect(carriers[1]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "text", text: DEDUP_NOTE },
    ]);
    expect(carriers[2]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "text", text: DEDUP_NOTE },
    ]);
    expect(carriers[3]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUFB" } },
    ]);
  });

  it("USER 图逐字节相同也全上（用户车道零漂移——去重只吃 tool 图）", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: contentResolver({ u1: "QUFB", u2: "QUFB", u3: "QUFB" }),
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "mine", images: [{ kind: "image", ref: ref("u1") }, { kind: "image", ref: ref("u2") }, { kind: "image", ref: ref("u3") }] }],
      tools: [],
    });
    const msgs = cap.bodies[0]!.messages as Record<string, unknown>[];
    const parts = (msgs[1] as { content: Record<string, unknown>[] }).content;
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(3);
    expect(JSON.stringify(parts)).not.toContain("截图未变");
  });

  it("确定性：同一史两次构建投影逐字节相同（note 字面固定）", async () => {
    const build = async (): Promise<string> => {
      const cap = captureFetch();
      const model = createOpenAICompatibleProvider(visionConfig(), {
        fetch: cap.fetch,
        attachments: contentResolver({ "shot-1": "QUFB", "shot-2": "QUFB", "shot-3": "QkI" }),
      });
      await model.generate({
        systemPrompt: "s",
        messages: [{ role: "user", content: "watch" }, ...shotsWith(3)],
        tools: [],
      });
      return JSON.stringify(carriersOf(cap.bodies[0]!));
    };
    expect(await build()).toEqual(await build());
  });

  it("JSONL 不动（append-only 直证）：投影后输入史三张 refs 一条不少", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: contentResolver({ "shot-1": "QUFB", "shot-2": "QUFB", "shot-3": "QUFB" }),
    });
    const history = [{ role: "user" as const, content: "watch" }, ...shotsWith(3)];
    const before = JSON.parse(JSON.stringify(history));
    await model.generate({ systemPrompt: "s", messages: history, tools: [] });
    expect(history).toEqual(before);
    expect(JSON.stringify(history).match(/shot-\d/g)).toHaveLength(3);
    expect(imageParts(carriersOf(cap.bodies[0]!))).toHaveLength(1); // 线上只 1 张
  });

  it("哈希解析失败 fail-open：不可解析帧不毒化准入（offload 路径表面与 β1 前一致）", async () => {
    const cap = captureFetch();
    const calls = new Map<string, number>();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      // Budget fits ONE image: the resolver-throwing frame must offload (its
      // bytes never resolve in the render pass either) — same as pre-β1.
      maxRequestImageBytes: 8,
      attachments: {
        resolveDataUrl: async (r: { attachmentId: string; mediaType: string }) => {
          const n = calls.get(r.attachmentId) ?? 0;
          calls.set(r.attachmentId, n + 1);
          if (r.attachmentId === "shot-1") throw new Error("store read failed");
          return `data:${r.mediaType};base64,${r.attachmentId === "shot-2" ? "QUFB" : "QkI"}`;
        },
      },
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "watch" }, ...shotsWith(3)],
      tools: [],
    });
    // shot-1 resolved once (hash attempt, swallowed), never again; the note
    // never applies to it (no hash → unique sentinel → rides/offloads as ever).
    expect(calls.get("shot-1")).toBe(1);
    const flat = carriersOf(cap.bodies[0]!).flat();
    expect(flat.some((p) => p["type"] === "text" && p["text"] === "[image omitted: shot-1]")).toBe(true);
  });
});
