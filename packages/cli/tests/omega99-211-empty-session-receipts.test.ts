// ω99-211: #R — receipts：Buddy 进门零空会话（用户令 09-09「buddy 模式默认不
// 开会话，进来应该是欢迎界面」）。四钉：
//   ① boot 零输入不物化（in-process 引擎钉 + WUDAO_E2E=1 真 dist/index.js
//      spawn 钉——index.ts ui 分支的 boot 簿记只在真进程路径跑）；
//   ② 首条 submit 才物化：model_change + workspace_root 簿记先于用户行落盘，
//      sessions op 出行且可 resume；
//   ③ [+ 新对话]（/clear）后未输入退出不留空行——boot id 未物化时连
//      clear_boundary 都不写（写它=凭空物化一行）；
//   ④（web 半在 packages/web/tests/omega99-211-buddy-entry.test.tsx）。
// 夹具全在 os.tmpdir() 自建目录；不触真实 ~/.wudao / 用户工作区（★用户红线）。
// e2e 半沿用 approval-trace-e2e 的门：WUDAO_E2E=1 且 dist/ 已构建才跑（子进程
// 启动全 CLI，默认套件不背这份负载）。
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJsonlSessionStore, createScriptedModel } from "@wudao-org/core";
import type { ModelClient, ModelInput } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { startUiSession } from "../src/ui.js";
import type { UiSession } from "../src/ui.js";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const E2E_ON = process.env.WUDAO_E2E === "1";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

/** A model that never exhausts: every conversation call answers the same line
 * (title calls — querySource-tagged — get their own throwaway answer so the
 * auto-title fork never hangs the run). */
function steadyModel(): ModelClient {
  return {
    async generate(_input: ModelInput) {
      return { role: "assistant" as const, content: "STEADY-OK", stopReason: "end_turn" as const };
    },
  };
}

const sessions: UiSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The session FILES a sessions-op row would come from (sidechains and the
 * .leases dir are excluded — they are not session rows). */
const sessionFiles = (root: string): string[] => {
  try {
    return readdirSync(join(root, ".wudao", "sessions")).filter((n) => n.endsWith(".jsonl") && !n.startsWith("side-"));
  } catch {
    return [];
  }
};

/** Seed one REAL prior session (a user message on disk) so the row-count
 * assertions have a non-zero baseline. */
function seedPriorSession(root: string, id = "wudao-prior-0001"): void {
  const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
  void store.append(id, { role: "user", content: "既有的第一句" });
}

interface Frame {
  t: string;
  id?: unknown;
  ok?: unknown;
  state?: { busy?: boolean };
}

