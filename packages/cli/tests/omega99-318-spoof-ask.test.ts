// ω99-318 — 审批 ask 帧的视觉欺骗载荷（源检验、边渲染）+ TUI 显形行。
// 钉四件事：
//   1) askPermission 缝（车道分叉前）算 spoof，停泊车道挂 pendingPermission.spoof；
//   2) 回调车道（onPermissionAsk）ctx 同一载荷（web/TUI/pet 同源）；
//   3) 干净输入零新键——帧字节不变（加性契约）；JSONL ask 行五字段不动（252 钉的延续）；
//   4) PermissionPrompt 渲染显形行（黄字，问句上方）——缺席=帧不含该行。
// ★红线：全 mock（scripted model、stub 工具、parkingGate、手动 resolve 的弹窗替身）；
// 夹具只写 mkdtemp(os.tmpdir()) 只写不删；显形不拦截——载荷在场与否按键道/应答零差。
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, createJsonlSessionStore, buildTool } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import type { AskAnswer } from "../src/permission.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { PermissionPrompt } from "../src/tui/permission.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "o318-spoof-"));
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function parkingGate(box: { current?: AgentDriver }): (toolName: string, input: Record<string, unknown>) => Promise<import("@wudao-org/core").PermissionDecision> {
  return async (toolName, input) => box.current?.ask(toolName, input) ?? { behavior: "allow" };
}

function stubShell(): Tool {
  return buildTool({
    name: "shell",
    description: "stub shell",
    parameters: {
      type: "object" as const,
      properties: { command: { type: "string" as const } },
      required: ["command"],
    },
    execute: async (input) => ({ content: `ran ${String(input.command)}` }),
  });
}

function stubFetch(): Tool {
  return buildTool({
    name: "fetch",
    description: "stub fetch",
    parameters: {
      type: "object" as const,
      properties: { url: { type: "string" as const } },
      required: ["url"],
    },
    execute: async (input) => ({ content: `fetched ${String(input.url)}` }),
  });
}

type DialogBox = { current: ((answer: AskAnswer) => void) | null };
type SeenCtx = { toolName: string; ctx?: { spoof?: unknown } } | null;
const tuiAsk = (box: DialogBox, seen: { current: SeenCtx } = { current: null }) =>
  (toolName: string, _summary: string, _input: Record<string, unknown>, ctx?: { spoof?: unknown }): Promise<AskAnswer> =>
    new Promise((resolve) => {
      seen.current = { toolName, ...(ctx !== undefined ? { ctx } : {}) };
      box.current = (answer: AskAnswer): void => {
        box.current = null;
        resolve(answer);
      };
    });

