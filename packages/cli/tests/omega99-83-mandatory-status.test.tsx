// ω99-83 — driver /status wires reasoningMandatoryPreArmed (42-疑点2 payoff).
// ω99-42 landed the /status line itself (commands/status.ts:35/:69 — the
// one-pager omits the reasoning line unless the input carries the flag) and
// the REPL lane (repl.ts:861 holder / :946 provider-callback mount / :2505
// conditional spread). But the DRIVER's case "status" (agent-driver.ts
// :4889-4916) assembled the input WITHOUT the flag — every driver-based
// frontend (TUI app.tsx, web ui + Slack through session-engine.ts) never
// showed the line even after 42's mandatory repair armed. The seam: the
// provider fires onMandatoryRepairApplied (providers openai-compatible.ts
// :118/:213) at the MODEL CONSTRUCTION point, and the driver constructs no
// model — so the frontend owns a verbatim holder ({ current: boolean },
// repl.ts:861's literal shape) that the construction-site callback writes
// and the driver's /status conditionally spreads (status.ts:69's form).
// Three lanes pinned here: the driver seam (RED core — holder.current=true
// must surface the line; absent/false must be byte-identical), the TUI
// assembly (82's recording idiom: the SAME holder reaches the driver opts
// and the provider callback flips it), and the session-engine twin
// (end-to-end: fire the captured callback → /status notice carries the
// line). Construction-site recording: m80-resolver-wiring's vi.mock idiom.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AssistantMessage } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriverOptions, AgentDriver } from "../src/driver/agent-driver.js";
import { WudaoApp } from "../src/tui/app.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait(20);
  }
}

// Every construction site's opts, in call order (the m80 recording idiom).
const { providerOpts, driverOpts } = vi.hoisted(() => ({
  providerOpts: [] as Array<Record<string, unknown>>,
  driverOpts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@wudao-org/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wudao-org/providers")>();
  return {
    ...actual,
    createProvider: (config: ProviderConfig, opts?: Record<string, unknown>) => {
      providerOpts.push(opts ?? {});
      return actual.createProvider(config, opts as Parameters<typeof actual.createProvider>[1]);
    },
  };
});

vi.mock("../src/driver/agent-driver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/driver/agent-driver.js")>();
  return {
    ...actual,
    createAgentDriver: (opts: Record<string, unknown>) => {
      driverOpts.push(opts);
      return actual.createAgentDriver(opts as Parameters<typeof actual.createAgentDriver>[0]);
    },
  };
});

/** 42's verbatim holder shape (repl.ts:861): a mutable boolean slot. */
type MandatoryRepairArmed = { current: boolean };

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "om83-model" };

/** No model call is expected on any lane here — /status is offline. */
const idleModel: ModelClient = {
  async generate(_input: ModelInput): Promise<AssistantMessage> {
    throw new Error("no model call expected in ω99-83");
  },
};

function makeDriver(extra: Partial<AgentDriverOptions>): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    model: idleModel,
    tools: [],
    summarize: (n, i) => JSON.stringify(i).slice(0, 60),
    ...extra,
  });
}

async function statusNotice(driver: AgentDriver): Promise<string> {
  driver.submit("/status");
  await until(() => driver.getHistory().some((e) => e.kind === "notice" && e.text.startsWith("状态：")), "the /status notice lands"); // ω99-193: 表外漏网钉同弧演进（brief §二未列，预扫兜出）
  const e = driver.getHistory().find((e) => e.kind === "notice" && e.text.startsWith("状态：")); // ω99-193: 表外漏网钉同弧演进（brief §二未列，预扫兜出）
  return (e as { text: string }).text;
}

