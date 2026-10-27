// 129 弧（OpenHands 8784a5946 同款 bug 引进修复）——formatTokensK 的 M 档。
// 双镜像（cli/src/log.ts 与 web/src/log.ts 同式）双钉：本件钉 cli 侧，web 侧
// 同形钉在 packages/web/tests/arc129-format-tokens-m.test.ts。
// bug 形：≥999_950 时 k 路径印 "1000k"/"1050k"（无 M 档——DeepSeek V4 1M 窗下
// StatusBar/压缩通知真可命中）。
import { describe, expect, it } from "vitest";
import { formatTokensK } from "../src/log.js";

describe("129 — formatTokensK 的 M 档与进位边界", () => {
  it("k 档原样：1k / 1.2k / 999.9k", () => {
    expect(formatTokensK(987)).toBe("1k");
    expect(formatTokensK(1234)).toBe("1.2k");
    expect(formatTokensK(49800)).toBe("49.8k");
    // k 路径四舍五入到 1000.0k 之前的最后一个值。
    expect(formatTokensK(999_949)).toBe("999.9k");
  });

  it("M 档：999_950（=k 路径将印 1000k 的确切起点）起切换", () => {
    expect(formatTokensK(999_950)).toBe("1M");
    expect(formatTokensK(999_999)).toBe("1M");
    expect(formatTokensK(1_049_999)).toBe("1M");
    expect(formatTokensK(1_500_000)).toBe("1.5M");
  });

  it("旧 bug 形归零：任何输入不再产出 \"1000k\" 族", () => {
    for (const n of [999_950, 999_999, 1_000_000, 1_049_999, 1_999_999, 2_500_000]) {
      expect(formatTokensK(n)).not.toMatch(/^1000k$|^1\d{3}k$/);
    }
  });
});
