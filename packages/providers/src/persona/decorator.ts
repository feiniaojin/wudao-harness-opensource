// packages/providers/src/persona/decorator.ts — 层3：协议无关的 ModelInput 变换（spec §4）
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao/core";
import type { PersonaRuntime } from "./runtime.js";
import type { PromptStyle } from "./types.js";

function invertMap(map: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(map)) out[to] = from;
  return out;
}

/** Final-review I2：映射显示名 ∩ 未映射的在册工具名 ≠ ∅ → fail-closed。
 * 这种冲突会把两个同名工具送上 wire，且入向逆映射会把模型对真
 * `bash` 的调用翻译成 `read_file`——用 bash 的参数执行错工具。在任
 * 何 wire 效果之前抛出（transformInput 在 client 调用之前求值），
 * 报错点名 persona id 与冲突双方。schema 已查显示名互相重复
 * （schema.ts checkPrompt）——这里补的是对在册清单的交叉检查。 */
function assertNoDisplayCollision(personaId: string, map: Readonly<Record<string, string>>, input: ModelInput): void {
  const mapped = new Set(Object.values(map));
  const hits: string[] = [];
  for (const t of input.tools) {
    if (map[t.name] === undefined && mapped.has(t.name)) hits.push(t.name);
  }
  if (hits.length === 0) return;
  const detail = hits
    .map((n) => {
      const from = Object.entries(map).find(([, to]) => to === n)?.[0];
      return `"${n}" is both the display name of "${from ?? "?"}" and a live unmapped tool name`;
    })
    .join("; ");
  throw new Error(
    `persona "${personaId}" prompt.toolNameMap: display-name collision — ${detail}; two same-named tools would reach the wire and the inbound reverse map would execute the wrong tool`,
  );
}

/** 出向：system 快照/前缀 + 工具名映射（tools 定义与 tool 消息都改）。永不改写原对象。 */
function transformInput(personaId: string, style: PromptStyle, input: ModelInput): ModelInput {
  let systemPrompt = input.systemPrompt;
  if (style.system?.mode === "snapshot") systemPrompt = style.system.text;
  else if (style.system?.mode === "prefix") systemPrompt = style.system.text + input.systemPrompt;
  const map = style.toolNameMap;
  if (map === undefined || Object.keys(map).length === 0) {
    return systemPrompt === input.systemPrompt ? input : { ...input, systemPrompt };
  }
  assertNoDisplayCollision(personaId, map, input);
  const tools = input.tools.map((t) => {
    const n = map[t.name];
    return n !== undefined ? { ...t, name: n } : t;
  });
  const messages = input.messages.map((m) => {
    if (m.role === "tool") {
      const n = map[m.name];
      if (n !== undefined) return { ...m, name: n };
    }
    if (m.role === "assistant" && m.toolCalls !== undefined && m.toolCalls.length > 0) {
      // Multi-turn: assistant history toolCalls need renaming too (fix round 1)
      return {
        ...m,
        toolCalls: m.toolCalls.map((tc) => {
          const n = map[tc.name];
          return n !== undefined ? { ...tc, name: n } : tc;
        }),
      };
    }
    return m;
  });
  return { ...input, systemPrompt, tools, messages };
}

/** 入向：响应 tool_calls 的显示名逆映射回我们的原名（core loop 只认原名）。 */
function reverseMessage(style: PromptStyle, msg: AssistantMessage): AssistantMessage {
  if (style.toolNameMap === undefined || msg.toolCalls === undefined || msg.toolCalls.length === 0) return msg;
  const rev = invertMap(style.toolNameMap);
  return {
    ...msg,
    toolCalls: msg.toolCalls.map((tc) => {
      const n = rev[tc.name];
      return n !== undefined ? { ...tc, name: n } : tc;
    }),
  };
}

export function withPersona(client: ModelClient, runtime: PersonaRuntime): ModelClient {
  const activeStyle = (): { id: string; style: PromptStyle } | null => {
    const p = runtime.current;
    if (p === null || !p.layers.prompt || p.definition.prompt === undefined) return null;
    return { id: p.definition.id, style: p.definition.prompt };
  };
  const wrapped: ModelClient = {
    ...(client.modelId !== undefined ? { modelId: client.modelId } : {}),
    async generate(input) {
      const a = activeStyle();
      if (a === null) return client.generate(input);
      return reverseMessage(a.style, await client.generate(transformInput(a.id, a.style, input)));
    },
  };
  if (client.stream !== undefined) {
    wrapped.stream = async function* (input: ModelInput) {
      const a = activeStyle();
      if (a === null) { yield* client.stream!(input); return; }
      for await (const ev of client.stream!(transformInput(a.id, a.style, input))) {
        if (ev.type === "done") yield { type: "done", message: reverseMessage(a.style, ev.message) };
        else yield ev;
      }
    };
  }
  return wrapped;
}