// ---------------------------------------------------------------------------
// R1 停泊车道（web/WS 形）：载荷挂 pendingPermission.spoof；干净输入零新键。
// ---------------------------------------------------------------------------
describe("R1 parked lane — the spoof payload rides the pending frame", () => {
  it("零宽字符命令：pendingPermission.spoof 显形（key/码点钉），答案语义照常", async () => {
    const root = tmp();
    const box: { current?: AgentDriver } = {};
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: `rm -rf /tmp/​safe` } }] },
        { role: "assistant", content: "PARKED-DONE" },
      ]),
      tools: [stubShell()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
    });
    box.current = driver;
    const sid = driver.getSessionId();
    driver.submit("parked spoof job");
    await until(() => driver.getStatus().pendingPermission !== null, "the ask to park");

    const parked = driver.getStatus().pendingPermission;
    expect(parked).not.toBeNull();
    const spoof = (parked as { spoof?: { text: { key: string; issues: { codepoint: string }[] }[] } }).spoof;
    expect(spoof).toBeDefined();
    expect(spoof?.text).toHaveLength(1);
    expect(spoof?.text[0]?.key).toBe("command");
    expect(spoof?.text[0]?.issues[0]?.codepoint).toBe("U+200B");

    // 加性契约的持久面：JSONL ask 行仍是五字段（spoof 绝不进 ledger）。
    await wait(80);
    const file = join(root, ".wudao", "sessions", `${sid}.jsonl`);
    expect(existsSync(file)).toBe(true);
    const askLine = readFileSync(file, "utf8").split("\n").find((l) => l.includes('"permission_ask"')) as string;
    const data = (JSON.parse(askLine) as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(["at", "question", "sessionId", "summary", "toolName"]);

    // 显形不拦截：应答照常收束（allow 语义与无载荷时一字不差）。
    driver.answerPermission({ kind: "deny" });
    await until(() => driver.getStatus().busy === false, "the parked run to finish");
    driver.dispose();
  }, 10_000);

  it("干净输入：停泊帧零新键（spoof 键缺席——老消费者字节面不变）", async () => {
    const root = tmp();
    const box: { current?: AgentDriver } = {};
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "./clean.sh --fast" } }] },
        { role: "assistant", content: "CLEAN-DONE" },
      ]),
      tools: [stubShell()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
    });
    box.current = driver;
    driver.submit("clean job");
    await until(() => driver.getStatus().pendingPermission !== null, "the ask to park");
    const parked = driver.getStatus().pendingPermission as Record<string, unknown> | null;
    expect(parked).not.toBeNull();
    expect(Object.keys(parked as Record<string, unknown>)).not.toContain("spoof");
    expect((parked as Record<string, unknown>).spoof).toBeUndefined();
    driver.answerPermission({ kind: "deny" });
    await until(() => driver.getStatus().busy === false, "the parked run to finish");
    driver.dispose();
  }, 10_000);

  it("同形域名 url 参数：spoof.urls 携带真实指向（归一形）", async () => {
    const root = tmp();
    const box: { current?: AgentDriver } = {};
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fetch", arguments: { url: "https://gοogle.com" } }] },
        { role: "assistant", content: "URL-DONE" },
      ]),
      tools: [stubFetch()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
    });
    box.current = driver;
    driver.submit("url spoof job");
    await until(() => driver.getStatus().pendingPermission !== null, "the ask to park");
    const spoof = (driver.getStatus().pendingPermission as { spoof?: { urls: { key: string; normalizedUrl: string; warnings: string[] }[] } }).spoof;
    expect(spoof?.urls).toHaveLength(1);
    expect(spoof?.urls[0]?.key).toBe("url");
    expect(spoof?.urls[0]?.normalizedUrl).toBe("https://google.com");
    expect(spoof?.urls[0]?.warnings.join(" ")).toContain("xn--"); // 机器实际去哪
    driver.answerPermission({ kind: "deny" });
    await until(() => driver.getStatus().busy === false, "the parked run to finish");
    driver.dispose();
  }, 10_000);

  it("载荷是纯 JSON（帧可走 wire——server 透传不打吗）", async () => {
    const root = tmp();
    const box: { current?: AgentDriver } = {};
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fetch", arguments: { url: "https://gοogle.com" } }] },
        { role: "assistant", content: "JSON-DONE" },
      ]),
      tools: [stubFetch()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
    });
    box.current = driver;
    driver.submit("wire job");
    await until(() => driver.getStatus().pendingPermission !== null, "the ask to park");
    const spoof = (driver.getStatus().pendingPermission as { spoof?: unknown }).spoof;
    expect(() => JSON.parse(JSON.stringify(spoof))).not.toThrow();
    driver.answerPermission({ kind: "deny" });
    await until(() => driver.getStatus().busy === false, "the parked run to finish");
    driver.dispose();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// R2 回调车道（TUI/pet 形）：ctx.spoof 同一载荷；干净输入 ctx 无该键。
