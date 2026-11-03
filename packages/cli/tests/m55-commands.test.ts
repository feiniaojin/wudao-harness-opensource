// M55 §A — the command-parity pack's pure logic: status/cost/rename/diff/
// config/memory-edit/init helpers, plus the driver-level routing that lands
// each command as a notice. The end-to-end /init preview→confirm→write flow
// is pinned by det-39 (packages/evals); these are the unit shapes.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, createJsonlSessionStore, createReadFileTool } from "@wudao-org/core";
import { formatStatusReport, formatCtxLine } from "../src/commands/status.js";
import { formatCostReport, recordUsage, emptyUsageTotals, usageTotalsFromStats, formatWallDuration, CostRegistry } from "../src/commands/cost.js";
import { appendCostLedgerRow, readCostLedger, costLedgerPath } from "../src/commands/wallet.js";
import { validateSessionName, renameSession, SESSION_NAME_MAX_CHARS } from "../src/commands/rename.js";
import { formatDiffReport, collectGitUncommitted, runDiffCommand } from "../src/commands/diff.js";
import { buildConfigReport, formatEnvOverrides, formatFlagOverrides } from "../src/commands/config.js";
import { runMemoryEditCommand, findContextFile, listContextPaths } from "../src/commands/memory-edit.js";
import { buildInitPrompt, extractInitDraft, formatInitPreview, applyInitDraft, hasExistingAgentsMd, INIT_DRAFT_OPEN, INIT_DRAFT_CLOSE, INIT_REVIEW_HINT } from "../src/commands/init.js";
import { CacheStats } from "../src/cache.js";
import { collectSessionRows } from "../src/session-list.js";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

async function tmpWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), "m55-cmds-"));
}

describe("/status — formatStatusReport", () => {
  it("renders the one-pager: version/provider·model/mode/session/ctx/surfaces, offline by default", () => {
    const report = formatStatusReport({
      version: "9.9.9",
      provider: "deepseek",
      model: "deepseek-chat",
      mode: "auto",
      sessionId: "wudao-abc-1234",
      ctx: { used: 12_000, window: 64_000 },
      surfaces: { skills: 3, plugins: 2, extensions: 1, mcp: 4, tools: 22 },
    });
    expect(report).toContain("版本：9.9.9"); // ω99-193: 钉随源演进
    expect(report).toContain("供应商 · 模型：deepseek · deepseek-chat"); // ω99-193: 钉随源演进
    expect(report).toContain("模式：auto"); // ω99-193: 钉随源演进
    expect(report).toContain("会话：wudao-abc-1234"); // ω99-193: 钉随源演进
    expect(report).toContain("上下文：12.0k / 64.0k (19%)"); // ω99-193: 钉随源演进
    expect(report).toContain("3 个技能 · 2 个插件 · 1 个扩展 · 4 个 MCP 工具 · 共 22 个工具"); // ω99-193: 钉随源演进
    expect(report).toContain("未探测"); // ω99-193: 钉随源演进
  });

  it("ctx line degrades: unknown occupancy and pre-first-call", () => {
    expect(formatCtxLine(null)).toBe("（尚未测量）"); // ω99-193: 钉随源演进
    expect(formatCtxLine({ used: null, window: 64_000 })).toBe("… / 64.0k");
  });

  it("ω99-42: the mandatory-reasoning pre-arm line appears only when armed", () => {
    const base = {
      version: "9.9.9",
      provider: "qwen",
      model: "qwen3-max",
      mode: "default",
      sessionId: "s",
      ctx: null,
      surfaces: { skills: 0, plugins: 0, extensions: 0, mcp: 0, tools: 0 },
    } as const;
    expect(formatStatusReport(base)).not.toContain("推理："); // ω99-193: 钉随源演进
    expect(formatStatusReport({ ...base, reasoningMandatoryPreArmed: true })).toContain(
      "推理：端点要求思考——本会话已预启用", // ω99-193: 钉随源演进
    );
  });
});

