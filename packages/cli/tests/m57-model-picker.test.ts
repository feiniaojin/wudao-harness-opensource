// M57 §2 — numeric selection over the /model + /effort listings: the bare
// listing prints 1-based ordinals, and `/model <n>` / `/effort <n>` resolve
// through the same data path (resolveModelArgument / resolveEffortArgument
// — used by the driver, the REPL, and behind the web picker).
import { describe, it, expect } from "vitest";
import { availableModels, resolveModelArgument, resolveEffortArgument, formatModelList, formatEffortList } from "../src/commands/model.js";

describe("resolveModelArgument (name | number)", () => {
  const list = availableModels({});
  it("a number picks the printed ordinal (same provider → switchable)", () => {
    const glmIdx = list.findIndex((c) => c.provider === "glm") + 1;
    const v = resolveModelArgument(list, String(glmIdx), { provider: "glm" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.choice.provider).toBe("glm");
  });

  it("a numeric pick of a FOREIGN entry points at /provider instead of switching", () => {
    const deepseekIdx = list.findIndex((c) => c.provider === "deepseek") + 1;
    const v = resolveModelArgument(list, String(deepseekIdx), { provider: "glm" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error).toContain("cross-provider");
      expect(v.error).toContain("/provider deepseek");
    }
  });

  it("out-of-range numbers list the real count; names still validate per provider", () => {
    const over = resolveModelArgument(list, String(list.length + 1), { provider: "glm" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain(`the list has ${list.length}`);
    const byName = resolveModelArgument(list, "glm-4.6", { provider: "glm" });
    expect(byName.ok).toBe(true);
    const foreignName = resolveModelArgument(list, "deepseek-v4-flash", { provider: "glm" });
    expect(foreignName.ok).toBe(false);
  });

  it("the listing prints the ordinals the numbers refer to", () => {
    const text = formatModelList(list, { provider: "glm", model: "glm-4.6" });
    const lines = text.split("\n").filter((l) => /^\s+\d+\./.test(l));
    expect(lines.length).toBe(list.length);
    expect(lines[0]).toMatch(/^  1\. /);
  });
});

describe("resolveEffortArgument (level | number)", () => {
  it("numbers index the printed level list; out-of-range lists the levels", () => {
    expect(resolveEffortArgument("2")).toEqual({ ok: true, level: expect.any(String) });
    const v = resolveEffortArgument("2");
    if (v.ok) expect(v.level).toBe(formatEffortList(undefined).match(/^\s+2\. (\S+)/m)?.[1]);
    const bad = resolveEffortArgument("99");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("no level 99");
  });
  it("level names still work exactly (case-sensitive)", () => {
    expect(resolveEffortArgument("max").ok).toBe(true);
    expect(resolveEffortArgument("MAX").ok).toBe(false);
  });
});
