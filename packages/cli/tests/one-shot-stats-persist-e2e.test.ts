// R2 深测弧（永续迭代）— one-shot run_stats_receipt 落盘 E2E。
//
// 背景：one-shot（`wudao "任务"`）的结算统计（耗时/模型/工具/缓存）此前只
// 打印 stdout；TUI/web 走 driver settle 把 run_stats_receipt 落进 session
// JSONL（omega99-217），one-shot 是第二套结算、只打印 → resume/考古/探针
// 监督回路对 one-shot 会话全盲。修复（packages/cli/src/index.ts 收尾段）：
// 同一 M35 §2 泛型车道、同一载荷形状（text 必带；idleReconnects/
// cacheDebtTokens additive >0 才带），与 driver 侧逐字节同形，读侧
// receiptNoticesFromEntries 无差别回放。
//
// 钉四件事（真 CLI spawn，观察面 = 落盘 JSONL）：
//   落盘   一次性 run 退出后，workspace .wudao/sessions/*.jsonl 含
//          run_stats_receipt，data.text 以「耗时」起头（formatRunStats 同
//          串），零值 additive 字段缺席（与 driver 同纪律）；
//   免静默 --quiet 下 stdout 无统计行，receipt 照落（审计完整性不是日志
//          详略问题）；
//   竞速   receipt 是 await 后才退进程（spawn 观察 exit code=0 + 条目在
//          文件里——不 await 会跟 process exit 竞速丢条，此钉就是回归哨）；
//   形状   条目恰为 {type, data} 泛型形，回放侧（resume notice）可认。
//
// 环境门 WUDAO_E2E=1（approval-trace-e2e 同款：孩子启动整只 CLI，默认门
// 不跑；dist 需先构建）。夹具全在 os.tmpdir()（红线：不碰用户文件）。
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const E2E_ON = process.env.WUDAO_E2E === "1";

/** Minimal stub: every request gets one plain text answer (no tool calls —
 *  the receipt lands regardless of turn shape). */
function stubAnswerEndpoint(): { server: Server; port: Promise<number>; close: () => Promise<void> } {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      void body;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "done." } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** R3-T001 深测弧 stub：第 1 轮答一个 read_file 工具调用；第 2 轮（历史
 *  里已有工具结果）回 HTTP 400 —— 不可重试类错误，run 中途死。 */
function stubMidRunDeathEndpoint(): { server: Server; port: Promise<number>; close: () => Promise<void> } {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString("utf8"); });
    req.on("end", () => {
      let hasToolResult = false;
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        hasToolResult = (parsed.messages ?? []).some((m) => m.role === "tool");
      } catch { /* ignore */ }
      if (hasToolResult) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "mid-run death" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "hello.txt" }) } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  const port = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface ChildRun { code: number | null; stdout: string; stderr: string }

function runOneShot(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("nice", ["-n", "19", process.execPath, CLI_ENTRY, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    killer.unref?.();
    child.on("close", () => clearTimeout(killer));
  });
}

function childEnv(home: string, baseURL: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WUDAO_GLOBAL_HOME: home,
    WUDAO_API_KEY: "test-key",
    WUDAO_BASE_URL: baseURL,
    WUDAO_MODEL: "fake-e2e-model",
    NO_COLOR: "1",
    WUDAO_NO_GATES: "1",
  };
}

function makeWs(prefix: string): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(ws, ".wudao"), { recursive: true });
  return ws;
}

/** Every run_stats_receipt line found in the workspace's session files. */
function receiptsIn(ws: string): Array<Record<string, unknown>> {
  const dir = join(ws, ".wudao", "sessions");
  const out: Array<Record<string, unknown>> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const d = JSON.parse(line) as Record<string, unknown>;
      if (d["type"] === "run_stats_receipt") out.push(d["data"] as Record<string, unknown>);
    }
  }
  return out;
}

describe.runIf(E2E_ON)("one-shot run_stats_receipt — 落盘/免静默/竞速", () => {
  it("一次性 run 退出后 JSONL 携带 run_stats_receipt（text 起头「耗时」，零值 additive 缺席，exit 0）", async () => {
    const stub = stubAnswerEndpoint();
    const ws = makeWs("oneshot-stats-1-");
    const home = mkdtempSync(join(tmpdir(), "oneshot-stats-home-"));
    try {
      const { code } = await runOneShot(["说点什么"], ws, childEnv(home, `http://127.0.0.1:${await stub.port}`));
      expect(code).toBe(0);
      const rs = receiptsIn(ws);
      expect(rs.length).toBeGreaterThanOrEqual(1);
      const last = rs.at(-1) as { text: string; idleReconnects?: number; cacheDebtTokens?: number };
      expect(last.text.startsWith("耗时")).toBe(true);
      expect(last.idleReconnects).toBeUndefined(); // additive：零值缺席（driver 同纪律）
      expect(last.cacheDebtTokens).toBeUndefined();
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 45_000);

  it("--quiet：stdout 无统计行，receipt 照落（审计完整性不受日志详略门）", async () => {
    const stub = stubAnswerEndpoint();
    const ws = makeWs("oneshot-stats-2-");
    const home = mkdtempSync(join(tmpdir(), "oneshot-stats-home-"));
    try {
      const { stdout, code } = await runOneShot(["--quiet", "说点什么"], ws, childEnv(home, `http://127.0.0.1:${await stub.port}`));
      expect(code).toBe(0);
      expect(stdout).not.toContain("耗时"); // 静默不打
      expect(receiptsIn(ws).length).toBeGreaterThanOrEqual(1); // 数据层照落
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 45_000);

  it("R3-T001 中途异常：已执行的工具结果 + aborted 收据照落，exit 1（孤儿 tool_use 不再是终局）", async () => {
    const stub = stubMidRunDeathEndpoint();
    const ws = makeWs("oneshot-stats-3-");
    const home = mkdtempSync(join(tmpdir(), "oneshot-stats-home-"));
    try {
      writeFileSync(join(ws, "hello.txt"), "real executed content\n", "utf8");
      const { code, stderr } = await runOneShot(["读一下 hello.txt 然后总结"], ws, childEnv(home, `http://127.0.0.1:${await stub.port}`));
      expect(code).toBe(1); // 失败语义不变
      expect(stderr).toContain("wudao:"); // main 的 catch 面照旧
      // ① 已执行的工具结果必须落盘（数据层完整：真实读过的内容不丢）
      const dir = join(ws, ".wudao", "sessions");
      const texts: string[] = [];
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (line.trim() === "") continue;
          const d = JSON.parse(line) as Record<string, unknown>;
          if (d["role"] === "tool") texts.push(String(d["content"]));
        }
      }
      expect(texts.some((t) => t.includes("real executed content"))).toBe(true);
      // ② aborted 收据在场（additive 字段 machine-readable）
      const rs = receiptsIn(ws);
      expect(rs.length).toBeGreaterThanOrEqual(1);
      const last = rs.at(-1) as { text: string; aborted?: boolean };
      expect(last.aborted).toBe(true);
      expect(last.text).toContain("异常中断");
    } finally {
      await stub.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 45_000);
});