describe("/cost — totals + report", () => {
  it("recordUsage folds prompt/completion/hit/miss/calls", () => {
    let t = emptyUsageTotals();
    t = recordUsage(t, { promptTokens: 100, cacheHitTokens: 80, cacheMissTokens: 20, completionTokens: 5 });
    t = recordUsage(t, { promptTokens: 50, cacheHitTokens: 50, cacheMissTokens: 0 });
    expect(t).toEqual({ promptTokens: 150, completionTokens: 5, cacheHitTokens: 130, cacheMissTokens: 20, calls: 2, evaluatorTokens: 0 });
  });

  it("formatCostReport renders calls/tokens/cache%/wall time (injected clock)", () => {
    const t = recordUsage(emptyUsageTotals(), { promptTokens: 10_000, cacheHitTokens: 9_000, cacheMissTokens: 1_000, completionTokens: 2_500 });
    const report = formatCostReport(t, { startedAt: 1_000_000, now: () => 1_000_000 + 4 * 60_000 + 12_000 });
    expect(report).toContain("模型调用：1"); // ω99-187: 钉随源演进
    expect(report).toContain("输入 tokens：10.0k（缓存命中 9.0k · 未命中 1.0k · 缓存 90.0%）"); // ω99-187: 钉随源演进
    expect(report).toContain("输出 tokens：2.5k"); // ω99-187: 钉随源演进
    expect(report).toContain("用时：4m 12s"); // ω99-187: 钉随源演进
  });

  it("zero-usage sessions report the no-usage line", () => {
    expect(formatCostReport(emptyUsageTotals(), { startedAt: 0, now: () => 0 })).toContain("尚无用量"); // ω99-187: 钉随源演进
  });

  it("formatWallDuration shapes and CacheStats completion getter feed the REPL", () => {
    expect(formatWallDuration(0)).toBe("0s");
    expect(formatWallDuration(59_000)).toBe("59s");
    expect(formatWallDuration(3_600_000 + 5 * 60_000)).toBe("1h 5m");
    const stats = new CacheStats();
    stats.record({ promptTokens: 100, cacheHitTokens: 40, cacheMissTokens: 60, completionTokens: 7 });
    expect(usageTotalsFromStats(stats)).toEqual({ promptTokens: 100, completionTokens: 7, cacheHitTokens: 40, cacheMissTokens: 60, calls: 1, evaluatorTokens: 0 });
  });
});

