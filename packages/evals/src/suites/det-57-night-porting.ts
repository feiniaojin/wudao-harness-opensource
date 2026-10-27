// det-57-night-porting — the deterministic behavior pins for the 2026-08-28
// night-porting arc (夜移 010/011/012). The features landed with unit tests
// in their own packages; this suite pays the det-44-style debt — the same
// behaviors pinned at the harness boundary inside the release-eval matrix,
// so a regression in ANY of the three seams fails the release evals, not
// just a package test someone might not run. Zero network, zero real-home
// reads (the one process.env pin — WUDAO_NO_LANGUAGE — is saved and
// restored, det-53's pattern):
//
//   ① 010 credential ask gate   decideRichPermission matrix: auto mode ASKS
//      for ~/.ssh/id_rsa (mode-immune, no silent read), plan mode asks too
//      (the read-only fence is about mutation, not secrets), an explicit
//      settings-allow rule PRE-APPROVES (capability ≠ policy — a human may
//      legitimately run a keys workflow), and .env is NOT credential
//      material (the 4.65 gate's exact boundary — no false positives).
//   ② 011/011b peel→replay      the provider chain end to end: a qwen-
//      chat-template stream inlines CoT as a turn-initial <think> block in
//      the CONTENT channel; the peel stores it on AssistantMessage.reasoning
//      and the FOLLOWING tool-call turn replays it verbatim as
//      reasoning_content — exactly one request before the replay call (the
//      peel also spares the missing-reasoning frozen re-request).
//   ③ 012 language blocks       the driver turn tail: a Chinese prompt
//      appends [language] then [reasoning-language] (pure appends — prefix
//      bytes never move), and WUDAO_NO_LANGUAGE=1 ablates BOTH blocks (the
//      M53 §5 global ablation switch).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadFileTool, createScriptedModel, type Tool } from "@wudao/core";
import { createOpenAICompatibleProvider } from "@wudao/providers";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { decideRichPermission } from "wudao-harness/permission";
import { LANGUAGE_BLOCK_ZH, REASONING_BLOCK_ZH } from "wudao-harness/language";
import { summarizeToolCall } from "wudao-harness/log";
import type { EvalDefinition } from "../runner.js";

export interface NightPortingEvidence {
  readonly root: string;
  // ① the credential ask gate (夜移 010)
  readonly credAuto: unknown;
  readonly credPlan: unknown;
  readonly credPreapproved: unknown;
  readonly envRead: unknown;
  // ② the in-band peel → reasoning-replay chain (夜移 011/011b)
  readonly peeledReasoning?: string;
  readonly replayedReasoning?: string;
  readonly requestsBeforeReplay: number;
  // ③ the reasoning-language transient block (夜移 012)
  readonly driverTail: readonly string[];
  readonly ablatedTail: readonly string[];
}

const CRED_INPUT = { path: "~/.ssh/id_rsa" };

function sseStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

