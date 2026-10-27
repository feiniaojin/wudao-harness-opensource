// ω99-176 — 候选池收口杂族中文化：源接线钉（readFileSync 直读源，
// 166/170 系范式）。三组：A inbound relaxation×2（peer/inbound.ts，173 域
// 补刀）/ B resume 工具行 + 事件臂孪生×3（tui/resume.ts + index.ts +
// repl.ts，#5/#6 headless/REPL 双车道值逐字节一致）/ C tui-visual 夹具
// 归一（:94/:95 自包含渲染输入 + 期望帧）。
// 负钉落笔前已 grep 注释层 + 活码层复核：裸 `loop-safety challenger`
// 命中域外注释层（index.ts:2083 / repl.ts:1909 ω-4b 注释——brief §四域界
// 披露明示只译 stdout 臂不触注释），按 brief §三预案收窄为
// `↳ loop-safety challenger` stdout 形窄负钉，此处披露；其余负钉
// （`is a relaxation`/`set it in the global tier`/`tools: ${`/`↳ Loaded`/
// `resumed abc12345`）注释层零命中，按 brief 原形落笔。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const inboundSrc = readFileSync(new URL("../src/peer/inbound.ts", import.meta.url), "utf8") as string;
const resumeSrc = readFileSync(new URL("../src/tui/resume.ts", import.meta.url), "utf8") as string;
const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8") as string;
const replSrc = readFileSync(new URL("../src/repl.ts", import.meta.url), "utf8") as string;
const visualSrc = readFileSync(new URL("./tui-visual.test.tsx", import.meta.url), "utf8") as string;

/** #5/#6 孪生全形（码元级）：headless 与 REPL 两车道必须逐字节一致。 */
const challengerLine = '\\x1b[2m↳ 循环安全挑战者：${event.outcome}${tail !== "" ? ` —— ${truncate(tail, 80)}` : ""}\\x1b[0m\\n';

describe("ω99-176 A — inbound relaxation 两面中文化（173 域补刀）", () => {
  it("项目层/本地层 accept 放宽警告为中文（两条全形正钉；路径字面/配置形/枚举值原样）", () => {
    expect(inboundSrc).toContain('⚠️ .wudao/settings.json 的 peerInbound:"accept" 是放宽——请在全局层设置（项目层只能 refuse/hold）');
    expect(inboundSrc).toContain('⚠️ .wudao/settings.local.json 的 peerInbound:"accept" 是放宽——请在全局层设置（本地层只能 refuse/hold）');
  });

  it("旧英文警告归零（负钉）", () => {
    expect(inboundSrc).not.toContain("is a relaxation");
    expect(inboundSrc).not.toContain("set it in the global tier");
  });
});

describe("ω99-176 B — resume 工具行 + 事件臂孪生中文化", () => {
  it("resume 工具行计数为中文词表「N 个工具」（码元形正钉）", () => {
    expect(resumeSrc).toContain("${calls.length} 个工具：");
  });

  it("headless 车道：规则已加载 + 循环安全挑战者回执为中文（正钉；ANSI 码原样）", () => {
    expect(indexSrc).toContain("↳ 规则已加载：${event.source}");
    expect(indexSrc).toContain("↳ 循环安全挑战者：${event.outcome}");
    expect(indexSrc).toContain('\\x1b[2m↳ 规则已加载：${event.source}\\x1b[0m\\n');
    expect(indexSrc).toContain(challengerLine);
  });

  it("REPL 车道孪生：循环安全挑战者回执与 headless 逐字节一致（正钉）", () => {
    expect(replSrc).toContain("↳ 循环安全挑战者：${event.outcome}");
    expect(replSrc).toContain(challengerLine);
  });

  it("旧英文回执归零（负钉；裸 loop-safety challenger 命中 :2083/:1909 注释层，收窄为 ↳ stdout 形并披露）", () => {
    expect(resumeSrc).not.toContain("tools: ${");
    expect(indexSrc).not.toContain("↳ Loaded");
    expect(indexSrc).not.toContain("↳ loop-safety challenger");
    expect(replSrc).not.toContain("↳ loop-safety challenger");
  });
});

describe("ω99-176 C — tui-visual 夹具归一（divider 词表「已恢复 … 条消息」）", () => {
  it("夹具渲染输入与期望帧均为中文（正钉；── 边框字面保留）", () => {
    expect(visualSrc).toContain('text: "已恢复 abc12345 · 3 条消息"');
    expect(visualSrc).toContain("── 已恢复 abc12345 · 3 条消息 ──");
  });

  it("旧英文夹具归零（负钉）", () => {
    expect(visualSrc).not.toContain("resumed abc12345");
  });
});