describe("ω99-83 — driver lane: /status reads the mandatoryRepairArmed holder", () => {
  it("holder.current=true → the notice carries 42's reasoning line", async () => {
    const holder: MandatoryRepairArmed = { current: true };
    const driver = makeDriver({ sessionId: "om83-armed", mandatoryRepairArmed: holder });
    const text = await statusNotice(driver);
    expect(text).toContain("推理：端点要求思考——本会话已预启用"); // ω99-193: 钉随源演进
    driver.dispose();
  });

  it("holder absent ≡ holder.current=false → byte-identical notice, no reasoning line", async () => {
    const bare = makeDriver({ sessionId: "om83-bare" });
    const off = makeDriver({ sessionId: "om83-bare", mandatoryRepairArmed: { current: false } });
    const bareText = await statusNotice(bare);
    const offText = await statusNotice(off);
    expect(bareText).not.toContain("reasoning:");
    expect(offText).not.toContain("reasoning:");
    expect(offText).toBe(bareText); // 双向对照: the absent-holder bytes never move
    bare.dispose();
    off.dispose();
  });
});

const roots: string[] = [];
beforeEach(() => {
  providerOpts.length = 0;
  driverOpts.length = 0;
});
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("ω99-83 — TUI lane: app.tsx's holder reaches the driver; the provider callback flips it", () => {
  it("assembly: driver opts carry the holder; the boot model construction mounts onMandatoryRepairApplied onto the SAME slot", async () => {
    const root = mkdtempSync(join(tmpdir(), "om83-tui-"));
    roots.push(root);
    // NO modelOverride — the boot createProvider site is the write side
    // under test (the mock delegates to the real one; nothing calls it).
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64_000} />,
    );
    await wait(50);
    expect(driverOpts).toHaveLength(1);
    const holder = driverOpts[0]!.mandatoryRepairArmed as MandatoryRepairArmed | undefined;
    expect(holder).toBeDefined(); // RED on base: undefined — the dead lane.
    // The boot construction site mounted the provider callback (repl.ts:946's
    // twin) — every provider build of this session carries it.
    expect(providerOpts.length).toBeGreaterThanOrEqual(1);
    for (const p of providerOpts) expect(typeof p.onMandatoryRepairApplied).toBe("function");
    // The write side flips the read side's slot — the holder IS the bridge.
    (providerOpts[0]!.onMandatoryRepairApplied as () => void)();
    expect(holder!.current).toBe(true);
    inst.unmount();
  });
});

describe("ω99-83 — session-engine lane: web/Slack /status carries the line after the callback fires", () => {
  it("end-to-end: fire the construction-site callback → the engine driver's /status notice shows 42's line", async () => {
    const root = mkdtempSync(join(tmpdir(), "om83-se-"));
    roots.push(root);
    const home = mkdtempSync(join(tmpdir(), "om83-se-home-"));
    roots.push(home);
    process.env.WUDAO_GLOBAL_HOME = home;
    let session: DriverSession | null = null;
    try {
      session = await createDriverSession({
        config: { ...config, provider: "deepseek" },
        workspaceRoot: root,
        contextWindowTokens: 64_000,
        tools: [],
        sessionId: "wudao-om83-se-0001",
        noPeer: true,
      });
      // The engine's driver got the holder (the subagentUpdateBox isomorph).
      const holder = driverOpts[0]!.mandatoryRepairArmed as MandatoryRepairArmed | undefined;
      expect(holder).toBeDefined(); // RED on base: undefined.
      expect(holder!.current).toBe(false);
      // The boot construction site mounted the callback (repl.ts:946's twin).
      expect(providerOpts.length).toBeGreaterThanOrEqual(1);
      const cb = providerOpts[0]!.onMandatoryRepairApplied as (() => void) | undefined;
      expect(typeof cb).toBe("function"); // RED on base: undefined.
      cb!();
      expect(holder!.current).toBe(true);
      // The driver's /status reads the holder — the line surfaces.
      const text = await statusNotice(session.driver);
      expect(text).toContain("推理：端点要求思考——本会话已预启用"); // ω99-193: 钉随源演进
    } finally {
      await session?.close();
      delete process.env.WUDAO_GLOBAL_HOME;
    }
  });
});
