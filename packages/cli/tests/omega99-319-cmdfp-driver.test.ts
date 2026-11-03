// ω99-319: #2 — 命令足迹的 driver settle 面（落账 + changes merge + M24 旁路）。
// 钉（brief §5.3/§5.4/§5.6）：
//   落账   shell 改文件 → notice changes 行带 cmd；JSONL 泛型车道多出
//          command_footprint 条目（{turn,run,command,files} 恰形）；command 200
//          字符帽；settle 批随行（与 turn_diff_receipt/file_snapshot 同批）。
//   merge  同 path cmd 行 wins（op 用足迹 kind）；deleted 不进 changes（只在
//          command_footprint 条目）；shell-only 轮也落 changes 收据（门=净足迹
//          非空）；deleted-only 轮零 changes 收据（诚实边界）。
//   播种   首轮 shell 改动无 beforeSha（首改未播种——按钮置灰的数据面）；次轮
//          同文件再改 → beforeSha 在场（超越点②自播种）+ file_snapshot 行。
//   M24    旁路零 sessionStore 写（side-question.test:208 同款 Proxy 断言——除
//          appendEntries 外零写）+ 请求投影字节不受影响（模型输入的消息面零
//          足迹痕迹、systemPrompt 逐字节同）+ 泛型条目不进 load() 消息视图。
//   时序   长命令窗口内用户文件变更 → 归因到该命令（诚实边界行为钉——brief
//          §2 缺点 3 的行为面）。
// 夹具全在 os.tmpdir()；绝不删用户文件（rm 仅作用于测试自建 tmpdir）。
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, realpath, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScriptedModel,
  createTurnDiffTracker,
  createWriteFileTool,
  createShellTool,
  createJsonlSessionStore,
} from "@wudao-org/core";
import type { ModelClient, SessionStore, ModelInput, AssistantMessage } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { createSnapshotStore, sha256Hex } from "../src/snapshots.js";
import { receiptNoticesFromEntries } from "../src/tui/resume.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

interface NoticeEntry {
  kind: "notice";
  text: string;
  changes?: readonly { path: string; op: "created" | "modified"; writes: number; cmd?: string; beforeSha?: string }[];
}
const notices = (d: ReturnType<typeof createAgentDriver>): NoticeEntry[] =>
  d.getHistory().filter((e): e is NoticeEntry => e.kind === "notice");

/** 记录每次模型输入的模型（脚本回答 + 投影捕获——M24 双证的字节面）。 */
function recordingScriptedModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inner = createScriptedModel(responses);
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...(input.tools ?? [])] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

interface CmdFootprintData {
  turn: number;
  run: string;
  command: string;
  files: readonly { path: string; kind: "modified" | "created" | "deleted"; afterSha?: string }[];
}
const loadEntries = async (ws: string, sid: string) =>
  (await createJsonlSessionStore(join(ws, ".wudao", "sessions")).loadSessionEntries(sid)) as readonly Record<string, unknown>[];
const footprintEntries = (entries: readonly Record<string, unknown>[]): CmdFootprintData[] =>
  entries
    .filter((e) => e["type"] === "command_footprint")
    .map((e) => (e as { data: CmdFootprintData }).data);

