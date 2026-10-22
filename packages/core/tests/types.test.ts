import { describe, it, expect } from "vitest";
import type {
  UserMessage, AssistantMessage, ToolResultMessage, AgentMessage,
  Terminal, Continue,
} from "../src/types.js";

describe("message types", () => {
  it("a user message has role user", () => {
    const m: UserMessage = { role: "user", content: "hi" };
    expect(m.role).toBe("user");
  });

  it("an assistant message may carry tool calls", () => {
    const m: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }],
    };
    expect(m.toolCalls?.[0]?.name).toBe("read_file");
  });

  it("a tool result message is correlated by toolCallId", () => {
    const m: ToolResultMessage = {
      role: "tool", toolCallId: "c1", name: "read_file", content: "hello",
    };
    expect(m.toolCallId).toBe("c1");
  });

  it("AgentMessage is the union", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ];
    expect(msgs).toHaveLength(2);
  });
});

describe("transitions", () => {
  it("Terminal carries completed + final message", () => {
    const t: Terminal = {
      reason: "completed",
      finalMessage: { role: "assistant", content: "ok" },
    };
    expect(t.reason).toBe("completed");
  });

  it("Continue is next_turn", () => {
    const c: Continue = { reason: "next_turn" };
    expect(c.reason).toBe("next_turn");
  });
});
