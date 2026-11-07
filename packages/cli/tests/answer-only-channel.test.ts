import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { diagLine } from "../src/answer-only-channel.js";

// 2026-11-06 Terminal-Bench 取证：`--answer-only` 的契约是「仅输出终答
// （无空行包裹，供脚本/benchmark 消费）」。实测 stdout 里还混着
// `模型：…` / `session: …` / 耗时收据 —— 它们是 ge("info") 门控的，不看
// answerOnly。于是「机器可读模式」并不可读。
//
// 修法不是删诊断（benchmark 靠它们定位问题），而是换通道：answer-only 下
// 诊断走 stderr。这三条钉住这个分流。

const indexSrc = (): string =>
  readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

describe("--answer-only 的输出通道分流", () => {
  it("answer-only 时诊断走 stderr", () => {
    const written: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    // @ts-expect-error — narrow test seam on the stream
    process.stderr.write = (chunk: string) => { written.push(String(chunk)); return true; };
    // @ts-expect-error — narrow test seam on the stream
    process.stdout.write = (chunk: string) => { written.push("STDOUT:" + String(chunk)); return true; };
    try {
      diagLine("诊断行\n", true);
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
    }
    expect(written).toContain("诊断行\n");
    expect(written).not.toContain("STDOUT:诊断行\n");
  });

  it("非 answer-only 时诊断仍走 stdout（行为不变）", async () => {
    const written: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    // @ts-expect-error — narrow test seam on the stream
    process.stdout.write = (chunk: string) => { written.push("STDOUT:" + String(chunk)); return true; };
    try {
      diagLine("诊断行\n", false);
      // diagLine 走守卫泳道（异步排干），给它一拍
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.stdout.write = origOut;
    }
    expect(written.join("")).toContain("诊断行");
  });

  it("index.ts 的元数据行全部走分流器，不再裸写 stdout", () => {
    const src = indexSrc();
    // 模型名 / session 行必须经 diagLine（裸写会让 answer-only 的 stdout 不可机读）
    expect(src).not.toMatch(/process\.stdout\.write\(`模型：/);
    expect(src).not.toMatch(/process\.stdout\.write\(`session: /);
    expect(src).toContain("diagLine(`模型：");
    expect(src).toContain("diagLine(`session: ");
  });
});
