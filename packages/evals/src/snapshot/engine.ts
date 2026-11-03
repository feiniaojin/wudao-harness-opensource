// M71 §1 — snapshot record/replay engine (research 36 §8, dsh's keyless
// snapshot design): record once WITH a key against the REAL provider, replay
// forever WITHOUT one.
//
// The capture point is the provider's fetch boundary — every request the
// real assembly code produces (raw body bytes + headers) and every response
// payload the endpoint returned (verbatim SSE/JSON text). Replay re-runs the
// SAME scenario code through the SAME loop + provider assembly, serving the
// recorded responses from a fake fetch, then diffs:
//   1. prompts[]  — normalizeText(serializePrompt(input)): the canonical
//      serializer's bytes, per model call (THE prompt-assembly net);
//   2. requests[] — the normalized raw request bodies per HTTP call;
//   3. transcript — the final message lists of both loop phases;
//   4. session    — the persisted JSONL entries (read back from disk).
// Any divergence is a prompt-assembly regression caught keylessly.
//
// M71 §2 — the negative prompt-injection canary rides every scenario: a
// persistence-only session entry carrying INJECTION_MARKER is appended
// between the two phases, the second phase resumes through the REAL
// store.load() (which must filter non-message entries out), and every
// captured request — header values, raw body, prompt bytes — is asserted to
// never contain the marker.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runAgentLoop,
  createJsonlSessionStore,
  isFormatMarker,
  type AgentMessage,
  type AgentState,
  type LoopEvent,
  type LoopOptions,
  type ModelClient,
  type ModelInput,
  type Terminal,
  type Tool,
} from "@wudao-org/core";
import { createOpenAICompatibleProvider, serializePrompt, type ProviderConfig } from "@wudao-org/providers";
import { containsMarker, diffPromptBytes, diffValues, INJECTION_MARKER, normalizeText, normalizeValue } from "./normalize.js";

/** Fixture schema version — replay refuses unknown versions loudly. */
export const SNAPSHOT_FIXTURE_VERSION = 1;

/** The marker-bearing persistence-only entry appended between the phases. */
const MARKER_ENTRY_TYPE = "local_notice";

// ---------------------------------------------------------------------------
// Fixture shapes
// ---------------------------------------------------------------------------

/** One recorded HTTP exchange at the provider boundary. */
export interface RecordedRequest {
  /** Normalized parsed request body (volatile fields stripped). */
  readonly body: unknown;
  /** Header names → values, authorization REDACTED (no secrets on disk). */
  readonly headers: Record<string, string>;
  /** The verbatim response payload replayed keylessly later. */
  readonly response: { readonly status: number; readonly contentType: string; readonly text: string };
}

/** One persisted-transcript line of transcript.jsonl. */
export type TranscriptLine =
  | { readonly kind: "meta"; readonly version: number; readonly scenario: string }
  | { readonly kind: "message"; readonly phase: 1 | 2; readonly message: unknown }
  | { readonly kind: "terminal"; readonly phase: 1 | 2; readonly reason: string };

export interface SnapshotFixture {
  readonly version: number;
  readonly scenario: string;
  /** The resolved provider config the run used, apiKey stripped. Replay
   *  reconstructs its client from this so request assembly + response
   *  parsing are byte-faithful to the recording. */
  readonly config: Record<string, unknown>;
  /** The RECORDING run's workspace root (raw, un-normalized). Models some-
   *  times embed the absolute working directory into tool-call arguments —
   *  those bytes ride the recorded responses verbatim, so replay REWRITES
   *  this root to its own before serving (see rewriteResponseText). */
  readonly recordWorkspaceRoot: string;
  readonly requests: readonly RecordedRequest[];
  /** normalizeText(serializePrompt(input)) per model call. */
  readonly prompts: readonly string[];
  readonly transcript: readonly TranscriptLine[];
  /** The persisted session JSONL entries, normalized, in file order. */
  readonly session: readonly unknown[];
}

/** Everything one run (record OR replay) captured. */
export interface CapturedRun {
  readonly scenario: string;
  readonly workspaceRoot: string;
  readonly requests: readonly RecordedRequest[];
  readonly prompts: readonly string[];
  readonly transcript: readonly TranscriptLine[];
  readonly session: readonly unknown[];
  /** M71 §2: marker sightings in assembled requests — must always be []. */
  readonly markerLeaks: readonly string[];
}

