// ω99-52 — the conformance wirings: the JSONL filesystem backend and the new
// in-memory backend run the SAME forBackend suite (backend-agnostic proof),
// plus the memory backend's subagent-foundation scenario (acceptance 5: a
// real runSubagent persisting its child sidechain into the Map domain).
// The existing 9 store-facing test files are untouched — they pin JSONL
// specifics; this suite pins the backend-agnostic contract.
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forBackend } from "./conformance/storage-conformance.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import { createMemorySessionStore } from "../src/session/memory-store.js";
import { runSubagent } from "../src/subagent.js";
import type { SubagentType } from "../src/subagent.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";
import { createReadFileTool } from "../src/index.js";

forBackend("JSONL (filesystem)", async () => {
  const root = await mkdtemp(join(tmpdir(), "conf-jsonl-"));
  return {
    store: createJsonlSessionStore(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
    capabilities: { byteFace: true, leaseFace: true, sessionsRoot: root },
  };
});

forBackend("in-memory (Map)", () => ({
  store: createMemorySessionStore(),
  cleanup: async () => {},
  capabilities: { byteFace: false, leaseFace: false },
}));

// ---------------------------------------------------------------------------
// Acceptance 5 — the memory backend is a subagent/evals foundation: a real
// runSubagent child persists its transcript through the sidechain faces into
// the Map domain while the parent's top-level sessions stay separate.
// ---------------------------------------------------------------------------
const CHILD_TYPE: SubagentType = {
  name: "coder",
  description: "d",
  systemPrompt: "CHILD-SYSTEM-PROMPT",
  toolNames: ["read_file"],
};

describe("in-memory backend — subagent foundation (ω99-52 acceptance 5)", () => {
  it("runSubagent persists the child sidechain in the Map domain; top-level sessions stay separate", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "conf-mem-sub-"));
    try {
      await writeFile(join(scratch, "data.txt"), "hello world", "utf8");
      const store = createMemorySessionStore();
      const responses: AssistantMessage[] = [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(scratch, "data.txt") } }] },
        { role: "assistant", content: "read it: hello world" },
      ];
      let call = 0;
      const model: ModelClient = {
        async generate(_input: ModelInput): Promise<AssistantMessage> {
          const r = responses[call];
          call += 1;
          if (!r) throw new Error("scripted responses exhausted");
          return r;
        },
      };
      const answer = await runSubagent({
        model,
        allTools: [createReadFileTool()],
        subagentType: CHILD_TYPE,
        prompt: "read data.txt",
        loopOptions: { maxTurns: 20 },
        session: { mode: "new", id: "mem-child-1", store },
      });
      expect(answer).toContain("hello world");
      const transcript = await store.loadSidechain("mem-child-1");
      expect(transcript.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      // Map domain separation: the sidechain is invisible to the top level…
      expect(await store.list()).toEqual([]);
      // …and the parent session coexists untouched.
      await store.append("parent", { role: "user", content: "parent turn" });
      expect(await store.list()).toEqual(["parent"]);
      expect(await store.load("parent")).toEqual([{ role: "user", content: "parent turn" }]);
      expect(await store.loadSidechainEntries("mem-child-1")).toHaveLength(4);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
