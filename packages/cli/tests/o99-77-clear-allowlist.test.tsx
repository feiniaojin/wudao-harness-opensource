// ω99-77 rider（73 的第三条 lane）— TUI /clear 清 allowlist。ω99-73 已把
// 「/clear ⇒ ask 复活」修成 REPL（repl.ts `sessionAllowlist.clear()`）与
// 引擎（session-engine.ts onSessionCleared `allowlist.clear()`）两 lane 的
// 机械律，但 TUI 是第三条 lane：app.tsx 的 allowlistRef（createSessionAllowlist
// 实例，铸入 richDecide 的 `session: allowlistRef.current`）在 onSessionCleared
// （boundary 落盘 + sessionId 轮换 + model.rotate）里唯独不清——`a` 的会话
// 规则越界存活到 /clear 之后。两枚用例：
//   ① 源钉（强制底线）：onSessionCleared 体内必须调 allowlistRef.current.clear()
//      ——72 的 readFileSync 源钉先例（行为级无缝时它兜底；这里两者都有）；
//   ② 行为级（o99-73 REPL lane 的 TUI 形状）：ask 模式下 edit:a.ts 问 →
//      答 `a`（落 session 规则 + 收据）→ 同路径静默（规则真落了）→ /clear
//      确认 → 同路径再问（恰第二次；base 上 1 次=红）→ 答 `y` 仍执行。
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { Tool } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { WudaoApp } from "../src/tui/app.js";

const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`o99-77: timeout waiting for ${what}`);
    await wait(20);
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

const src = (p: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

function stubEditTool(): Tool {
  return buildTool({
    name: "edit",
    description: "stub edit",
    parameters: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const },
        old_string: { type: "string" as const },
        new_string: { type: "string" as const },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    execute: async () => ({ content: "ok" }),
  });
}

describe("ω99-77 rider — TUI /clear clears the session allowlist", () => {
  it("① source pin: onSessionCleared calls allowlistRef.current.clear() (73's third lane)", () => {
    // 拆分运动 C 钉随迁：onSessionCleared 随持久化回调簇外提至 app-persist.ts
    //（allowlistRef 经依赖注入，调用点为 S.allowlistRef.current.clear()）。
    const app = src("tui/app-persist.ts");
    // Scope the pin to the callback BODY (a clear() anywhere else in app-persist.ts
    // must not satisfy it).
    const body = /const onSessionCleared = useCallback\(([\s\S]*?), \[persistFailed\]\);/.exec(app)?.[1] ?? "";
    expect(body).not.toBe("");
    expect(body).toContain("S.allowlistRef.current.clear();");
  });

  it("② `a` covers the path; after /clear the SAME path asks again (exactly one new ask) and executes", async () => {
    const editCall = (id: string) => ({
      role: "assistant" as const,
      content: "",
      toolCalls: [
        { id, name: "edit", arguments: { path: "a.ts", old_string: "hello", new_string: "world" } },
      ],
    });
    const model = createScriptedModel([
      editCall("c1"),
      { role: "assistant", content: "ONE-DONE" },
      editCall("c2"),
      { role: "assistant", content: "TWO-SILENT" },
      editCall("c3"),
      { role: "assistant", content: "THREE-DONE" },
    ]);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "o9977-tui-")));
    const inst = render(
      <WudaoApp
        config={config}
        workspaceRoot={root}
        contextWindowTokens={64_000}
        modelOverride={model}
        tools={[stubEditTool()]}
        gates={{ verify: false }}
        initialPermissionMode="ask"
      />,
    );
    await wait();

    // 🔑 only ever renders in PermissionPrompt, so an absent→present frame
    // transition counts one ask exactly (the prompt stays mounted until WE
    // answer it — a poll can never miss it).
    let asks = 0;
    let hadAsk = false;
    const pollAsks = (): void => {
      const has = (inst.lastFrame() ?? "").includes("🔑");
      if (has && !hadAsk) asks += 1;
      hadAsk = has;
    };

    // turn 1 — the ask fires; `a` records the session rule (夜移 009 receipt).
    await type(inst.stdin, "one\r");
    await until(() => {
      pollAsks();
      return (inst.lastFrame() ?? "").includes("🔑");
    }, "first ask");
    await wait(); // the prompt mounts after the started-event hop (M45)
    inst.stdin.write("a");
    await until(() => {
      pollAsks();
      return (inst.lastFrame() ?? "").includes("ONE-DONE");
    }, "turn one to settle");
    expect((inst.lastFrame() ?? "").includes("permissions: session rule")).toBe(true);

    // turn 2 — the same path: covered by the session rule, 0 asks (this is
    // the behavior the boundary must END). Holds on base AND fixed.
    await type(inst.stdin, "two\r");
    await until(() => {
      pollAsks();
      return (inst.lastFrame() ?? "").includes("TWO-SILENT");
    }, "turn two to settle");
    expect(asks).toBe(1);

    // /clear — routed clear (ω99-38): confirm y → rotation + onSessionCleared.
    await type(inst.stdin, "/clear\r");
    // ω99-159: 确认框文案中文化——等待串随源演进；并加 dim 图例行新断言。
    await until(() => (inst.lastFrame() ?? "").includes("🗑 清空历史——开一个全新会话？"), "confirm prompt");
    expect(inst.lastFrame() ?? "").toContain("(y 清空 · n 保留)");
    await wait();
    inst.stdin.write("y");
    // ω99-161: 清空回执串随源演进（等待语义不变）。
    await until(() => (inst.lastFrame() ?? "").includes("(历史已清空——开启全新会话)"), "cleared notice");

    // turn 3 — the rule died with the boundary: the SAME path asks again
    // (base: the rule survived, the run completes silently, asks stays 1 —
    // the RED). Answered `y` the edit still executes (allow-once intact).
    await type(inst.stdin, "three\r");
    let answered = false;
    await until(() => {
      pollAsks();
      const frame = inst.lastFrame() ?? "";
      if (!answered && asks === 2 && frame.includes("🔑")) {
        // answer once, on the NEXT tick (the prompt mount hop)
        setTimeout(() => inst.stdin.write("y"), 30);
        answered = true;
      }
      return frame.includes("THREE-DONE");
    }, "turn three to settle");

    expect(asks).toBe(2); // base: 1 (the rule outlived the boundary) — the RED
    // The re-ask is genuinely POST-clear (ordering, not just counts).
    expect((inst.lastFrame() ?? "").includes("THREE-DONE")).toBe(true);
    inst.unmount();
    for (let i = 0; i < 10; i += 1) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { /* EBUSY retry */ }
    }
  }, 30_000);
});