// ---------------------------------------------------------------------------
// Scenario shape
// ---------------------------------------------------------------------------

/** What a scenario's setup hands the engine. */
export interface SnapshotScenarioBuild {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly tools: readonly Tool[];
  /** Extra loop options (compaction budgets, …) — identical in both modes. */
  readonly loopOptions?: LoopOptions;
  /** Phase-2 prompt: appended after the resume through store.load(). */
  readonly resumePrompt: string;
}

/** A snapshot scenario: name = fixture dir, setup fills a fresh temp
 *  workspace and returns the run parameters. Deterministic by contract —
 *  the same code path runs in record and replay. */
export interface SnapshotScenario {
  readonly name: string;
  /** Fixed session id (SESSION_ID_RE-safe) for the persisted JSONL. */
  readonly sessionId: string;
  setup(workspaceRoot: string): Promise<SnapshotScenarioBuild>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** packages/evals/snapshots — fixtures live IN the repo, committed, replayed
 *  keylessly by `pnpm test`. Resolved from this module so cwd never matters. */
export function snapshotsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "snapshots");
}

export function scenarioDir(name: string): string {
  return join(snapshotsRoot(), name.replace(/[^A-Za-z0-9_-]/g, "_"));
}

// ---------------------------------------------------------------------------
// Fetch wrappers
// ---------------------------------------------------------------------------

/** Redact the authorization value; keep names + other values (marker scans
 *  run over them). Input may be Headers | Record | array of pairs. */
function redactHeaders(input: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (input === undefined) return out;
  const h = input as Iterable<[string, string]> | Record<string, string>;
  if (typeof (h as Iterable<[string, string]>)[Symbol.iterator] === "function") {
    for (const [k, v] of h as Iterable<[string, string]>) {
      out[k] = k.toLowerCase() === "authorization" ? "<REDACTED>" : String(v);
    }
  } else {
    for (const [k, v] of Object.entries(h as Record<string, string>)) {
      out[k] = k.toLowerCase() === "authorization" ? "<REDACTED>" : String(v);
    }
  }
  return out;
}

/** Response statuses that must carry a null body — constructing one with a
 *  body throws, and a replayed 204 must not crash the replay fetch. */
function nullBodyStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function responseFromText(status: number, contentType: string, text: string): Response {
  return new Response(nullBodyStatus(status) ? null : text, {
    status,
    headers: { "content-type": contentType },
  });
}

// ---------------------------------------------------------------------------
// The run (shared by record and replay)
// ---------------------------------------------------------------------------

export interface RunScenarioOptions {
  /** Record: the resolved real config + global fetch. Synthetic tests inject
   *  a fake upstream here; replay builds its own serving fetch instead. */
  readonly config: Record<string, unknown>;
  readonly upstreamFetch: typeof fetch;
  /** Cooperative cancellation for the loops (record passes a wall clock). */
  readonly signal?: AbortSignal;
  /** Per-phase loop turn budget. Default 12. */
  readonly maxTurns?: number;
  /** Replay path-rewrite source: the RECORDING run's workspace root. When
   *  set, every response payload's occurrences of it are rewritten to THIS
   *  run's workspace root before the provider parses the payload — recorded
   *  tool-call arguments that embed the absolute working directory then
   *  behave identically (same tool acceptance, same error bytes once
   *  normalized) instead of escaping this run's workspace. */
  readonly rewriteFromRoot?: string;
}

/** Rewrite a recorded response payload from the recording's workspace root
 *  to the replaying run's (plain prefix swap — the roots are absolute paths,
 *  and both sides normalize to <WORKSPACE> before any diff). */
export function rewriteResponseText(text: string, fromRoot: string, toRoot: string): string {
  if (fromRoot === "" || fromRoot === toRoot) return text;
  let out = text.split(fromRoot).join(toRoot);
  // win32: the payload is JSON text where every `\` in a path is escaped to
  // `\\` — the plain-sep swap misses those occurrences, so swap the
  // JSON-escaped spelling too (no-op on posix roots).
  if (fromRoot.includes("\\")) {
    out = out.split(fromRoot.split("\\").join("\\\\")).join(toRoot.split("\\").join("\\\\"));
  }
  return out;
}

