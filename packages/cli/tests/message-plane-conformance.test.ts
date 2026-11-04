// ω99-66 — message-plane conformance nails (three-channel unification,
// step ①): the six-dimension contract of
// docs/research/107-message-plane-constitution.md pinned against TODAY's
// behavior. Zero behavior change is the point — every assertion restates an
// invariant the channels already uphold (peer M64-A / teams M64-C / mail
// ω99-57 / steer ω99-60), so this file is GREEN now and is the baseline the
// step-② migration must keep green (byte-identical behavior), while step ③
// retires the :328 shadowing nail.
//
// ω99-67 (step-② first cut): peer/teams caps migrated onto the mail import
// — the two local-constant existence pins below became IMPORT-relation pins
// (single source, no numeric coincidence), and the peer/teams plane
// declarations now declare contentCap source "MAIL_CONTENT_MAX_CHARS".
//
// ω99-71 (step-③ ruling, route 1): the name double-occupancy is adjudicated
// as the NAMESPACE EXCLUSIVITY law (107 §3.7) — a loop's tools array must be
// name-unique (dispatch is by FIRST name match); any mount of a message tool
// into a tools array must first strip the same-name flavor (:328 is now the
// compliant INSTANCE, not a patch). The ω99-66 patch-existence nail is
// upgraded into a compliance-PROPERTY nail: every message-tool mount in the
// teams source tree must carry the same-name filter (recursive scan, the
// pattern's shape itself exempts description/preamble/name-list literals).
//
// Cross-family pointers (not duplicated here): deep peer inbound semantics
// — peer-m64a*.test.ts; teams runtime/board/panel — teams-m64c.test.ts;
// parent↔child registry semantics — core tests/omega99-57-mail.test.ts +
// omega99-60-steer.test.ts; steering drain — core loop tests.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync , existsSync } from "node:fs";
import {
  MAIL_CONTENT_MAX_CHARS, createParentMessageTool, PARENT_MESSAGE_TOOL_NAME,
  MAIL_NO_EDGE_ERROR, formatMailText, createMessageChildTool, createSteerMailbox,
  formatSteerText, CHILD_MESSAGE_TOOL_NAME, STEER_FROM_PARENT_PREFIX, STEER_NO_EDGE_ERROR,
  describeMessagePlane, checkMessagePlaneInvariants, buildTool,
  type MessagePlane, type Tool, type ModelClient, type ModelInput, type AssistantMessage,
  type SteerRegistry,
} from "@wudao-org/core";
import {
  createPeerTools, PEER_TEXT_MAX_CHARS, PEER_UNTRUSTED_BANNER, formatPeerInjection,
  type PeerRuntime,
} from "../src/peer/index.js";
import { TEAM_MESSAGE_MAX_CHARS, readTeamInbox } from "../src/teams/mailbox.js";
import { createTeamRuntime, LEAD_NAME, type TeamRuntime } from "../src/teams/runtime.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until<T>(cond: () => T | undefined | false, what: string, timeoutMs = 6000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait(15);
  }
}

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mp66-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const schemaProps = (t: Tool): readonly string[] =>
  Object.keys((t.parameters as { properties?: Record<string, unknown> }).properties ?? {}).sort();

/** Every .ts source under dir (recursive) — the grep-nail scope: the peer/
 *  and teams/ TREES, so a reintroduced 8k literal anywhere in them (not
 *  only where today's constants live) turns the nail red. */
function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

// ---- the three channels declared against the contract (test-side only) ----

const PEER_PLANE = describeMessagePlane({
  id: "peer",
  toolNames: ["send_message"],
  addressing: { syntax: "session name | short id (last 8 / unique ≥4 suffix) | full session id", unresolvedIsTypedRefusal: true },
  delivery: ["between-tool-calls"],
  inbound: { kinds: ["accept", "hold", "refuse"], receipt: "per-message" },
  attribution: { prefixShape: "[peer message from <name> (<id>, tier <tier>) — <banner>]", composedBy: "runtime", modelSuppliedFields: ["to", "text"] },
  contentCap: { maxChars: MAIL_CONTENT_MAX_CHARS, source: "MAIL_CONTENT_MAX_CHARS" }, // ω99-67: PEER_TEXT_MAX_CHARS imports the mail cap
  untrusted: { bannerDeclared: true, cannotApprovePermissions: true, cannotChangeConfig: true, commandsArePlainText: true },
});

