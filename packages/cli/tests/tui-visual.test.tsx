// M25-B visual-layer render tests (B2 turn structure; B3 spinner, B4 status
// bar and B5 input sections are appended with their commits).
//
// ink drops colors when stdout is not a TTY, so frames would carry no ANSI.
// This suite forces chalk's FORCE_COLOR before dynamically importing ink (the
// env var is read at chalk's module init) and restores it afterwards — color
// assertions then pin the semantic mapping (accent/err/warn/...) for real,
// while all text assertions run against a stripped (stripAnsi-tolerant) copy.
const HAD_FORCE_COLOR = process.env.FORCE_COLOR;
process.env.FORCE_COLOR = "1";
const React = await import("react");
const { render } = await import("ink-testing-library");
const { createScriptedModel } = await import("@wudao-org/core");
const { HistoryItem, WudaoApp } = await import("../src/tui/app.js");
const { SPINNER_FRAMES, Spinner } = await import("../src/tui/spinner.js");
const { StatusBar } = await import("../src/tui/status-bar.js");
const { TextInput } = await import("../src/tui/input.js");
const { T } = await import("../src/tui/theme.js");

import { describe, it, expect, afterAll, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@wudao-org/providers";

afterAll(() => {
  if (HAD_FORCE_COLOR === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = HAD_FORCE_COLOR;
});

// SGR helpers: ESC + "[<codes>m". Stripping leaves text intact; asserting the
// codes pins the color where the color is the feature.
const ESC = String.fromCharCode(27);
const sgr = (codes: string): string => ESC + "[" + codes + "m";
const strip = (s: string): string => s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

// ---------------------------------------------------------------------------
// B1/B2 — theme + turn structure
// ---------------------------------------------------------------------------


// M53 §3: the StatusBar renders from the statusline snapshot — build one.
const snap = (over: Partial<import("../src/statusline.js").StatuslineSnapshot>): import("../src/statusline.js").StatuslineSnapshot => ({
  version: "t",
  model: "m",
  mode: "ask",
  session: { id: "s12345678", id8: "s1234567" },
  busy: false,
  queued: 0,
  ctx: null,
  cache: null,
  board: null,
  sidecar: null,
  bg: { active: 0, spawned: 0 },
  live: { answerChars: 0, reasoningChars: 0, busyTools: 0 },
  ...over,
});

describe("M25-B1 theme", () => {
  it("exposes the semantic palette as ink color names", () => {
    expect(T).toEqual({
      accent: "cyan",
      dim: "gray",
      ok: "green",
      warn: "yellow",
      err: "red",
      board: "magenta",
    });
  });
});

describe("M25-B2 HistoryItem turn structure", () => {
  it("renders the divider entry as a dim rule: dash-dash text dash-dash", () => {
    const inst = render(<HistoryItem entry={{ kind: "divider", text: "已恢复 abc12345 · 3 条消息" }} />); // ω99-176: #7（夹具归一——divider 词表与 src/tui/resume.ts 对齐）
    expect(strip(inst.lastFrame() ?? "")).toBe("── 已恢复 abc12345 · 3 条消息 ──");
    expect(inst.lastFrame() ?? "").toContain(sgr("2")); // dim
  });

  it("renders the user echo with an accent prompt glyph and dim text", () => {
    const inst = render(<HistoryItem entry={{ kind: "user", text: "hi there" }} />);
    expect(strip(inst.lastFrame() ?? "")).toBe("› hi there");
    expect(inst.lastFrame() ?? "").toContain(sgr("36") + "› "); // accent prefix
  });

  it("renders a tool entry CC-style: marker name(params) + indented dim result preview", () => {
    const inst = render(
      <HistoryItem entry={{ kind: "tool", name: "read_file", summary: "a.ts", resultPreview: "file body" }} />,
    );
    const frame = inst.lastFrame() ?? "";
    expect(strip(frame).split("\n")).toEqual(["⏺ read_file(a.ts)", "  ↳ file body"]);
    // The marker+name line is default-colored; the preview is dim.
    expect(frame).toContain("⏺ read_file");
    expect(frame).toContain(sgr("2") + "  ↳ file body");
  });

  it("renders an errored tool with the stop-marker in err color", () => {
    const inst = render(
      <HistoryItem entry={{ kind: "tool", name: "shell", summary: "make", isError: true, resultPreview: "boom" }} />,
    );
    const frame = inst.lastFrame() ?? "";
    expect(strip(frame).split("\n")).toEqual(["⏹ shell(make)", "  ↳ [error] boom"]);
    expect(frame).toContain(sgr("31") + "⏹"); // err color on the marker
  });

  it("renders a tool without a summary as a bare marker + name", () => {
    const inst = render(<HistoryItem entry={{ kind: "tool", name: "task", summary: "" }} />);
    expect(strip(inst.lastFrame() ?? "")).toBe("⏺ task");
  });

  it("renders notices in warn color", () => {
    const inst = render(<HistoryItem entry={{ kind: "notice", text: "♻️ compacted context" }} />);
    expect(strip(inst.lastFrame() ?? "")).toBe("♻️ compacted context");
    expect(inst.lastFrame() ?? "").toContain(sgr("33")); // warn
  });

  it("separates Static entries with exactly one blank line (turn rhythm)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "TURN-ANSWER" }]);
    const root = mkdtempSync(join(tmpdir(), "wudao-b2-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} />,
    );
    await wait();
    await type(inst.stdin, "hi\r");
    await until(() => (inst.lastFrame() ?? "").includes("TURN-ANSWER"), "answer in frame");
    const lines = strip(inst.lastFrame() ?? "").split("\n");
    const echo = lines.indexOf("› hi");
    const answer = lines.indexOf("TURN-ANSWER");
    expect(echo).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThan(echo);
    // exactly one blank line between the echoed turn and the assistant answer
    expect(lines[echo + 1]).toBe("");
    expect(lines[echo + 2]).toBe("TURN-ANSWER");
    inst.unmount();
  });
});

// ---------------------------------------------------------------------------
// B3 — animated spinner
// ---------------------------------------------------------------------------

describe("M25-B3 Spinner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("animates frames at ~100ms with trailing elapsed seconds (fake timers, two snapshots)", async () => {
    vi.useFakeTimers();
    const inst = render(<Spinner />);
    // Snapshot 1 — t=0: first frame, 0 elapsed.
    expect(strip(inst.lastFrame() ?? "")).toBe(`${SPINNER_FRAMES[0]} (0s)`);
    // Advance two spinner ticks (t=250ms virtual; the extra 50ms covers
    // ink's ~32ms render throttle, which coalesces intermediate flushes —
    // the live frame lands exactly two glyphs ahead).
    await vi.advanceTimersByTimeAsync(250);
    // Snapshot 2 — two ticks later: third glyph, still 0s elapsed.
    expect(strip(inst.lastFrame() ?? "")).toBe(`${SPINNER_FRAMES[2]} (0s)`);
    inst.unmount();
  });

  it("wraps frames and counts elapsed seconds past the first second", async () => {
    vi.useFakeTimers();
    const inst = render(<Spinner />);
    await vi.advanceTimersByTimeAsync(1200);
    const frame = strip(inst.lastFrame() ?? "");
    expect(frame.endsWith(" (1s)")).toBe(true);
    expect(frame.startsWith(SPINNER_FRAMES[12 % SPINNER_FRAMES.length] ?? "")).toBe(true);
    inst.unmount();
  });

  it("clears the interval on unmount (no late frames)", async () => {
    vi.useFakeTimers();
    const inst = render(<Spinner />);
    await vi.advanceTimersByTimeAsync(100);
    inst.unmount();
    const before = inst.frames.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(inst.frames.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// B5 — input area
// ---------------------------------------------------------------------------

describe("M25-B5 TextInput", () => {
  it("renders an accent prompt glyph and a visible caret block on the empty line", () => {
    const inst = render(<TextInput onSubmit={() => {}} />);
    const frame = inst.lastFrame() ?? "";
    expect(strip(frame)).toBe("› █");
    expect(frame).toContain(sgr("36") + "› "); // accent prompt
    inst.unmount();
  });

  it("indents continuation lines two cells under the prompt-aligned text", async () => {
    const inst = render(<TextInput onSubmit={() => {}} />);
    await wait();
    await type(inst.stdin, "ab");
    await type(inst.stdin, "\\\r"); // \+Enter → new line
    await type(inst.stdin, "c");
    const frame = inst.lastFrame() ?? "";
    expect(strip(frame).split("\n")).toEqual(["› ab", "  c█"]);
    // caret block carries the accent color
    expect(frame).toContain(sgr("36") + "█");
    inst.unmount();
  });
});

// ---------------------------------------------------------------------------
// B4 — bottom status bar
// ---------------------------------------------------------------------------

describe("M25-B4 StatusBar", () => {
  it("composes the full single-line bar", () => {
    const inst = render(
      <StatusBar snapshot={snap({ model: "deepseek-chat", session: { id: "abcd1234", id8: "abcd1234" }, ctx: { used: 49800, window: 64000, nearLimit: false }, cache: { percent: 57 }, board: { done: 2, total: 3 } })} />,
    );
    expect(strip(inst.lastFrame() ?? "")).toBe(
      "wudao · deepseek-chat · abcd1234 │ 模式 ask │ ctx 49.8k/64k │ cache 57% │ ▣ 2/3", // ω99-190: 钉随源演进（census 兜出）
    );
    expect((inst.lastFrame() ?? "").split("\n")).toHaveLength(1); // single line
    inst.unmount();
  });

  it("appends a warn-colored ⚠ when ctx is near the limit", () => {
    const inst = render(
      <StatusBar snapshot={snap({ model: "m", session: { id: "s", id8: "s" }, ctx: { used: 60000, window: 64000, nearLimit: true } })} />,
    );
    expect(strip(inst.lastFrame() ?? "")).toBe("wudao · m · s │ 模式 ask │ ctx 60k/64k ⚠"); // ω99-190: 钉随源演进
    expect(inst.lastFrame() ?? "").toContain(sgr("33") + " ⚠"); // warn marker
    inst.unmount();
  });

  it("omits absent segments entirely (no dangling separators)", () => {
    const inst = render(<StatusBar snapshot={snap({ model: "m", session: { id: "s", id8: "s" } })} />);
    const frame = inst.lastFrame() ?? "";
    expect(strip(frame)).toBe("wudao · m · s │ 模式 ask"); // ω99-190: 钉随源演进
    expect(frame).not.toContain("ctx ");
    expect(frame).not.toContain("cache ");
    expect(frame).not.toContain("▣");
    inst.unmount();
  });

  it("renders the minimal head+mode line when every optional segment is absent", () => {
    const inst = render(<StatusBar snapshot={snap({})} />);
    expect(strip(inst.lastFrame() ?? "")).toBe("wudao · m · s1234567 │ 模式 ask"); // ω99-190: 钉随源演进
    inst.unmount();
  });

  it("renders the board segment in board color", () => {
    const inst = render(
      <StatusBar snapshot={snap({ model: "m", session: { id: "s", id8: "s" }, board: { done: 1, total: 4 } })} />,
    );
    expect(inst.lastFrame() ?? "").toContain(sgr("35") + "▣ 1/4"); // magenta
    inst.unmount();
  });

  it("threads model/session/cache/board into the app's bottom bar (integration)", async () => {
    let call = 0;
    const model = {
      async generate(input: import("@wudao-org/core").ModelInput) {
        call += 1;
        input.onUsage?.({ promptTokens: 2000, cacheHitTokens: 0, cacheMissTokens: 2000 });
        return { role: "assistant" as const, content: "BAR-ANSWER" };
      },
    };
    const root = mkdtempSync(join(tmpdir(), "wudao-b4-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} sessionId="wudao-bar-session-1" />,
    );
    await wait();
    // Before any model call: head + the M42 live mode segment (cache under
    // floor, no ctx, no board).
    const bar0 = strip(inst.lastFrame() ?? "").split("\n").filter((l) => l.startsWith("wudao · "));
    expect(bar0).toEqual([`wudao · ${config.model} · wudao-ba │ 模式 accept`]); // ω99-190: 钉随源演进

    await type(inst.stdin, "hi\r");
    await until(() => (inst.lastFrame() ?? "").includes("BAR-ANSWER"), "answer in frame");
    const bar1 = strip(inst.lastFrame() ?? "").split("\n").filter((l) => l.startsWith("wudao · "));
    // Post-merge: branch A's real ctx watermark is active — the bar shows
    // the estimate-based occupancy segment alongside cache.
    expect(bar1[0]).toContain(`wudao · ${config.model} · wudao-ba │ 模式 accept │ ctx `); // ω99-190: 钉随源演进
    expect(bar1[0]).toContain(`/64k │ cache 0%`);
    inst.unmount();
  });
});

// ---------------------------------------------------------------------------
// M35 §1/§2 — defer segment: the status bar counts deferred_loaded entries;
// the app integration drives a real load_tools call through the loop.
// ---------------------------------------------------------------------------

describe("M35 defer status", () => {
  it("StatusBar renders `defer N` only when the count is ≥ 1", () => {
    const withDefer = render(<StatusBar snapshot={snap({ model: "m", session: { id: "s", id8: "s" } })} deferredLoaded={1} />);
    expect(strip(withDefer.lastFrame() ?? "")).toBe("wudao · m · s │ 模式 ask │ defer 1"); // ω99-190: 钉随源演进
    withDefer.unmount();

    const zero = render(<StatusBar snapshot={snap({ model: "m", session: { id: "s", id8: "s" } })} deferredLoaded={0} />);
    expect(strip(zero.lastFrame() ?? "")).toBe("wudao · m · s │ 模式 ask"); // ω99-190: 钉随源演进
    zero.unmount();

    const absent = render(<StatusBar snapshot={snap({ model: "m", session: { id: "s", id8: "s" } })} deferredLoaded={null} />);
    expect(strip(absent.lastFrame() ?? "")).toBe("wudao · m · s │ 模式 ask"); // ω99-190: 钉随源演进
    absent.unmount();
  });

  it("a load_tools call through the app bumps the bar to `defer 1` and lands a deferred_loaded entry in the JSONL", async () => {
    const { buildTool } = await import("@wudao-org/core");
    const deferredTool = buildTool({
      name: "task",
      description: "Defer-marked orchestration stub.",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"], additionalProperties: false },
      shouldDefer: () => true,
      async execute() {
        return { content: "spawned" };
      },
    });
    const eager = buildTool({
      name: "read_file",
      description: "Eager stub.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async execute() {
        return { content: "ok" };
      },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "d1", name: "load_tools", arguments: { names: ["task"] } }] },
      { role: "assistant", content: "DEFER-ANSWER" },
    ]);
    const root = mkdtempSync(join(tmpdir(), "wudao-defer-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[eager, deferredTool]} sessionId="wudao-defer-sess1" />,
    );
    await wait();
    await type(inst.stdin, "go\r");
    await until(() => (inst.lastFrame() ?? "").includes("DEFER-ANSWER"), "defer run to finish");

    const frame = inst.lastFrame() ?? "";
    expect(frame).toContain("defer 1");
    expect(frame).toContain("工具已加载：task"); // ω99-166f-iii: 钉随源演进
    inst.unmount();

    // Persistence is fire-and-forget — poll for the entry like the other
    // JSONL assertions (the file write can lag the frame under load).
    const { readFileSync } = await import("node:fs");
    const sessPath = join(root, ".wudao", "sessions", "wudao-defer-sess1.jsonl");
    await until(() => {
      try {
        return readFileSync(sessPath, "utf8").includes("deferred_loaded");
      } catch {
        return false;
      }
    }, "deferred_loaded entry in the session JSONL");
    const lines = readFileSync(sessPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const entry = lines.find((l) => l["type"] === "deferred_loaded");
    expect(entry).toEqual({ type: "deferred_loaded", data: { names: ["task"] } });
  });
});

// ---------------------------------------------------------------------------
// 0.3.15（用户需求：执行耗时可见）—— tool 行尾耗时、回复卡耗时 meta、
// 状态栏 busy 活秒表。
// ---------------------------------------------------------------------------

describe("0.3.15 duration surfaces", () => {
  it("the tool line carries the I21 wall clock as a dim tail (errored calls too — failure also costs time)", () => {
    const ok = render(<HistoryItem entry={{ kind: "tool", name: "shell", summary: "npm t", resultPreview: "ok", durationMs: 1_234 }} />);
    expect(strip(ok.lastFrame() ?? "")).toContain("⏺ shell(npm t)");
    expect(strip(ok.lastFrame() ?? "")).toContain("· 1.2s");
    ok.unmount();

    const err = render(<HistoryItem entry={{ kind: "tool", name: "shell", summary: "npm t", isError: true, resultPreview: "boom", durationMs: 2_000 }} />);
    expect(strip(err.lastFrame() ?? "")).toContain("· 2.0s");
    err.unmount();

    const bare = render(<HistoryItem entry={{ kind: "tool", name: "read_file", summary: "a.ts" }} />);
    expect(strip(bare.lastFrame() ?? "")).not.toContain("· ");
    bare.unmount();
  });

  it("the settled assistant entry renders its generation-time meta line; absent durationMs renders none", () => {
    const withDur = render(<HistoryItem entry={{ kind: "assistant", text: "here you go", durationMs: 2_100 }} />);
    expect(strip(withDur.lastFrame() ?? "")).toContain("here you go");
    expect(strip(withDur.lastFrame() ?? "")).toContain("· 2.1s");
    withDur.unmount();

    const without = render(<HistoryItem entry={{ kind: "assistant", text: "here you go" }} />);
    expect(strip(without.lastFrame() ?? "")).not.toContain("2.1s");
    without.unmount();
  });

  it("the status bar renders the busy clock beside mode and omits it when idle", () => {
    const busy = render(<StatusBar snapshot={snap({})} busyElapsed={12} />);
    expect(strip(busy.lastFrame() ?? "")).toBe("wudao · m · s1234567 │ 模式 ask │ ▌12s"); // ω99-190: 钉随源演进
    busy.unmount();

    const idle = render(<StatusBar snapshot={snap({})} />);
    expect(strip(idle.lastFrame() ?? "")).toBe("wudao · m · s1234567 │ 模式 ask"); // ω99-190: 钉随源演进
    idle.unmount();
  });

  it("integration: a slow run ticks the live clock in the bar and clears it at settle, then the receipt notice lands", async () => {
    // ≥2.6s model call: the 1s-delayed clock ticks at least once mid-run.
    // The tick condition matches ANY second label (the feature is "it ticks",
    // not a specific label): under release-gate load a paint can skip "▌1s"
    // entirely, and a 300ms-only window made the old exact-match flake
    // (gate run 3). 2.6s widens the visible window to 1.6s.
    const model = {
      async generate(input: import("@wudao-org/core").ModelInput) {
        await new Promise((r) => setTimeout(r, 2_600));
        input.onUsage?.({ promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, durationMs: 2_600 });
        return { role: "assistant" as const, content: "SLOW-ANSWER" };
      },
    };
    const root = mkdtempSync(join(tmpdir(), "wudao-dur-"));
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} sessionId="wudao-dur-sess1" />,
    );
    await wait();
    await type(inst.stdin, "go\r");
    await until(() => /▌\d+s/.test(inst.lastFrame() ?? ""), "the live busy clock to tick in the status bar");
    await until(() => (inst.lastFrame() ?? "").includes("SLOW-ANSWER"), "slow run to finish");
    // Settled: the clock segment retires (idle) and the receipt notice +
    // the reply's own meta line land.
    await until(() => {
      const bars = strip(inst.lastFrame() ?? "").split("\n").filter((l) => l.startsWith("wudao · "));
      return bars.length > 0 && !bars[0]!.includes("▌");
    }, "busy clock to retire at settle");
    const frame = strip(inst.lastFrame() ?? "");
    expect(frame).toContain("· 2.6s"); // the reply's generation-time meta
    expect(frame).toContain("耗时 "); // the run receipt notice
    expect(frame).toContain("模型 2.6s");
    inst.unmount();
  }, 20000);
});
