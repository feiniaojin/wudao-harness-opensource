// M55 §B — the medium-command pack's unit shapes: /model //effort (the
// switchable matrix, the live-config mutation the provider reads per request,
// the M28 entry write), /permissions (grammar, the immunity guard, the
// settings mutation + hot-reload), and /export (markdown render, default
// path, the overwrite-confirm flow). The end-to-end driver flow is det-41.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, createReadFileTool, createJsonlSessionStore } from "@wudao/core";
import { createOpenAICompatibleProvider } from "@wudao/providers";
import type { ProviderConfig } from "@wudao/providers";
import {
  availableModels,
  validateModelChoice,
  sameProviderModels,
  validateEffort,
  applyModelSelection,
  asMutableConfig,
  recordModelSwitch,
  formatModelList,
  formatEffortList,
} from "../src/commands/model.js";
import {
  parsePermissionsArgs,
  ruleTouchesImmunity,
  refusesMutation,
  mutatePermissionSettings,
  runPermissionsCommand,
  IMMUNITY_REFUSAL,
} from "../src/commands/permissions.js";
import { createPermissionSettingsWatcher, EMPTY_PERMISSION_SETTINGS } from "../src/permission.js";
import {
  defaultExportPath,
  exportEntriesFromHistory,
  exportEntriesFromMessages,
  renderSessionMarkdown,
  renderSessionHtml,
  resolveExportFormat,
  prepareExport,
  writeExportFile,
} from "../src/commands/export.js";
import { lastModelState } from "../src/run.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import {
  collectUncommittedDiff,
  buildReviewPrompt,
  hasReviewableContent,
  formatNoDiffNotice,
  SECURITY_CHECKLIST,
  REVIEW_PATCH_CAP_CHARS,
} from "../src/commands/review.js";
import { mcpToolCounts, buildMcpRows, formatMcpReport, runMcpStatusCommand } from "../src/commands/mcp-status.js";
import { rosterSources, roleSummary, formatRosterReport, runAgentsCommand } from "../src/commands/agents-roster.js";
import { BUILTIN_ROLES, loadRoleProfiles } from "@wudao/core";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

