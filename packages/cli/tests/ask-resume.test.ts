// 小精灵会话弧（会话体验：选择会话、基于会话恢复或追问）—— CLI 侧钉件：
// 恢复即追问 `wudao --resume <id> --ask "问题"`（resume 后自动提交该问题作为
// 开场，one-shot 路径）。两层钉：①parseAskFlags 的拼法识别（空格形/等号形/
// 单杠容错；空格形的「值」留给自由文本提示词，不在此消费）；②
// resolveAskOpening 的组合裁决——--ask 与 --resume/--continue 组合成追问、
// 缺值（含 `--ask=` 空值）与等号形混自由文本 fail-closed、无恢复上下文时
// --ask 保持权限档位语义（permission-modes 的 modeFromArgv，零回归钉）。
import { describe, expect, it } from "vitest";
import { parseAskFlags, resolveAskOpening } from "../src/args.js";

describe("小精灵会话弧 — parseAskFlags（拼法识别）", () => {
  it("空格形/单杠形/等号形都在场识别；空格形不消费下一 token（自由文本的领地）", () => {
    expect(parseAskFlags(["--resume", "abc", "--ask", "问题"])).toEqual({ present: true });
    expect(parseAskFlags(["-resume", "abc", "-ask", "问题"])).toEqual({ present: true });
  });

  it("等号形取值（双杠/单杠）；`--ask=` 空值是显式缺值信号", () => {
    expect(parseAskFlags(["--resume", "abc", "--ask=接着问"])).toEqual({ present: true, value: "接着问" });
    expect(parseAskFlags(["-resume", "abc", "-ask=接着问"])).toEqual({ present: true, value: "接着问" });
    expect(parseAskFlags(["--resume", "abc", "--ask="])).toEqual({ present: true, emptyEquals: true });
  });

  it("无 --ask → 不在场（默认运行字节同形）", () => {
    expect(parseAskFlags(["--resume", "abc", "修个"])).toEqual({ present: false });
    expect(parseAskFlags([])).toEqual({ present: false });
  });
});

describe("小精灵会话弧 — resolveAskOpening（恢复即追问门，纯函数）", () => {
  it("组合：--resume <id> --ask <问题> → 自由文本即追问问题", () => {
    expect(resolveAskOpening(["--resume", "abc123", "--ask", "这个问题怎么继续"], "这个问题怎么继续")).toEqual({
      kind: "question",
      question: "这个问题怎么继续",
    });
  });

  it("组合：--continue --ask 多词问题原样成题（空格形不拆词）", () => {
    expect(resolveAskOpening(["--continue", "--ask", "接着", "昨晚的", "活干完"], "接着 昨晚的 活干完")).toEqual({
      kind: "question",
      question: "接着 昨晚的 活干完",
    });
  });

  it("组合：等号形 --resume <id> --ask=<问题> → 值即问题（stripLogFlags 不剥等号形，prompt 里只剩旗标 token 本身）", () => {
    expect(resolveAskOpening(["--resume", "abc", "--ask=接着问"], "--ask=接着问")).toEqual({
      kind: "question",
      question: "接着问",
    });
    expect(resolveAskOpening(["-resume", "abc", "-ask=接着问"], "-ask=接着问")).toEqual({
      kind: "question",
      question: "接着问",
    });
  });

  it("缺值 fail-closed：恢复上下文里 --ask 后无自由文本 → 拒答文案（不静默降级成交互恢复）", () => {
    const d = resolveAskOpening(["--resume", "abc", "--ask"], "");
    expect(d.kind).toBe("off");
    expect(d.error).toContain("--ask 需要问题内容");
    // --continue 同判（追问旗标配任一恢复上下文）。
    expect(resolveAskOpening(["--continue", "--ask"], "").error).toContain("--ask 需要问题内容");
    // 旗标后跟的是别的旗标而非问题 → 同样缺值（prompt 已剥旗标为空）。
    expect(resolveAskOpening(["--resume", "abc", "--ask", "--auto"], "").error).toContain("--ask 需要问题内容");
  });

  it("缺值 fail-closed：`--ask=` 空值（显式给了值形却无内容）→ 拒答", () => {
    const d = resolveAskOpening(["--resume", "abc", "--ask="], "--ask=");
    expect(d.kind).toBe("off");
    expect(d.error).toContain("--ask 需要问题内容");
  });

  it("混用 fail-closed：等号形 + 自由文本两处都给问题 → 拒答（绝不静默丢一边）", () => {
    const d = resolveAskOpening(["--resume", "abc", "--ask=甲", "乙"], "--ask=甲 乙");
    expect(d.kind).toBe("off");
    expect(d.error).toContain("不能再带自由文本");
  });

  it("无恢复上下文：--ask 保持权限档位语义（今日行为，零回归钉）", () => {
    // `wudao --ask "修个 bug"` = ask 档跑一次性任务——不是追问，门不接手。
    expect(resolveAskOpening(["--ask", "修个", "bug"], "修个 bug")).toEqual({ kind: "off" });
    expect(resolveAskOpening(["--ask"], "")).toEqual({ kind: "off" });
  });

  it("无 --ask → 门关闭且无错（默认运行字节同形）", () => {
    expect(resolveAskOpening(["--resume", "abc", "继续干"], "继续干")).toEqual({ kind: "off" });
    expect(resolveAskOpening(["--continue"], "")).toEqual({ kind: "off" });
    expect(resolveAskOpening([], "")).toEqual({ kind: "off" });
  });
});