/** The config fields that carry credential material: the single key AND the
 *  M56 pool (`resolveProviderConfigResult` returns both — stripping only
 *  `apiKey` is exactly how the real dev key landed in the first fixtures).
 *  Applied at BOTH ends: fixtures are WRITTEN sanitized, and replay builds
 *  its client from a sanitized config plus one dummy key, so a stale fixture
 *  can never engage a real key pool. Key fields never affect request bytes
 *  (they ride the authorization header only), so this is diff-neutral. */
const CREDENTIAL_CONFIG_FIELDS = ["apiKey", "apiKeys"] as const;

/** Copy of `config` with every credential field removed. */
export function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const f of CREDENTIAL_CONFIG_FIELDS) delete out[f];
  return out;
}

/** The diffable view of captured headers: everything except authorization
 *  (which is "<REDACTED>" on both sides by construction — excluded so the
 *  comparison never couples to the redaction token). */
function headersMinusAuthorization(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "authorization") continue;
    out[k] = v;
  }
  return out;
}

async function drainLoop(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> {
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return value;
  }
}

/** Wrap a ModelClient so every model call's canonical prompt bytes are
 *  captured (generate AND stream — the loop prefers stream). */
function capturePrompts(provider: ModelClient, sink: (bytes: string) => void): ModelClient {
  const record = (input: ModelInput): void => sink(serializePrompt(input));
  const stream = provider.stream?.bind(provider);
  const generate = provider.generate.bind(provider);
  return {
    async generate(input: ModelInput) {
      record(input);
      return generate(input);
    },
    ...(stream
      ? {
          async *stream(input: ModelInput) {
            record(input);
            yield* stream(input);
          },
        }
      : {}),
  };
}

/** Run one scenario end-to-end: two loop phases around a marker-bearing
 *  persistence boundary, capturing requests/prompts/transcript/session. The
 *  ONLY difference between record and replay is where responses come from. */