function connect(session: UiSession): { ws: WebSocket; frames: Frame[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${session.server.port}`);
  const frames: Frame[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as Frame));
  return { ws, frames };
}

async function authed(session: UiSession): Promise<{ ws: WebSocket; frames: Frame[] }> {
  const c = connect(session);
  await new Promise<void>((resolve) => c.ws.addEventListener("open", resolve));
  c.ws.send(JSON.stringify({ t: "auth", token: session.server.token }));
  await until(() => c.frames.some((f) => f.t === "history" && (f as { reset?: boolean }).reset === true), "initial replay");
  return c;
}

/** The sessions op over the wire — the exact lane the Buddy sidebar rides. */
async function sessionsRows(c: { ws: WebSocket; frames: Frame[] }): Promise<{ id: string; messages: number; firstUser: string }[]> {
  const id = Math.floor(Math.random() * 100000);
  c.ws.send(JSON.stringify({ t: "op", id, op: { op: "sessions" } }));
  await until(() => c.frames.some((f) => f.t === "result" && f.id === id), "sessions result");
  return c.frames.find((f) => f.t === "result" && f.id === id)?.ok as { id: string; messages: number; firstUser: string }[];
}

async function bootSession(root: string, sessionId: string): Promise<UiSession> {
  const session = await startUiSession({
    config,
    workspaceRoot: root,
    contextWindowTokens: 64000,
    modelOverride: steadyModel(),
    tools: [],
    gates: { verify: false },
    announce: false,
    openBrowser: false,
    staticDir: undefined,
    sessionId,
    // ω99-211: index.ts 的 fresh boot 分支传的就是这个旗（A 路线落盘延迟）。
    sessionFresh: true,
  });
  sessions.push(session);
  return session;
}

describe("ω99-211 — 空会话不物化（route A：首条 submit 才落盘）", () => {
  it("① 引擎半：sessionFresh boot 零输入 → 无 <id>.jsonl，sessions op 行数不变（只有既有会话）", async () => {
    const root = mkdtempSync(join(tmpdir(), "omega99-211-t1-"));
    roots.push(root);
    seedPriorSession(root);
    await until(() => sessionFiles(root).includes("wudao-prior-0001.jsonl"), "prior session flushed");
    const before = sessionFiles(root);

    const session = await bootSession(root, "wudao-fresh-t1");
    const c = await authed(session);
    await wait(150); // boot 完全落定（改前引擎本就不写——index.ts 半由 e2e 钉）

    expect(existsSync(join(root, ".wudao", "sessions", "wudao-fresh-t1.jsonl"))).toBe(false);
    expect(sessionFiles(root)).toEqual(before);
    const rows = await sessionsRows(c);
    expect(rows.map((r) => r.id)).toEqual(["wudao-prior-0001"]);
    c.ws.close();
  }, 12000);

  it("② 首条 submit 才物化：model_change + workspace_root 先于用户行；sessions 出行且可 resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "omega99-211-t2-"));
    roots.push(root);
    seedPriorSession(root);
    await until(() => sessionFiles(root).includes("wudao-prior-0001.jsonl"), "prior session flushed");

    const session = await bootSession(root, "wudao-fresh-t2");
    const c = await authed(session);
    c.ws.send(JSON.stringify({ t: "op", id: 21, op: { op: "submit", text: "进门后的第一句话" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 21 && f.ok === "started"), "submit started");
    await until(() => session.driver.getStatus().busy === false, "run settles");
    await until(() => {
      try {
        return readFileSync(join(root, ".wudao", "sessions", "wudao-fresh-t2.jsonl"), "utf8").includes("进门后的第一句话");
      } catch {
        return false;
      }
    }, "fresh session materialized");

    // 落盘序（引擎自身写队 FIFO）：format marker → model_change →
    // workspace_root → 用户行。相对序断言——auto-title 的 session_name 走
    // driver 自建 store 实例（跨实例写本就可能交错，M80 clear_boundary 同款），
    // 不钉它的落位，只钉引擎簿记全部在场且先于用户行。
    const lines = readFileSync(join(root, ".wudao", "sessions", "wudao-fresh-t2.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
    const kinds = lines.map((l) => (l.type !== undefined ? String(l.type) : String(l.role)));
    const at = (k: string): number => {
      const i = kinds.indexOf(k);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    expect(at("user")).toBeGreaterThan(at("workspace_root"));
    expect(at("workspace_root")).toBeGreaterThan(at("model_change"));
    expect(at("model_change")).toBeGreaterThan(at("wudao_meta"));

    // sessions op：+1 行，行带首句；resume op（侧栏点击同一车道）可采纳。
    const rows = await sessionsRows(c);
    expect(rows.map((r) => r.id)).toContain("wudao-fresh-t2");
    expect(rows.find((r) => r.id === "wudao-fresh-t2")?.firstUser).toContain("进门后的第一句话");
    c.ws.send(JSON.stringify({ t: "op", id: 22, op: { op: "resume", id: "wudao-fresh-t2" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 22), "resume result");
    // ω99-228 走查热修：225 的 ResumeOutcome 契约改后 wire 帧载荷从裸 true
    // 变 {ok:true}（server reply(ok) 把 outcome 原样装进 ok 字段）——本钉
    // 是 225 solo 域漏面（同 0.3.60 slack 漏面类），结构断言跟上三态真话。
    expect(c.frames.find((f) => f.t === "result" && f.id === 22)?.ok).toEqual({ ok: true });
    c.ws.close();
  }, 12000);

  it("③ [+ 新对话]（/clear）后未输入退出 → 不留空行：未物化的 boot id 连 clear_boundary 都不写", async () => {
    const root = mkdtempSync(join(tmpdir(), "omega99-211-t3-"));
    roots.push(root);
    seedPriorSession(root);
    await until(() => sessionFiles(root).includes("wudao-prior-0001.jsonl"), "prior session flushed");
    const before = sessionFiles(root);

    const session = await bootSession(root, "wudao-fresh-t3");
    const c = await authed(session);
    c.ws.send(JSON.stringify({ t: "op", id: 31, op: { op: "submit", text: "/clear" } }));
    await until(() => c.frames.some((f) => f.t === "result" && f.id === 31 && (f.ok === "cleared" || f.ok === "frontend")), "clear outcome");
    await wait(150); // 边界标记（若有）落定

    expect(sessionFiles(root)).toEqual(before); // 改前红：clear_boundary 凭空物化 boot id
    const rows = await sessionsRows(c);
    expect(rows.map((r) => r.id)).toEqual(["wudao-prior-0001"]);
    c.ws.close();
  }, 12000);
});

// e2e 半（WUDAO_E2E=1）：真 index.js ui boot——index.ts 的 fresh 分支跳过 boot
// 簿记只有这条进程级车道能钉（引擎单测看不到 index.ts 的 boot 写）。
describe.skipIf(!E2E_ON)("ω99-211 — e2e：真 `wudao ui` boot 零输入不产生会话行（WUDAO_E2E 门）", () => {
  it("spawn dist/index.js ui → 零输入退出 → sessions 目录零 *.jsonl", async () => {
    expect(existsSync(CLI_ENTRY)).toBe(true); // 先 pnpm --filter wudao-harness run build
    const root = mkdtempSync(join(tmpdir(), "omega99-211-e2e-"));
    roots.push(root);
    const child = spawn(process.execPath, [CLI_ENTRY, "ui", "--no-open"], {
      cwd: root,
      env: { ...process.env, HOME: root, WUDAO_API_KEY: "", DEEPSEEK_API_KEY: "", OPENAI_API_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    await until(() => out.includes("open: http"), "ui server up", 20000);
    await wait(1500); // boot 簿记（若有）落定
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      setTimeout(resolve, 3000); // SIGTERM 兜底
    });
    expect(sessionFiles(root)).toEqual([]); // 改前红：boot 簿记物化 <id>.jsonl
  }, 30000);
});