const TEAMS_PLANE = describeMessagePlane({
  id: "teams",
  toolNames: ["send_message"],
  addressing: { syntax: "teammate name | \"lead\"", unresolvedIsTypedRefusal: true },
  delivery: ["at-next-model-call"],
  inbound: { kinds: ["accept", "refuse"], receipt: "next-wake" }, // review sidecar may deny (typed)
  attribution: { prefixShape: "[team message from <teammate> — <banner>]", composedBy: "runtime", modelSuppliedFields: ["to", "text"] },
  contentCap: { maxChars: MAIL_CONTENT_MAX_CHARS, source: "MAIL_CONTENT_MAX_CHARS" }, // ω99-67: TEAM_MESSAGE_MAX_CHARS imports the mail cap
  untrusted: { bannerDeclared: true, cannotApprovePermissions: true, cannotChangeConfig: true, commandsArePlainText: true },
});

const PC_PLANE = describeMessagePlane({
  id: "parent-child",
  toolNames: [PARENT_MESSAGE_TOOL_NAME, CHILD_MESSAGE_TOOL_NAME],
  addressing: { syntax: "bg-N (registry-local id from the task receipt / agent_status)", unresolvedIsTypedRefusal: true },
  delivery: ["between-tool-calls", "at-next-model-call"], // mail: parent lane landing; steer: child's next model input
  inbound: { kinds: ["accept", "gate"], receipt: "none" }, // steer rides the child's onPromptSubmit gate (allow/block/rewrite)
  attribution: { prefixShape: "[message from subagent <id> (<role>)] / [steer from parent]", composedBy: "runtime", modelSuppliedFields: ["content", "id"] },
  contentCap: { maxChars: MAIL_CONTENT_MAX_CHARS, source: "MAIL_CONTENT_MAX_CHARS" }, // the true single source
  untrusted: { bannerDeclared: true, cannotApprovePermissions: true, cannotChangeConfig: true, commandsArePlainText: true },
});

const PLANES: readonly MessagePlane[] = [PEER_PLANE, TEAMS_PLANE, PC_PLANE];

// The live model fields per tool (the plane stores the channel union).
const MODEL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  send_message: ["text", "to"],
  [PARENT_MESSAGE_TOOL_NAME]: ["content"],
  [CHILD_MESSAGE_TOOL_NAME]: ["content", "id"],
};

// ---- harness stubs ----------------------------------------------------------

/** A minimal inert PeerRuntime — createPeerTools only touches refusal /
 *  sessionId / listAgents / send (validation runs BEFORE any of them). */
function stubPeerRuntime(over: { refusal?: string; send?: PeerRuntime["send"] } = {}): PeerRuntime {
  const base = {
    refusal: undefined as string | undefined,
    sessionId: "sess-mp66",
    socketPath: undefined,
    token: undefined,
    entry: undefined,
    approvalSink: { current: undefined },
    takeInjection: () => undefined,
    pendingHolds: () => [],
    answer: () => false,
    sweepHolds: () => [],
    listAgents: async () => [],
    send: async () => ({ ok: true, line: "stubbed" }),
    rename: async () => {},
    setTier: async () => {},
    stop: async () => {},
  };
  return { ...base, ...over } as unknown as PeerRuntime;
}

const stubTaskTool: Tool = buildTool({
  name: "task",
  description: "stub task",
  parameters: { type: "object" as const, properties: { description: { type: "string" as const }, prompt: { type: "string" as const } }, additionalProperties: true },
  async execute() { return { content: "spawned" }; },
});

