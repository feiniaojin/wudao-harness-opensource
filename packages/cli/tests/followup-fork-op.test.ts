// 小精灵会话弧（会话体验：基于会话追问）—— withSettingsOps.forkSession 钉件：
// resume 的 fork 形（PROTOCOL "resume" 携 fork:true）的驱动面。三段合一验：
// busy 拒（主车道换血不能打断运行中的回合）/ 源不存在拒 not_found / ok 路
// 径=字节复制源会话到全新 id + resume 副本（forkSessionFile 复用——其字节
// 保真与 rewind lineage 继承已由 m58-fork-session/fork-history-lineage 钉，
// 这里只钉 wrapper 的回执联合与调用形状）。夹具只写 tmpdir（红线：开发/
// 测试禁碰用户文件）。driver 是结构化最小 stub——forkSession 只触
// getStatus/resume 两个面，无需真 driver。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSettingsOps } from "../src/driver/settings-ops.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wudao-forkop-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** 写一个最小会话 JSONL（role 交替的真消息行），返回源文件路径。 */
const seedSession = (id: string, lines = 2): string => {
  const dir = join(root, ".wudao", "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(
    file,
    `${Array.from({ length: lines }, (_, i) => JSON.stringify({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` })).join("\n")}\n`,
  );
  return file;
};

const stubDriver = (over: {
  busy?: boolean;
  resume?: (id: string) => Promise<unknown>;
}): AgentDriver =>
  ({
    getStatus: () => ({ busy: over.busy ?? false }),
    resume: over.resume ?? (async () => ({ ok: true })),
  }) as unknown as AgentDriver;

const portOf = (d: AgentDriver) => withSettingsOps(d, { workspaceRoot: root });

describe("小精灵会话弧 — withSettingsOps.forkSession（resume 的 fork 形驱动面）", () => {
  it("ok 路径：复制到全新 id + resume 副本；回执 {ok:true,forkedId}；源文件字节不动", async () => {
    const src = seedSession("src00001", 4);
    const before = readFileSync(src, "utf8");
    const resumed: string[] = [];
    const port = portOf(stubDriver({ resume: async (id) => { resumed.push(id); return { ok: true }; } }));
    const out = (await port.forkSession!("src00001")) as { ok: boolean; forkedId?: string };
    expect(out.ok).toBe(true);
    expect(out.forkedId).toBeDefined();
    expect(out.forkedId).not.toBe("src00001"); // 全新 id（原会话不被接着写）
    expect(resumed).toEqual([out.forkedId]); // resume 的是副本，不是源
    expect(existsSync(join(root, ".wudao", "sessions", `${out.forkedId}.jsonl`))).toBe(true);
    expect(readFileSync(src, "utf8")).toBe(before); // 源字节不动
    expect(readFileSync(join(root, ".wudao", "sessions", `${out.forkedId}.jsonl`), "utf8")).toBe(before); // 字节复制
  });

  it("busy 拒：主车道运行中不换血（回执 {ok:false,reason:'busy'}，零文件产生）", async () => {
    const port = portOf(stubDriver({ busy: true }));
    const out = (await port.forkSession!("src00002")) as { ok: boolean; reason?: string };
    expect(out).toEqual({ ok: false, reason: "busy" });
    expect(existsSync(join(root, ".wudao", "sessions"))).toBe(false); // 连目录都没碰
  });

  it("not_found 拒：源会话不存在（forkSessionFile 抛错收敛为回执，不外泄异常）", async () => {
    const port = portOf(stubDriver({}));
    const out = (await port.forkSession!("no-such-id")) as { ok: boolean; reason?: string };
    expect(out).toEqual({ ok: false, reason: "not_found" });
  });

  it("occupied 透传：副本 resume 撞租约时原样回执（union 全形钉）", async () => {
    seedSession("src00003");
    const port = portOf(stubDriver({ resume: async () => ({ ok: false, reason: "occupied", holderPid: 4321 }) }));
    const out = (await port.forkSession!("src00003")) as { ok: boolean; reason?: string; holderPid?: number };
    expect(out).toEqual({ ok: false, reason: "occupied", holderPid: 4321 });
  });
});
