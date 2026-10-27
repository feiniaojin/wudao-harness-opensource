// 129 弧——web 侧镜像钉（与 cli/tests/arc129-format-tokens-m.test.ts 同形双镜像）。
import { describe, expect, it } from "vitest";
import { formatTokensK } from "../src/log.js";

describe("129 — formatTokensK 的 M 档（web 镜像）", () => {
  it("k 档原样 + M 档边界（999_950 起切换）", () => {
    expect(formatTokensK(987)).toBe("1k");
    expect(formatTokensK(1234)).toBe("1.2k");
    expect(formatTokensK(999_949)).toBe("999.9k");
    expect(formatTokensK(999_950)).toBe("1M");
    expect(formatTokensK(1_500_000)).toBe("1.5M");
  });
  it("旧 bug 形归零（无 1000k 族）", () => {
    expect(formatTokensK(999_999)).not.toBe("1000k");
    expect(formatTokensK(1_049_999)).not.toBe("1050k");
  });
});
