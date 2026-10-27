// ω99-311 receipts — CLI 面称谓产品级统一（随 web 310 同词收口）：旧词在
// cli/src 六站点与 web 已统一的新词并存（provider.ts 同文件 :398/:421 相距
// 23 行两名并存为铁证），310 弧 census 记档的真缺陷，本弧收口。
// 值侧/尾语/插值原样：${p.provider}/${v.name} (${config.model}) 插值、
// 「—— 客户端已重建…」「—— 已记录/已排队…」尾、· 分隔符、（离线视图——
// 上方为…标签，默认不联网）句、profile 矩阵 token 全不动；只翻词。
// A=census 归零（310 A 同法 recursive 全树 .ts，offenders 数组直报文件）
//   + 六站点新词正钉（175/191/195 源钉范式，readFileSync 定位）。
// B 面钉的运行时宿主（m63/settings-ops/ui/persona-wiring/m55/m55b/199/193）
// 已随源演进，不在本文件。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const cliRoot = fileURLToPath(new URL("../src", import.meta.url));

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

describe("ω99-311 A — CLI src 全树旧称谓归零", () => {
  it("recursive .ts 扫描：旧词零命中（310 A 同法 census 门）", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".ts")) {
          if (readFileSync(p, "utf8").includes("服务商")) offenders.push(p);
        }
      }
    };
    walk(cliRoot);
    expect(offenders, `旧称谓残留在: ${offenders.join(", ")}`).toEqual([]);
  });

  it("六站点新词正钉：回执前缀×2 + repl 串 + status 两行 + 列表头", () => {
    const driver = srcOf("driver/agent-driver.ts");
    expect(driver).toContain("`供应商 → ${p.provider}`"); // ω99-199: #2 同钉
    expect(driver).toContain("`供应商 → ${v.name} (${config.model})`"); // ω99-199: #3 同钉
    const repl = srcOf("repl.ts");
    expect(repl).toContain("供应商 → ${v.name} (${r.config.model}) —— 客户端已重建，下一个请求即生效（/status 显示新标签）");
    const status = srcOf("commands/status.ts");
    expect(status).toContain("`  供应商 · 模型：${providerLine}`"); // ω99-193: #7 同钉
    expect(status).toContain("未探测（离线视图——上方为供应商标签，默认不联网）"); // ω99-193: #13 同钉
    const provider = srcOf("commands/provider.ts");
    expect(provider).toContain("供应商（profile 矩阵；/provider <名称> 在下一轮边界切换）："); // ω99-200: #2 同钉
  });
});
