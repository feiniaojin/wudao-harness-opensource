// packages/providers/tests/persona-builtins.test.ts
// Task 4: the five builtin persona definitions transcribed from doc 90
// (docs/research/90-persona-fingerprints.md). Every asserted value below
// carries its doc 90 section in a comment; the assertions lock the
// transcription so later edits cannot silently drift from the doc.
import { describe, it, expect } from "vitest";
import { BUILTIN_PERSONAS } from "../src/persona/builtins.js";
import { validatePersonaDefinition } from "../src/persona/schema.js";
import { loadPersonaRegistry } from "../src/persona/registry.js";

const EXPECTED_IDS = new Set(["anthropic-cli", "openai-responses", "cursor", "multi-wire", "deepseek-native"]);

const byId = (id: string) => {
  const p = BUILTIN_PERSONAS.find((p) => p.id === id);
  if (p === undefined) throw new Error(`builtin persona "${id}" missing`);
  return p;
};

describe("BUILTIN_PERSONAS", () => {
  it("is exactly the five v1 personas", () => {
    expect(new Set(BUILTIN_PERSONAS.map((p) => p.id))).toEqual(EXPECTED_IDS);
    expect(BUILTIN_PERSONAS).toHaveLength(5);
  });

  it("every entry passes the strict schema (JSON round-trip)", () => {
    for (const p of BUILTIN_PERSONAS) {
      const v = validatePersonaDefinition(JSON.parse(JSON.stringify(p)));
      expect(v.ok).toBe(true);
    }
  });

  it("every entry carries non-empty provenance and pinnedVersion (D6 lineage)", () => {
    for (const p of BUILTIN_PERSONAS) {
      expect(p.source.provenance.length).toBeGreaterThan(0);
      expect(p.source.pinnedVersion.length).toBeGreaterThan(0);
    }
  });

  it("all five load through loadPersonaRegistry alongside user files", async () => {
    const r = await loadPersonaRegistry({});
    for (const id of EXPECTED_IDS) {
      expect(r.personas.some((p) => p.id === id)).toBe(true);
    }
    expect(r.errors).toEqual([]);
  });

  it("no builtin header value carries an unresolved ${…} template placeholder", () => {
    // 2026-08-31 lesson: the claude-code/codex UAs were transcribed as source
    // templates verbatim; their ${…} segments have no resolution slot, so they
    // reached the wire unresolved (kimi 后台显示模板原文) and UA-whitelisting
    // providers rejected the runs. Evaluated constants are pinned instead —
    // this locks the whole builtin registry against a recurrence.
    for (const p of BUILTIN_PERSONAS) {
      for (const proto of Object.values(p.headers ?? {})) {
        for (const v of Object.values(proto as Record<string, unknown>)) {
          expect(String(v)).not.toMatch(/\$\{/);
        }
      }
    }
  });

  // --- codex (doc 90 §2; OpenAI Responses protocol) ---

  it("codex pins the byte-verified originator and session-id slot", () => {
    // doc90 §2.1: originator default `wudao_harness` (DEFAULT_ORIGINATOR,
    // default_client.rs:40) — process-level default header, always sent.
    // session-id: current session id on every Responses request
    // (headers.rs:5-13 build_session_headers). NOTE: the header name is
    // hyphenated `session-id` in both doc 90 and the pinned codex-rs source;
    // the task brief's sketch used `session_id`, the doc governs.
    const codex = byId("openai-responses");
    expect(codex.headers.responses?.["originator"]).toBe("wudao_harness");
    expect(codex.headers.responses?.["session-id"]).toBe("{{sessionId}}");
    expect(Object.keys(codex.headers)).toEqual(["responses"]);
  });

  it("codex user-agent is the doc-pinned evaluated form (no unresolved placeholders)", () => {
    // doc90 §2.1: `{originator}/{CARGO_PKG_VERSION} ({os_type} {os_version};
    // {arch}) {terminal_token}` (default_client.rs:164-188); workspace
    // version pinned "0.0.0" (Cargo.toml:140-141). os/arch/terminal are
    // machine values with no slots — pinned to a common macOS/Apple Silicon
    // evaluated form. Unresolved ${…} placeholders on the wire get rejected
    // by UA-whitelisting providers (2026-08-31), same as the the reference harness UA.
    expect(codexUA()).toBe("wudao_harness/0.0.0 (Mac OS 15.5; arm64) Apple_Terminal");
    expect(codexUA()).not.toMatch(/\$\{/);
  });
  function codexUA(): string {
    return byId("openai-responses").headers.responses?.["User-Agent"] as string;
  }

  it("codex body: store=false (always sent, client.rs:946); no other body keys", () => {
    // doc90 §2.2: `store: false` 恒发. reasoning is always-present but its
    // fields are config-determined — not encoded (宁缺毋滥).
    expect(byId("openai-responses").body?.responses).toEqual({ store: false });
  });

  it("openai-responses prompt: prefix mode with the pinned base-instructions opening", () => {
    // doc90 §2.3: default.md:1 opening; the rest of default.md
    // ("+能力清单等") is not transcribed in doc 90, so prefix (identity
    // head), not a truncated snapshot.
    expect(byId("openai-responses").prompt?.system).toEqual({
      mode: "prefix",
      text: "You are a coding agent running in a terminal-based coding assistant powered by the OpenAI Responses API. You are expected to be precise, safe, and helpful.",
    });
  });

  // --- the reference harness (doc 90 §1; Anthropic Messages protocol) ---

  it("the reference harness headers live on the anthropic protocol and look like CC", () => {
    const cc = byId("anthropic-cli");
    expect(Object.keys(cc.headers)).toEqual(["anthropic"]);
    expect(cc.headers.anthropic?.["anthropic-version"]).toBe("2023-06-01"); // doc90 §1.1
    expect(cc.headers.anthropic?.["user-agent"]).toMatch(/^wudao-harness\//); // doc90 §1.1 (http.ts:34)
    expect(cc.headers.anthropic?.["x-app"]).toBe("cli"); // doc90 §1.1 (client.ts:106)
    expect(cc.headers.anthropic?.["X-Claude-Code-Session-Id"]).toBe("{{sessionId}}"); // doc90 §1.1 (client.ts:108)
  });

  it("the reference harness user-agent is the doc-pinned evaluated form (no unresolved placeholders)", () => {
    // doc90 §1.1 row 1 (http.ts:34): getUserAgent() evaluated at the pinned
    // build — ${MACRO.VERSION}→npm 2.1.88, external=npm USER_TYPE, cli=
    // entrypoint default, empty agent-sdk/client-app/workload suffixes.
    // The template verbatim leaked unresolved ${…} to the wire (user report
    // 2026-08-31: kimi 后台显示模板原文) — UA-whitelisting providers reject
    // it, so the evaluated constant is pinned instead.
    expect(byId("anthropic-cli").headers.anthropic?.["user-agent"]).toBe(
      "wudao-harness/2.1.88 (external, cli)",
    );
    expect(byId("anthropic-cli").headers.anthropic?.["user-agent"]).not.toMatch(/\$\{/);
  });

  it("the reference harness anthropic-beta carries only the non-haiku-always beta", () => {
    // doc90 §1.1 beta table: `claude-code-20250219` is always sent for
    // non-haiku models (betas.ts:3); every other beta is model/identity/
    // feature-conditional and therefore not encoded.
    expect(byId("anthropic-cli").headers.anthropic?.["anthropic-beta"]).toBe("claude-code-20250219");
  });

  it("the reference harness body: none (all §1.2 rows conditional or wire-mechanical)", () => {
    expect(byId("anthropic-cli").body).toBeUndefined();
  });

  it("the reference harness prompt: prefix mode with the pinned interactive prefix", () => {
    // doc90 §1.3 (system.ts:10) — DEFAULT_PREFIX; the billing first block is
    // not transcribable (fingerprint component unpinned) and full sections
    // are not pinned, so prefix, not snapshot.
    expect(byId("anthropic-cli").prompt?.system).toEqual({
      mode: "prefix",
      text: "You are Anthropic CLI, Anthropic's official CLI agent.",
    });
  });

  // --- cursor (doc 90 §5; community-reverse-engineered, no prompt) ---

  it("cursor is marked community-reverse-engineered; source-kind others", () => {
    const cursor = byId("cursor");
    expect(cursor.confidence).toBe("community-reverse-engineered");
    expect(cursor.source.kind).toBe("external-research");
  });

  it("cursor headers: cross-confirmed multi-source subset only, no prompt, no body", () => {
    // doc90 §5.1 — only S1+S2(+S3) cross-confirmed, non-auth, non-corrupting
    // headers. Single-source rows and the checksum cipher are omitted (no
    // schema slot for per-header single-source flags / machine identity).
    const cursor = byId("cursor");
    expect(Object.keys(cursor.headers)).toEqual(["openai-chat"]);
    expect(cursor.headers["openai-chat"]).toEqual({
      "connect-protocol-version": "1",
      "connect-accept-encoding": "gzip",
      "x-cursor-client-version": "2.6.22", // doc90 pinned table: reverse-engineering target Cursor IDE v2.6.22
      "x-cursor-client-type": "ide",
      "x-session-id": "{{sessionId}}",
      "x-request-id": "{{uuid}}",
    });
    expect(cursor.prompt).toBeUndefined(); // doc90 §5.3: 未定 — never guess
    expect(cursor.body).toBeUndefined();
  });

  // --- multi-wire (doc 90 §4; multi-protocol) ---

  it("multi-wire spans anthropic/responses/openai-chat with session headers on each", () => {
    // doc90 §4.1 rows 1-3 (llm.ts:209-211): every LLM request carries the
    // session headers regardless of protocol; x-parent-session-id is
    // child-session-conditional and omitted.
    const oc = byId("multi-wire");
    expect(new Set(Object.keys(oc.headers))).toEqual(new Set(["anthropic", "responses", "openai-chat"]));
    for (const proto of ["responses", "openai-chat"] as const) {
      expect(oc.headers[proto]).toEqual({ "x-session-affinity": "{{sessionId}}", "X-Session-Id": "{{sessionId}}" });
    }
    // anthropic carries the same session headers plus the protocol-scoped beta pair.
    const anth = oc.headers.anthropic!;
    expect(anth["x-session-affinity"]).toBe("{{sessionId}}");
    expect(anth["X-Session-Id"]).toBe("{{sessionId}}");
    expect(Object.keys(anth).filter((k) => k !== "anthropic-beta")).toEqual(["x-session-affinity", "X-Session-Id"]);
  });

  it("multi-wire anthropic-beta is the pinned pair", () => {
    // doc90 §4.1 row 4 (anthropic.ts:13-14) — @ai-sdk/anthropic providers.
    expect(byId("multi-wire").headers.anthropic?.["anthropic-beta"]).toBe(
      "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
    );
  });

  it("multi-wire body: responses store=false only (route-level default)", () => {
    // doc90 §4.2 (openai-responses.ts:990-991,1017-1019). reasoningEffort
    // 'medium' is gpt-5-model-gated in source, not a blanket protocol
    // default — omitted.
    const oc = byId("multi-wire");
    expect(oc.body?.responses).toEqual({ store: false });
    expect(oc.body?.anthropic).toBeUndefined();
    expect(oc.body?.["openai-chat"]).toBeUndefined();
  });

  it("multi-wire prompt: prefix mode with the pinned BUILD_SYSTEM", () => {
    // doc90 §4.3 (agent.ts:12-13); system assembly is [agent.system,
    // baseline] — the agent part leads, hence prefix.
    expect(byId("multi-wire").prompt?.system).toEqual({
      mode: "prefix",
      text: "You are an AI coding agent. Help the user accomplish software engineering tasks by inspecting the workspace, making targeted changes, and using tools according to the configured permissions.",
    });
  });

  // --- the reference harness (doc 90 §3; OpenAI-compatible chat-completions) ---

  it("the reference harness rides openai-chat (relay scenario), not anthropic/responses", () => {
    const dsh = byId("deepseek-native");
    expect(Object.keys(dsh.headers)).toEqual(["openai-chat"]);
  });

  it("the reference harness attribution user-agent is the pinned resolved value", () => {
    // doc90 §3.1 (attribution.ts:53-54 template, :40-44 identity, package
    // manifest 0.1.1-rc.2): `deepseek-harness/${version}
    // (+https://github.com/deepseek-ai/deepseek-harness)`, always sent,
    // cannot be suppressed.
    expect(byId("deepseek-native").headers["openai-chat"]?.["user-agent"]).toBe(
      "wudao-harness/0.4.20 (+https://github.com/feiniaojin/wudao-harness-opensource)",
    );
  });

  it("the reference harness session header uses the sessionId slot; no body overlay", () => {
    // doc90 §3.1: x-deepseek-harness-session-id sent when a sessionId
    // exists. thinking (§3.2) is outside the v1 openai-chat whitelist and is
    // not forced in (disclosed conflict, see task-4 report).
    const dsh = byId("deepseek-native");
    expect(dsh.headers["openai-chat"]?.["x-deepseek-harness-session-id"]).toBe("{{sessionId}}");
    expect(dsh.body).toBeUndefined();
  });

  it("the reference harness prompt: prefix mode with the pinned harness identity", () => {
    // doc90 §3.3 (system-prompt/src/index.ts:358-363): harness:identity
    // section, order -100 — first section of the system prompt.
    expect(byId("deepseek-native").prompt?.system).toEqual({
      mode: "prefix",
      text: "You are an AI agent powered by wudao-harness.",
    });
  });
});
