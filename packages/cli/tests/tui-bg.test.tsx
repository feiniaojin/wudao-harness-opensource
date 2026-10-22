// M30 TUI wiring tests: the `bg active/spawned` status-bar segment, the
// per-user-turn in-flight relist, and interrupt/exit abort-all linkage
// (spec §B). The registry exposes no change notification — the app polls
// status() and aggregates; these tests spawn real registry children.
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import type { AssistantMessage, ModelClient } from "@wudao/core";
import { createScriptedModel } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { StatusBar } from "../src/tui/status-bar.js";
import { WudaoApp } from "../src/tui/app.js";
import { createSessionRegistry } from "../src/agents/index.js";
import type { AgentRegistry } from "../src/agents/index.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(12);
  }
}

/** A model whose generate() never settles — the child stays in flight. */
function hangingModel(): ModelClient {
  return { async generate(): Promise<AssistantMessage> { return new Promise<never>(() => {}); } };
}

/** counts()/in-flight as the real API expresses them: status() aggregation. */
function inFlight(reg: AgentRegistry): number {
  return reg.status().filter((s) => s.status === "queued" || s.status === "running").length;
}


// M53 §3: the StatusBar renders from the statusline snapshot — build one.
const snap = (over: Partial<import("../src/statusline.js").StatuslineSnapshot>): import("../src/statusline.js").StatuslineSnapshot => ({
  version: "t",
  model: "m",
  mode: "default",
  session: { id: "s12345678", id8: "s1234567" },
  busy: false,
  queued: 0,
  ctx: null,
  cache: null,
  board: null,
  sidecar: null,
  bg: { active: 0, spawned: 0 },
  live: { answerChars: 0, reasoningChars: 0, busyTools: 0 },
  ...over,
});

describe("StatusBar bg segment", () => {
  it("renders `bg active/spawned` while agents exist, omits it otherwise", () => {
    const withBg = render(<StatusBar snapshot={snap({ model: "m", session: { id: "s1234567", id8: "s1234567" }, bg: { active: 1, spawned: 2 } })} />);
    expect(withBg.lastFrame()).toContain("bg 1/2");
    withBg.unmount();
    const zero = render(<StatusBar snapshot={snap({ model: "m", session: { id: "s1234567", id8: "s1234567" }, bg: { active: 0, spawned: 0 } })} />);
    expect(zero.lastFrame()).not.toContain("bg 0/0");
    zero.unmount();
    const none = render(<StatusBar snapshot={snap({ model: "m", session: { id: "s1234567", id8: "s1234567" } })} />);
    expect(none.lastFrame()).not.toContain("bg ");
    none.unmount();
  });

  it("sits in the standard dim segment order", () => {
    const c = render(
      <Text dimColor>
        <StatusBar snapshot={snap({ model: "m", session: { id: "s1234567", id8: "s1234567" }, ctx: { used: 1000, window: 64000, nearLimit: false }, cache: { percent: 50 }, board: { done: 1, total: 2 }, bg: { active: 1, spawned: 1 } })} />
      </Text>,
    );
    const frame = c.lastFrame() ?? "";
    expect(frame.indexOf("ctx")).toBeGreaterThan(-1);
    expect(frame.indexOf("cache")).toBeGreaterThan(frame.indexOf("ctx"));
    expect(frame.indexOf("bg 1/1")).toBeGreaterThan(frame.indexOf("cache"));
    c.unmount();
  });
});

describe("WudaoApp background wiring", () => {
  it("shows the bg counter for a shared registry and re-lists in-flight agents on a user turn", async () => {
    const registry = createSessionRegistry();
    registry.spawn({
      model: hangingModel(),
      allTools: [],
      role: { id: "coder", description: "long exploration of the auth module", toolNames: [] },
      prompt: "p",
    });
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const app = render(
      <WudaoApp config={config} workspaceRoot="/tmp/ws" contextWindowTokens={64000} modelOverride={model} tools={[]} agentsRegistry={registry} />,
    );
    await until(() => (app.lastFrame() ?? "").includes("bg 1/1"), "bg counter");
    expect(app.lastFrame()).not.toContain("bg 0/1");

    // A user turn re-lists the in-flight agent once: id + role.
    await type(app.stdin, "status?\r");
    await until(() => (app.lastFrame() ?? "").includes("后台在飞"), "in-flight relist");
    expect(app.lastFrame()).toContain("bg-1");
    expect(app.lastFrame()).toContain("coder");

    app.unmount();
    await until(() => inFlight(registry) === 0, "abort-all on unmount");
  });

  it("no relist when nothing is in flight", async () => {
    const registry = createSessionRegistry();
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const app = render(
      <WudaoApp config={config} workspaceRoot="/tmp/ws" contextWindowTokens={64000} modelOverride={model} tools={[]} agentsRegistry={registry} />,
    );
    await type(app.stdin, "hello\r");
    await wait(150);
    expect(app.lastFrame()).not.toContain("后台在飞");
    app.unmount();
  });

  // M31 §3: the relist marks resume children with the lineage arrow.
  it("re-lists resume children with the lineage arrow (bg-2 ← t-1)", async () => {
    const registry = createSessionRegistry();
    const role = { id: "coder", description: "worker", toolNames: [] };
    registry.spawn({ model: hangingModel(), allTools: [], role, prompt: "p", callId: "t-1" });
    registry.spawn({ model: hangingModel(), allTools: [], role, prompt: "p", callId: "t-2", parentCallId: "t-1" });
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const app = render(
      <WudaoApp config={config} workspaceRoot="/tmp/ws" contextWindowTokens={64000} modelOverride={model} tools={[]} agentsRegistry={registry} />,
    );
    await until(() => (app.lastFrame() ?? "").includes("bg 2/2"), "bg counter");
    await type(app.stdin, "status?\r");
    await until(() => (app.lastFrame() ?? "").includes("后台在飞"), "in-flight relist");
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("bg-1 coder");
    expect(frame).toContain("bg-2 ← t-1");
    app.unmount();
    await until(() => inFlight(registry) === 0, "abort-all on unmount");
  });

  it("a settled agent stops counting as active", async () => {
    const registry = createSessionRegistry();
    registry.spawn({
      model: createScriptedModel([{ role: "assistant", content: "done fast" }]),
      allTools: [],
      role: { id: "consultant", description: "quick take", toolNames: [] },
      prompt: "p",
    });
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const app = render(
      <WudaoApp config={config} workspaceRoot="/tmp/ws" contextWindowTokens={64000} modelOverride={model} tools={[]} agentsRegistry={registry} />,
    );
    await until(() => (app.lastFrame() ?? "").includes("bg 0/1"), "settled counter (active 0, spawned 1)");
    app.unmount();
  });
});