export async function runSnapshotScenario(
  scenario: SnapshotScenario,
  options: RunScenarioOptions,
): Promise<CapturedRun> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `wudao-snap-${scenario.sessionId}-`));
  // Isolate the user-global project-context tier (~/.wudao/WUDAO.md via
  // os.homedir()): fixtures must not bake in one machine's personal context.
  // Scoped to this run and restored even on throw.
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const isolatedHome = join(workspaceRoot, "isolated-home");
  await mkdir(isolatedHome, { recursive: true });
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  try {
    const nctx = { workspaceRoot, platform: platform() };
    const build = await scenario.setup(workspaceRoot);

    const requests: RecordedRequest[] = [];
    const prompts: string[] = [];
    const doFetch: typeof fetch = async (url, init) => {
      const rawBodyText = String(init?.body ?? "");
      const headers = redactHeaders(init?.headers);
      const res = await options.upstreamFetch(url, init);
      const rawText = await res.text();
      // M71 §1: recorded absolute paths must point at THIS run's workspace.
      const text =
        options.rewriteFromRoot !== undefined ? rewriteResponseText(rawText, options.rewriteFromRoot, workspaceRoot) : rawText;
      const status = res.status;
      const contentType = res.headers.get("content-type") ?? "application/json";
      let parsedBody: unknown = undefined;
      try {
        parsedBody = normalizeValue(JSON.parse(rawBodyText), nctx);
      } catch {
        parsedBody = { unparsable: normalizeText(rawBodyText.slice(0, 400), nctx) };
      }
      requests.push({ body: parsedBody, headers, response: { status, contentType, text } });
      return responseFromText(status, contentType, text);
    };

    const provider = createOpenAICompatibleProvider(options.config as unknown as ProviderConfig, { fetch: doFetch });
    const model = capturePrompts(provider, (bytes) => prompts.push(normalizeText(bytes, nctx)));

    const loopOptions: LoopOptions = {
      maxTurns: options.maxTurns ?? 12,
      // Headless snapshot: the workspace is a throwaway temp dir.
      canUseTool: () => ({ behavior: "allow" as const }),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(build.loopOptions ?? {}),
    };

    const store = createJsonlSessionStore(join(workspaceRoot, "sessions"));
    const transcript: TranscriptLine[] = [
      { kind: "meta", version: SNAPSHOT_FIXTURE_VERSION, scenario: scenario.name },
    ];

    // -- phase 1: the scenario's own run -------------------------------------
    const state1: AgentState = {
      systemPrompt: build.systemPrompt,
      messages: [{ role: "user", content: build.userPrompt }],
      tools: [...build.tools],
      status: "idle",
    };
    const terminal1 = await drainLoop(runAgentLoop(state1, model, loopOptions));
    for (const m of state1.messages) {
      transcript.push({ kind: "message", phase: 1, message: normalizeValue(m, nctx) });
    }
    transcript.push({ kind: "terminal", phase: 1, reason: terminal1.reason });
    for (const m of state1.messages) await store.append(scenario.sessionId, m);

    // -- M71 §2: mount the marker on a persistence-only surface --------------
    // A GENERIC non-message entry (load() filters these out) carries the
    // canary. It rides the SAME JSONL as the messages — if any assembly path
    // ever leaks persistence-only entries into a request, phase 2 shows it.
    await store.appendEntry(scenario.sessionId, {
      type: MARKER_ENTRY_TYPE,
      data: { text: INJECTION_MARKER, note: "M71 §2 negative prompt-injection canary — must never reach the model" },
    });

    // -- phase 2: resume through the REAL load() path ------------------------
    const resumed = await store.load(scenario.sessionId);
    const state2: AgentState = {
      systemPrompt: build.systemPrompt,
      messages: [...resumed, { role: "user", content: build.resumePrompt }],
      tools: [...build.tools],
      status: "idle",
    };
    const terminal2 = await drainLoop(runAgentLoop(state2, model, loopOptions));
    for (const m of state2.messages.slice(resumed.length)) {
      transcript.push({ kind: "message", phase: 2, message: normalizeValue(m, nctx) });
    }
    transcript.push({ kind: "terminal", phase: 2, reason: terminal2.reason });
    for (const m of state2.messages.slice(resumed.length)) await store.append(scenario.sessionId, m);

    // -- persisted session, read back from disk --------------------------------
    const sessionText = await readFile(join(workspaceRoot, "sessions", `${scenario.sessionId}.jsonl`), "utf8");
    // ω99-84 (fixture-debt clearance): a session file's FIRST write now stamps
    // the soft format marker as line 1 (ω99-47, 9699daef: {"type":"wudao_meta",
    // "data":{"formatVersion":1}}). The platform's read-path law makes that
    // marker TRANSPORT FRAMING, never data — core's entry views
    // (loadSessionEntries / loadSidechainEntries) drop it so a marked file
    // reads identically to an unmarked one on EVERY read path (pinned by core
    // o99-47-session-version-gate.test.ts A2). This raw read is the snapshot
    // engine's read path and must apply the same rule, or every session diff
    // false-alarms on a wudao_meta entry at index 0 (the committed fixtures
    // were recorded 2026-09-03, pre-marker; the replay reds were exactly that
    // insertion — +1 entry, zero other drift). Strip exactly what the platform
    // strips: line 1, only a WELL-FORMED marker (isFormatMarker). A second or
    // malformed marker still diffs; unknown entries still diff (this view
    // stays stricter than loadSessionEntries' tolerant filter).
    const sessionEntries = sessionText
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown);
    const session = sessionEntries
      .filter((e, i) => !(i === 0 && isFormatMarker(e)))
      .map((e) => normalizeValue(e, nctx));

    // -- M71 §2: scan EVERY assembled request for the canary -----------------
    const markerLeaks: string[] = [];
    requests.forEach((r, i) => {
      if (containsMarker(JSON.stringify(r.body))) markerLeaks.push(`request ${i}: marker in assembled body`);
      for (const [k, v] of Object.entries(r.headers)) {
        if (containsMarker(v)) markerLeaks.push(`request ${i}: marker in header ${k}`);
      }
    });
    prompts.forEach((p, i) => {
      if (containsMarker(p)) markerLeaks.push(`model call ${i}: marker in canonical prompt bytes`);
    });
    // The resume boundary itself: load() must have filtered the entry out.
    for (const m of resumed as AgentMessage[]) {
      if (containsMarker(JSON.stringify(m))) markerLeaks.push("resume: load() leaked the persistence-only entry into messages");
    }

    return { scenario: scenario.name, workspaceRoot, requests, prompts, transcript, session, markerLeaks };
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Fixture I/O
// ---------------------------------------------------------------------------

