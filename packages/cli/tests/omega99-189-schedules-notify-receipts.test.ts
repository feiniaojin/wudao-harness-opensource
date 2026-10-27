// ω99-189 receipts — schedules notify 通道运行完成通知行（schedules.ts:364
// 一行 4 落点中文化面）的确定性验收。镜像 m61-schedules 的 daemon fixture
// 形（tmpWs + createScheduleDaemon + runTask stub），notify stub 收集行；
// 每条断言咬住面表新串的逐字形（token 裁定项原样：✅/⚠️、cron expr、ISO
// 串、workspace 路径、slice(0, 200)+\n 折平结构）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduleDaemon } from "../src/schedules.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "om189-sched-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const T0 = new Date("2026-08-17T10:00:00").getTime();
type RunResult = { ok: boolean; exitCode: number; output: string };

// One manual run (runNow) → poll the notify line. The run + notify ride the
// daemon's async void body incl. real fs I/O — a fixed nap loses the race
// under a loaded pool (m61 同款轮询手法).
const notifyLine = async (
  result: RunResult,
  schedule: { type: "cron"; expr: string } | { type: "at"; at: number },
): Promise<{ id: string; line: string }> => {
  const lines: string[] = [];
  const daemon = await createScheduleDaemon({
    workspaceRoot: ws,
    now: () => T0,
    tickMs: 0,
    env: {},
    runTask: async () => result,
    notify: (line) => {
      lines.push(line);
    },
  });
  await daemon.add({ schedule, prompt: "p", createdFrom: "test" });
  const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
  const id = stored.tasks[0].id as string;
  await daemon.runNow(id);
  const by = Date.now() + 10_000;
  while (lines.length < 1) {
    if (Date.now() > by) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  daemon.stop();
  return { id, line: lines[0] ?? "" };
};

describe("ω99-189 A — notify 行形态（cron expr / at ISO）", () => {
  it("cron 任务：✅ 计划任务 ${id}（${expr}）于 ${workspace}：前缀逐字 + output 预览在场", async () => {
    const { id, line } = await notifyLine({ ok: true, exitCode: 0, output: "构建检查通过" }, { type: "cron", expr: "*/10 * * * *" });
    expect(line).toBe(`✅ 计划任务 ${id}（*/10 * * * *）于 ${ws}：构建检查通过`);
  });

  it("at 任务：（${ISO}）在场，非（undefined）", async () => {
    const at = T0 + 5 * 60_000;
    const { id, line } = await notifyLine({ ok: true, exitCode: 0, output: "ok" }, { type: "at", at });
    const iso = new Date(at).toISOString();
    expect(line).toBe(`✅ 计划任务 ${id}（${iso}）于 ${ws}：ok`);
    expect(line).not.toContain("（undefined）");
  });
});

describe("ω99-189 B — notify 行状态（ok 首字符 / 多行折平 + 200 截断）", () => {
  it("ok=true → ✅ 首 char；ok=false → ⚠️ 首 char", async () => {
    const okLine = await notifyLine({ ok: true, exitCode: 0, output: "ok" }, { type: "cron", expr: "0 9 * * 1-5" });
    expect(okLine.line[0]).toBe("✅");
    expect(okLine.line.startsWith(`✅ 计划任务 ${okLine.id}（0 9 * * 1-5）于 ${ws}：`)).toBe(true);
    const badLine = await notifyLine({ ok: false, exitCode: 1, output: "boom" }, { type: "cron", expr: "0 9 * * 1-5" });
    expect(badLine.line.startsWith("⚠️")).toBe(true); // ⚠️ 为双 code unit（U+26A0+VS16），首字符断言用 startsWith
    expect(badLine.line.startsWith(`⚠️ 计划任务 ${badLine.id}（0 9 * * 1-5）于 ${ws}：`)).toBe(true);
  });

  it("多行 output 折平单行（\\n→空格）+ slice(0, 200) 截断亲证", async () => {
    const output = "x".repeat(150) + "\n" + "y".repeat(149); // 300 字符，\n 在第 151 位
    const { id, line } = await notifyLine({ ok: true, exitCode: 0, output }, { type: "cron", expr: "0 9 * * 1-5" });
    const preview = "x".repeat(150) + " " + "y".repeat(49); // slice(0,200) 后折平
    expect(line).not.toContain("\n"); // 折平后整行单行
    expect(line).toBe(`✅ 计划任务 ${id}（0 9 * * 1-5）于 ${ws}：${preview}`);
    expect(line).not.toContain("y".repeat(50)); // 第 201 位起被截断
  });
});
