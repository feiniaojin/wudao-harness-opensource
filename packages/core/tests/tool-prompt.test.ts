// 长程弧 §1 — 工具自述渲染器。钉住四条不变量：
//   1. 确定性排序（按名 code-unit 升序，与注册顺序无关）；
//   2. 缺席静默（没声明的工具整条不出现）；
//   3. 空集零字节（"" 而不是 "# Tool usage" 空节）；
//   4. 渲染是纯的（同输入同字节——前缀缓存的前提）。
import { describe, expect, it } from "vitest";
import { buildTool } from "../src/tool.js";
import { collectToolPromptEntries, renderToolGuideSection, TOOL_GUIDE_HEADING } from "../src/tool-prompt.js";
import type { Tool } from "../src/tool.js";

const mk = (name: string, snippet?: string, guidelines: readonly string[] = []): Tool =>
  buildTool({
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: "ok" }),
    ...(snippet !== undefined ? { promptSnippet: snippet } : {}),
    ...(guidelines.length > 0 ? { promptGuidelines: guidelines } : {}),
  });

describe("collectToolPromptEntries", () => {
  it("sorts by name, not registration order", () => {
    const entries = collectToolPromptEntries([mk("zebra", "z"), mk("alpha", "a"), mk("mike", "m")]);
    expect(entries.map((e) => e.name)).toEqual(["alpha", "mike", "zebra"]);
  });

  it("skips tools without a snippet (absent = silent)", () => {
    const entries = collectToolPromptEntries([mk("has", "s"), mk("hasnot")]);
    expect(entries.map((e) => e.name)).toEqual(["has"]);
  });

  it("skips an empty-string snippet too (a blank line would be noise)", () => {
    expect(collectToolPromptEntries([mk("blank", "")])).toHaveLength(0);
  });

  it("carries guidelines through, defaulting to []", () => {
    const [withG, without] = collectToolPromptEntries([
      mk("a", "sa", ["one", "two"]),
      mk("b", "sb"),
    ]);
    expect(withG?.guidelines).toEqual(["one", "two"]);
    expect(without?.guidelines).toEqual([]);
  });
});

describe("renderToolGuideSection", () => {
  it("renders a heading, one line per tool, nested guidelines", () => {
    const out = renderToolGuideSection([mk("edit", "replace text", ["be exact"])]);
    expect(out).toBe(`${TOOL_GUIDE_HEADING}\n- edit: replace text\n  - be exact`);
  });

  it("returns EMPTY STRING when nothing declares (zero bytes, not an empty section)", () => {
    expect(renderToolGuideSection([])).toBe("");
    expect(renderToolGuideSection([mk("quiet")])).toBe("");
  });

  it("is pure — same input, same bytes (the prefix-cache precondition)", () => {
    const tools = [mk("b", "sb"), mk("a", "sa", ["g"])];
    expect(renderToolGuideSection(tools)).toBe(renderToolGuideSection(tools));
    // and order-independent: a shuffled registration renders identically
    expect(renderToolGuideSection([mk("a", "sa", ["g"]), mk("b", "sb")])).toBe(renderToolGuideSection(tools));
  });

  it("does not duplicate a tool mentioned in two guideline lines", () => {
    const out = renderToolGuideSection([mk("shell", "run commands", ["a", "b", "c"])]);
    expect(out.split("shell:").length - 1).toBe(1);
  });
});

describe("the real built-in tools declare themselves", () => {
  it("at least the core loop tools carry a snippet", async () => {
    // Import the real modules rather than trusting the inventory by hand.
    const { createReadFileTool } = await import("../src/tools/read-file.js");
    const { createWriteFileTool } = await import("../src/tools/write-file.js");
    const { createEditTool } = await import("../src/tools/edit.js");
    const { createShellTool } = await import("../src/tools/shell.js");
    const tools = [
      createReadFileTool(),
      createWriteFileTool(),
      createEditTool(),
      createShellTool({}),
    ];
    const entries = collectToolPromptEntries(tools);
    expect(entries.length).toBe(4);
    expect(entries.map((e) => e.name).sort()).toEqual(["edit", "read_file", "shell", "write_file"]);
    for (const e of entries) expect(e.snippet.length).toBeGreaterThan(0);
  });
});
