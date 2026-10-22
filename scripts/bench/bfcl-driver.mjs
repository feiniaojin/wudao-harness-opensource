// BFCL 驱动 v2（走 wudao 全解析线 + propose-verify 二段通用优化）。
// 第一段：函数调用生成。第二段：把题面+schema+首段调用喂回，要求逐参
// 校验「值是否精确取自题面用词/单位制/值表」，不一致输出修正调用。
// 这是通用范式（self-consistency 校验），不针对任何题面。
import { buildRunPlan } from "external/packages/cli/dist/run.js";
import { createProvider } from "external/packages/providers/dist/index.js";

const task = JSON.parse(process.argv[2]);
const plan = buildRunPlan({
  prompt: "",
  env: process.env,
  ...(process.env.BENCH_PROVIDER ? { provider: process.env.BENCH_PROVIDER } : {}),
  ...(process.env.BENCH_MODEL ? { model: process.env.BENCH_MODEL } : {}),
});
if (plan.kind !== "real") {
  console.log("RESULT:" + JSON.stringify({ error: "no-key: " + (plan.reason ?? "") }));
  process.exit(0);
}
const client = createProvider(plan.config);
const tools = task.fns.map((f) => ({
  name: f.name,
  description: f.description || "",
  parameters: task.schemas[f.name],
}));

const GENERATE_SYS = [
  "You are a function calling assistant. Answer by calling the provided function with correct arguments.",
  "Argument discipline:",
  "- Copy values VERBATIM from the user's message whenever the message contains them (names, IDs, titles, list items): do not paraphrase, expand, or shorten.",
  "- Numbers use the unit convention the function's parameter description implies; a parameter named like rate/ratio/percent takes a DECIMAL fraction (8% → 0.08) unless the description says otherwise.",
  "- For enum-like choices, prefer the exact vocabulary used in the user's message or the parameter description.",
  "- If no function fits, reply with text only.",
].join("\n");

const VERIFY_SYS = [
  "You are a function-call auditor. You will see a user request, a function schema, and a proposed tool call.",
  "Check EVERY argument value against the user's message:",
  "1. VERBATIM: string values must copy the message's exact wording (not synonyms, not expansions like 'Giant panda' for 'panda'). When the value names a category/type/kind, use the single category word the schema description implies (e.g. 'human', 'renewable'), not a longer phrase containing it.",
  "1b. FIDELITY: numeric values must come from the message's own numbers after unit conversion — re-locate each number in the message before accepting it. Unit conversions include 12-hour→24-hour clock times ('until 11 PM' → 23), percent→decimal, and quantity splitting ('three bottles and a five pound bag' with a separate quantity parameter → items ['name1','name2'] + quantities [3,1]).",
  "1c. ITEMS: when a parameter holds a list of goods/items AND a separate quantity parameter exists, extract each item's plain NAME (drop size/count descriptors: 'a five pound bag of rice' → 'bag of rice' or 'rice') and put counts in the quantity parameter.",
  "1d. OPTIONAL BOOLEANS: if an optional boolean is not stated explicitly in the message and you are not certain, OMIT it rather than guessing.",
  "1e. DEFAULTS: when an optional parameter documents a DEFAULT and the user's message does not explicitly contradict it, prefer passing the default (or omitting the parameter) over inferring a different value from world knowledge.",
  "1f. FORMAT BEATS EXAMPLE: when a parameter's description declares a format (e.g. 'This is in 24 hour format') but its inline example number seems to contradict that format, follow the DECLARED FORMAT and convert the example accordingly ('11 PM' with 24-hour format → 23).",
  "2. UNITS: rates/ratios/percentages must be decimal fractions when the parameter name or description implies a fraction.",
  "3. SHAPE: nested objects/lists must match the schema's described structure exactly.",
  "If everything is correct, reply exactly: OK",
  "Otherwise reply with ONLY the corrected tool call as JSON: {\"name\": ..., \"arguments\": {...}}",
].join("\n");

function extractCall(text) {
  if (!text) return undefined;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[0]);
    return typeof v.name === "string" ? { id: "verify", name: v.name, arguments: v.arguments ?? {} } : undefined;
  } catch {
    return undefined;
  }
}

try {
  let msg = await client.generate({ systemPrompt: GENERATE_SYS, messages: task.messages, tools });
  const first = msg.toolCalls?.[0];
  if (first && task.verify !== false) {
    const fnDef = task.fns.find((f) => f.name === first.name);
    const verifyPrompt = [
      `User request: ${JSON.stringify(task.messages.filter((x) => x.role === "user").map((x) => x.content))}`,
      `Function schema: ${JSON.stringify({ name: fnDef?.name, description: fnDef?.description, parameters: task.schemas[first.name] })}`,
      `Proposed call: ${JSON.stringify({ name: first.name, arguments: first.arguments })}`,
    ].join("\n\n");
    try {
      const vmsg = await client.generate({
        systemPrompt: VERIFY_SYS,
        messages: [{ role: "user", content: verifyPrompt }],
        tools,
      });
      const text = (vmsg.content ?? "").trim();
      if (!/^OK\b/i.test(text)) {
        const fixed = vmsg.toolCalls?.[0] ?? extractCall(text);
        if (fixed && fixed.name) {
          msg = { ...msg, toolCalls: [{ ...first, name: fixed.name, arguments: fixed.arguments ?? first.arguments }] };
        }
      }
    } catch {
      /* verify 失败保首段结果 */
    }
  }
  console.log("RESULT:" + JSON.stringify({ toolCalls: msg.toolCalls ?? null, content: (msg.content ?? "").slice(0, 200) }));
} catch (e) {
  console.log("RESULT:" + JSON.stringify({ error: String((e && e.message) || e) }));
}