export const det57Eval: EvalDefinition<{ readonly root: string }, NightPortingEvidence> = {
  name: "det-57-night-porting",
  kind: "deterministic",
  async setup() {
    return { root: await mkdtemp(join(tmpdir(), "det57-night-")) };
  },
  async run(ctx) {
    // ① — pure permission-matrix pins (the same seam det-23 drives).
    const credAuto = decideRichPermission({ mode: "auto", toolName: "read_file", input: CRED_INPUT });
    const credPlan = decideRichPermission({ mode: "plan", toolName: "read_file", input: CRED_INPUT });
    const credPreapproved = decideRichPermission({
      mode: "auto", toolName: "read_file", input: CRED_INPUT,
      settings: { allow: ["read_file"], deny: [], ask: [], sidecarExempt: [] },
    });
    const envRead = decideRichPermission({ mode: "auto", toolName: "read_file", input: { path: ".env" } });

    // ② — the provider chain: stream-peel then replay-on-the-tool-turn.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub = (async (_url: unknown, init: { body?: string } | undefined) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(
          sseStream([
            'data: {"choices":[{"delta":{"content":"<think>IN"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"NER</think>"}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "http://provider.test", model: "m", reasoningFormat: "qwen-chat-template", reasoningReplay: "toolCallTurns" },
      { fetch: fetchStub },
    );
    let peeledReasoning: string | undefined;
    // ModelClient.stream is optional on the port; the OpenAI-compatible
    // adapter always provides it (stream is this suite's whole subject).
    for await (const ev of provider.stream!({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }] })) {
      if (ev.type === "done") peeledReasoning = (ev.message as { reasoning?: string }).reasoning;
    }
    const requestsBeforeReplay = bodies.length;
    await provider.generate({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }], reasoning: peeledReasoning },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "file a" },
        { role: "user", content: "continue" },
      ],
    });
    const wire = bodies[1]?.messages as Array<Record<string, unknown>> | undefined;
    const replayedReasoning = wire?.find((m) => m.role === "assistant" && "tool_calls" in m)?.reasoning_content as string | undefined;

    // ③ — the driver turn tail (both transient blocks + the ablation switch).
    const readFile = createReadFileTool({ workspaceRoot: ctx.root }) as unknown as Tool;
    const makeDriver = () =>
      createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "好的" }]),
        tools: [readFile],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ctx.root,
        languageBlock: "auto",
        reasoningLanguage: "auto",
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
    const settle = async (d: ReturnType<typeof createAgentDriver>): Promise<void> => {
      for (let i = 0; i < 200 && !d.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
      for (let i = 0; i < 500 && d.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 20));
    };
    const driver = makeDriver();
    driver.submit("请总结这个项目");
    await settle(driver);
    const driverTail = driver.state.messages.slice(0, 3).map((m) => (m as { content: string }).content);

    const savedNo = process.env.WUDAO_NO_LANGUAGE;
    process.env.WUDAO_NO_LANGUAGE = "1";
    try {
      const ablated = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "好的" }]),
        tools: [readFile],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ctx.root,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      ablated.submit("请总结这个项目");
      await settle(ablated);
      var ablatedTail = ablated.state.messages.map((m) => (m as { content: string }).content);
    } finally {
      if (savedNo === undefined) delete process.env.WUDAO_NO_LANGUAGE;
      else process.env.WUDAO_NO_LANGUAGE = savedNo;
    }

    return {
      root: ctx.root,
      credAuto, credPlan, credPreapproved, envRead,
      peeledReasoning, replayedReasoning, requestsBeforeReplay,
      driverTail, ablatedTail,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    // ① the credential gate: ask in auto AND plan, pre-approvable, .env free.
    need(e.credAuto === "ask", `① auto must ask for ~/.ssh/id_rsa (got ${JSON.stringify(e.credAuto)})`);
    need(e.credPlan === "ask", `① plan must ask too — the fence is about mutation, not secrets (got ${JSON.stringify(e.credPlan)})`);
    need(
      typeof e.credPreapproved === "object" && e.credPreapproved !== null && (e.credPreapproved as { behavior?: string }).behavior === "allow",
      `① an explicit settings-allow rule pre-approves credential material (got ${JSON.stringify(e.credPreapproved)})`,
    );
    need(
      typeof e.envRead === "object" && e.envRead !== null && (e.envRead as { behavior?: string }).behavior === "allow",
      `① .env is NOT credential material — auto allows (got ${JSON.stringify(e.envRead)})`,
    );

    // ② the chain: peeled bytes land on reasoning AND ride the replay verbatim,
    //    with no frozen re-request in between.
    need(e.peeledReasoning === "INNER", `② the in-band think block must peel into reasoning (got ${JSON.stringify(e.peeledReasoning)})`);
    need(e.replayedReasoning === "INNER", `② the tool-call turn must replay the peeled bytes verbatim as reasoning_content (got ${JSON.stringify(e.replayedReasoning)})`);
    need(e.requestsBeforeReplay === 1, `② exactly one request before the replay call — the peel spares the missing-reasoning frozen re-request (got ${e.requestsBeforeReplay})`);

    // ③ the language blocks: both ride the turn tail in order; ablation kills both.
    need(
      e.driverTail.length === 3 && e.driverTail[0] === "请总结这个项目" && e.driverTail[1] === LANGUAGE_BLOCK_ZH && e.driverTail[2] === REASONING_BLOCK_ZH,
      `③ the Chinese turn tail must be [prompt, language block, reasoning block] (got ${JSON.stringify(e.driverTail)})`,
    );
    need(
      !e.ablatedTail.includes(LANGUAGE_BLOCK_ZH) && !e.ablatedTail.includes(REASONING_BLOCK_ZH),
      `③ WUDAO_NO_LANGUAGE=1 must ablate BOTH blocks (got ${JSON.stringify(e.ablatedTail)})`,
    );

    return errs;
  },
};
