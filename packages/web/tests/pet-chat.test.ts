// ω99-201 — 宠物窗本地 transcript 纯模块（pet-chat.ts）receipts，先红后绿。
// transcript 是宠物窗本地态（服务器协议零改——answerTail 自 ω99-272 起携带
// 全文）：pushTurn 记宠物源的轮（ω99-272 起无轮数帽、live 只挂新末位），
// applyFrame 把状态帧按规则序①②③归账进活格，digest 把问题压成 ≤24 字摘
// 要（Array.from 码点计字——CJK 不按 UTF-16 半个算）。纯模块零 DOM 零
// React 零 import，同 busy-narration 的边界。
import { describe, expect, it } from "vitest";
import { applyFrame, digest, emptyPetChat, pushTurn } from "../src/pet/pet-chat.js";

describe("ω99-201 pushTurn（宠物源轮入账）", () => {
  it("空 chat 推一轮：{q,a:\"\",live:true}——live 只挂新末位", () => {
    const c = pushTurn(emptyPetChat, "帮我查天气");
    expect(c.turns).toEqual([{ q: "帮我查天气", a: "", live: true }]);
  });

  it("live 唯一性：再推一轮，旧末位冻结（live=false，q/a 不动）", () => {
    const c1 = pushTurn(emptyPetChat, "第一问");
    const c2 = pushTurn(c1, "第二问");
    expect(c2.turns[0]).toEqual({ q: "第一问", a: "", live: false });
    expect(c2.turns[1]?.live).toBe(true);
  });

  it("ω99-272: #7 — 无限：轮数不设帽（60 轮全保，最旧不被逐——本地转写无限，滚动区承接）", () => {
    let c = emptyPetChat;
    for (let i = 0; i < 60; i += 1) c = pushTurn(c, `第${i}问`);
    expect(c.turns).toHaveLength(60);
    expect(c.turns[0]?.q).toBe("第0问"); // 最旧仍在
    expect(c.turns[59]?.live).toBe(true); // live 唯一性不受影响
  });

  it("空 q 合法（主窗轮兜底格同形——q 可为空串）", () => {
    const c = pushTurn(emptyPetChat, "");
    expect(c.turns).toEqual([{ q: "", a: "", live: true }]);
  });
});

describe("ω99-201 applyFrame（帧归账规则①②③）", () => {
  it("规则①：turns 空 && tail≠\"\" → 建 {q:\"\",a:tail,live:true}（主窗轮兜底建格）", () => {
    const c = applyFrame(emptyPetChat, { busy: true, answerTail: "主窗的回答" });
    expect(c.turns).toEqual([{ q: "", a: "主窗的回答", live: true }]);
  });

  it("规则②-a：末位 live && tail≠\"\" → 填 a（流式尾窗续写活格，live 不动）", () => {
    const c0 = pushTurn(emptyPetChat, "问句");
    const c1 = applyFrame(c0, { busy: true, answerTail: "回答开头" });
    expect(c1.turns[0]?.a).toBe("回答开头");
    expect(c1.turns[0]?.live).toBe(true);
    const c2 = applyFrame(c1, { busy: true, answerTail: "回答开头变长" });
    expect(c2.turns[0]?.a).toBe("回答开头变长");
  });

  it("规则②-b：末位 live && tail==\"\" && !busy → 冻结（live=false，a 保最后非空值）", () => {
    const c0 = applyFrame(pushTurn(emptyPetChat, "问句"), { busy: true, answerTail: "最终回答" });
    const c = applyFrame(c0, { busy: false, answerTail: "" });
    expect(c.turns[0]).toEqual({ q: "问句", a: "最终回答", live: false });
  });

  it("规则②-c：末位 live && tail==\"\" && busy → 不变（推理期空尾不是结束）", () => {
    const c0 = pushTurn(emptyPetChat, "问句");
    const c = applyFrame(c0, { busy: true, answerTail: "" });
    expect(c.turns).toEqual(c0.turns);
  });

  it("规则③：末位 !live && tail≠\"\" → 新一轮自他处开始（push {q:\"\",live:true}）", () => {
    const live = applyFrame(pushTurn(emptyPetChat, "问一"), { busy: true, answerTail: "答一" });
    const frozen = applyFrame(live, { busy: false, answerTail: "" });
    const c = applyFrame(frozen, { busy: true, answerTail: "新轮的回答" });
    expect(c.turns.length).toBe(2);
    expect(c.turns[1]).toEqual({ q: "", a: "新轮的回答", live: true });
  });

  it("全空帧（!busy、tail==\"\"、turns 空）→ 不建格（无轮可归）", () => {
    const c = applyFrame(emptyPetChat, { busy: false, answerTail: "" });
    expect(c.turns).toEqual([]);
  });
});

describe("ω99-201 digest（问题摘要 ≤24 字）", () => {
  it("短串原样（≤24 字不加省略号）", () => {
    expect(digest("短问题")).toBe("短问题");
    expect(digest("a".repeat(24))).toBe("a".repeat(24));
  });

  it("ASCII 超 24 字截 24 + …", () => {
    expect(digest("a".repeat(30))).toBe(`${"a".repeat(24)}…`);
  });

  it("CJK 按字计（Array.from 码点）：25 个汉字 → 24 字 + …", () => {
    expect(digest("汉".repeat(25))).toBe(`${"汉".repeat(24)}…`);
  });
});
