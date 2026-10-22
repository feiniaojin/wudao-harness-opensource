// ω99-36 — mission 台账生命周期存储（campaign-two evidence: 12× mission_start
// whole-file overwrite left ONE ledger; a t5 mission /clear-ed 36s after
// creation dangles as active with tasks/ratchet/notes all empty). Two faces,
// one storage spine:
//   T2 归档制 — .wudao/missions/<missionId>.json per-mission archives (the
//      archaeology layer: "这工作区干过哪些战役" survives any number of
//      mission_starts) + .wudao/mission.json as the SMALL active pointer
//      (version 2: missionId + summary — it points, it never carries history);
//      legacy version-1 files (the whole mission inline) load in place, and a
//      displaced v1 mission is backfilled into its archive before the pointer
//      flip would orphan its bytes.
//   T3 边界结算 — the session-end/rotation seams settle an active ALL-EMPTY
//      mission to the terminal status "stale" (空壳悬空终态); a non-empty
//      active mission is NEVER settled (跨会话续作 is the feature). The
//      normal complete/abandon terminal snapshots keep their exact shape.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMissionController,
  loadMissionStore,
  MISSION_STORE_FILE,
  type MissionState,
} from "../src/mission.js";

let ws: string;
beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), "o9936-mission-")));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const stubGate = async () => ({ code: 0, output: "" });

/** A controller over the REAL tmpdir store (no injected store handle — the
 *  disk layout under test IS the subject). */
const fresh = async (notices: string[] = []) =>
  createMissionController({ workspaceRoot: ws, notify: (t) => notices.push(t), runGateCommand: stubGate });

