// ω99-119 — the A layer's copy table, RED-first. dropIntentChips is the
// pure function that turns staged file names into the three suggestion
// chips; the labels AND the sent texts are pinned VERBATIM by the brief
// (文案表逐字钉死，不得自创) — every assertion below is a toEqual on the
// full ordered array so a reworded label, a swapped order, or a changed
// instruction text all fail here before they reach the composer.
import { describe, expect, it } from "vitest";
import { dropIntentChips } from "../src/drop-intent.js";

describe("ω99-119 dropIntentChips（三族文案逐字）", () => {
  it("文档族 .txt/.md/.pdf/.docx → 总结要点/提炼待办/看看这是啥（文案逐字）", () => {
    const doc = [
      { label: "总结要点", text: "总结这个文件的要点" },
      { label: "提炼待办", text: "从这个文件里提炼出我的待办事项" },
      { label: "看看这是啥", text: "这个文件是讲什么的" },
    ];
    expect(dropIntentChips(["报告.pdf"])).toEqual(doc);
    expect(dropIntentChips(["notes.txt"])).toEqual(doc);
    expect(dropIntentChips(["readme.md"])).toEqual(doc);
    expect(dropIntentChips(["合同.docx"])).toEqual(doc);
  });

  it("表格族 .xlsx/.csv → 看看数据/总结要点/提炼待办（文案逐字）", () => {
    expect(dropIntentChips(["预算.xlsx"])).toEqual([
      { label: "看看数据", text: "看看这份数据有什么值得注意的" },
      { label: "总结要点", text: "总结这个文件的要点" },
      { label: "提炼待办", text: "从这个文件里提炼出我的待办事项" },
    ]);
    expect(dropIntentChips(["导出.csv"])).toEqual([
      { label: "看看数据", text: "看看这份数据有什么值得注意的" },
      { label: "总结要点", text: "总结这个文件的要点" },
      { label: "提炼待办", text: "从这个文件里提炼出我的待办事项" },
    ]);
  });

  it("通用兜底（无扩展名/其余扩展名）→ 帮我处理/总结要点/看看这是啥（文案逐字）", () => {
    const generic = [
      { label: "帮我处理", text: "帮我处理这个文件" },
      { label: "总结要点", text: "总结这个文件的要点" },
      { label: "看看这是啥", text: "这个文件是讲什么的" },
    ];
    expect(dropIntentChips(["archive.zip"])).toEqual(generic);
    expect(dropIntentChips(["无扩展名"])).toEqual(generic);
    expect(dropIntentChips([])).toEqual(generic); // 空名数组 → 通用兜底
  });

  it("扩展名大小写不敏感（.PDF/.Md 同族）", () => {
    expect(dropIntentChips(["REPORT.PDF"])).toEqual(dropIntentChips(["报告.pdf"]));
    expect(dropIntentChips(["a.Md"])).toEqual(dropIntentChips(["a.md"]));
    expect(dropIntentChips(["B.XLSX"])).toEqual(dropIntentChips(["b.xlsx"]));
  });

  it("多文件混合：按首文件族给，兜底不混拼", () => {
    // 首文件是文档 → 整排文档族（第二个表格文件不把「看看数据」混进来）
    expect(dropIntentChips(["报告.pdf", "数据.csv"])).toEqual(dropIntentChips(["报告.pdf"]));
    // 首文件是表格 → 整排表格族
    expect(dropIntentChips(["数据.csv", "报告.pdf"])).toEqual(dropIntentChips(["数据.csv"]));
    // 首文件是兜底 → 整排兜底（后来的文档文件不改变族）
    expect(dropIntentChips(["打包.zip", "报告.pdf"])).toEqual(dropIntentChips(["打包.zip"]));
  });

  it("族判取最后一个点后段（archive.tar.gz → gz → 兜底；a.b.md → md → 文档族）", () => {
    expect(dropIntentChips(["archive.tar.gz"])).toEqual(dropIntentChips(["打包.zip"]));
    expect(dropIntentChips(["a.b.md"])).toEqual(dropIntentChips(["a.md"]));
  });
});