describe("ω99-319 落账 — settle 缝的 command_footprint + changes[].cmd", () => {
  it("shell 改文件 → changes 行带 cmd + command_footprint 条目恰形 + M24 泛型不进消息视图", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "cfp319-a-")));
    try {
      await writeFile(join(ws, "a.ts"), "OLD\n", "utf8");
      const t = createTurnDiffTracker();
      const model = recordingScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "printf 'NEW-LINE\\n' > a.ts" } }] },
        { role: "assistant", content: "done" },
      ]);
      const driver = createAgentDriver({
        model,
        tools: [createShellTool({ workspaceRoot: ws })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        snapshots: createSnapshotStore(ws),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      driver.submit("fix it");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "run settled");
      await wait(80); // fire-and-forget 持久化 flush
      // changes 行带 cmd（归因标记）+ afterSha 播种在仓（无 beforeSha——首改未播种）
      const td = notices(driver).find((n) => n.changes !== undefined && n.changes.length > 0);
      expect(td).toBeDefined();
      expect(td!.changes).toEqual([
        { path: "a.ts", op: "modified", writes: 1, cmd: "printf 'NEW-LINE\\n' > a.ts" },
      ]);
      expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("NEW-LINE\n");
      // JSONL：command_footprint 恰形（与 turn_diff_receipt/file_snapshot 同批）
      const entries = await loadEntries(ws, sid);
      expect(footprintEntries(entries)).toEqual([
        {
          turn: 1,
          run: sid,
          command: "printf 'NEW-LINE\\n' > a.ts",
          files: [{ path: "a.ts", kind: "modified", afterSha: sha256Hex("NEW-LINE\n") }],
        },
      ]);
      expect(entries.some((e) => e["type"] === "turn_diff_receipt")).toBe(true);
      // M24：泛型条目不进 load() 消息视图
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const msgs = await store.load(sid);
      expect(JSON.stringify(msgs)).not.toContain("command_footprint");
      // M24：请求投影字节不受影响——第二轮输入的消息面零足迹痕迹、systemPrompt 同
      const second = model.inputs[1]!;
      expect(second.systemPrompt).toBe("s");
      expect(second.messages).toHaveLength(3); // user + assistant(toolCall) + tool result——足迹零加塞
      expect(JSON.stringify(second.messages)).not.toContain("command_footprint");
      expect(JSON.stringify(second.messages)).not.toContain('"cmd"');
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("M24：旁路零 sessionStore 写——除 appendEntries 外零调用（side-question:208 同款 Proxy）", async () => {
    const fns = new Map<string, ReturnType<typeof vi.fn>>();
    const store = new Proxy({} as SessionStore, {
      get: (_t, k: string) => {
        if (typeof k !== "string" || k === "then") return undefined;
        if (!fns.has(k)) {
          const ret = k === "load" || k === "loadSessionEntries" || k === "list" ? Promise.resolve([]) : Promise.resolve(undefined);
          fns.set(k, vi.fn().mockReturnValue(ret));
        }
        return fns.get(k);
      },
    }) as SessionStore;
    const ws = await realpath(await mkdtemp(join(tmpdir(), "cfp319-m24-")));
    try {
      await writeFile(join(ws, "a.ts"), "OLD\n", "utf8");
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo CHANGED > a.ts" } }] },
          { role: "assistant", content: "done" },
        ]),
        tools: [createShellTool({ workspaceRoot: ws })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        sessionStore: store,
        snapshots: createSnapshotStore(ws),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.submit("go");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "settled");
      await wait(80);
      const writeCalls = [...fns.entries()].filter(([k]) => k.startsWith("append")).map(([k, f]) => `${k}×${f.mock.calls.length}`);
      // 主 run 的正常持久化=append/appendEntries；足迹零新增写面（无 appendSidechain* 等）
      expect(writeCalls.every((w) => w.startsWith("append") && !w.includes("Sidechain"))).toBe(true);
      expect(fns.get("appendEntries")!.mock.calls.length).toBeGreaterThanOrEqual(1); // 收据批（含 command_footprint）
      expect(fns.get("appendSidechain") === undefined || fns.get("appendSidechain")!.mock.calls.length === 0).toBe(true);
      expect(fns.get("appendSidechainEntry") === undefined || fns.get("appendSidechainEntry")!.mock.calls.length === 0).toBe(true);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("merge 规则：同 path cmd 行 wins（op 用足迹 kind）；write_file 行照旧；deleted 不进 changes", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "cfp319-merge-")));
    try {
      await writeFile(join(ws, "keep.ts"), "K\n", "utf8");
      await writeFile(join(ws, "doomed.txt"), "D\n", "utf8");
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "rm doomed.txt && echo cmd-made > made.txt && printf CMD > keep.ts" } }] },
          { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "write_file", arguments: { path: "wf.ts", content: "WF\n" } }] },
          { role: "assistant", content: "done" },
        ]),
        tools: [createShellTool({ workspaceRoot: ws }), createWriteFileTool({ workspaceRoot: ws, turnDiff: t })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        snapshots: createSnapshotStore(ws),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      driver.submit("go");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "settled");
      await wait(80);
      const td = notices(driver).find((n) => n.changes !== undefined && n.changes.length > 0)!;
      const paths = td.changes!.map((c) => `${c.path}:${c.op}${c.cmd !== undefined ? ":cmd" : ""}`);
      expect(paths.sort()).toEqual(["keep.ts:modified:cmd", "made.txt:created:cmd", "wf.ts:created"]);
      // deleted（doomed.txt）不在 changes——只在 command_footprint 条目
      expect(td.changes!.some((c) => c.path === "doomed.txt")).toBe(false);
      const fps = footprintEntries(await loadEntries(ws, sid));
      expect(fps).toHaveLength(1);
      const kinds = new Map(fps[0]!.files.map((f) => [f.path, f.kind]));
      expect(kinds.get("doomed.txt")).toBe("deleted");
      expect(kinds.get("made.txt")).toBe("created");
      expect(kinds.get("keep.ts")).toBe("modified");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("deleted-only 轮：零 changes 收据（诚实边界）但 command_footprint 条目照落", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "cfp319-del-")));
    try {
      await writeFile(join(ws, "only.txt"), "x\n", "utf8");
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "rm only.txt" } }] },
          { role: "assistant", content: "done" },
        ]),
        tools: [createShellTool({ workspaceRoot: ws })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        snapshots: createSnapshotStore(ws),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      driver.submit("go");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "settled");
      await wait(80);
      expect(notices(driver).some((n) => n.changes !== undefined && n.changes.length > 0)).toBe(false); // 两态形状限制
      const fps = footprintEntries(await loadEntries(ws, sid));
      expect(fps).toEqual([{ turn: 1, run: sid, command: "rm only.txt", files: [{ path: "only.txt", kind: "deleted" }] }]);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("命令 200 字符帽：超长命令在条目上截断加 …", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "cfp319-cap-")));
    try {
      const long = `echo ${"x".repeat(230)} > out.txt`;
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: long } }] },
          { role: "assistant", content: "done" },
        ]),
        tools: [createShellTool({ workspaceRoot: ws })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      driver.submit("go");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "settled");
      await wait(80);
      const fps = footprintEntries(await loadEntries(ws, sid));
      expect(fps).toHaveLength(1);
      expect(fps[0]!.command).toHaveLength(201);
      expect(fps[0]!.command.endsWith("…")).toBe(true);
      const td = notices(driver).find((n) => n.changes !== undefined && n.changes.length > 0)!;
      expect(td.changes![0]!.cmd).toHaveLength(201);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("自播种（超越点②）：首轮无 beforeSha；次轮同文件再改 → beforeSha 在场 + file_snapshot 行", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "cfp319-seed-")));
    try {
      await writeFile(join(ws, "a.ts"), "V0\n", "utf8");
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "echo V1 > a.ts" } }] },
          { role: "assistant", content: "ok1" },
          { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "shell", arguments: { command: "echo V2 > a.ts" } }] },
          { role: "assistant", content: "ok2" },
        ]),
        tools: [createShellTool({ workspaceRoot: ws })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        snapshots: createSnapshotStore(ws),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      driver.submit("go");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "run1 settled");
      await wait(80);
      const first = notices(driver).find((n) => n.changes !== undefined && n.changes.length > 0)!;
      expect(first.changes![0]!.beforeSha).toBeUndefined(); // 首改未播种（本会话从未见过它的内容）
      // 次轮：同文件再改 → beforeSha = 上轮 after 指针（V1 内容可回退）；file_snapshot 行落泛型车道
      driver.submit("again");
      await until(() => notices(driver).filter((n) => n.changes !== undefined && n.changes.length > 0).length === 2, "run2 receipt");
      await wait(80);
      const second = notices(driver).filter((n) => n.changes !== undefined && n.changes.length > 0)[1]!;
      expect(second.changes![0]).toMatchObject({ path: "a.ts", op: "modified", writes: 1, cmd: "echo V2 > a.ts", beforeSha: sha256Hex("V1\n") });
      const entries = await loadEntries(ws, sid);
      const snaps = entries.filter((e) => e["type"] === "file_snapshot") as { type: string; data: { turn: number; path: string; beforeSha: string; afterSha: string } }[];
      expect(snaps).toEqual([{ type: "file_snapshot", data: { turn: 2, run: sid, path: "a.ts", beforeSha: sha256Hex("V1\n"), afterSha: sha256Hex("V2\n") } }]);
      // 回退闭环：fileRevert 到 V1（播种的 beforeSha 真可用——超越点②直证）
      const r = await driver.fileRevert("a.ts", sha256Hex("V1\n"));
      expect(r).toMatchObject({ ok: true });
      expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("V1\n");
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("回放：receiptNoticesFromEntries 的 cmd 字段存活（畸形值只弃字段不弃行）", () => {
    const ok = receiptNoticesFromEntries([
      { type: "turn_diff_receipt", data: { text: "回合净变更 1 文件：a.ts", changes: [{ path: "a.ts", op: "modified", writes: 1, cmd: "echo x > a.ts" }] } },
      { type: "turn_diff_receipt", data: { text: "回合净变更 1 文件：b.ts", changes: [{ path: "b.ts", op: "modified", writes: 1, cmd: "" }] } }, // 空串=畸形 → 弃字段留行
      { type: "turn_diff_receipt", data: { text: "回合净变更 1 文件：c.ts", changes: [{ path: "c.ts", op: "modified", writes: 1, cmd: 42 }] } }, // 非串 → 弃字段留行
    ] as never);
    expect(ok).toEqual([
      { kind: "notice", text: "回合净变更 1 文件：a.ts", changes: [{ path: "a.ts", op: "modified", writes: 1, cmd: "echo x > a.ts" }] },
      { kind: "notice", text: "回合净变更 1 文件：b.ts", changes: [{ path: "b.ts", op: "modified", writes: 1 }] },
      { kind: "notice", text: "回合净变更 1 文件：c.ts", changes: [{ path: "c.ts", op: "modified", writes: 1 }] },
    ]);
  });

  it("时序（brief §2 缺点 3 的行为面）：长命令窗口内用户文件变更 → 归因到该命令（诚实边界钉）", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "cfp319-window-")));
    try {
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "sleep 0.3; echo cmdout > cmd-out.txt" } }] },
          { role: "assistant", content: "done" },
        ]),
        tools: [createShellTool({ workspaceRoot: ws })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        snapshots: createSnapshotStore(ws),
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      const sid = driver.getSessionId();
      driver.submit("go");
      await until(() => driver.getStatus().busy === true, "run in flight");
      await wait(120); // 命令窗口内：用户在编辑器改了自己的文件
      await writeFile(join(ws, "user-edit.txt"), "用户手改\n", "utf8");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => /^耗时 /.test(n.text)), "settled");
      await wait(80);
      // 归因语义=「该命令执行窗口内变更」非「因果」——两文件都归到该命令（诚实钉）
      const fps = footprintEntries(await loadEntries(ws, sid));
      expect(fps).toHaveLength(1);
      const paths = fps[0]!.files.map((f) => f.path).sort();
      expect(paths).toEqual(["cmd-out.txt", "user-edit.txt"]);
      const td = notices(driver).find((n) => n.changes !== undefined && n.changes.length > 0)!;
      expect(td.changes!.map((c) => c.path).sort()).toEqual(["cmd-out.txt", "user-edit.txt"]);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
