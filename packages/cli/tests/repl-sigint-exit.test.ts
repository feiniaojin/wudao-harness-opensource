// 夜移 034 stage-3 — SIGINT at the idle prompt takes the NATURAL exit (the
// /exit seam) instead of process.exit(0). Stage-2's core insight: Node
// drains stdio on natural exit; a direct process.exit skips the drain AND
// main()'s finally (the guard-lane flush) — and here it also skipped the
// session-end hook and the close-event cleanup (cron/monitor/peer). The
// mechanics: a pending rl.question NEVER settles after the interface closes
// (probed: no resolve, no reject — that is WHY the old code needed the
// blunt exit), so the wake rides a raced promise every question shares
// (one wrapper at rl creation covers all six dialog sites), resolving ""
// — fail-closed in every dialog parser (parseAskAnswer→deny, peer hold→
// deny, ask_user→empty answer) — and the loop-head flag check breaks
// through the SAME fireSessionEnd("exit") path /exit takes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { ProviderConfig } from "@wudao-org/providers";
import type { AgentHooks } from "@wudao-org/core";
import { runRepl } from "../src/repl.js";

const replSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/repl.ts", import.meta.url)), "utf8");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("夜移 034 stage-3 — SIGINT exits the REPL naturally (no process.exit)", () => {
  it("SIGINT at the idle prompt: the runRepl promise resolves, session-end fires, exit(0) is never called", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "sigint-idle-")));
    const globalHome = await mkdtemp(join(tmpdir(), "sigint-idle-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    // Block the real process.exit — today's code calls it from the SIGINT
    // handler, which would kill the whole vitest worker; the recording stub
    // turns that into the RED signal (exit called + promise never resolves).
    const exits: number[] = [];
    const realExit = process.exit;
    (process as { exit: (code?: number) => never }).exit = (code?: number): never => {
      exits.push(code ?? 0);
      throw new Error(`process.exit(${code ?? 0}) blocked in test`);
    };

    const ends: string[] = [];
    const hooks: AgentHooks = {
      onSessionEnd: (source) => {
        ends.push(source);
      },
    };

    let seen = "";
    const drain = (): string => {
      let text = "";
      let chunk = stdout.read();
      while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
      return text;
    };

    let replError: unknown;
    let settled = false;
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    try {
      const doneRepl = runRepl({
        config: { apiKey: "sk-sigint", baseURL: "https://sigint.invalid/v1", model: "sigint-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        hooks,
        stdin,
        stdout,
      });
      // Wait for the idle prompt, then SIGINT (the established suite
      // pattern: process.emit reaches the REPL's process-level handler).
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        seen += drain();
        if (seen.includes("wudao> ")) break;
        await delay(10);
      }
      expect(seen).toContain("wudao> ");
      try {
        process.emit("SIGINT");
      } catch {
        /* today's handler throws through the blocked exit — the RED shape */
      }
      // Natural exit: the promise resolves (the old path stranded it at the
      // never-settling question). Give it a tight window — a hang must fail
      // fast, not burn the full timeout.
      await Promise.race([
        doneRepl.then(() => { settled = true; }),
        delay(2000),
      ]);
    } catch (err) {
      replError = err;
    } finally {
      (process as { exit: (code?: number) => never }).exit = realExit;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      stdin.end();
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    seen += drain();

    // The three-part receipt of a natural exit.
    expect(settled).toBe(true);
    expect(exits).toEqual([]);
    expect(ends).toContain("exit");
  }, 15_000);

  it("SIGINT mid-dialog (/clear confirm): the wake resolves \"\" → deny, the session still ends naturally", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "sigint-clear-")));
    const globalHome = await mkdtemp(join(tmpdir(), "sigint-clear-gh-"));
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const exits: number[] = [];
    const realExit = process.exit;
    (process as { exit: (code?: number) => never }).exit = (code?: number): never => {
      exits.push(code ?? 0);
      throw new Error(`process.exit(${code ?? 0}) blocked in test`);
    };
    const ends: string[] = [];
    const hooks: AgentHooks = {
      onSessionEnd: (source) => {
        ends.push(source);
      },
    };

    let seen = "";
    const drain = (): string => {
      let text = "";
      let chunk = stdout.read();
      while (chunk !== null) { text += chunk.toString(); chunk = stdout.read(); }
      return text;
    };

    let replError: unknown;
    let settled = false;
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    try {
      const doneRepl = runRepl({
        config: { apiKey: "sk-sigint", baseURL: "https://sigint.invalid/v1", model: "sigint-model" } satisfies ProviderConfig,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        hooks,
        stdin,
        stdout,
      });
      // Open the /clear confirm dialog (stdin.isTTY is false on a
      // PassThrough, so /clear skips the confirm — force the TTY shape by
      // flagging the stream, the dialog is what this test exercises).
      (stdin as unknown as { isTTY: boolean }).isTTY = true;
      const waitFor = async (pred: () => boolean, what: string, ms = 5000): Promise<void> => {
        const dline = Date.now() + ms;
        while (Date.now() < dline) {
          seen += drain();
          if (pred()) return;
          await delay(10);
        }
        throw new Error(`sigint-clear: timed out waiting for ${what}\n--- output ---\n${seen}`);
      };
      await waitFor(() => seen.includes("wudao> "), "the first prompt");
      stdin.write("/clear\n");
      // ω99-159: 确认文案中文化——等待串随源演进（对话语义不变）。
      await waitFor(() => seen.includes("清空历史？"), "the confirm dialog");
      try {
        process.emit("SIGINT");
      } catch {
        /* the blocked-exit throw, pre-fix */
      }
      await Promise.race([
        doneRepl.then(() => { settled = true; }),
        delay(2000),
      ]);
    } catch (err) {
      replError = err;
    } finally {
      (process as { exit: (code?: number) => never }).exit = realExit;
      process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      stdin.end();
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    if (replError !== undefined) throw replError;
    seen += drain();

    // The "" wake went through the REAL deny parser (confirm declined),
    // then the loop-head check landed the natural exit.
    expect(settled).toBe(true);
    expect(exits).toEqual([]);
    expect(ends).toContain("exit");
    expect(seen).toContain("已取消清空"); // ω99-161: 裸碎片钉随源演进（裸形态保留）。
    // ω99-161: /clear 拒绝回执中文化——全串在场钉（#1；上方裸碎片钉随源演进）。
    expect(seen).toContain("(已取消清空)");
  }, 15_000);

  it("wiring pin: the REPL owns zero direct process.exit calls", () => {
    // Call-form only — the prose comments (including this feature's own
    // docs) legitimately mention process.exit.
    expect([...replSrc().matchAll(/process\.exit\(/g)]).toEqual([]);
    // ω99-161: REPL /help 页脚 keysLine 中文化接线钉（#7——渲染路径无 e2e
    // 宿主，沿本用例的源接线钉范式钉串值本身）。
    expect(replSrc()).toContain('keysLine: "Enter 发送 · Tab 补全 /命令 · shift+tab 切换模式"');
  });
});
