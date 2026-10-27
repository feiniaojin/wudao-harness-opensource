// 130-C1（cua jev-use 引进）— 稳定元素 ID + 风险档收据。
// slug 化（ASCII kebab + CJK 保留）/稳定 ID 形/风险档分类/部分重渲染
// 生存（同一元素跨两张表同 ID）/解析回 eN/行注记。
import { describe, expect, it } from "vitest";
import {
  slugifyLabel,
  elementStableId,
  riskTierOfRole,
  isStableIdRef,
  resolveStableId,
  annotateElementLine,
} from "../src/computer/element-id.js";

describe("130-C1 — slug 与稳定 ID", () => {
  it("ASCII 标题 kebab 化；CJK 标题原样保留段（中文应用的区分面）", () => {
    expect(slugifyLabel("Sign In")).toBe("sign-in");
    expect(slugifyLabel("删除选中的项目")).toBe("删除选中的项目");
    expect(slugifyLabel("")).toBe("");
    expect(slugifyLabel(`"quoted"`)).toBe("quoted");
  });

  it("稳定 ID 形：有题 `ax:role:slug`；无题 `ax:role`", () => {
    expect(elementStableId("button", "登录")).toBe("ax:button:登录");
    expect(elementStableId("textField", "用户名")).toBe("ax:textField:用户名");
    expect(elementStableId("image", "")).toBe("ax:image");
  });

  it("部分重渲染生存：同一元素在两张表里同 ID（编号挪了 ID 不挪）", () => {
    const before = new Map([["e3", { role: "button", title: "登录" }], ["e4", { role: "staticText", title: "欢迎" }]]);
    const after = new Map([["e4", { role: "button", title: "登录" }], ["e5", { role: "staticText", title: "欢迎" }]]); // 顶部插了一个
    const id = elementStableId("button", "登录");
    expect(resolveStableId(id, before)).toBe("e3");
    expect(resolveStableId(id, after)).toBe("e4"); // 编号变了，稳定 ID 解析到新编号
  });

  it("消失的元素解析 undefined（诚实——重观察出路）", () => {
    const refs = new Map([["e1", { role: "button", title: "其它" }]]);
    expect(resolveStableId("ax:button:登录", refs)).toBeUndefined();
  });
});

describe("130-C1 — 风险档", () => {
  it("输入面=medium；按钮/链接/单元格=low；未知=high", () => {
    expect(riskTierOfRole("textField")).toBe("medium");
    expect(riskTierOfRole("textarea")).toBe("medium");
    expect(riskTierOfRole("button")).toBe("low");
    expect(riskTierOfRole("link")).toBe("low");
    expect(riskTierOfRole("cell")).toBe("low");
    expect(riskTierOfRole("unknownRole42")).toBe("high");
  });
});

describe("130-C1 — ref 形与行注记", () => {
  it("isStableIdRef：ax: 前缀形", () => {
    expect(isStableIdRef("ax:button:登录")).toBe(true);
    expect(isStableIdRef("e3")).toBe(false);
    expect(isStableIdRef("ax:")).toBe(false);
    expect(isStableIdRef(42)).toBe(false);
  });

  it("行注记：[e3] button 行追加 @ax: 稳定 ID 与风险档；无匹配行原样", () => {
    const refs = new Map<string, { role: string; title: string }>();
    refs.set("e3", { role: "button", title: "登录" });
    refs.set("e4", { role: "textField", title: "用户名" });
    refs.set("e5", { role: "matrix", title: "单元格" });
    expect(annotateElementLine(`[e3] button "登录"`, refs)).toBe(`[e3] button "登录" @ax:button:登录`);
    expect(annotateElementLine(`[e4] textField "用户名"`, refs)).toBe(`[e4] textField "用户名" @ax:textField:用户名 ·中`);
    expect(annotateElementLine(`[e5] matrix "单元格"`, refs)).toBe(`[e5] matrix "单元格" @ax:matrix:单元格 ·高`);
    expect(annotateElementLine(`header 行不合形`, refs)).toBe(`header 行不合形`);
  });
});