// 回滚重做 T2d（同族扫尾）：会话 JSONL 由异步写入器落盘，model_change/
// thinking_level_change 条目可能晚于 driver 可见状态（switched 回调、notices
// 都不蕴含「已写入」）。轮询至全部标记串出现再返回全文；条目真丢时轮询
// 超时，测试照红，断言不弱化。
async function readJsonlWhen(ws: string, sid: string, markers: readonly string[], timeoutMs = 5000): Promise<string> {
  const file = join(ws, ".wudao", "sessions", `${sid}.jsonl`);
  const start = Date.now();
  for (;;) {
    const content = await readFile(file, "utf8").catch(() => "");
    if (markers.every((m) => content.includes(m))) return content;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for session JSONL ${sid} to contain ${JSON.stringify(markers)}`);
    }
    await wait(25);
  }
}

async function tmpWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), "m55b-cmds-"));
}

const noticesOf = (driver: AgentDriver): string =>
  driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");

// ---------------------------------------------------------------------------
// /model + /effort
// ---------------------------------------------------------------------------

describe("/model — the switchable matrix", () => {
  it("availableModels: every profile default + the env override (deduped)", () => {
    const base = availableModels({ WUDAO_MODEL: "custom-x" });
    expect(base.map((c) => `${c.provider}/${c.model}`)).toContain("deepseek/deepseek-v4-flash");
    expect(base.map((c) => `${c.provider}/${c.model}`)).toContain("glm/glm-4.6");
    expect(base.find((c) => c.model === "custom-x")?.source).toBe("env");
    // an env model that duplicates a profile default is not listed twice
    const dup = availableModels({ WUDAO_MODEL: "deepseek-v4-flash" });
    expect(dup.filter((c) => c.model === "deepseek-v4-flash").length).toBe(1);
    // 反馈① 收口 (2026-08-29): builtin catalogs now carry doc-verified
    // context pins — non-default catalog models ride the registry lane
    // (glm-4.6 / qwen3-max pins dedupe with their defaults); with no env
    // override every row is profile- or registry-sourced.
    const plain = availableModels({});
    expect(plain.some((c) => c.source === "env")).toBe(false);
    // (this file pins no WUDAO_GLOBAL_HOME — the m63 hermeticity lesson:
    // assert only the deepseek lane so a real-home custom/overlay on some
    // OTHER provider can't perturb the pin.)
    const dsReg = plain.filter((c) => c.source === "registry" && c.provider === "deepseek").map((c) => c.model);
    expect(dsReg).toEqual(["deepseek-v4-pro", "deepseek-v4-flash-vision-exp"]);
  });

  it("validateModelChoice: bare id, provider-qualified form, unknown listing", () => {
    const list = availableModels({});
    expect(validateModelChoice(list, " glm-4.6 ")).toEqual({ ok: true, choice: { provider: "glm", model: "glm-4.6", source: "profile", contextLength: 204_800 } });
    expect(validateModelChoice(list, "deepseek/deepseek-v4-flash").ok).toBe(true);
    const bad = validateModelChoice(list, "gpt-99");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("unknown or cross-provider model \"gpt-99\"");
    expect(validateEffort("high")).toEqual({ ok: true, level: "high" });
    expect(validateEffort("NONE").ok).toBe(false);
    expect(validateEffort("max").ok).toBe(true);
  });

  it("formatModelList / formatEffortList mark the current entry", () => {
    const list = availableModels({});
    const text = formatModelList(list, { provider: "glm", model: "glm-4.6" });
    expect(text).toContain("glm/glm-4.6  ← current");
    expect(text).toContain("profile 矩阵 + 注册表 + WUDAO_MODEL");
    // foreign-provider entries point at the /provider lane (M63 §A made the
    // endpoint switch in-session; /model stays same-provider)
    expect(text).toContain("deepseek/deepseek-v4-flash  (switch providers with /provider deepseek)");
    expect(sameProviderModels(list, "deepseek").every((c) => c.provider === "deepseek")).toBe(true);
    expect(sameProviderModels(list, "deepseek").map((c) => c.model)).toContain("deepseek-v4-flash");
    expect(sameProviderModels(list, "deepseek").map((c) => c.model)).not.toContain("glm-4.6");
    const effort = formatEffortList("high");
    expect(effort).toContain("high  ← current");
    expect(effort).toContain("low | medium | high | max | none");
  });
});

describe("/model — the live-config switch is the provider's next request", () => {
  it("field mutation flips the request body (model + reasoning_effort), client identity stable", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchStub = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
      } as unknown as Response;
    }) as typeof fetch;
    const cfg = asMutableConfig({ apiKey: "k", baseURL: "https://switch.test", model: "m-one" } satisfies ProviderConfig);
    const provider = createOpenAICompatibleProvider(cfg, { fetch: fetchStub });
    const input = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
    await provider.generate(input);
    expect(bodies[0]?.model).toBe("m-one");
    applyModelSelection(cfg, { model: "m-two", effort: "high" });
    await provider.generate(input);
    expect(bodies[1]?.model).toBe("m-two");
    expect(bodies[1]?.reasoning_effort).toBe("high");
    applyModelSelection(cfg, { effort: "none" });
    await provider.generate(input);
    expect(bodies[2]?.model).toBe("m-two");
    expect(bodies[2]?.reasoning_effort).toBe("none");
  });
});

describe("/model — the M28 entry write", () => {
  it("records model_change + thinking_level_change; lastModelState folds them back", async () => {
    const ws = await tmpWs();
    try {
      await recordModelSwitch({ workspaceRoot: ws, sessionId: "sw1", selection: { model: "glm-4.6", provider: "glm" } });
      await recordModelSwitch({ workspaceRoot: ws, sessionId: "sw1", selection: { effort: "high" } });
      const text = await readFile(join(ws, ".wudao", "sessions", "sw1.jsonl"), "utf8");
      expect(text).toContain("\"type\":\"model_change\"");
      expect(text).toContain("glm-4.6");
      expect(text).toContain("\"type\":\"thinking_level_change\"");
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const state = lastModelState(await store.loadSessionEntries("sw1"));
      expect(state).toEqual({ model: "glm-4.6", provider: "glm", effort: "high" });
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// /permissions
// ---------------------------------------------------------------------------

describe("/permissions — grammar", () => {
  it("bare views; add/remove need a list and a single-line rule", () => {
    expect(parsePermissionsArgs("")).toEqual({ kind: "view" });
    expect(parsePermissionsArgs("  ")).toEqual({ kind: "view" });
    expect(parsePermissionsArgs("add allow shell:echo")).toEqual({ kind: "add", list: "allow", rule: "shell:echo" });
    expect(parsePermissionsArgs("remove deny  write_file:.env ")).toEqual({ kind: "remove", list: "deny", rule: "write_file:.env" });
    expect(parsePermissionsArgs("frobnicate").kind).toBe("usage");
    expect(parsePermissionsArgs("add maybe x").kind).toBe("usage");
    expect(parsePermissionsArgs("add allow").kind).toBe("usage");
  });
});

describe("/permissions — the immunity guard (hard rule)", () => {
  it("write-class rules covering the policy files touch the immunity layer", () => {
    expect(ruleTouchesImmunity("write_file")).toBe(true);
    expect(ruleTouchesImmunity("edit")).toBe(true);
    expect(ruleTouchesImmunity("write_file:.wudao/settings.json")).toBe(true);
    expect(ruleTouchesImmunity("write_file:.wudao/mcp.json")).toBe(true);
    expect(ruleTouchesImmunity("write_file:.wudao")).toBe(true);
    expect(ruleTouchesImmunity("write_file:.")).toBe(true);
    expect(ruleTouchesImmunity("write_file:src/lib")).toBe(false);
    expect(ruleTouchesImmunity("read_file")).toBe(false);
    expect(ruleTouchesImmunity("shell")).toBe(false);
    expect(ruleTouchesImmunity("shell:rm")).toBe(false);
  });

  it("ω99-22: the guard consumes the runtime gate's list — .mcp.json and the .wudao/extensions|plugins hook trees are covered (no mirror desync)", () => {
    // ω99-21 widened the runtime side (protectedSettingsFile) to .mcp.json +
    // the hook-source trees; the display-side hand-copied list never heard.
    // Same source of truth now: every runtime-protected target is guard-
    // covered, so an allow rule scoping writes over them is refused here too.
    expect(ruleTouchesImmunity("write_file:.mcp.json")).toBe(true);
    expect(ruleTouchesImmunity("write_file:.wudao/extensions")).toBe(true);
    expect(ruleTouchesImmunity("write_file:.wudao/plugins")).toBe(true);
    expect(ruleTouchesImmunity("edit:.wudao/extensions/hooks/x.mjs")).toBe(false); // a rule UNDER the tree covers only deeper paths, not the protected targets
    expect(refusesMutation({ kind: "add", list: "allow", rule: "write_file:.wudao/extensions" })).toBe(true);
    expect(refusesMutation({ kind: "add", list: "ask", rule: "write_file:.wudao/plugins" })).toBe(true);
    expect(refusesMutation({ kind: "add", list: "allow", rule: "write_file:.mcp.json" })).toBe(true);
    expect(refusesMutation({ kind: "remove", list: "deny", rule: "write_file:.wudao/plugins" })).toBe(true);
    expect(refusesMutation({ kind: "add", list: "deny", rule: "write_file:.wudao/extensions" })).toBe(false); // tightening still allowed
  });

  it("add allow/ask touching immunity refused; remove deny touching immunity refused; tightening allowed", () => {
    expect(refusesMutation({ kind: "add", list: "allow", rule: "write_file:.wudao/settings.json" })).toBe(true);
    expect(refusesMutation({ kind: "add", list: "ask", rule: "write_file:.wudao" })).toBe(true);
    expect(refusesMutation({ kind: "add", list: "allow", rule: "write_file" })).toBe(true);
    expect(refusesMutation({ kind: "add", list: "deny", rule: "write_file:.wudao/settings.json" })).toBe(false);
    expect(refusesMutation({ kind: "remove", list: "deny", rule: "write_file:.wudao/settings.json" })).toBe(true);
    expect(refusesMutation({ kind: "remove", list: "allow", rule: "shell:git" })).toBe(false);
    expect(refusesMutation({ kind: "add", list: "allow", rule: "shell:echo" })).toBe(false);
  });
});

describe("/permissions — the mutation + hot reload", () => {
  it("mutatePermissionSettings adds (dedup) and removes; no-op stays reference-equal", () => {
    const s = { allow: ["shell:echo"], deny: [], ask: [] };
    expect(mutatePermissionSettings(s, { kind: "add", list: "allow", rule: "shell:echo" })).toBe(s);
    const next = mutatePermissionSettings(s, { kind: "add", list: "deny", rule: "write_file:.env" });
    expect(next.deny).toEqual(["write_file:.env"]);
    expect(mutatePermissionSettings(next, { kind: "remove", list: "deny", rule: "write_file:.env" }).deny).toEqual([]);
  });

  it("runPermissionsCommand: add writes settings.json preserving other keys; the watcher hot-reloads", async () => {
    const ws = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(join(ws, ".wudao", "settings.json"), JSON.stringify({ hooks: { onRunStop: [] }, permissions: { allow: ["read_file"] } }), "utf8");
      const watcher = createPermissionSettingsWatcher(ws, () => {}, { revalidateMs: 0 });
      expect((await watcher.get()).allow).toEqual(["read_file"]);

      const notice = await runPermissionsCommand({ workspaceRoot: ws, args: "add allow shell:echo" });
      expect(notice).toContain("added allow rule \"shell:echo\"");
      expect(notice).toContain("hot-reloads");

      const onDisk = JSON.parse(await readFile(join(ws, ".wudao", "settings.json"), "utf8")) as Record<string, unknown>;
      expect(onDisk.hooks).toEqual({ onRunStop: [] }); // other top-level keys survive
      expect((onDisk.permissions as { allow: string[] }).allow).toEqual(["read_file", "shell:echo"]);

      const hot = await watcher.get();
      expect(hot.allow).toEqual(["read_file", "shell:echo"]);

      const removed = await runPermissionsCommand({ workspaceRoot: ws, args: "remove allow shell:echo" });
      expect(await watcher.get()).toEqual({ allow: ["read_file"], deny: [], ask: [], sidecarExempt: [] });
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("ω99-27: a /permissions mutation never deletes hand-authored sidecarExempt rules; empty → key absent (legacy write shape)", async () => {
    const ws = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      // The operator authored an exemption; the model then mutates the file.
      await writeFile(
        join(ws, ".wudao", "settings.json"),
        JSON.stringify({ permissions: { allow: ["read_file"], sidecarExempt: ["edit:README.md"] } }),
        "utf8",
      );
      await runPermissionsCommand({ workspaceRoot: ws, args: "add allow shell:echo" });
      const onDisk = JSON.parse(await readFile(join(ws, ".wudao", "settings.json"), "utf8")) as {
        permissions: { allow: string[]; sidecarExempt?: string[] };
      };
      expect(onDisk.permissions.sidecarExempt).toEqual(["edit:README.md"]); // survived
      expect(onDisk.permissions.allow).toEqual(["read_file", "shell:echo"]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    // A workspace with NO exemptions keeps the legacy node shape (no key).
    const ws2 = await tmpWs();
    try {
      await mkdir(join(ws2, ".wudao"), { recursive: true });
      await writeFile(join(ws2, ".wudao", "settings.json"), JSON.stringify({ permissions: { allow: ["read_file"] } }), "utf8");
      await runPermissionsCommand({ workspaceRoot: ws2, args: "add allow shell:echo" });
      const node = (JSON.parse(await readFile(join(ws2, ".wudao", "settings.json"), "utf8")) as { permissions: Record<string, unknown> }).permissions;
      expect("sidecarExempt" in node).toBe(false);
    } finally {
      await rm(ws2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("the protected refusal leaves the file untouched; a missing file is created; bare views", async () => {
    const ws = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      const before = JSON.stringify({ permissions: { deny: ["write_file:.wudao/settings.json"] } });
      await writeFile(join(ws, ".wudao", "settings.json"), before, "utf8");

      expect(await runPermissionsCommand({ workspaceRoot: ws, args: "add allow write_file:.wudao/settings.json" })).toBe(IMMUNITY_REFUSAL);
      expect(await runPermissionsCommand({ workspaceRoot: ws, args: "add ask write_file:.wudao" })).toBe(IMMUNITY_REFUSAL);
      expect(await runPermissionsCommand({ workspaceRoot: ws, args: "remove deny write_file:.wudao/settings.json" })).toBe(IMMUNITY_REFUSAL);
      expect(await readFile(join(ws, ".wudao", "settings.json"), "utf8")).toBe(before); // untouched

      const view = await runPermissionsCommand({ workspaceRoot: ws, args: "" });
      expect(view).toContain("deny:");
      expect(view).toContain("write_file:.wudao/settings.json");
      expect(view).toContain("layer order");

      const ws2 = await tmpWs();
      try {
        const made = await runPermissionsCommand({ workspaceRoot: ws2, args: "add deny shell:rm" });
        expect(made).toContain("added deny rule");
        expect(JSON.parse(await readFile(join(ws2, ".wudao", "settings.json"), "utf8"))).toEqual({
          permissions: { allow: [], deny: ["shell:rm"], ask: [] },
        });
      } finally {
        await rm(ws2, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("EMPTY_PERMISSION_SETTINGS re-export stays the shared empty shape", () => {
    expect(EMPTY_PERMISSION_SETTINGS).toEqual({ allow: [], deny: [], ask: [], sidecarExempt: [] }); // ω99-27: fourth list
  });
});

// ---------------------------------------------------------------------------
// /export
// ---------------------------------------------------------------------------

describe("/export — the markdown render", () => {
  const entries = [
    { kind: "user", text: "fix the loop" },
    { kind: "tool", name: "read_file", summary: "packages/core/src/query.ts (210 lines)" },
    { kind: "board", done: 1, total: 2, lines: ["- [x] read", "- [ ] patch"] },
    { kind: "assistant", text: "done — patched" },
    { kind: "notice", text: "noise" },
  ];

  it("renders turns, tool summaries, board snapshots; notices stay out", () => {
    const md = renderSessionMarkdown({ entries: exportEntriesFromHistory(entries), sessionId: "wudao-exp-1", model: "glm-4.6", generatedAt: new Date("2026-08-17T08:09:10Z") });
    expect(md).toContain("# wudao session wudao-exp-1");
    expect(md).toContain("model glm-4.6");
    expect(md).toContain("## Turn 1");
    expect(md).toContain("**User:**");
    expect(md).toContain("fix the loop");
    expect(md).toContain("`read_file`");
    expect(md).toContain("**Todo board (1/2):**");
    expect(md).toContain("- [x] read");
    expect(md).toContain("**Assistant:**");
    expect(md).toContain("done — patched");
    expect(md).not.toContain("noise");
  });

  it("exportEntriesFromMessages maps conversation turns and skips machinery", () => {
    const mapped = exportEntriesFromMessages(
      [
        { role: "user", content: "hello" },
        { role: "user", content: "[steering rider]" },
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a.ts" } }] },
        { role: "assistant", content: "answer" },
      ],
      summarizeToolCall,
    );
    expect(mapped).toEqual([
      { kind: "user", text: "hello" },
      { kind: "tool", name: "read_file", summary: mapped[1]?.summary ?? "" },
      { kind: "assistant", text: "answer" },
    ]);
    expect(mapped[1]?.summary).toContain("a.ts");
  });

  it("default path lands under .wudao/exports; prepareExport writes, then guards overwrite", async () => {
    const ws = await tmpWs();
    try {
      expect(defaultExportPath(ws, "wudao-a_b-1")).toBe(join(ws, ".wudao", "exports", "wudao-a_b-1.md"));
      const first = await prepareExport({ workspaceRoot: ws, sessionId: "s1", fileArg: "", entries: [{ kind: "user", text: "q" }, { kind: "assistant", text: "a" }] });
      expect(first.kind).toBe("ok");
      if (first.kind === "ok") {
        expect(first.path).toBe(join(ws, ".wudao", "exports", "s1.md"));
        const text = await readFile(first.path, "utf8");
        expect(text).toContain("# wudao session s1");
        expect(text).toContain("q");
      }
      const second = await prepareExport({ workspaceRoot: ws, sessionId: "s1", fileArg: "", entries: [{ kind: "user", text: "q2" }] });
      expect(second.kind).toBe("exists");
      if (second.kind === "exists") {
        expect(second.hint).toContain("already exists");
        expect(second.hint).toContain('"ok"');
        // the target still holds the FIRST render — nothing was overwritten
        expect(await readFile(second.path, "utf8")).toContain("q");
        expect(await readFile(second.path, "utf8")).not.toContain("q2");
        await writeExportFile(second.path, second.content);
        expect(await readFile(second.path, "utf8")).toContain("q2");
      }
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// /export — the html render (96 队列 P0-3: the same ExportEntry pipeline as a
// single self-contained page — inline CSS, native <details> folds, zero
// external resources, zero JS. Every interpolation escapes; the export file
// must never become a stored-XSS carrier.)
// ---------------------------------------------------------------------------

describe("/export — the html render", () => {
  const entries = [
    { kind: "user", text: "fix the loop" },
    { kind: "tool", name: "read_file", summary: "packages/core/src/query.ts (210 lines)" },
    { kind: "tool", name: "shell", summary: "npm test\n12 passed", isError: true },
    { kind: "board", done: 1, total: 2, lines: ["- [x] read", "- [ ] patch"] },
    { kind: "assistant", text: "done — patched" },
  ];

  it("renders the single-file document: head, message cards, tool folds, board, meta", () => {
    const html = renderSessionHtml({ entries: exportEntriesFromHistory(entries), sessionId: "wudao-htm-1", model: "glm-4.6", generatedAt: new Date("2026-08-17T08:09:10Z") });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>wudao session wudao-htm-1</title>");
    expect(html).toContain("2026-08-17 08:09");
    expect(html).toContain("glm-4.6");
    expect(html).toContain("5 entries");
    expect(html).toContain('<section class="msg user">');
    expect(html).toContain('<section class="msg assistant">');
    expect(html).toContain('<details class="tool">');
    expect(html).toContain('class="tool error"');
    expect(html).toContain('<section class="board">');
    expect(html).toContain("Todo board (1/2)");
    expect(html).toContain("- [x] read");
    expect(html).toContain("_end of session export_");
    // self-contained: no scripts, no external resources (offline-openable)
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(src|href)=/);
  });

  it("every interpolation is escaped — the export cannot carry stored XSS", () => {
    const html = renderSessionHtml({
      entries: [
        { kind: "user", text: "<script>alert(1)</script>" },
        { kind: "tool", name: "a<b>", summary: "s" },
      ],
      sessionId: 'x"y&<z>',
      generatedAt: new Date("2026-08-17T08:09:10Z"),
    });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("a&lt;b&gt;");
    expect(html).not.toContain("a<b>");
    expect(html).toContain("x&quot;y&amp;&lt;z&gt;"); // the title's session id escapes too
    // the five entities, & first — a payload touching all of them fully entity-izes
    const full = renderSessionHtml({ entries: [{ kind: "assistant", text: `a&b<c>"d'e` }], sessionId: "s", generatedAt: new Date("2026-08-17T08:09:10Z") });
    expect(full).toContain("a&amp;b&lt;c&gt;&quot;d&#39;e");
  });

  it("resolveExportFormat: the exact keyword or a *.html suffix; everything else markdown", () => {
    expect(resolveExportFormat("")).toBe("markdown");
    expect(resolveExportFormat("notes.md")).toBe("markdown");
    expect(resolveExportFormat("htmlnotes")).toBe("markdown");
    expect(resolveExportFormat("a.html.txt")).toBe("markdown");
    expect(resolveExportFormat("html")).toBe("html");
    expect(resolveExportFormat("HTML")).toBe("html");
    expect(resolveExportFormat("s.html")).toBe("html");
    expect(resolveExportFormat("S.HTML")).toBe("html");
  });

  it("defaultExportPath takes the format — html → .html; the default stays .md", () => {
    expect(defaultExportPath("/ws", "wudao-a_b-1", "html")).toBe(join("/ws", ".wudao", "exports", "wudao-a_b-1.html"));
    expect(defaultExportPath("/ws", "wudao-a_b-1", "markdown")).toBe(join("/ws", ".wudao", "exports", "wudao-a_b-1.md"));
    expect(defaultExportPath("/ws", "wudao-a_b-1")).toBe(join("/ws", ".wudao", "exports", "wudao-a_b-1.md")); // existing shape untouched
  });

  it("prepareExport: fileArg html → the default .html with a DOCTYPE; the exists guard parks it too", async () => {
    const ws = await tmpWs();
    try {
      const first = await prepareExport({ workspaceRoot: ws, sessionId: "h1", fileArg: "html", entries: [{ kind: "user", text: "q" }, { kind: "assistant", text: "a" }] });
      expect(first.kind).toBe("ok");
      if (first.kind === "ok") {
        expect(first.path).toBe(join(ws, ".wudao", "exports", "h1.html"));
        expect(first.content.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(await readFile(first.path, "utf8")).toContain("<!DOCTYPE html>");
      }
      const second = await prepareExport({ workspaceRoot: ws, sessionId: "h1", fileArg: "html", entries: [{ kind: "user", text: "q2" }] });
      expect(second.kind).toBe("exists");
      if (second.kind === "exists") {
        expect(second.hint).toContain("already exists");
        // nothing was overwritten — the target still holds the first render
        expect(await readFile(second.path, "utf8")).toContain("<!DOCTYPE html>");
      }
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// driver routing — the Batch B commands land as notices
// ---------------------------------------------------------------------------


describe("driver routing — /model //effort /permissions /export", () => {
  function makeDriver(model: ReturnType<typeof createScriptedModel>, opts: Partial<Parameters<typeof createAgentDriver>[0]> = {}): AgentDriver {
    return createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model,
      tools: [createReadFileTool({ workspaceRoot: process.cwd() })],
      ...opts,
    });
  }

  it("/model bare lists the matrix; with arg: entry + onModelSwitch + /status refresh; unknown refused", async () => {
    const ws = await tmpWs();
    try {
      const switched: string[] = [];
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-model-1",
        availableModels: availableModels({ WUDAO_MODEL: "deepseek-v4-pro" }),
        sessionMeta: { provider: "deepseek", model: "deepseek-v4-flash" },
        onModelSwitch: (sel) => {
          switched.push(JSON.stringify(sel));
        },
      });
      driver.submit("/model");
      await wait();
      expect(noticesOf(driver)).toContain("deepseek/deepseek-v4-flash");
      expect(noticesOf(driver)).toContain("← current");

      driver.submit("/model deepseek-v4-pro");
      await until(() => switched.length === 1, "switch fired");
      expect(switched[0]).toContain("deepseek-v4-pro");
      const jsonl = await readJsonlWhen(ws, "wudao-model-1", ['"type":"model_change"', "deepseek-v4-pro"]);
      expect(jsonl).toContain("\"type\":\"model_change\"");
      expect(jsonl).toContain("deepseek-v4-pro");
      driver.submit("/status");
      await wait();
      expect(noticesOf(driver)).toContain("供应商 · 模型：deepseek · deepseek-v4-pro"); // ω99-193: 表外漏网钉同弧演进（brief §二未列，全量门 R1 兜出）ω99-311: 称谓产品级统一

      // cross-provider switch: refused with the restart hint (keys are
      // endpoint-bound — a glm model on the deepseek endpoint would 4xx)
      driver.submit("/model glm-4.6");
      await until(() => noticesOf(driver).includes("unknown or cross-provider model \"glm-4.6\""), "cross-provider refusal");
      expect(switched.length).toBe(1);
      driver.submit("/model gpt-99");
      await wait();
      expect(noticesOf(driver)).toContain("unknown or cross-provider model \"gpt-99\"");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/effort bare lists levels; with arg: thinking_level_change entry + switch seam", async () => {
    const ws = await tmpWs();
    try {
      const switched: string[] = [];
      const driver = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-eff-2",
        onModelSwitch: (sel) => {
          switched.push(JSON.stringify(sel));
        },
      });
      driver.submit("/effort");
      await wait();
      expect(noticesOf(driver)).toContain("low | medium | high | max | none");
      driver.submit("/effort high");
      await until(() => switched.length === 1, "effort switch fired");
      expect(switched[0]).toContain("\"effort\":\"high\"");
      const jsonl = await readJsonlWhen(ws, "wudao-eff-2", ['"type":"thinking_level_change"']);
      expect(jsonl).toContain("\"type\":\"thinking_level_change\"");
      expect(jsonl).toContain("high");
      driver.submit("/effort turbo");
      await wait();
      expect(noticesOf(driver)).toContain("unknown effort \"turbo\"");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/permissions add lands in settings.json; the protected rule is refused", async () => {
    const ws = await tmpWs();
    try {
      const driver = makeDriver(createScriptedModel([]), { workspaceRoot: ws, sessionId: "wudao-perm-3" });
      driver.submit("/permissions add allow shell:echo");
      await until(async () => (await readFile(join(ws, ".wudao", "settings.json"), "utf8").catch(() => "")).includes("shell:echo"), "rule written");
      driver.submit("/permissions add allow write_file:.wudao/settings.json");
      await wait();
      expect(noticesOf(driver)).toContain(IMMUNITY_REFUSAL);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/export writes the default file, guards overwrite behind ok", async () => {
    const ws = await tmpWs();
    try {
      const model = createScriptedModel([{ role: "assistant", content: "the answer" }]);
      const driver = makeDriver(model, {
        workspaceRoot: ws,
        sessionId: "wudao-exp-4",
        onPermissionAsk: async () => ({ kind: "allow" }),
      });
      driver.submit("hello");
      await until(() => driver.getStatus().busy === false, "run");
      driver.submit("/export");
      const path = join(ws, ".wudao", "exports", "wudao-exp-4.md");
      await until(async () => (await readFile(path, "utf8").catch(() => "")).includes("the answer"), "export written");
      const first = await readFile(path, "utf8");
      expect(first).toContain("# wudao session wudao-exp-4");
      expect(first).toContain("hello");

      driver.submit("/export");
      await until(() => noticesOf(driver).includes("already exists"), "overwrite guard");
      expect(await readFile(path, "utf8")).toBe(first); // untouched before ok
      driver.submit("ok");
      await wait(50);
      const second = await readFile(path, "utf8");
      expect(second).toContain("# wudao session wudao-exp-4");
      expect(noticesOf(driver)).toContain("确认后已覆写"); // ω99-166c-iii: #11 钉演进（孪生归一）
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/export exp.html writes an html document through the driver (fileArg passthrough, zero caller change)", async () => {
    const ws = await tmpWs();
    try {
      const model = createScriptedModel([{ role: "assistant", content: "the answer" }]);
      const driver = makeDriver(model, {
        workspaceRoot: ws,
        sessionId: "wudao-htm-6",
        onPermissionAsk: async () => ({ kind: "allow" }),
      });
      driver.submit("hello");
      await until(() => driver.getStatus().busy === false, "run");
      driver.submit("/export exp.html");
      const path = join(ws, "exp.html");
      await until(async () => (await readFile(path, "utf8").catch(() => "")).includes("<!DOCTYPE html>"), "html export written");
      const text = await readFile(path, "utf8");
      expect(text.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(text).toContain("<title>wudao session wudao-htm-6</title>");
      expect(text).toContain('<section class="msg user">');
      expect(text).toContain("the answer");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// /review + /security-review
// ---------------------------------------------------------------------------

describe("/review — diff collection + the template", () => {
  it("collectUncommittedDiff folds stat/patch/untracked; not-a-repo reports repo:false (injected git)", async () => {
    const git = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "rev-parse") return "true\n";
      if (args[0] === "diff" && args.includes("--stat")) return " a.ts | 2 +-\n 1 file changed\n";
      if (args[0] === "diff") return "diff --git a/a.ts b/a.ts\n+hello\n";
      if (args[0] === "ls-files") return "new.ts\nother.ts\n";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const diff = await collectUncommittedDiff(git);
    expect(diff.repo).toBe(true);
    expect(diff.stat).toContain("a.ts | 2 +-");
    expect(diff.patch).toContain("+hello");
    expect(diff.untracked).toEqual(["new.ts", "other.ts"]);
    expect(diff.truncated).toBe(false);
    const notRepo = async (): Promise<string> => {
      throw new Error("致命错误：不是 git 仓库（或者任何父目录）：.git");
    };
    expect((await collectUncommittedDiff(notRepo)).repo).toBe(false);
    // a huge patch truncates at the cap
    const huge = async (args: readonly string[]): Promise<string> =>
      args[0] === "rev-parse" ? "true\n" : args[0] === "diff" && !args.includes("--stat") ? "x".repeat(REVIEW_PATCH_CAP_CHARS + 10) : "";
    expect((await collectUncommittedDiff(huge)).truncated).toBe(true);
  });

  it("the review prompt carries the diff envelope + verdict contract; focus rides through", () => {
    const prompt = buildReviewPrompt({
      diff: { repo: true, stat: " a.ts | 2 +-", patch: "+hello", untracked: ["n.ts"], truncated: false },
      security: false,
      focus: "error paths",
    });
    expect(prompt).toContain("<review-request>");
    expect(prompt).toContain("</review-request>");
    expect(prompt).toContain("CURRENT UNCOMMITTED");
    expect(prompt).toContain("Focus requested by the user: error paths");
    expect(prompt).toContain("severity (P0..P3)");
    expect(prompt).toContain("approve / approve-with-changes / reject");
    expect(prompt).toContain("```diff");
    expect(prompt).toContain("+hello");
    expect(prompt).toContain("- n.ts");
    expect(prompt).not.toContain("checklist");
  });

  it("the security variant pins the checklist", () => {
    const prompt = buildReviewPrompt({
      diff: { repo: true, stat: "", patch: "", untracked: [], truncated: false },
      security: true,
    });
    expect(prompt).toContain("<security-review-request>");
    for (const item of SECURITY_CHECKLIST) expect(prompt).toContain(item);
    expect(prompt).toContain("Assume the change is guilty");
    expect(prompt).toContain("no tracked-file diff — untracked files only");
  });

  it("nothing reviewable → the notice path, not an empty run", () => {
    const empty = { repo: true, stat: "", patch: "", untracked: [], truncated: false };
    expect(hasReviewableContent(empty)).toBe(false);
    expect(formatNoDiffNotice("/ws")).toContain("nothing to review");
    expect(hasReviewableContent({ ...empty, untracked: ["n.ts"] })).toBe(true);
  });
});

describe("driver routing — /review /security-review /mcp /agents", () => {
  function makeDriver(model: ReturnType<typeof createScriptedModel>, opts: Partial<Parameters<typeof createAgentDriver>[0]> = {}): AgentDriver {
    return createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model,
      tools: [createReadFileTool({ workspaceRoot: process.cwd() })],
      ...opts,
    });
  }

  it("/review over a scratch diff: the run's first request embeds the diff", async () => {
    const ws = await tmpWs();
    try {
      // a real scratch repo with an uncommitted change
      await writeFile(join(ws, "a.ts"), "export const one = 1;\n", "utf8");
      const { execFile } = await import("node:child_process");
      const git = (args: readonly string[]): Promise<string> =>
        new Promise((resolve, reject) => {
          execFile("git", [...args], { cwd: ws }, (err, stdout, stderr) => {
            if (err !== null) reject(new Error(stderr || err.message));
            else resolve(stdout);
          });
        });
      await git(["init", "-q"]);
      await git(["config", "user.email", "t@t"]);
      await git(["config", "user.name", "t"]);
      await git(["add", "a.ts"]);
      await git(["commit", "-q", "-m", "init"]);
      await writeFile(join(ws, "a.ts"), "export const one = 2;\n", "utf8");
      await writeFile(join(ws, "new.ts"), "export const two = 2;\n", "utf8");

      const model = createScriptedModel([{ role: "assistant", content: "LGTM" }]);
      const driver = makeDriver(model, { workspaceRoot: ws, sessionId: "wudao-rev-5", onPermissionAsk: async () => ({ kind: "allow" }) });
      driver.submit("/review error paths");
      // the diff collection is async — wait for the prompt to LAND, then settle
      await until(() => driver.getHistory().some((e) => e.kind === "user"), "review prompt submitted");
      await until(() => driver.getStatus().busy === false, "review run");
      const userText = driver.getHistory().map((e) => (e.kind === "user" ? e.text : "")).join("\n");
      expect(userText).toContain("<review-request>");
      expect(userText).toContain("Focus requested by the user: error paths");
      expect(userText).toContain("+export const one = 2;");
      expect(userText).toContain("- new.ts");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/review with nothing uncommitted stays a notice", async () => {
    const ws = await tmpWs();
    try {
      const driver = makeDriver(createScriptedModel([]), { workspaceRoot: ws, sessionId: "wudao-rev-6" });
      driver.submit("/review");
      await until(() => noticesOf(driver).length > 0, "notice");
      // a tmp dir is not a repo → the not-a-repo notice
      expect(noticesOf(driver)).toContain("（审查不可用——不是 git 仓库）"); // ω99-166c-iv: 表外同族钉演进（ad:5123 审查面中文化连带；m55b noticesOf=join 串，子串语义同 worktree-driver）。
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/mcp renders configured servers with tool-lane counts and the empty case", async () => {
    const ws = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(join(ws, ".wudao", "mcp.json"), JSON.stringify({ servers: { demo: { command: "node" } } }), "utf8");
      const report = runMcpStatusCommand({ workspaceRoot: ws, toolNames: ["read_file", "mcp__demo__echo", "mcp__demo__ping"] });
      expect(report).toContain("demo: 已连接 · 2 个工具"); // ω99-180: 钉随源演进
      expect(report).toContain("mcp__");
      // CC-format compat: the row names its source tier.
      expect(report).toContain("来源：project .wudao/mcp.json"); // ω99-180: 钉随源演进

      const empty = runMcpStatusCommand({ workspaceRoot: tmpdir(), toolNames: ["read_file"] });
      expect(empty).toContain("未配置服务器"); // ω99-180: 钉随源演进

      const counts = mcpToolCounts(["read_file", "mcp__a__x", "mcp__a__y", "mcp__b__z", "mcp_weird"]);
      expect(counts.get("a")).toBe(2);
      expect(counts.get("b")).toBe(1);
      expect(counts.has("weird")).toBe(false);

      const rows = buildMcpRows({
        config: { servers: { dead: { command: "nope" } } },
        toolNames: [],
        runtime: new Map([["dead", { connected: false, tools: 0, handshakeMs: 3_000, calls: 0, errors: 1, failure: "spawn ENOENT" }]]),
      });
      expect(rows[0]?.connected).toBe(false);
      const text = formatMcpReport(rows);
      expect(text).toContain("dead: 失败 · 0 个工具"); // ω99-180: 钉随源演进
      expect(text).toContain("握手 3.0s"); // ω99-180: 钉随源演进
      expect(text).toContain("spawn ENOENT");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/mcp lists ALL tiers (user + root + project) with replacement receipts — the 配置后看不见 problem", async () => {
    const ws = await tmpWs();
    // The isolated global home the suite boots with (setup-global-home).
    const ghome = process.env.WUDAO_GLOBAL_HOME;
    try {
      expect(ghome).toBeDefined();
      await mkdir(join(ghome!, ".wudao"), { recursive: true }).catch(() => {});
      // globalMcpConfigPath = <globalHome>/mcp.json (not .wudao/mcp.json).
      await writeFile(join(ghome!, "mcp.json"), JSON.stringify({
        mcpServers: { MiniMax: { command: "uvx", args: ["minimax-coding-plan-mcp"] }, shadowed: { command: "global-one" } },
      }), "utf8");
      await writeFile(join(ws, ".mcp.json"), JSON.stringify({
        mcpServers: { rootOnly: { command: "echo", type: "stdio" } },
      }), "utf8");
      await mkdir(join(ws, ".wudao"), { recursive: true });
      await writeFile(join(ws, ".wudao", "mcp.json"), JSON.stringify({
        servers: { shadowed: { command: "project-one" } },
      }), "utf8");

      const report = runMcpStatusCommand({ workspaceRoot: ws, toolNames: [] });
      // All three tiers' servers appear — including the user-level one that
      // motivated the feature (configured globally, invisible before).
      expect(report).toContain("MiniMax:");
      expect(report).toContain("来源：user ~/.wudao/mcp.json"); // ω99-180: 钉随源演进
      expect(report).toContain("rootOnly:");
      expect(report).toContain("来源：root .mcp.json"); // ω99-180: 钉随源演进
      // Replacement: the project entry wins the name AND the receipt names
      // what it replaced.
      expect(report).toContain("shadowed:");
      expect(report).toContain("来源：project .wudao/mcp.json · 取代 user ~/.wudao/mcp.json"); // ω99-180: 钉随源演进
      // The report is driven by the EFFECTIVE entry (project's command).
      expect(report).not.toContain("global-one");
    } finally {
      await rm(join(ghome!, "mcp.json"), { force: true });
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("/agents lists builtin/plugin/workspace with pins, scopes, and receipts", async () => {
    const ws = await tmpWs();
    try {
      await mkdir(join(ws, ".wudao", "agents"), { recursive: true });
      await writeFile(
        join(ws, ".wudao", "agents", "scoper.json"),
        JSON.stringify({ description: "scoped worker", frozen: true, writeScope: { roots: ["src/lib"], exactFiles: ["pkg.json"] }, worktree: true }),
        "utf8",
      );
      const report = await runAgentsCommand({
        workspaceRoot: ws,
        pluginAgents: [{ profile: { id: "pluginner", description: "from a plugin" }, source: "plugin demo: agents/pluginner.md" }],
      });
      expect(report).toMatch(/builtin · 1 plugin · 0 global · 1 workspace/);
      expect(report).toContain("scoper — scoped worker");
      expect(report).toContain("已冻结（拒绝覆盖）"); // ω99-181: 钉随源演进
      expect(report).toContain("写入：1 个根+1 个精确文件"); // ω99-181: 钉随源演进
      expect(report).toContain("worktree");
      expect(report).toContain("pluginner — from a plugin");
      expect(report).toContain("general-purpose");

      const roster = await loadRoleProfiles(ws, { pluginAgents: [] });
      const sources = rosterSources({ roster, pluginAgents: [], globalIds: [], workspaceIds: ["scoper"] });
      expect(sources.get("scoper")).toBe("workspace");
      expect(sources.get("coder")).toBe("builtin");
      const consultant = BUILTIN_ROLES["consultant"];
      expect(consultant !== undefined && roleSummary(consultant).includes("模型 high")).toBe(true); // ω99-195: 钉随源演进（census 漏列——roleSummary 渲染值断言）
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
