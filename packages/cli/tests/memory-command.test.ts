// M-Memory 弧第二半 — /memory 命令面确定性钉：新动词（search/save/forget/
// list/refresh/on/off）解析与行为 + 旧动词回落（undefined 信号）+ 会话终了
// 沉淀的保守提炼规则（宁缺勿滥——错误记忆比无记忆更糟）。
// 夹具只写 mkdtemp(os.tmpdir())；全局设置写 WUDAO_GLOBAL_HOME 指向的 tmpdir。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore as openM49Store } from "../src/memory/store.js";
import {
  runLongtermMemoryVerb,
  extractLessonCandidates,
  longtermMemoryEnabledFromNode,
  openLongtermMemoryStore,
  createLongtermMemoryRuntime,
  LTS_MEMORY_CAPTURE_MAX_PER_SESSION,
} from "../src/longterm-memory.js";
import { globalSettingsPath } from "../src/settings-layer.js";

let ws: string;
let globalHome: string;
let savedEnv: string | undefined;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "wudao-lts-cmd-"));
  globalHome = await mkdtemp(join(tmpdir(), "wudao-lts-cmd-global-"));
  // 隔离全局设置（runtime 的 layered 读取与 on/off 写入共用此家）。
  savedEnv = process.env.WUDAO_GLOBAL_HOME;
  process.env.WUDAO_GLOBAL_HOME = globalHome;
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedEnv;
  await rm(ws, { recursive: true, force: true });
  await rm(globalHome, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({ ...process.env, WUDAO_GLOBAL_HOME: globalHome });

describe("/memory 动词解析与行为", () => {
  it("save <kind> <text>：合法保存；非法 kind / 缺 text → 用法行", async () => {
    const ok = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "save lesson 先跑测试再提交", env: env() });
    expect(ok).toContain("已存入长期记忆");
    const badKind = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "save diary 某文本", env: env() });
    expect(badKind).toMatch(/用法：\/memory save <kind> <text>/);
    const noText = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "save fact", env: env() });
    expect(noText).toMatch(/用法：\/memory save <kind> <text>/);
  });

  it("search <q>：命中渲染；无命中诚实行；缺参用法行", async () => {
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "构建命令是 pnpm build" });
    const hit = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "search 构建命令", env: env() });
    expect(hit).toContain("pnpm build");
    const miss = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "search qqqzzz", env: env() });
    expect(miss).toMatch(/没有匹配/);
    const none = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "search", env: env() });
    expect(none).toMatch(/用法：\/memory search <query>/);
  });

  it("forget <id>：遗忘成功；未知 id → ⚠️；缺参用法行（永不 throw）", async () => {
    const store = openLongtermMemoryStore(ws);
    const entry = await store.save({ kind: "fact", text: "临时事实" });
    const ok = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: `forget ${entry.id}`, env: env() });
    expect(ok).toContain("已遗忘");
    // per-handle 索引：断言走新句柄（读文件——tombstone 行生效）
    expect(openLongtermMemoryStore(ws).list()).toHaveLength(0);
    const miss = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "forget nope", env: env() });
    expect(miss).toMatch(/⚠️/);
    const none = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "forget", env: env() });
    expect(none).toMatch(/用法：\/memory forget <id>/);
  });

  it("list：合并渲染长期记忆与旧 M49 两段", async () => {
    const lts = openLongtermMemoryStore(ws);
    await lts.save({ kind: "preference", text: "长期记忆偏好条目" });
    const m49 = openM49Store(ws);
    await m49.write({ kind: "fact", content: "旧系统事实条目", scope: "project" });
    const out = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "list", env: env() });
    expect(out).toContain("长期记忆（M-Memory");
    expect(out).toContain("长期记忆偏好条目");
    expect(out).toContain("旧记忆系统（M49");
    expect(out).toContain("旧系统事实条目");
  });

  it("旧动词（del/ok/edit/dream）与裸 /memory → undefined（回落 M49 面）；未知词 → 合并用法行", async () => {
    for (const legacy of ["del abc", "ok abc", "edit", "dream", ""]) {
      const r = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: legacy, env: env() });
      expect(r, `verb="${legacy}" 应回落 M49`).toBeUndefined();
    }
    const unknown = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "teleport now", env: env() });
    expect(unknown).toMatch(/用法：\/memory \[list\|search/);
  });

  it("on/off：写全局设置 memory.enabled（tmpdir WUDAO_GLOBAL_HOME；下会话生效回执）", async () => {
    const off = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "off", env: env() });
    expect(off).toContain("已关闭");
    const raw = JSON.parse(await readFile(globalSettingsPath(env()), "utf8")) as { memory?: { enabled?: boolean } };
    expect(raw.memory?.enabled).toBe(false);
    const on = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "on", env: env() });
    expect(on).toContain("已开启");
    const raw2 = JSON.parse(await readFile(globalSettingsPath(env()), "utf8")) as { memory?: { enabled?: boolean } };
    expect(raw2.memory?.enabled).toBe(true);
    // 开关读取容忍：junk 节点读缺省（on），布尔读值
    expect(longtermMemoryEnabledFromNode(undefined)).toBe(true);
    expect(longtermMemoryEnabledFromNode({ enabled: false })).toBe(false);
    expect(longtermMemoryEnabledFromNode({ enabled: "yes" })).toBe(true);
    expect(longtermMemoryEnabledFromNode("junk")).toBe(true);
  });

  it("refresh：无 runtime → 用法行；有 runtime → 重算回执", async () => {
    const noRt = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "refresh", env: env() });
    expect(noRt).toMatch(/未装配/);
    const store = openLongtermMemoryStore(ws);
    await store.save({ kind: "fact", text: "refresh 回执事实" });
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    const r = await runLongtermMemoryVerb({ workspaceRoot: ws, verbArgs: "refresh", runtime: rt, env: env() });
    expect(r).toContain("长期记忆注入块已重算");
  });
});

