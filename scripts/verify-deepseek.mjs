// Live probe: verify @wudao/providers works against a real OpenAI-compatible endpoint.
// Reads config from process.env (WUDAO_* / OPENAI_*). Run with the env sourced from a
// gitignored .env, e.g.:  set -a; . ./.env; set +a; node scripts/verify-deepseek.mjs
import { createOpenAICompatibleProvider, resolveProviderConfig } from "../packages/providers/dist/index.js";

const config = resolveProviderConfig();
if (!config) {
  console.error("No API key in env (set WUDAO_API_KEY or OPENAI_API_KEY).");
  process.exit(1);
}
console.log(`endpoint: ${config.baseURL}/chat/completions`);
console.log(`model:    ${config.model}`);

const model = createOpenAICompatibleProvider(config);

// 1) Plain text round-trip (no tools).
const txt = await model.generate({
  systemPrompt: "You are a connectivity probe. Follow instructions exactly.",
  messages: [{ role: "user", content: "Reply with exactly the word: PONG" }],
  tools: [],
});
console.log("\n[text] content:", JSON.stringify(txt.content));

// 2) Tool-call round-trip (verify the model can emit tool calls our provider parses).
const tool = {
  name: "get_weather",
  description: "Get the weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const tc = await model.generate({
  systemPrompt: "Use the provided tool when asked about weather.",
  messages: [{ role: "user", content: "What is the weather in Beijing? Use the tool." }],
  tools: [tool],
});
console.log("[tool] content:", JSON.stringify(tc.content));
console.log("[tool] toolCalls:", tc.toolCalls ? JSON.stringify(tc.toolCalls) : "(none)");

// 3) Full multi-turn tool use: feed the tool RESULT back and confirm the model
//    answers (proves assistant{toolCalls} + tool-role message serialization).
const call = tc.toolCalls?.[0];
if (call) {
  const turn2 = await model.generate({
    systemPrompt: "Use the provided tool when asked about weather, then answer.",
    messages: [
      { role: "user", content: "What is the weather in Beijing? Use the tool." },
      { role: "assistant", content: "", toolCalls: [call] },
      { role: "tool", toolCallId: call.id, name: "get_weather", content: "Beijing is sunny, 25°C." },
    ],
    tools: [tool],
  });
  console.log("[multi-turn] final:", JSON.stringify(turn2.content));
  console.log("[multi-turn] further toolCalls:", turn2.toolCalls ? JSON.stringify(turn2.toolCalls) : "(none)");
}

console.log("\nLIVE VERIFICATION OK");
