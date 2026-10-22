// ω99-323 — 软警告接线轻钉（320 c1 兑现）。纯源 census：读源文件、数接线
// 字面，零运行时、零 src 侵入——钉的是现状，现状是 320 已收货的正确接线。
//
// 为什么需要它：320 把软警告 slot（createSoftWarnSlot() → {forward,
// setListener}）铺进四个 createProvider 构造缝（engine boot/switch ×2 + TUI
// useMemo/persona 切换 ×2）+ use-agent 转发 + driver options 两处携带。行为面
// 12 钉全绿，但接线存在性本身无自动化钉——接线是声明式 spread
// （...streamIdleOpts, onStreamIdleWarning: softWarnSlot.forward），未来重构
// （构造点挪位/字段改名/slot 忘传）会让软警告 UI 静默掉线回 no-op：
//   · 类型系统不红——spread 是加性的，少一个 key 只是「没传」；
//   · 320 的行为回归不红——回调 no-op 本来就是 315 时代的合法态。
// 掉线从「用户报障才发现」变「CI 红」——本文件就是那道门。
//
// census 门族先例复用（a11y-names / ω99-305 / ω99-312 同构）：计数断言 +
// 「文件确实读到了」哨兵 + 纯 node 读源三件套，零新范式。路径解析走
// process.cwd() 相对（306 教训：jsdom pragma 下 import.meta.url 是桩路径；
// 本文件无 pragma 仍用 cwd 防移植陷阱——vitest 从 packages/cli 起跑，源路径
// 形如 src/driver/session-engine.ts，312 census 同款解析）。
//
// use-agent 的实际转发是整对象传递（实现者亲读定位，非字段级
// softWarnSlot: opts.softWarnSlot）：UseAgentOptions 声明字段（:76），hook 里
// createAgentDriver(opts)（:285）+ driver.setOptions(opts)（:291）把 opts 整
// 个交给 driver——正钉就是这三处字面。若未来重构成字段级构造而漏掉
// softWarnSlot，createAgentDriver(opts) 字面消失 → 红 → 人来裁定「接线仍在
// → 演进钉」（m81 先例）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** process.cwd() = packages/cli（vitest 从包根起跑——312 census 同款解析）。 */
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

/** 子串出现次数（split 计数——同一行多次出现也计全，比逐行 grep 更严）。 */
const count = (src: string, needle: string): number => src.split(needle).length - 1;

describe("ω99-323 — 软警告接线 census（源钉）", () => {
  it("session-engine.ts：两个 provider 构造缝都携带 onStreamIdleWarning: softWarnSlot.forward（恰好 2 处）", () => {
    const src = read("src/driver/session-engine.ts") + "\n" + read("src/driver/session-engine-switch.ts"); // 拆分B 钉随迁：provider-switch 构造缝迁 session-engine-switch.ts（boot 缝留主件——两缝合计仍恰好 2 处）
    // 哨兵：文件真的读到了（防路径错读的静默过——:447 的 slot 创建字面是
    // 该文件的已知常量；读空/读错路径时它先红）。
    expect(src).toContain("const softWarnSlot = createSoftWarnSlot();");
    // boot 缝（主件）+ provider-switch 缝（switch 件）各一处；挪位/漏传即刻红。
    expect(count(src, "onStreamIdleWarning: softWarnSlot.forward")).toBe(2);
  });

  it("session-engine.ts：driver options 携带 slot（shorthand 至少 1 处）", () => {
    const src = read("src/driver/session-engine.ts");
    expect(src).toContain("const softWarnSlot = createSoftWarnSlot();");
    // :995 的 options 对象 shorthand——driver 侧 listener 武装依赖它。
    expect(count(src, "softWarnSlot,")).toBeGreaterThanOrEqual(1);
  });

  it("app.tsx：两个模型构造缝都携带 onStreamIdleWarning: softWarnSlotRef.current.forward（恰好 2 处）", () => {
    // 拆分运动 C 钉随迁：模型构造簇迁 app-model.ts（两缝同文件保持恰好 2 处）。
    const src = read("src/tui/app-model.ts");
    // 哨兵：:853 的 slot ref 创建字面。
    expect(src).toContain("const softWarnSlotRef = useRef(createSoftWarnSlot());");
    // resolveModel useMemo（:859）+ persona 切换（:971）各一处。
    expect(count(src, "onStreamIdleWarning: softWarnSlotRef.current.forward")).toBe(2);
  });

  it("app.tsx：driver options 携带 softWarnSlot: softWarnSlotRef.current（至少 1 处）", () => {
    // 拆分运动 C 钉随迁：声明钉读 app-model.ts（宿主），driver options 钉读 app-agent-opts.ts（消费点）。
    expect(read("src/tui/app-model.ts")).toContain("const softWarnSlotRef = useRef(createSoftWarnSlot());");
    const src = read("src/tui/app-agent-opts.ts");
    // :1534 的 useAgent opts——App → driver 的那条线。
    expect(count(src, "softWarnSlot: softWarnSlotRef.current")).toBeGreaterThanOrEqual(1);
  });

  it("use-agent.ts：声明 softWarnSlot 字段，hook 以整对象转发（createAgentDriver(opts) + driver.setOptions(opts)）", () => {
    const src = read("src/tui/use-agent.ts");
    // 哨兵：该文件不 import createSoftWarnSlot，用已知 driver import 证明
    // 读到了真身（防路径错读）。
    expect(src).toContain('from "../driver/agent-driver.js"');
    // 接口字段（:76）——App 传进来的钥匙；类型层缺它整条链都编译红，
    // 这里钉的是「字段名没被改」。
    expect(src).toContain('softWarnSlot?: AgentDriverOptions["softWarnSlot"];');
    // 实际转发表达式（亲读定位）：opts 整个交给 driver，字段级转发不存在——
    // 重构成字段级构造时这两个字面消失 → 红 → 人裁定后演进钉。
    expect(src).toContain("createAgentDriver(opts)");
    expect(src).toContain("driver.setOptions(opts)");
  });
});