describe("会话终了沉淀 — 保守提炼规则（精确行为钉）", () => {
  it("祈使式标记：去引导词后余文即 lesson（逐字，不重写）", () => {
    expect(extractLessonCandidates(["别再跳过测试直接提交"])).toEqual(["跳过测试直接提交"]);
    expect(extractLessonCandidates(["记住：这个项目用 pnpm 不是 npm"])).toEqual(["这个项目用 pnpm 不是 npm"]);
    expect(extractLessonCandidates(["以后记得先看 CONTRIBUTING"])).toEqual(["先看 CONTRIBUTING"]);
    expect(extractLessonCandidates(["不要再把密钥写进代码"])).toEqual(["把密钥写进代码"]);
  });

  it("纠错式标记：门槛更高（≥8 字）；「不对，应该是 X」→ lesson=X", () => {
    expect(extractLessonCandidates(["不对，应该是先跑聚焦测试再全量"])).toEqual(["应该是先跑聚焦测试再全量"]);
    expect(extractLessonCandidates(["不对，是左边的那个"])).toEqual([]); // 7 字 < 8：缺上下文，宁缺勿滥
    expect(extractLessonCandidates(["不对"])).toEqual([]); // 无余文
  });

  it("拒收面：疑问句 / 多行长文 / 过长 / [合成] / / 命令 / 太短", () => {
    expect(extractLessonCandidates(["别再这样做对吗？"])).toEqual([]);
    expect(extractLessonCandidates(["别再这样做\n第二段话"])).toEqual([]);
    expect(extractLessonCandidates([`记住：${"长".repeat(130)}`])).toEqual([]);
    expect(extractLessonCandidates(["[context rule] 别再忽略上下文规则"])).toEqual([]);
    expect(extractLessonCandidates(["/memory save lesson x"])).toEqual([]);
    expect(extractLessonCandidates(["记住：嗯"])).toEqual([]); // 1 字 < 6
  });

  it("批量纪律：批内去重 + 每会话帽（取最早的纠正）", () => {
    const texts = [
      "别再直接改 dist", // 最早的纠正 → 取
      "别再直接改 dist", // 重复 → 去重
      "不对，应该是先跑聚焦测试再全量", // 第二条 → 取（帽=2）
      "以后不要在没有评审的情况下合主干", // 超帽 → 弃
    ];
    expect(extractLessonCandidates(texts)).toEqual(["直接改 dist", "应该是先跑聚焦测试再全量"]);
    expect(LTS_MEMORY_CAPTURE_MAX_PER_SESSION).toBe(2);
  });

  it("captureAtSessionEnd：静默 save（kind=lesson、sourceSession、tags 含 auto）；批内只取前 2", async () => {
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws });
    await rt.captureAtSessionEnd({
      sessionId: "sess-cap-1",
      messages: [
        { role: "assistant", content: "assistant 不参与提炼" },
        { role: "user", content: "别再跳过 lint" },
        { role: "user", content: "记住：提交前跑聚焦测试" },
        { role: "user", content: "以后别在白天跑全量测试" }, // 超帽
        { role: "user", content: "普通消息不构成教训" },
      ],
    });
    const list = rt.store.list();
    expect(list).toHaveLength(2);
    for (const e of list) {
      expect(e.kind).toBe("lesson");
      expect(e.sourceSession).toBe("sess-cap-1");
      expect(e.tags).toContain("auto");
    }
    expect(list.map((e) => e.text)).toEqual(["跳过 lint", "提交前跑聚焦测试"]);
  });

  it("enabled=false 的 capture：零写入、resolve 正常（沉淀绝不冒泡纪律）", async () => {
    const rt = await createLongtermMemoryRuntime({ workspaceRoot: ws, enabled: false });
    await expect(rt.captureAtSessionEnd({ sessionId: "s", messages: [{ role: "user", content: "别再 x" }] })).resolves.toBeUndefined();
    expect(rt.store.list()).toHaveLength(0);
    expect(rt.block()).toBe("");
  });
});
