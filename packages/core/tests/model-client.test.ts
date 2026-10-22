import { describe, it, expect } from "vitest";
import { createScriptedModel, hasConfigCapConflict, CONFIG_CAP_ALSO_CONFLICTS_FIELD } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";

describe("createScriptedModel", () => {
  it("returns scripted responses in order", async () => {
    const r1: AssistantMessage = {
      role: "assistant", content: "",
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }],
    };
    const r2: AssistantMessage = { role: "assistant", content: "done" };
    const model = createScriptedModel([r1, r2]);

    const first = await model.generate({ systemPrompt: "s", messages: [], tools: [] });
    const second = await model.generate({ systemPrompt: "s", messages: [], tools: [] });

    expect(first.toolCalls?.[0]?.name).toBe("read_file");
    expect(second.content).toBe("done");
    expect(model.calls).toBe(2);
  });

  it("throws when the script runs out", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "only" }]);
    await model.generate({ systemPrompt: "s", messages: [], tools: [] });
    await expect(
      model.generate({ systemPrompt: "s", messages: [], tools: [] }),
    ).rejects.toThrow(/scripted responses exhausted/);
  });
});

// ---------------------------------------------------------------------------
// conflict-origin — the config-cap-conflict marker's duck type + the
// field-name seam. The literal "configCapAlsoConflicts" is pinned HERE (and
// again in the providers suite, wire-effort) so a value drift of the core
// constant goes loud on BOTH sides: this pin red in core, the providers
// literal pin red there (the class field is computed from the constant, so
// it silently follows a rename otherwise).
// ---------------------------------------------------------------------------

describe("conflict-origin — hasConfigCapConflict duck type + field-name seam", () => {
  it("the field-name constant is the pinned literal (both sides of the seam pin it)", () => {
    expect(CONFIG_CAP_ALSO_CONFLICTS_FIELD).toBe("configCapAlsoConflicts");
  });

  it("true ONLY for an Error whose marker field is literally true", () => {
    expect(hasConfigCapConflict(Object.assign(new Error("c"), { [CONFIG_CAP_ALSO_CONFLICTS_FIELD]: true }))).toBe(true);
    // Absent, false, non-boolean, non-Error — all read as no marker (the
    // byte-equivalence guarantee for unmarked errors).
    expect(hasConfigCapConflict(new Error("c"))).toBe(false);
    expect(hasConfigCapConflict(Object.assign(new Error("c"), { [CONFIG_CAP_ALSO_CONFLICTS_FIELD]: false }))).toBe(false);
    expect(hasConfigCapConflict(Object.assign(new Error("c"), { [CONFIG_CAP_ALSO_CONFLICTS_FIELD]: "true" }))).toBe(false);
    expect(hasConfigCapConflict("not an error")).toBe(false);
    expect(hasConfigCapConflict(undefined)).toBe(false);
  });
});
