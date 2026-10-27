import { runAgentLoop, createScriptedModel, createReadFileTool } from "../dist/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "tests", "fixtures", "sample.txt");

const state = {
  systemPrompt: "You are wudao-harness. Use tools, then answer.",
  messages: [{ role: "user", content: `Read the file at ${fixturePath} and tell me what it says.` }],
  tools: [createReadFileTool()],
  status: "idle",
};

const model = createScriptedModel([
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }] },
  { role: "assistant", content: "The file says: the quick brown fox" },
]);

console.log("wudao-harness demo — deterministic model (no API key needed)\n");
const gen = runAgentLoop(state, model, { maxTurns: 5 });
const toolCallIdToName = new Map();
for await (const e of gen) {
  switch (e.type) {
    case "turn_started":
      console.log(`↻ turn ${e.turn}`);
      break;
    case "model_call_started":
      console.log("→ model");
      break;
    case "model_call_finished":
      console.log(`← model (${e.toolCallCount} tool call${e.toolCallCount !== 1 ? "s" : ""})`);
      break;
    case "tool_call_started":
      toolCallIdToName.set(e.toolCallId, e.toolName);
      console.log(`🔧 ${e.toolName}`);
      break;
    case "tool_call_finished":
      const toolName = toolCallIdToName.get(e.toolCallId) ?? "unknown";
      const ok = e.isError ? "(error)" : "(ok)";
      console.log(`✓ ${toolName} ${ok}`);
      break;
    case "turn_finished":
      console.log(`✓ turn ${e.turn} finished (${e.toolCallCount} tool call${e.toolCallCount !== 1 ? "s" : ""})`);
      break;
  }
}
const last = state.messages.at(-1);
console.log(`\nFinal answer: ${last?.role === "assistant" ? last.content : "(no assistant message)"}`);
console.log(`Messages exchanged: ${state.messages.length}`);
