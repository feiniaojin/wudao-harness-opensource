// ω99-166f-ii — 切换回执族中文化：五份源文件的源接线钉（24 面累积串）。
//
// model/provider/persona 切换回执族（agent-driver.ts 16 面、repl.ts 4 面、
// commands/persona.ts 2 面、commands/provider.ts 1 面、commands/model.ts 1 面）：
// 有运行时宿主的钉（m63/m58/agent-driver-persona/persona-phase-b/persona-wire-
// repl/persona-wiring 六文件 25 钉）已随源演进；无宿主可钉的面沿 ω99-166b/c/
// d/e/f 的源接线钉范式（readFileSync 定位 src 文件）钉串值本身。
// 域界：repl.ts :2762/:2785 的 /model、/effort 回执（"the next request carries
// it" 裸串仍在）归后续弧——故 repl.ts 负钉用窄子串（mismatchNote 前缀形 +
// `— the next request carries it${` 模板形），裸负钉会撞域外面（见弧报告）。
// 注：brief §3.3 的 `此 persona 未定义` 正钉被移到 agent-driver.ts/repl.ts 组
// （faces #12/#17 的 mismatch 注记在那两份文件；commands/persona.ts 无此串）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

describe("ω99-166f-ii — 切换回执族中文化源接线钉", () => {
  it("wiring pin: agent-driver.ts 切换回执为中文（正钉）", () => {
    const s = srcOf("driver/agent-driver.ts");
    expect(s).toContain("已自动命名："); // #1 auto-title 回执
    expect(s).toContain("（已在 "); // #15 already-on 回执（全角括号）
    expect(s).toContain("—— 下一个请求即生效"); // #3/#13/#14 尾段
    expect(s).toContain("此 persona 未定义"); // #12 mismatch 注记（\n 前缀保留）
  });

  it("wiring pin: agent-driver.ts 旧英文切换回执归零（负钉，窄子串避注释层）", () => {
    const s = srcOf("driver/agent-driver.ts");
    expect(s).not.toContain("auto-titled:");
    expect(s).not.toContain("(already on ");
    expect(s).not.toContain("recorded (model_change entry)");
    expect(s).not.toContain("supersedes the queued switch");
    expect(s).not.toContain("switch landed at run settle");
  });

  it("wiring pin: repl.ts provider/persona 切换回执为中文（正钉）", () => {
    const s = srcOf("repl.ts");
    expect(s).toContain("客户端已重建"); // #20 provider 客户端重建回执
    expect(s).toContain("—— 下一个请求即生效"); // #18/#19 尾段
    expect(s).toContain("此 persona 未定义"); // #17 mismatch 注记孪生
    // #15 already-on 的 repl 孪生（控制器走查补刀：brief 漏盘 :2845）。
    expect(s).toContain("（已在 ");
  });

  it("wiring pin: repl.ts 旧英文 persona 切换尾段归零（负钉，窄子串避 :2762/:2785 域外面）", () => {
    const s = srcOf("repl.ts");
    expect(s).not.toContain("note: this persona defines no"); // #17
    expect(s).not.toContain("— the next request carries it${"); // #18/#19 模板形（/model、/effort 的 `it (`/`it\n` 不匹配）
  });

  it("wiring pin: commands/persona.ts 链跟随与 persona 缓存注记为中文（正钉）", () => {
    const s = srcOf("commands/persona.ts");
    expect(s).toContain("—— 下一个请求即生效"); // #21 formatPersonaChainFollow 尾段
    expect(s).toContain("\"供应商绑定\""); // #21 via 三元码元形（注释层裸串先在，见弧报告）
    expect(s).toContain("persona 缓存断裂"); // #22 PERSONA_SWITCH_CACHE_NOTE
  });

  it("wiring pin: commands/persona.ts 旧英文链跟随尾段归零（负钉）", () => {
    const s = srcOf("commands/persona.ts");
    expect(s).not.toContain("the next request carries it"); // #21
  });

  it("wiring pin: commands/provider.ts 切供应商缓存注记为中文（正钉）", () => {
    const s = srcOf("commands/provider.ts");
    expect(s).toContain("切供应商后缓存完全变冷"); // #23 PROVIDER_SWITCH_CACHE_NOTE
  });

  it("wiring pin: commands/provider.ts 旧英文缓存注记归零（负钉）", () => {
    const s = srcOf("commands/provider.ts");
    expect(s).not.toContain("cache is FULLY cold"); // #23
  });

  it("wiring pin: commands/model.ts 切模型缓存注记为中文（正钉）", () => {
    const s = srcOf("commands/model.ts");
    expect(s).toContain("切模型后下一轮缓存变冷"); // #24 MODEL_SWITCH_CACHE_NOTE
  });

  it("wiring pin: commands/model.ts 旧英文缓存注记归零（负钉）", () => {
    const s = srcOf("commands/model.ts");
    expect(s).not.toContain("cache is cold next turn"); // #24
  });
});