// ---------------------------------------------------------------------------
describe("R2 callback lane — the same payload rides ctx", () => {
  it("onPermissionAsk 的 ctx 携带 spoof（web/TUI/pet 同源显形）", async () => {
    const root = tmp();
    const box: { current?: AgentDriver } = {};
    const dialog: DialogBox = { current: null };
    const seen: { current: SeenCtx } = { current: null };
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: `cat /etc/pa​sswd` } }] },
        { role: "assistant", content: "CTX-DONE" },
      ]),
      tools: [stubShell()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
      onPermissionAsk: tuiAsk(dialog, seen),
    });
    box.current = driver;
    driver.submit("ctx spoof job");
    await until(() => dialog.current !== null, "the dialog to open");
    expect(seen.current?.toolName).toBe("shell");
    const ctxSpoof = (seen.current?.ctx as { spoof?: { text: { key: string; issues: { codepoint: string }[] }[] } } | undefined)?.spoof;
    expect(ctxSpoof).toBeDefined();
    expect(ctxSpoof?.text[0]?.key).toBe("command");
    expect(ctxSpoof?.text[0]?.issues[0]?.codepoint).toBe("U+200B");
    dialog.current({ kind: "deny" });
    await until(() => driver.getStatus().busy === false, "the run to finish");
    driver.dispose();
  }, 10_000);

  it("干净输入：ctx 无 spoof 键（回调车道零新键）", async () => {
    const root = tmp();
    const box: { current?: AgentDriver } = {};
    const dialog: DialogBox = { current: null };
    const seen: { current: SeenCtx } = { current: null };
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "ls -la" } }] },
        { role: "assistant", content: "CTX-CLEAN-DONE" },
      ]),
      tools: [stubShell()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: root,
      gates: { verify: false },
      canUseTool: parkingGate(box),
      onPermissionAsk: tuiAsk(dialog, seen),
    });
    box.current = driver;
    driver.submit("ctx clean job");
    await until(() => dialog.current !== null, "the dialog to open");
    const ctx = seen.current?.ctx as Record<string, unknown> | undefined;
    expect(ctx === undefined || ctx.spoof === undefined).toBe(true);
    dialog.current({ kind: "allow" });
    await until(() => driver.getStatus().busy === false, "the run to finish");
    driver.dispose();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// R3 TUI 显形行：载荷在场=黄字一行（问句上方）；缺席=帧不含该行；键道零动。
// ---------------------------------------------------------------------------
describe("R3 PermissionPrompt reveal line", () => {
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  const spoofPayload = {
    text: [{ key: "command", issues: [{ codepoint: "U+200B", name: "ZERO WIDTH SPACE", nameZh: "零宽空格", position: 13, category: "zero-width" as const }], more: 0 }],
    urls: [{ key: "url", original: "https://gοogle.com", normalizedUrl: "https://google.com", warnings: ["实际网络名（punycode）：xn--gogle-rce.com"] }],
  };

  it("载荷在场：帧含显形行（码点徽标 + 真实指向）；y 仍是 allow（键道零动）", async () => {
    const onChoose = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "shell", summary: "./x.sh", spoof: spoofPayload, onChoose }),
    );
    await wait();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("视觉欺骗检查");
    expect(frame).toContain("U+200B 零宽空格");
    expect(frame).toContain("url 真实指向 https://google.com");
    expect(frame).toContain("[y/a/p/N]"); // 问句照常
    stdin.write("y");
    await wait();
    expect(onChoose).toHaveBeenCalledWith({ kind: "allow" }); // 显形不拦截
    unmount();
  });

  it("载荷缺席：帧不含显形行（字节面与 ω99-318 之前全等）", async () => {
    const onChoose = vi.fn();
    const { stdin, lastFrame, unmount } = render(
      React.createElement(PermissionPrompt, { toolName: "shell", summary: "./x.sh", onChoose }),
    );
    await wait();
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).not.toContain("视觉欺骗检查");
    stdin.write("n");
    await wait();
    stdin.write("\r");
    await wait();
    expect(onChoose).toHaveBeenCalledWith({ kind: "deny" });
    unmount();
  });
});
