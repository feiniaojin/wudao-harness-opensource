// M34 §1 — the line-prompt shape shared by the REPL and one-shot ask_user paths.
import { describe, it, expect } from "vitest";
import { formatAskUserPrompt, mapAskUserLine } from "../src/ask-user-line.js";

describe("formatAskUserPrompt", () => {
  it("lists numbered options with descriptions and an answer cue", () => {
    const text = formatAskUserPrompt("Flag or no flag?", [
      { label: "flag" },
      { label: "no flag", description: "direct release" },
    ]);
    expect(text).toBe(
      "❓ Flag or no flag?\n" +
      "  1) flag\n" +
      "  2) no flag — direct release\n" +
      "answer [1-2 or free text]: ",
    );
  });

  it("free-text question has no option lines", () => {
    expect(formatAskUserPrompt("What now?")).toBe("❓ What now?\nanswer: ");
  });
});

describe("mapAskUserLine", () => {
  const options = [{ label: "flag" }, { label: "no flag" }];

  it("a bare in-range number picks that option's label", () => {
    expect(mapAskUserLine("2", options)).toBe("no flag");
    expect(mapAskUserLine(" 1 ", options)).toBe("flag");
  });

  it("out-of-range numbers and non-numeric lines are free text, verbatim (trimmed)", () => {
    expect(mapAskUserLine("3", options)).toBe("3");
    expect(mapAskUserLine("neither — do a third thing", options)).toBe("neither — do a third thing");
    expect(mapAskUserLine("  spaced answer  ")).toBe("spaced answer");
  });

  it("without options every line is the answer", () => {
    expect(mapAskUserLine("12", undefined)).toBe("12");
  });
});