/** A queue-fed scripted model; call 0 blocks until openGate() (a busy run). */
function gatedModel(responses: readonly AssistantMessage[], inputs: ModelInput[] = []): ModelClient & { inputs: ModelInput[]; openGate: () => void } {
  let i = 0;
  let openGate: () => void = () => {};
  const gate = new Promise<void>((r) => { openGate = r; });
  return {
    inputs,
    openGate,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      if (i === 0) await gate;
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

function makeTeam(over: Partial<Parameters<typeof createTeamRuntime>[0]> = {}): TeamRuntime {
  return createTeamRuntime({
    workspaceRoot: root,
    team: "alpha",
    sessionId: "s-mp66",
    model: gatedModel([{ role: "assistant", content: "ok" }]),
    tools: [],
    taskTool: () => stubTaskTool,
    notify: () => {},
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Shared invariants (the cross-channel laws)
// ---------------------------------------------------------------------------

describe("ω99-66 message-plane conformance — shared invariants", () => {
  it("all three channel declarations satisfy checkMessagePlaneInvariants (the contract, typed)", () => {
    for (const plane of PLANES) {
      expect(checkMessagePlaneInvariants(plane), plane.id).toEqual([]);
    }
  });

  it("the 8k cap is value-unified across all three channels (one constitutional value)", () => {
    expect(MAIL_CONTENT_MAX_CHARS).toBe(8000);
    expect(PEER_TEXT_MAX_CHARS).toBe(MAIL_CONTENT_MAX_CHARS);
    expect(TEAM_MESSAGE_MAX_CHARS).toBe(MAIL_CONTENT_MAX_CHARS);
  });

  it("the cap TOPOLOGY after ω99-67: mail is the source; steer, peer, and teams all hold it by IMPORT — no assignment-shaped 8k literal anywhere in the peer/teams source trees", () => {
    const mail = readFileSync(join(import.meta.dirname, "../../core/src/agents/mail.ts"), "utf8");
    const steer = readFileSync(join(import.meta.dirname, "../../core/src/agents/steer.ts"), "utf8");
    const proto = readFileSync(join(import.meta.dirname, "../src/peer/protocol.ts"), "utf8");
    const mbox = readFileSync(join(import.meta.dirname, "../src/teams/mailbox.ts"), "utf8");
    expect(mail).toMatch(/export const MAIL_CONTENT_MAX_CHARS = 8_000;/);
    expect(steer).toMatch(/import \{ MAIL_CONTENT_MAX_CHARS \} from "\.\/mail\.js";/);
    expect(steer).toMatch(/export \{ MAIL_CONTENT_MAX_CHARS \} from "\.\/mail\.js";/);
    // IMPORT relations (ω99-67, 107 §3.5 closed): the former local constants
    // are now definitions over the imported constitutional value — names
    // kept (the peer/teams export ABI is untouched), the VALUE single-
    // sourced. A regression back to a numeric literal must go red here.
    expect(proto).toMatch(/import \{ MAIL_CONTENT_MAX_CHARS \} from "@wudao-org\/core";/);
    expect(proto).toMatch(/export const PEER_TEXT_MAX_CHARS = MAIL_CONTENT_MAX_CHARS;/);
    expect(mbox).toMatch(/import \{ MAIL_CONTENT_MAX_CHARS \} from "@wudao-org\/core";/);
    expect(mbox).toMatch(/export const TEAM_MESSAGE_MAX_CHARS = MAIL_CONTENT_MAX_CHARS;/);
    // And NO assignment-shaped 8k literal anywhere under the peer/ and
    // teams/ trees: the cap may only enter them through the import. The
    // pin bans `= 8_000` / `= 8000` (the assignment shape), NOT the bare
    // digits — tool description strings ("≤8000 chars") are model-visible
    // contract text that stays byte-identical; that exemption is expressed
    // by the pattern's shape itself, not by a file allowlist.
    for (const dir of [join(import.meta.dirname, "../src/peer"), join(import.meta.dirname, "../src/teams")]) {
      for (const f of sourceFiles(dir)) {
        expect(readFileSync(f, "utf8"), f).not.toMatch(/=\s*8[_,]?000\b/);
      }
    }
  });

  it("attribution is unforgeable: every live tool's schema carries exactly the declared model fields — no prefix/sender/banner field on any channel", () => {
    const team = makeTeam();
    try {
      const live: readonly Tool[] = [
        ...createPeerTools(stubPeerRuntime()),
        team.sendToolFor("books"),
        createParentMessageTool(),
        createMessageChildTool(),
      ];
      for (const tool of live) {
        const expected = MODEL_FIELDS[tool.name];
        if (expected === undefined) continue; // list_agents etc. — discovery, not message tools
        expect(schemaProps(tool), tool.name).toEqual([...expected].sort());
        for (const field of schemaProps(tool)) {
          expect(/prefix|sender|banner|from|attribution/i.test(field), `${tool.name}.${field}`).toBe(false);
        }
      }
    } finally {
      team.stop();
    }
  });

  it("the three runtime-side prefix shapes exist and are channel-distinct (peer/teams render, mail/steer format)", () => {
    expect(formatPeerInjection({
      id: "m1", senderId: "wudao-deadbeef", senderName: "web-a7", senderTier: "normal",
      text: "hi", receivedAt: 0, kind: "peer",
    })).toMatch(new RegExp(`^\\[peer message from web-a7 \\(wudao-de, tier normal\\) — ${PEER_UNTRUSTED_BANNER.slice(0, 24)}`));
    expect(formatMailText("child-1", "scout", "found it")).toBe("[message from subagent child-1 (scout)]\nfound it");
    expect(formatSteerText("course correct")).toBe("[steer from parent]\ncourse correct");
    expect(STEER_FROM_PARENT_PREFIX).toBe("[steer from parent]");
  });

  it("the contract base is pure additive: ≤150 lines, imports only mail's cap (no new dependencies)", () => {
    const src = readFileSync(join(import.meta.dirname, "../../core/src/agents/message-plane.ts"), "utf8");
    expect(src.split("\n").length).toBeLessThanOrEqual(150);
    const imports = src.match(/from "[^"]+"/g) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((s) => s === 'from "./mail.js"')).toBe(true);
  });

  // 开源仓不带 docs/research（内部研究档案，同步脚本有意不拷）——公开树上
  // 此钉如实显示 skipped；内部树继续全钉。
  it.skipIf(!existsSync(join(import.meta.dirname, "../../../docs/research/107-message-plane-constitution.md")))("docs/research/107 exists with the six dimensions, the name double-occupancy record, and the three-step roadmap", () => {
    const doc = readFileSync(join(import.meta.dirname, "../../../docs/research/107-message-plane-constitution.md"), "utf8");
    expect(doc).toContain("寻址");
    expect(doc).toContain("送达");
    expect(doc).toContain("入站");
    expect(doc).toContain("attribution");
    expect(doc).toContain("MAIL_CONTENT_MAX_CHARS");
    expect(doc).toContain("UNTRUSTED");
    expect(doc).toContain("双占");
    expect(doc).toContain("遮蔽");
    expect(doc).toContain("第①步");
    expect(doc).toContain("第②步");
    expect(doc).toContain("第③步");
    // ω99-71: the namespace law (§3.7) and the step-③ ruling are on the page.
    expect(doc).toContain("工具名字空间律");
    expect(doc).toContain("名字唯一");
    expect(doc).toContain("组装点负责");
    expect(doc).toContain("路线 1 采纳，路线 2 否决");
  });

  it("ω99-71 namespace law: every message-tool mount in the teams source tree strips the same name first — a loop's tools array is name-unique (dispatch is by FIRST name match)", () => {
    // Law premise (107 §3.7c): the loop dispatches by first name match, so a
    // same-name entry after the first is silently shadowed — the mount, not
    // the dispatcher, must resolve the collision.
    const loopSrc = readFileSync(join(import.meta.dirname, "../../core/src/loop.ts"), "utf8");
    expect(loopSrc).toMatch(/tools\.find\(\(t\) => t\.name === call\.name\)/);
    // The compliance PROPERTY (107 §3.7a/b), ω99-67-style recursive tree
    // scan: any point in the teams tree that mounts a message tool into a
    // tools array — an array literal spreading an existing array, appending
    // a message-tool-shaped element (sendTool, sendToolFor("x"),
    // parentMessageTool, …) — MUST strip the same-name flavor first.
    //   mount = [ ...<spread>, <message-tool element> ]
    //   strip = a .filter((x) => x.name !== "<name>") over the spread part.
    // The mount shape itself carries the literal exemption: strings that
    // merely MENTION send_message (tool descriptions, preamble text, error
    // lines, role name-lists like [...roleTools, "send_message"]) cannot
    // match it — no file allowlist, same philosophy as the 8k assignment-
    // shape nail above.
    const MOUNT = /\[[^\][{}]*\.\.\.[^\]]*,\s*\w*(?:send|message|mail)\w*Tool\w*(?:\([^()[\]]*\))?\s*\]/g;
    const STRIP = /\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.name\s*!==\s*"[^"]+"\s*\)/;
    let mounts = 0;
    for (const f of sourceFiles(join(import.meta.dirname, "../src/teams"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(MOUNT)) {
        mounts += 1;
        expect(m[0], `${f}: message-tool mount without a same-name strip (107 §3.7b)`).toMatch(STRIP);
      }
    }
    // Positive anchor — the scan must not pass vacuously: the compliant
    // instance exists (the mount that strips "send_message" before mounting
    // the teams flavor). If the mount's identifiers are ever renamed out of
    // the scan's shape, this goes red and the shape must be re-derived.
    expect(mounts).toBeGreaterThanOrEqual(1);
    const rt = readFileSync(join(import.meta.dirname, "../src/teams/runtime.ts"), "utf8");
    expect(rt).toMatch(/\[\s*\.\.\.tools\.filter\(\(x\) => x\.name !== "send_message"\),\s*sendTool\s*\]/);
  });
});

// ---------------------------------------------------------------------------
// Peer channel (M64-A)
// ---------------------------------------------------------------------------

describe("ω99-66 conformance — peer channel (M64-A)", () => {
  it("to/text validation order: shape first, to BEFORE text — typed refusals before any side effect", async () => {
    const send = createPeerTools(stubPeerRuntime()).find((t) => t.name === "send_message")!;
    const r1 = await send.execute({ to: "", text: "" });
    expect(r1.isError).toBe(true);
    expect(r1.content).toContain('send_message: "to" must be a session name or id');
    const r2 = await send.execute({ to: "web-a7", text: "" });
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain('send_message: "text" is empty');
  });

  it("a refusal runtime (kill switch / sandbox) answers both tools with the typed unavailable line", async () => {
    const tools = createPeerTools(stubPeerRuntime({ refusal: "disabled (WUDAO_DISABLE_PEER=1)" }));
    const list = tools.find((t) => t.name === "list_agents")!;
    const send = tools.find((t) => t.name === "send_message")!;
    const rl = await list.execute({});
    expect(rl.isError).toBe(true);
    expect(rl.content).toBe("agent messaging unavailable: disabled (WUDAO_DISABLE_PEER=1)");
    const rs = await send.execute({ to: "web-a7", text: "hello" });
    expect(rs.isError).toBe(true);
    expect(rs.content).toBe("agent messaging unavailable: disabled (WUDAO_DISABLE_PEER=1)");
  });

  it("the model-visible contract declarations ride the tool face: UNTRUSTED semantics, the 8k cap, between-tool-calls delivery, the addressing grammar", () => {
    const send = createPeerTools(stubPeerRuntime()).find((t) => t.name === "send_message")!;
    expect(send.description).toContain("UNTRUSTED");
    expect(send.description).toContain("never interrupts a running tool");
    const params = send.parameters as { properties: Record<string, { description: string }> };
    expect(params.properties.to!.description).toContain("short id");
    expect(params.properties.text!.description).toContain("≤8000 chars");
    // Delivery-timing semantics (deep behavior: the UDS inbox + steering
    // drain) are pinned by peer-m64a*.test.ts — this nails the declared face.
  });
});

// ---------------------------------------------------------------------------
// Teams channel (M64-C)
// ---------------------------------------------------------------------------

describe("ω99-66 conformance — teams channel (M64-C)", () => {
  it("send to the lead renders the banner-prefixed attribution runtime-side (renderMail composes; the text is stored bare)", async () => {
    const lines: string[] = [];
    const team = makeTeam({ notify: (l) => lines.push(l) });
    try {
      const r = await team.send("books", LEAD_NAME, "status report");
      expect(r.ok).toBe(true);
      const rendered = lines.find((l) => l.startsWith(`[team message from books — `));
      expect(rendered).toBeDefined();
      expect(rendered!).toContain(PEER_UNTRUSTED_BANNER);
      expect(rendered!).toContain("status report");
      const leadInbox = await readTeamInbox(join(root, ".wudao", "teams", "alpha"), LEAD_NAME);
      expect(leadInbox.map((e) => e.text)).toContain("status report"); // stored BARE — prefix composed at render
    } finally {
      team.stop();
    }
  });

  it("WAITING wake semantics: a busy teammate reads at its next wake; an idle (waiting) one wakes immediately — delivery NEVER interrupts the running tool", async () => {
    const inputs: ModelInput[] = [];
    const model = gatedModel([
      { role: "assistant", content: "working" },
      { role: "assistant", content: "done" },
      { role: "assistant", content: "done" },
    ], inputs);
    const team = makeTeam({ model });
    try {
      const spawn = await team.spawnTeammate({ name: "books", role: "general-purpose", prompt: "organize" });
      expect(spawn.ok).toBe(true);
      await until(() => (team.teammates().find((t) => t.name === "books")?.status === "working" ? true : undefined), "brief run starts (gated)");
      // busy: the message lands in the mailbox; the run is NOT interrupted
      const busy = await team.send("lead", "books", "ping-1");
      expect(busy.ok).toBe(true);
      expect(busy.line).toContain("busy — it reads the message at its next wake");
      model.openGate();
      await until(() => (inputs.length >= 2 ? true : undefined), "wake dispatch renders the mail");
      // A resume dispatch (dispatches>0) rides the `[resume] ` steering line —
      // the rendered mail (prefix + banner) is carried inside it verbatim.
      const wakePrompt = inputs[1]!.messages.find((m) => m.role === "user" && m.content.includes("ping-1"));
      expect(wakePrompt?.content).toContain(`[team message from lead — `);
      expect(wakePrompt?.content).toContain(PEER_UNTRUSTED_BANNER);
      await until(() => (team.teammates().find((t) => t.name === "books")?.status === "idle" ? true : undefined), "run settles idle");
      // idle (WAITING): the wake is immediate — same rail, no busy gap
      const wake = await team.send("lead", "books", "ping-2");
      expect(wake.ok).toBe(true);
      expect(wake.line).toContain("waking it now");
      await until(() => (inputs.length >= 3 ? true : undefined), "immediate wake dispatch");
      expect(inputs[2]!.messages.some((m) => m.role === "user" && m.content.includes("ping-2"))).toBe(true);
    } finally {
      team.stop();
    }
  }, 15_000);

  it("the :328 mount is the law's compliant INSTANCE (ω99-71): the peer flavor is stripped before the teams flavor is mounted — behavioral evidence (the static law nail lives in shared invariants)", async () => {
    // ω99-71: the ω99-66 static existence nail (the patch shape) is upgraded
    // into the namespace-law compliance-PROPERTY nail in the shared
    // invariants above (tree-wide mount scan + first-match premise + the
    // positive anchor on this very line). What remains HERE is the
    // behavioral half — proof that the strip actually decides which flavor
    // the loop dispatches when a pool send_message (peer flavor) is present.
    // behavioral: a pool send_message (the peer flavor) never reaches the
    // teammate — the team flavor is the one the loop dispatches
    const fired: string[] = [];
    const marker: Tool = buildTool({
      name: "send_message",
      description: "MARKER peer-flavor send_message",
      parameters: { type: "object" as const, properties: { to: { type: "string" as const }, text: { type: "string" as const } }, required: ["to", "text"], additionalProperties: false },
      async execute(args) { fired.push(String(args.text)); return { content: "MARKER-PEER-FLAVOR" }; },
    });
    const inputs: ModelInput[] = [];
    const model = gatedModel([
      { role: "assistant", content: "reporting", toolCalls: [{ id: "c1", name: "send_message", arguments: { to: LEAD_NAME, text: "shadow check" } }] },
      { role: "assistant", content: "done" },
    ], inputs);
    const team = makeTeam({ model, tools: [marker] });
    try {
      const spawn = await team.spawnTeammate({ name: "books", role: "general-purpose", prompt: "report to the lead" });
      expect(spawn.ok).toBe(true);
      model.openGate();
      await until(() => (team.teammates().find((t) => t.name === "books")?.status === "idle" ? true : undefined), "teammate settles");
      expect(fired).toEqual([]); // the marker NEVER ran
      const leadInbox = await readTeamInbox(join(root, ".wudao", "teams", "alpha"), LEAD_NAME);
      expect(leadInbox.map((e) => e.text)).toContain("shadow check"); // the TEAM flavor ran
      const seen = inputs[0]!.tools.filter((t) => t.name === "send_message");
      expect(seen.length).toBe(1); // stripped, not shadowed
      expect(seen[0]!.description).toContain("mailbox"); // team flavor, not the marker
      expect(seen[0]!.description).not.toContain("MARKER");
    } finally {
      team.stop();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Parent↔child channel (ω99-57 mail / ω99-60 steer)
// ---------------------------------------------------------------------------

describe("ω99-66 conformance — parent↔child channel (ω99-57/60)", () => {
  it("FIFO: the steer mailbox delivers in submission order and drains to undefined — the exact face the loop's steering seam consumes (deep registry semantics: omega99-60-steer.test.ts)", () => {
    const box = createSteerMailbox();
    box.submit("first");
    box.submit("second");
    box.submit("third");
    expect([box.take(), box.take(), box.take()]).toEqual(["first", "second", "third"]);
    expect(box.take()).toBeUndefined();
    expect(box.take()).toBeUndefined(); // take-until-undefined — the drain law
  });

  it("absent edges are typed refusals, never silent drops (no scope / no registry / the registry's own typed reason)", async () => {
    const rp = await createParentMessageTool().execute({ content: "mid-run finding" });
    expect(rp.isError).toBe(true);
    expect(rp.content).toBe(MAIL_NO_EDGE_ERROR);
    const rc = await createMessageChildTool().execute({ id: "bg-1", content: "course correct" });
    expect(rc.isError).toBe(true);
    expect(rc.content).toBe(STEER_NO_EDGE_ERROR);
    const rejecting: SteerRegistry = { steer(id: string): void { throw new Error(`unknown or settled child ${id}`); } };
    const rr = await createMessageChildTool(rejecting).execute({ id: "bg-9", content: "x" });
    expect(rr.isError).toBe(true);
    expect(rr.content).toContain("message_child failed: unknown or settled child bg-9");
  });

  it("the 8k cap is ENFORCED with typed refusals on both directions (MAIL_CONTENT_MAX_CHARS, not a description-only bound)", async () => {
    const over = "x".repeat(MAIL_CONTENT_MAX_CHARS + 1);
    const rp = await createParentMessageTool().execute({ content: over });
    expect(rp.isError).toBe(true);
    expect(rp.content).toContain(`exceeds ${MAIL_CONTENT_MAX_CHARS} chars (got ${over.length})`);
    const rc = await createMessageChildTool().execute({ id: "bg-1", content: over });
    expect(rc.isError).toBe(true);
    expect(rc.content).toContain(`exceeds ${MAIL_CONTENT_MAX_CHARS} chars (got ${over.length})`);
  });

  it("content-shape validation precedes everything (typed, before cap, before edge resolution)", async () => {
    const rp = await createParentMessageTool().execute({ content: "   " });
    expect(rp.isError).toBe(true);
    expect(rp.content).toContain('message_parent: "content" must be a non-empty string');
    const rc = await createMessageChildTool().execute({ id: "  ", content: "x" });
    expect(rc.isError).toBe(true);
    expect(rc.content).toContain('message_child: "id" must be a non-empty string');
  });
});