const missionsDir = () => join(ws, ".wudao", "missions");
const archiveOf = (id: string): string => join(missionsDir(), `${id}.json`);
const readJson = async (p: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;

const legacyFile = (m: Partial<MissionState> & Pick<MissionState, "id" | "objective" | "status">): string =>
  JSON.stringify({ version: 1, mission: { createdAt: "2026-01-01T00:00:00.000Z", tasks: [], ...m } });

describe("ω99-36 T1/T2 — per-mission archives + active pointer (覆写 churn)", () => {
  it("红例① 两次 mission_start 后：两个 per-mission 文件皆在、首个完整可读，指针指向第二个", async () => {
    const c = await fresh();
    await c.start("战役一目标");
    const id1 = c.snapshot()!.id;
    await c.plan([{ title: "首个任务", detail: "细节留档" }]);
    await c.abandon();
    await c.start("战役二目标");
    const id2 = c.snapshot()!.id;
    expect(id1).not.toBe(id2);

    // RED pre-fix: no missions/ dir exists — the first campaign's bytes died
    // in the whole-file overwrite.
    expect(existsSync(archiveOf(id1))).toBe(true);
    expect(existsSync(archiveOf(id2))).toBe(true);
    const a1 = (await readJson(archiveOf(id1))) as { version: number; mission: MissionState };
    expect(a1.version).toBe(1);
    expect(a1.mission.id).toBe(id1);
    expect(a1.mission.objective).toBe("战役一目标");
    expect(a1.mission.status).toBe("abandoned");
    expect(a1.mission.endCause).toBe("user-abort"); // v7 γ2：abandoned 留终态成因（用户/模型 deliberate 放弃）
    expect(a1.mission.tasks[0]?.title).toBe("首个任务"); // 内容完整，非摘要
    expect(a1.mission.tasks[0]?.detail).toBe("细节留档");

    // The pointer file is the SMALL v2 pointer: it names the (second) mission
    // file — it carries no ledger bytes of its own.
    const pointer = await readJson(join(ws, ".wudao", MISSION_STORE_FILE));
    expect(pointer.version).toBe(2);
    expect(pointer.missionId).toBe(id2);
    expect(JSON.stringify(pointer)).not.toContain("战役一目标"); // 只指路不载史
  });

  it("读侧经指针：新 controller 恢复的是指针目标文件（resume 走归档）", async () => {
    const c = await fresh();
    await c.start("跨会话战役");
    await c.plan([{ title: "t" }, { title: "u" }]);
    await c.nextReady();
    const c2 = await fresh();
    const snap = c2.snapshot();
    expect(snap?.objective).toBe("跨会话战役");
    expect(snap?.tasks.map((t) => t.status)).toEqual(["todo", "todo"]); // doing→todo honest redo
  });

  it("旧 mission.json 兼容读入；被顶替时旧战役归档回填（迁移零丢失）", async () => {
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await writeFile(join(ws, ".wudao", MISSION_STORE_FILE), legacyFile({ id: "mlegacy", objective: "旧格式战役", status: "active", tasks: [{ id: "t1", title: "旧任务", dependsOn: [], status: "done", attempts: 0 }] }), "utf8");
    // 旧格式原地读入（非破坏迁移：文件未被改写）。
    const c1 = await fresh();
    expect(c1.snapshot()?.objective).toBe("旧格式战役");
    expect(await readFile(join(ws, ".wudao", MISSION_STORE_FILE), "utf8")).toContain("旧格式战役");
    // 顶替：abandon → 新战役 → 指针翻成 v2。v1 的唯一载体是旧 mission.json，
    // 指针翻页前必须先把它的字节落进归档（否则考古层永远少第一战役）。
    await c1.abandon();
    await c1.start("新格式战役");
    expect(existsSync(archiveOf("mlegacy"))).toBe(true);
    const a = (await readJson(archiveOf("mlegacy"))) as { mission: MissionState };
    expect(a.mission.objective).toBe("旧格式战役");
    expect(a.mission.tasks[0]?.title).toBe("旧任务");
    const pointer = await readJson(join(ws, ".wudao", MISSION_STORE_FILE));
    expect(pointer.version).toBe(2);
    expect(pointer.missionId).toBe(c1.snapshot()!.id);
  });

  it("fail-closed 新面：v2 指针指向缺失/危险/符号链接归档 → loadMissionStore 拒绝（不静默重建）", async () => {
    await mkdir(missionsDir(), { recursive: true });
    // 缺失归档。
    await writeFile(join(ws, ".wudao", MISSION_STORE_FILE), JSON.stringify({ version: 2, missionId: "mmissing", summary: null }), "utf8");
    await expect(loadMissionStore({ workspaceRoot: ws })).rejects.toThrow(/corrupt/);
    // 危险 id（路径穿越）— the pointer is machine-written; anything else is tampering.
    await writeFile(join(ws, ".wudao", MISSION_STORE_FILE), JSON.stringify({ version: 2, missionId: "../evil", summary: null }), "utf8");
    await expect(loadMissionStore({ workspaceRoot: ws })).rejects.toThrow(/corrupt/);
    // 指针指向符号链接归档 — the symlink red line extends to the archive face.
    await writeFile(join(ws, ".wudao", MISSION_STORE_FILE), JSON.stringify({ version: 2, missionId: "mlink", summary: null }), "utf8");
    await writeFile(join(ws, "outside.json"), JSON.stringify({ version: 1, mission: null }), "utf8");
    await symlink(join(ws, "outside.json"), archiveOf("mlink"));
    await expect(loadMissionStore({ workspaceRoot: ws })).rejects.toThrow(/symlink/);
  });
});
describe("ω99-36 T3 — 会话边界结算（stale-active 悬空）", () => {
  it("红例② 空壳 active mission 在边界结算落 stale 终态（盘上不再悬空）", async () => {
    const notices: string[] = [];
    const c = await fresh(notices);
    await c.start("悬空目标");
    const id = c.snapshot()!.id;
    // 现状钉：结算前盘上是 active 空壳（campaign-two 的 t5 形态）。
    const before = await loadMissionStore({ workspaceRoot: ws });
    expect(before.mission?.status).toBe("active");

    const receipt = await c.settleAtSessionBoundary();
    expect(receipt).toContain("结算");
    expect(c.snapshot()?.status).toBe("stale");
    expect(notices.join("\n")).toContain("结算");
    // 落盘：reload 后是终态，不再 active（下个前端进来不再看到悬空 doing/active）。
    const after = await loadMissionStore({ workspaceRoot: ws });
    expect(after.mission?.status).toBe("stale");
    const a = (await readJson(archiveOf(id))) as { mission: MissionState };
    expect(a.mission.status).toBe("stale"); // 终局快照在归档里
    expect(a.mission.endCause).toBe("shutdown"); // v7 γ2：stale 留终态成因（会话边界=关窗/卸载面）
  });

  it("非空 active 不被结算（mission 跨会话续作是特性，只结算空壳）", async () => {
    const c = await fresh();
    await c.start("进行中战役");
    await c.plan([{ title: "只做一半" }]);
    await c.nextReady();
    const receipt = await c.settleAtSessionBoundary();
    expect(receipt).not.toContain("结算");
    expect(c.snapshot()?.status).toBe("active");
    const reloaded = await loadMissionStore({ workspaceRoot: ws });
    expect(reloaded.mission?.status).toBe("active");
    // 恢复面照常：新 controller 把在途 doing 重置回 todo（honest redo）。
    const c2 = await fresh();
    expect(c2.snapshot()?.status).toBe("active");
    expect(c2.snapshot()?.tasks[0]?.status).toBe("todo");
  });

  it("全空的定义钉：无任务但登记过约定 → 不结算（有内容就不是空壳）", async () => {
    const c = await fresh();
    await c.start("带约定的空任务战役");
    await c.knowAdd({ kind: "decision", title: "拍板", content: "内容" });
    await c.settleAtSessionBoundary();
    expect(c.snapshot()?.status).toBe("active");
  });

  it("无 active mission / refusal 时边界结算是无害 no-op", async () => {
    const c = await fresh();
    const receipt = await c.settleAtSessionBoundary();
    expect(receipt).not.toContain("结算");
    expect(c.snapshot()).toBeUndefined();
  });

  it("正常 complete 路径的终局快照形状不变（{version:1, mission:{...completed}}）", async () => {
    const c = await fresh();
    await c.start("完整战役");
    const id = c.snapshot()!.id;
    await c.plan([{ title: "唯一任务" }]);
    await c.nextReady();
    const r = await c.complete("t1", "完成");
    expect(r.ok).toBe(true);
    const a = (await readJson(archiveOf(id))) as { version: number; mission: MissionState };
    expect(a.version).toBe(1);
    expect(a.mission.status).toBe("completed");
    expect(a.mission.tasks[0]?.result).toBe("完成");
    // 指针仍指这本台账（terminal 也指——加载语义与今日一致），summary 同步。
    const pointer = await readJson(join(ws, ".wudao", MISSION_STORE_FILE));
    expect(pointer.missionId).toBe(id);
    expect((pointer.summary as { status: string }).status).toBe("completed");
  });
});
describe("ω99-36 T3 — 边界缝接线（进程内会话结束 → 空壳结算落盘）", () => {
  // The repl seam: the fireSessionEnd funnel is the ONE in-process session-end
  // site (/exit, EOF, SIGINT and /clear all pass through it) — o99-32's
  // trimmed driveRepl harness feeds /mission + /exit through a real runRepl.
  it("repl /exit：空壳 mission 在会话结束时被结算为 stale", async () => {
    const { PassThrough } = await import("node:stream");
    const { runRepl } = await import("../src/repl.js");
    const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const enc = new TextEncoder();
    const sse = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const globalHome = await mkdtemp(join(tmpdir(), "o9936-gh-"));
    const prevHome = process.env.WUDAO_GLOBAL_HOME;
    const prevFetch = globalThis.fetch;
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    globalThis.fetch = (async () => new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    let seen = "";
    let fed = 0;
    const lines = ["/mission repl悬空目标", "/exit"];
    const pump = (): void => {
      let c = stdout.read();
      while (c !== null) { seen += c.toString(); c = stdout.read(); }
      const prompts = seen.split("wudao> ").length - 1;
      while (fed < lines.length && fed < prompts) { stdin.write(`${lines[fed]}\n`); fed += 1; }
    };
    let replError: unknown;
    let done: Promise<void> | undefined;
    try {
      done = runRepl({
        config: { apiKey: "sk-o9936", baseURL: "https://o9936.invalid/v1", model: "o9936-model" } as never,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        sessionId: "wudao-o9936repl",
        stdin,
        stdout,
      });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) { pump(); if (fed >= lines.length) break; await delay(10); }
      await Promise.race([done, delay(5_000)]);
      // fireSessionEnd 的结算是 fire-and-forget fs 写 — 轮询落盘。
      const settleDeadline = Date.now() + 5_000;
      await delay(50);
      while (Date.now() < settleDeadline) {
        pump();
        try {
          const st = await loadMissionStore({ workspaceRoot: ws });
          if (st.mission !== null && st.mission.status === "stale") break;
        } catch { /* not yet */ }
        await delay(20);
      }
      const st = await loadMissionStore({ workspaceRoot: ws });
      expect(st.mission?.status).toBe("stale"); // RED pre-fix: 仍 active（悬空）
      expect(st.mission?.objective).toBe("repl悬空目标");
      expect(seen).toContain("mission 已创建");
    } catch (err) {
      replError = err;
    } finally {
      stdin.end();
      if (done !== undefined) await Promise.race([done.then(() => {}, () => {}), delay(500)]);
      process.env.WUDAO_GLOBAL_HOME = prevHome;
      globalThis.fetch = prevFetch;
      await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
    if (replError !== undefined) throw replError;
  }, 30_000);

  it("driver close()：空壳 mission 在引擎关闭时被结算为 stale；非空保留", async () => {
    const { createDriverSession } = await import("../src/driver/session-engine.js");
    const okModel = () => ({
      async generate(input: { onUsage?: (u: unknown) => void }) {
        input.onUsage?.({ promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 });
        return { role: "assistant" as const, content: "ok" };
      },
    });
    // 空壳：start → close → stale。
    const s1 = await createDriverSession({
      config: { apiKey: "k", baseURL: "http://127.0.0.1:1/v1", model: "fake" } as never,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: okModel() as never,
      sessionId: "o9936drv-empty",
    });
    await s1.missionBox.current!.start("driver悬空目标");
    await s1.close();
    expect((await loadMissionStore({ workspaceRoot: ws })).mission?.status).toBe("stale");
    // 非空：start + plan → close → 仍 active（续作保留）。
    const s2 = await createDriverSession({
      config: { apiKey: "k", baseURL: "http://127.0.0.1:1/v1", model: "fake" } as never,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: okModel() as never,
      sessionId: "o9936drv-full",
    });
    await s2.missionBox.current!.start("driver进行中");
    await s2.missionBox.current!.plan([{ title: "任务" }]);
    await s2.close();
    expect((await loadMissionStore({ workspaceRoot: ws })).mission?.status).toBe("active");
  }, 30_000);
});