/** Record: write the fixture files (requests.json + transcript.jsonl) into
 *  `dir` — the real flow passes scenarioDir(name); synthetic tests pass a
 *  temp dir so they never touch the committed fixture tree. */
export async function writeSnapshotFixture(
  captured: CapturedRun,
  config: Record<string, unknown>,
  dir: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const fixture: SnapshotFixture = {
    version: SNAPSHOT_FIXTURE_VERSION,
    scenario: captured.scenario,
    // M71 review F1: credential fields (single key AND the M56 pool) are
    // stripped engine-side — the fixture tree must never carry key material,
    // whatever the caller passes.
    config: sanitizeConfig(config),
    recordWorkspaceRoot: captured.workspaceRoot,
    requests: captured.requests,
    prompts: captured.prompts,
    transcript: captured.transcript,
    session: captured.session,
  };
  await writeFile(join(dir, "requests.json"), `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  // transcript.jsonl: one JSON line per transcript entry, then the persisted
  // session entries — the file IS the diffable transcript surface.
  const lines = [
    ...captured.transcript.map((t) => JSON.stringify(t)),
    ...captured.session.map((e) => JSON.stringify({ kind: "session", entry: e })),
  ];
  await writeFile(join(dir, "transcript.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

/** Load + structurally validate a fixture directory. Throws on unknown
 *  versions or a missing dir (replay of an unrecorded scenario fails loud). */
export async function loadSnapshotFixtureDir(dir: string): Promise<SnapshotFixture> {
  const raw = await readFile(join(dir, "requests.json"), "utf8");
  const parsed = JSON.parse(raw) as Partial<SnapshotFixture>;
  if (parsed.version !== SNAPSHOT_FIXTURE_VERSION) {
    throw new Error(`snapshot fixture in ${dir}: version ${String(parsed.version)} != ${SNAPSHOT_FIXTURE_VERSION} — re-record (WUDAO_SNAPSHOT=record)`);
  }
  const transcriptText = await readFile(join(dir, "transcript.jsonl"), "utf8");
  const transcript: TranscriptLine[] = [];
  const session: unknown[] = [];
  for (const line of transcriptText.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as { kind: string } & Record<string, unknown>;
    if (entry.kind === "session") session.push(entry.entry);
    else transcript.push(entry as TranscriptLine);
  }
  return {
    version: parsed.version,
    scenario: parsed.scenario ?? dir,
    config: parsed.config ?? {},
    recordWorkspaceRoot: typeof parsed.recordWorkspaceRoot === "string" ? parsed.recordWorkspaceRoot : "",
    requests: parsed.requests ?? [],
    prompts: parsed.prompts ?? [],
    transcript,
    session,
  };
}

/** Load the committed fixture for a scenario name. */
export function loadSnapshotFixture(name: string): Promise<SnapshotFixture> {
  return loadSnapshotFixtureDir(scenarioDir(name));
}

// ---------------------------------------------------------------------------
// Replay: serve recorded responses, re-assemble, diff
// ---------------------------------------------------------------------------

export interface ReplayResult {
  readonly captured: CapturedRun;
  /** Empty = the replay matched the fixture byte-for-byte (normalized). */
  readonly errors: string[];
}

/** Replay one scenario against a fixture: responses come from disk, requests
 *  are re-assembled through the real code paths, then everything diffs. */
export async function replaySnapshotScenario(
  scenario: SnapshotScenario,
  fixture: SnapshotFixture,
): Promise<ReplayResult> {
  let call = 0;
  const servingFetch: typeof fetch = async () => {
    const rec = fixture.requests[call];
    call += 1;
    if (rec === undefined) {
      throw new Error(`snapshot replay of ${scenario.name}: fixture exhausted at HTTP call ${call} — the assembly now makes MORE calls than were recorded`);
    }
    return responseFromText(rec.response.status, rec.response.contentType, rec.response.text);
  };
  const captured = await runSnapshotScenario(scenario, {
    // M71 review F1: sanitize BEFORE adding the dummy key — a fixture that
    // somehow still carries an apiKeys pool must never win over the dummy
    // (the pool, not apiKey, is what the provider's key selection uses).
    config: { ...sanitizeConfig(fixture.config), apiKey: "snapshot-replay" },
    upstreamFetch: servingFetch,
    // Recorded absolute paths → this run's workspace (see RunScenarioOptions).
    ...(fixture.recordWorkspaceRoot !== "" ? { rewriteFromRoot: fixture.recordWorkspaceRoot } : {}),
  });

  const errors: string[] = [];
  // M71 §2 first: a leak is worse than a divergence.
  errors.push(...captured.markerLeaks);

  // 1. canonical prompt bytes per model call.
  if (captured.prompts.length !== fixture.prompts.length) {
    errors.push(`prompts: ${captured.prompts.length} model calls != recorded ${fixture.prompts.length}`);
  }
  for (let i = 0; i < Math.min(captured.prompts.length, fixture.prompts.length); i += 1) {
    const actual = captured.prompts[i] ?? "";
    const expected = fixture.prompts[i] ?? "";
    for (const d of diffPromptBytes(actual, expected)) {
      errors.push(`prompts[${i}] ${d}`);
    }
  }

  // 2. raw request bodies per HTTP call.
  if (captured.requests.length !== fixture.requests.length) {
    errors.push(`requests: ${captured.requests.length} HTTP calls != recorded ${fixture.requests.length}`);
  }
  for (let i = 0; i < Math.min(captured.requests.length, fixture.requests.length); i += 1) {
    const actual = captured.requests[i];
    const expected = fixture.requests[i];
    if (actual === undefined || expected === undefined) continue;
    errors.push(...diffValues(actual.body, expected.body).map((d) => `requests[${i}].body ${d}`));
    // M71 review F2: headers are assembly output too — diff them, minus the
    // authorization value (redacted to a placeholder on both sides by
    // design, since record and replay authenticate differently).
    errors.push(
      ...diffValues(headersMinusAuthorization(actual.headers), headersMinusAuthorization(expected.headers)).map(
        (d) => `requests[${i}].headers ${d}`,
      ),
    );
  }

  // 3. transcript lines.
  if (captured.transcript.length !== fixture.transcript.length) {
    errors.push(`transcript: ${captured.transcript.length} lines != recorded ${fixture.transcript.length}`);
  }
  for (let i = 0; i < Math.min(captured.transcript.length, fixture.transcript.length); i += 1) {
    errors.push(...diffValues(captured.transcript[i], fixture.transcript[i]).map((d) => `transcript[${i}] ${d}`));
  }

  // 4. persisted session JSONL.
  if (captured.session.length !== fixture.session.length) {
    errors.push(`session: ${captured.session.length} entries != recorded ${fixture.session.length}`);
  }
  for (let i = 0; i < Math.min(captured.session.length, fixture.session.length); i += 1) {
    errors.push(...diffValues(captured.session[i], fixture.session[i]).map((d) => `session[${i}] ${d}`));
  }

  return { captured, errors };
}

/** M71 §2, fixture side: the committed files themselves must be marker-free
 *  (a leak recorded into the fixture would replay as "normal" forever). */
export function scanFixtureForMarker(fixture: SnapshotFixture): string[] {
  const leaks: string[] = [];
  fixture.requests.forEach((r, i) => {
    if (containsMarker(JSON.stringify(r.body))) leaks.push(`fixture request ${i}: marker in body`);
    for (const [k, v] of Object.entries(r.headers)) {
      if (containsMarker(v)) leaks.push(`fixture request ${i}: marker in header ${k}`);
    }
  });
  fixture.prompts.forEach((p, i) => {
    if (containsMarker(p)) leaks.push(`fixture prompt ${i}: marker in canonical bytes`);
  });
  return leaks;
}