describe("/rename — validation + the append-only rewrite", () => {
  it("validates: trims, rejects empty/too-long/multiline", () => {
    expect(validateSessionName("  fix-loop  ")).toEqual({ ok: true, name: "fix-loop" });
    expect(validateSessionName("   ").ok).toBe(false);
    expect(validateSessionName("x".repeat(SESSION_NAME_MAX_CHARS + 1)).ok).toBe(false);
    expect(validateSessionName("a\nb").ok).toBe(false);
  });

  it("appends a session_name entry — the LAST one wins for the picker", async () => {
    const ws = await tmpWs();
    try {
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      await store.append("s1", { role: "user", content: "hello world" });
      await store.appendEntry("s1", { type: "session_name", name: "derived-name" });
      const r = await renameSession({ workspaceRoot: ws, sessionId: "s1", name: "explicit-name" });
      expect(r.notice).toContain("explicit-name");
      const row = (await collectSessionRows(join(ws, ".wudao", "sessions"))).find((x) => x.id === "s1");
      expect(row?.name).toBe("explicit-name");
      // append-only: both entries are still in the JSONL.
      const text = await readFile(join(ws, ".wudao", "sessions", "s1.jsonl"), "utf8");
      expect(text).toContain("derived-name");
      expect(text).toContain("explicit-name");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("/diff — git + session journal report", () => {
  it("collectGitUncommitted: repo status and the not-a-repo sentinel (injected git)", async () => {
    const gitOk = async (args: readonly string[]) =>
      args[0] === "rev-parse" ? "true\n" : args[0] === "status" ? " M a.ts\n?? b.ts\n" : " a.ts | 2 +-\n 1 file changed\n";
    const out = await collectGitUncommitted(gitOk);
    expect(out.repo).toBe(true);
    expect(out.porcelain).toEqual([" M a.ts", "?? b.ts"]);
    const notRepo = async () => {
      throw new Error("fatal: not a git repository (or any of the parent directories): .git");
    };
    expect((await collectGitUncommitted(notRepo)).repo).toBe(false);
  });

  it("review fix: repo detection is locale-independent (structural probe, no stderr matching)", async () => {
    // A Chinese-locale git refusing outside a repo — the OLD message matcher
    // missed it and misclassified the workspace as a repo WITH a git error.
    const zhLocaleNotARepo = async (args: readonly string[]) => {
      if (args[0] === "rev-parse") throw new Error("致命错误：不是 git 仓库（或任何父目录）：.git");
      throw new Error("致命错误：不是 git 仓库（或任何父目录）：.git");
    };
    expect((await collectGitUncommitted(zhLocaleNotARepo)).repo).toBe(false);
    // The probe decides, so a repo whose status fails with a LOCALIZED error
    // stays repo:true with the error lane (never "not a repository").
    const zhLocaleBrokenStatus = async (args: readonly string[]) => {
      if (args[0] === "rev-parse") return "true\n";
      throw new Error("错误：无法读取索引（index.lock 占用）");
    };
    const degraded = await collectGitUncommitted(zhLocaleBrokenStatus);
    expect(degraded.repo).toBe(true);
    expect(degraded.error).toContain("无法读取索引");
  });

  it("formatDiffReport shapes: dirty with stats, clean, not-a-repo, session journal", () => {
    const ws = "/ws";
    const dirty = formatDiffReport({
      git: { repo: true, porcelain: [" M a.ts"], statUnstaged: " a.ts | 2 +-", statStaged: "" },
      sessionChanges: [],
      workspaceRoot: ws,
    });
    expect(dirty).toContain("git (uncommitted):");
    expect(dirty).toContain(" M a.ts");
    expect(dirty).toContain("-- diff --stat (unstaged) --");
    expect(dirty).not.toContain("-- diff --cached");
    expect(dirty).toContain("(no file changes recorded this session)");
    expect(formatDiffReport({ git: { repo: true, porcelain: [], statUnstaged: "", statStaged: "" }, sessionChanges: [], workspaceRoot: ws })).toContain("(clean");
    expect(formatDiffReport({ git: { repo: false, porcelain: [], statUnstaged: "", statStaged: "" }, sessionChanges: [], workspaceRoot: ws })).toContain("(not a git repository)");
    const journaled = formatDiffReport({
      git: { repo: true, porcelain: [], statUnstaged: "", statStaged: "" },
      sessionChanges: [
        { seq: 1, op: "write_file", file: join(ws, "a.ts"), at: "2026-08-17T01:02:03Z", snapshotPath: "/h/1" },
        { seq: 2, op: "edit", file: join(ws, "sub", "b.ts"), at: "2026-08-17T01:03:04Z", snapshotPath: "/h/2" },
      ],
      workspaceRoot: ws,
    });
    // Relative display paths carry the platform separator (join).
    expect(journaled).toContain(`2 step(s) across 2 file(s) — a.ts, ${join("sub", "b.ts")}`);
    expect(journaled).toContain('"/rewind" lists the steps');
  });

  it("runDiffCommand composes real git with the injected seam", async () => {
    const ws = await tmpWs();
    try {
      const text = await runDiffCommand({
        workspaceRoot: ws,
        git: async () => {
          throw new Error("fatal: not a git repository");
        },
      });
      expect(text).toContain("(not a git repository)");
      expect(text).toContain("(no file changes recorded this session)");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("/config — effective-settings view", () => {
  it("settings.json pretty-printed + env (redacted) + flags, read-only footer", async () => {
    const ws = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(join(ws, ".wudao", "settings.json"), JSON.stringify({ permissions: { deny: ["shell:rm"] } }), "utf8");
      const report = await buildConfigReport({
        workspaceRoot: ws,
        env: { WUDAO_API_KEY: "sk-secret", WUDAO_MAX_TURNS: "50", PATH: "/bin" },
        argv: ["node", "wudao", "--provider", "glm", "--quiet"],
      });
      expect(report).toContain('"permissions"');
      expect(report).toContain("WUDAO_API_KEY=（已设置）"); // ω99-182: 钉随源演进
      expect(report).not.toContain("sk-secret");
      expect(report).toContain("WUDAO_MAX_TURNS=50");
      expect(report).not.toContain("PATH=");
      expect(report).toContain("--provider glm");
      expect(report).toContain("--quiet");
      // M62 §3 fix: the footer now points at the local-tier writer (the view
      // itself stays read-only — only `set local` mutates).
      expect(report).toContain("视图只读"); // ω99-182: 钉随源演进
      expect(report).toContain("/config set local <key> <value>");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("missing settings and absent overrides degrade; unknown flags stay off", async () => {
    const ws = await tmpWs();
    try {
      const report = await buildConfigReport({ workspaceRoot: ws, env: {}, argv: ["node", "wudao", "hello"] });
      expect(report).toContain("（无 .wudao/settings.json"); // ω99-182: 钉随源演进
      expect(report).toContain("（未设置）"); // ω99-182: 钉随源演进
      expect(report).toContain("（无）"); // ω99-182: 钉随源演进
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("flag helpers list only what is set", () => {
    expect(formatEnvOverrides({ WUDAO_SANDBOX: "1", WUDAO_SANDBOX_IMAGE: "" })).toEqual(["  WUDAO_SANDBOX=1"]);
    expect(formatFlagOverrides(["wudao", "--continue", "--sandbox"])).toEqual(["  --continue", "  --sandbox"]);
  });
});

describe("/memory edit — context files, not the store", () => {
  it("finds the first existing context file, native-first; lists the global too", async () => {
    const ws = await tmpWs();
    try {
      expect(findContextFile(ws)).toBeUndefined();
      await writeFile(join(ws, "AGENTS.md"), "rules\n", "utf8");
      expect(findContextFile(ws)).toBe(join(ws, "AGENTS.md"));
      await writeFile(join(ws, "WUDAO.md"), "native\n", "utf8");
      expect(findContextFile(ws)).toBe(join(ws, "WUDAO.md"));
      expect(listContextPaths(ws)).toEqual(["WUDAO.md"]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("no editor → guidance naming paths and the store boundary", async () => {
    const ws = await tmpWs();
    try {
      const text = await runMemoryEditCommand(ws, { env: {} });
      expect(text).toContain("no editor ran");
      expect(text).toContain("memory STORE .wudao/memory.jsonl is append-only");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("editor runs on the target and the receipt notes the restart; non-zero exit warns", async () => {
    const ws = await tmpWs();
    try {
      await writeFile(join(ws, "AGENTS.md"), "rules\n", "utf8");
      const opened: string[][] = [];
      const text = await runMemoryEditCommand(ws, {
        env: { EDITOR: "vim" },
        spawnEditor: async (_e, args) => {
          opened.push([...args]);
          return { code: 0 };
        },
      });
      expect(opened).toEqual([[join(ws, "AGENTS.md")]]);
      expect(text).toContain("edited AGENTS.md with vim");
      expect(text).toContain("restart");
      const bad = await runMemoryEditCommand(ws, {
        env: { VISUAL: "nano" },
        spawnEditor: async () => ({ code: 1 }),
      });
      expect(bad).toContain("exited with code 1");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("/init — draft helpers", () => {
  it("buildInitPrompt carries the scan contract + the marker envelope + append mode", () => {
    const fresh = buildInitPrompt({ workspaceRoot: "/ws", hasExisting: false });
    expect(fresh).toContain("<init-request>");
    expect(fresh).toContain("READ-ONLY");
    expect(fresh).toContain(INIT_DRAFT_OPEN);
    expect(fresh).toContain(INIT_DRAFT_CLOSE);
    expect(fresh).toContain("Draft the full file.");
    expect(buildInitPrompt({ workspaceRoot: "/ws", hasExisting: true })).toContain("Draft ONLY a supplementary section");
  });

  it("extractInitDraft takes the LAST marker block; absent/empty → undefined", () => {
    expect(extractInitDraft(`nope ${INIT_DRAFT_OPEN} one ${INIT_DRAFT_CLOSE} tail ${INIT_DRAFT_OPEN} two ${INIT_DRAFT_CLOSE}`)).toBe("two");
    expect(extractInitDraft("plain answer")).toBeUndefined();
    expect(extractInitDraft(`${INIT_DRAFT_OPEN}   ${INIT_DRAFT_CLOSE}`)).toBeUndefined();
    // unterminated close degrades to the rest of the answer
    expect(extractInitDraft(`${INIT_DRAFT_OPEN} dangling`)).toBe("dangling");
  });

  it("formatInitPreview shows the draft + the confirm hint, capping runaways", () => {
    const small = formatInitPreview({ draft: "## Overview\nA repo.", hasExisting: false });
    expect(small).toContain("AGENTS.md draft");
    expect(small).toContain("## Overview");
    expect(small).toContain(INIT_REVIEW_HINT);
    expect(small).toContain("write AGENTS.md at the workspace root");
    expect(formatInitPreview({ draft: "x", hasExisting: true })).toContain("append a dated section");
    const big = formatInitPreview({ draft: "y".repeat(4_000), hasExisting: false });
    expect(big).toContain("[… truncated");
  });

  it("applyInitDraft writes new, appends (never overwrites) when the file exists", async () => {
    const ws = await tmpWs();
    try {
      expect(hasExistingAgentsMd(ws)).toBe(false);
      const first = await applyInitDraft({ workspaceRoot: ws, draft: "# FIRST\n\ncontent one\n" });
      expect(first.appended).toBe(false);
      expect(await readFile(join(ws, "AGENTS.md"), "utf8")).toBe("# FIRST\n\ncontent one\n");
      const second = await applyInitDraft({ workspaceRoot: ws, draft: "# SECOND\n" });
      expect(second.appended).toBe(true);
      const text = await readFile(join(ws, "AGENTS.md"), "utf8");
      expect(text).toContain("# FIRST");
      expect(text).toContain("# SECOND");
      expect(text).toContain("wudao /init");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("driver routing — the Batch A commands land as notices", () => {
  function makeDriver(model: ReturnType<typeof createScriptedModel>, opts: Partial<Parameters<typeof createAgentDriver>[0]> = {}): AgentDriver {
    return createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model,
      tools: [createReadFileTool({ workspaceRoot: process.cwd() })],
      ...opts,
    });
  }

  it("/status renders provider·model from sessionMeta and the session id", async () => {
    const driver = makeDriver(createScriptedModel([]), {
      sessionId: "wudao-status-1",
      sessionMeta: { provider: "glm", model: "glm-4.6" },
      onPermissionAsk: async () => ({ kind: "allow" }),
    });
    const outcome = driver.submit("/status");
    expect(outcome).toBe("notice");
    await wait();
    const text = driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");
    expect(text).toContain("供应商 · 模型：glm · glm-4.6"); // ω99-193: 表外漏网钉同弧演进（brief §二未列，预扫兜出）
    expect(text).toContain("会话：wudao-status-1"); // ω99-193: 表外漏网钉同弧演进（brief §二未列，预扫兜出）
    driver.dispose();
  });

  it("/cost accumulates from the run's usage events", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "hi" }]);
    const driver = makeDriver(model, { onPermissionAsk: async () => ({ kind: "allow" }) });
    driver.submit("hello");
    await until(() => driver.getStatus().busy === false, "run");
    driver.submit("/cost");
    await wait();
    const text = driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");
    // the scripted model reports no usage → the no-usage line, not a crash
    expect(text).toContain("尚无用量"); // ω99-187: 钉随源演进（brief 未列——red 兜出同弧演进）
    driver.dispose();
  });

  // P0-4 (96 队列): `/cost all` — the cross-session ledger view. No sessionMeta
  // → no provider → the balance fetch resolves NOT-CONFIGURED and the section
  // is silently omitted (three-state rule, the omit leg E2E).
  it("/cost all renders the wallet ledger from the workspace (balance omitted when unconfigured)", async () => {
    const ws = await tmpWs();
    try {
      appendCostLedgerRow(ws, {
        ts: "2026-08-30T00:00:00.000Z", sessionId: "past-1", model: "deepseek-v4-flash",
        calls: 2, promptTokens: 2000, completionTokens: 18, cacheHitTokens: 1400, cacheMissTokens: 600,
        costUsd: 0.75,
      });
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        onPermissionAsk: async () => ({ kind: "allow" }),
      });
      expect(driver.submit("/cost all")).toBe("notice");
      await until(() => driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("费用（全部会话）：")), "wallet report"); // ω99-186: 钉随源演进
      const text = driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");
      expect(text).toContain("台账 1 行（1 个模型）"); // ω99-186: 钉随源演进
      expect(text).toContain("deepseek-v4-flash: 2 次调用"); // ω99-186: 钉随源演进（brief 漏列，红兜出同弧演进）
      expect(text).toContain("合计（已计价）：$0.750000"); // ω99-186: 钉随源演进（brief 漏列，红兜出同弧演进）
      expect(text).not.toContain("balance");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("dispose (sessionEnd exit) flushes the driver's costRegistry into the workspace ledger", async () => {
    const ws = await tmpWs();
    try {
      const reg = new CostRegistry({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-wallet-1",
        costRegistry: reg,
        onPermissionAsk: async () => ({ kind: "allow" }),
      });
      reg.record({
        model: "deepseek-v4-flash",
        provider: "deepseek",
        usage: { promptTokens: 1000, cacheHitTokens: 700, cacheMissTokens: 300, completionTokens: 9, cacheWriteTokens: 300 },
      });
      driver.dispose();
      const rows = readCostLedger(ws);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sessionId).toBe("wudao-wallet-1");
      expect(rows[0]?.model).toBe("deepseek-v4-flash");
      expect(costLedgerPath(ws)).toBe(join(ws, ".wudao", "costs.jsonl"));
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/rename appends the entry and fires onSessionRenamed; bad input → usage", async () => {
    const ws = await tmpWs();
    try {
      let renamed: string | undefined;
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-rename-9",
        onPermissionAsk: async () => ({ kind: "allow" }),
        onSessionRenamed: (n) => {
          renamed = n;
        },
      });
      driver.submit("/rename   my-new-name ");
      await until(() => renamed !== undefined, "rename applied");
      expect(renamed).toBe("my-new-name");
      const row = (await collectSessionRows(join(ws, ".wudao", "sessions"))).find((x) => x.id === "wudao-rename-9");
      expect(row?.name).toBe("my-new-name");
      driver.submit("/rename x".repeat(30));
      await wait();
      const text = driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");
      expect(text).toContain("name too long");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
