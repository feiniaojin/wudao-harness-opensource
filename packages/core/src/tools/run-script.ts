// M50 §1 — run_script: PTC (programmatic tool calling). The model stops
// paying one turn per tool call: it writes a program (JavaScript by default,
// or Python via language: "python" — ω99-61) that batches its orchestration,
// and ONLY the program's stdout (≤50KB) enters the conversation — the
// individual tool results never do. Context cost is decoupled from call
// count.
//
// Mechanism: a child process (node, or python3 for the python lane) executes
// the script with ONE injected global, `call(tool, args)`, backed by a
// file-RPC channel in a private temp dir: the child writes `req-<n>.json`
// (tmp + rename, atomic), the parent — this tool — polls the dir, routes
// EVERY request through the normal tool pipeline (per-call permission gate
// included), and answers with `res-<n>.json`. Zero new dependencies; works
// on any filesystem. The python shim (PY_SHIM_HEAD below) is a PEER
// implementation of the SAME protocol — same req fields, same res shape,
// same never-failing call() contract — so the parent router, gate, timeouts,
// and stdout cap are shared verbatim across lanes (pinned by tests), not
// forked per language.
//
// Sandbox (honest v1 trust model — same disclosure posture as the sidecar):
// the JAVASCRIPT lane runs under `node --permission
// --allow-fs-read=<rpcDir> --allow-fs-write=<rpcDir>`: file reads/writes
// outside the RPC dir fail with ERR_ACCESS_DENIED, child_process /
// worker_threads / native addons are denied. The Node permission model does
// NOT gate network sockets — a script can still open TCP connections,
// exactly like a plain `shell` — and `--permission` remains an
// experimental Node feature. The PYTHON lane has NO equivalent sandbox
// (python3 -I isolates imports/env, not the filesystem): its trust level is
// EXACTLY shell's — per-call permissions bound WHAT tools may do, the
// timeout (10s/call, 120s/script) bounds how long, the stdout cap bounds
// what returns, and NOTHING bounds the script's own filesystem reach. This
// per-lane capability difference is asserted in tests (js outside-read
// denied / python outside-read succeeds), not left to prose. Discovery is
// fail-closed: the lane spawns `python3` — no alias guessing, no env
// override, no silent fallback to js; a missing binary is a typed error.
// Either way run_script is a trusted-model tool: for hostile code use
// `--sandbox` (Docker) or a machine boundary. See the README trust-model
// section.
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "../tool.js";
import type { PermissionDecision } from "../loop.js";
import type { Tool } from "../tool.js";
import { scrubChildEnv } from "./shell.js";

/** Per-call file-RPC timeout (default). */
export const RUN_SCRIPT_CALL_TIMEOUT_MS = 10_000;
/** Whole-script wall-clock cap (default). */
export const RUN_SCRIPT_SCRIPT_TIMEOUT_MS = 120_000;
/** Only the script's stdout returns into context — capped (default). */
export const RUN_SCRIPT_MAX_STDOUT_BYTES = 50 * 1024;
/** Failure tail budget: stderr is surfaced ONLY on non-zero/timeout exits. */
const MAX_STDERR_BYTES = 2_048;
/** Parent poll cadence for request files. */
const POLL_MS = 20;
/** Node flag gate: the permission model exists (even if experimental) here. */
const NODE_HAS_PERMISSION_MODEL = Number(process.versions.node.split(".")[0]) >= 20;

/** The value a script's `await call(...)` resolves to. The channel NEVER
 *  rejects — every failure (unknown tool, denied, timeout, tool crash) is an
 *  ok:false value the script can branch on. */
export type ScriptCallResult =
  | { readonly ok: true; readonly content: string; readonly isError: boolean }
  | { readonly ok: false; readonly error: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The child-side shim: defines `call`, then runs the user code inside an
// async IIFE (so top-level `await` works) with fail-loud error handling.
// Built by plain concatenation — the user code is embedded verbatim, never
// interpolated through a template literal.
const SHIM_HEAD = [
  '"use strict";',
  "const __fs = require(\"node:fs\");",
  "const __join = require(\"node:path\").join;",
  "const __dir = process.env.WUDAO_PTC_DIR;",
  "const __callTimeoutMs = Number(process.env.WUDAO_PTC_CALL_TIMEOUT_MS || \"10000\");",
  "let __seq = 0;",
  "const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
  "async function call(tool, args) {",
  "  __seq += 1;",
  "  const n = __seq;",
  "  const req = __join(__dir, \"req-\" + n + \".json\");",
  "  const res = __join(__dir, \"res-\" + n + \".json\");",
  "  __fs.writeFileSync(req + \".tmp\", JSON.stringify({ n, tool, args: args === undefined ? {} : args }));",
  "  __fs.renameSync(req + \".tmp\", req);",
  "  const deadline = Date.now() + __callTimeoutMs;",
  "  for (;;) {",
  "    if (__fs.existsSync(res)) {",
  "      try { return JSON.parse(__fs.readFileSync(res, \"utf8\")); } catch {}",
  "    }",
  "    if (Date.now() >= deadline) {",
  "      return { ok: false, error: \"call timeout after \" + __callTimeoutMs + \"ms (tool: \" + tool + \")\" };",
  "    }",
  "    await __sleep(10);",
  "  }",
  "}",
  "(async () => {",
].join("\n");
const SHIM_TAIL = [
  "})().then(function () {}, function (err) {",
  "  process.stderr.write(String((err && err.stack) || err) + \"\\n\");",
  "  process.exit(1);",
  "});",
].join("\n");

// The python-lane shim: the SAME file-RPC protocol as the js shim, written
// against the python stdlib only (json/os/sys/time — the lane requires no
// third-party packages and spawns no virtualenv). `call(tool, args)` is a
// plain synchronous function (python scripts run top-to-bottom; no async
// wrapper needed) and never raises: every failure is an {"ok": False, ...}
// dict the script branches on, mirroring the js lane's never-rejects
// contract down to the timeout message bytes. The req payload is serialized
// with JSON.stringify-compatible settings (separators, ensure_ascii=False)
// so a python request is byte-for-byte what the js shim would write for the
// same call. Deadlines use time.monotonic() (not wall clock) so an NTP step
// cannot stretch a call. stdout is line-buffered so partial output survives
// an abnormal end (the wall-clock kill drops buffered bytes exactly like a
// killed node child drops pending pipe writes).
const PY_SHIM_HEAD = [
  "import json, os, sys, time",
  'if hasattr(sys.stdout, "reconfigure"):',
  "    sys.stdout.reconfigure(line_buffering=True)",
  '__dir = os.environ["WUDAO_PTC_DIR"]',
  '__call_timeout_ms = int(os.environ.get("WUDAO_PTC_CALL_TIMEOUT_MS", "10000"))',
  "__seq = 0",
  "def call(tool, args=None):",
  "    global __seq",
  "    __seq += 1",
  "    n = __seq",
  '    req = os.path.join(__dir, "req-%d.json" % n)',
  '    res = os.path.join(__dir, "res-%d.json" % n)',
  '    with open(req + ".tmp", "w", encoding="utf-8") as f:',
  '        f.write(json.dumps({"n": n, "tool": tool, "args": {} if args is None else args}, separators=(",", ":"), ensure_ascii=False))',
  '    os.replace(req + ".tmp", req)',
  "    deadline = time.monotonic() + __call_timeout_ms / 1000.0",
  "    while True:",
  "        if os.path.exists(res):",
  "            try:",
  '                with open(res, "r", encoding="utf-8") as f:',
  "                    return json.load(f)",
  "            except Exception:",
  "                pass",
  "        if time.monotonic() >= deadline:",
  '            return {"ok": False, "error": "call timeout after %dms (tool: %s)" % (__call_timeout_ms, tool)}',
  "        time.sleep(0.01)",
].join("\n");
// Deliberately empty: python's own top-level semantics already provide the
// js tail's guarantees — an uncaught exception prints its traceback to
// stderr and exits 1, and a normal exit flushes stdout.
const PY_SHIM_TAIL = "";

/** Serialize a call result (parent → child) with the sequence number. */
const resPayload = (n: number, result: ScriptCallResult): string =>
  JSON.stringify({ n, ...result });

export interface RunScriptOptions {
  /** The tool pool call() routes to. `run_script` itself is ALWAYS refused
   *  (no recursion), even if present in the pool. */
  readonly tools: readonly Tool[];
  /** Per-call permission gate — the SAME canUseTool the loop uses, re-entered
   *  for EVERY call(...) (contextProbe precedent: core stays loop-unaware;
   *  the caller injects the closure it built for the loop, sidecar layer
   *  included). Absent → allow, mirroring the loop's own no-gate semantics
   *  (the run_script call itself was still gated before execution). */
  readonly gate?: (toolName: string, input: Record<string, unknown>) => PermissionDecision | Promise<PermissionDecision>;
  readonly callTimeoutMs?: number;
  readonly scriptTimeoutMs?: number;
  readonly maxStdoutBytes?: number;
  /** Node binary (default: this process's). */
  readonly nodePath?: string;
  /** Child cwd (default: this process's). */
  readonly cwd?: string;
}

export function createRunScriptTool(options: RunScriptOptions) {
  const callTimeoutMs = options.callTimeoutMs ?? RUN_SCRIPT_CALL_TIMEOUT_MS;
  const scriptTimeoutMs = options.scriptTimeoutMs ?? RUN_SCRIPT_SCRIPT_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? RUN_SCRIPT_MAX_STDOUT_BYTES;
  const nodePath = options.nodePath ?? process.execPath;
  // workspace-ux B2: read at SPAWN time (not captured here) — the cli hands a
  // live-root options object so the child follows an agentRootSwitch without
  // rebuilding the tool (identical for constant-options callers).
  const cwd = () => options.cwd ?? process.cwd();
  const gate = options.gate;
  const pool: readonly Tool[] = options.tools;

  // Serve one request file: gate → execute → res file. Returns the response
  // payload plus the requested tool name (for the call receipt — every
  // attempt counts, denied calls included). Sequential by construction (the
  // pump awaits each serve) — a gate that prompts a human never runs
  // concurrently with another gate, preserving the loop's interactive-prompt
  // invariant inside scripts.
  const serve = async (n: number, rpcDir: string): Promise<{ payload: string; tool: string }> => {
    let req: { tool?: unknown; args?: unknown };
    try {
      req = JSON.parse(await readFile(join(rpcDir, `req-${n}.json`), "utf8")) as { tool?: unknown; args?: unknown };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { payload: resPayload(n, { ok: false, error: `bad request file: ${message}` }), tool: "(bad request)" };
    }
    const tool = req.tool;
    if (typeof tool !== "string" || tool === "") {
      return { payload: resPayload(n, { ok: false, error: `call(tool, args): tool must be a string (got ${String(tool)})` }), tool: "(bad request)" };
    }
    if (tool === "run_script") {
      return { payload: resPayload(n, { ok: false, error: "run_script cannot be called from a script (no recursion)" }), tool };
    }
    if (typeof req.args !== "object" || req.args === null || Array.isArray(req.args)) {
      return { payload: resPayload(n, { ok: false, error: `call(tool, args): args must be an object (got ${String(req.args)})` }), tool };
    }
    const args = req.args as Record<string, unknown>;
    const target = pool.find((t) => t.name === tool);
    if (target === undefined) {
      const known = pool.map((t) => t.name).sort().join(", ");
      return { payload: resPayload(n, { ok: false, error: `unknown tool: ${tool} (available: ${known})` }), tool };
    }
    let decision: PermissionDecision;
    // The gate+execute pair is bounded by the per-call timeout (+1s grace for
    // the child's final poll): the child gives up at callTimeoutMs, so a hung
    // tool or gate must not wedge the pump past that. An abandoned execute
    // may still settle in the background — its side effects are the tool's
    // own semantics (same posture as the loop's abort race), but nothing is
    // written to the channel. Interactive gates must therefore answer within
    // the per-call budget (the auto-mode sidecar's 4s bound fits).
    const parentCapMs = callTimeoutMs + 1_000;
    const gated: Promise<{ payload: string; tool: string } | undefined> = (async () => {
      try {
        decision = gate ? await gate(tool, args) : { behavior: "allow" };
      } catch {
        decision = { behavior: "deny", reason: "permission check failed" };
      }
      if (decision.behavior === "deny") {
        return { payload: resPayload(n, { ok: false, error: `permission denied${decision.reason ? `: ${decision.reason}` : ""}` }), tool };
      }
      try {
        const r = await target.execute(args);
        return { payload: resPayload(n, { ok: true, content: r.content, isError: r.isError === true }), tool };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { payload: resPayload(n, { ok: false, error: `tool ${tool} crashed: ${message}` }), tool };
      }
    })();
    const raced = await Promise.race([
      gated,
      sleep(parentCapMs).then((): undefined => undefined),
    ]);
    if (raced === undefined) {
      return { payload: resPayload(n, { ok: false, error: `call timeout after ${callTimeoutMs}ms (tool: ${tool})` }), tool };
    }
    return raced;
  };

  const writeRes = async (n: number, payload: string, rpcDir: string): Promise<void> => {
    const final = join(rpcDir, `res-${n}.json`);
    const tmp = `${final}.tmp`;
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, final);
  };

  return buildTool({
    name: "run_script",
    description:
      "Run a batch of tool calls as ONE program instead of one turn per call — language: js (default) or python. " +
      "Single injected API: call(tool, args) → {ok, content, isError} on success, {ok:false, error} on failure (denied, unknown tool, timeout) — " +
      "call() never throws (python: same contract; call is sync, use print). " +
      "CRITICAL: the individual tool results NEVER enter the conversation — ONLY what you print to stdout (capped 50KB) returns; " +
      "print distilled facts, never raw dumps. " +
      "Every call() passes the normal permission gate (a deny is an {ok:false} value, not a crash). " +
      "Timeouts: 10s per call, 120s per script. " +
      "Sandbox, honestly: js runs under node --permission (no fs outside its channel, no child processes; network NOT blocked); " +
      "python has NO filesystem sandbox — shell-level trust (per-call permissions, timeouts, stdout cap only). " +
      "Fixed human-written pipeline → `wudao workflow`; run_script is the ad-hoc lane. " +
      "Example: batch-check fixtures — const r = await call('shell', {command: 'node ' + f}); console.log(f, r.isError ? 'FAIL' : 'ok'). " +
      "Do NOT use run_script for a single call (invoke the tool directly) and do NOT print raw tool results — only the distilled facts survive the 50KB cap.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            'Program source — JavaScript (default), or Python when language="python". JS allows top-level await; python\'s call(tool, args) is sync. Print (console.log / print) the final distilled result — stdout is the only thing that returns.',
        },
        language: {
          type: "string",
          enum: ["js", "python"],
          description: 'Backend lane: "js" (default) or "python" (stdlib python3; NO filesystem sandbox — shell-level trust).',
        },
        description: { type: "string", description: "One line saying what this script batch is for (shown in the result header)." },
      },
      required: ["code"],
      additionalProperties: false,
    },
    // A script can call WRITE tools through the channel — never read-only.
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute({ code, description, language }) {
      // Lane selection: absent → js — the pre-ω99-61 default, byte-stable for
      // every existing caller. Anything but the two known lanes is a typed
      // rejection BEFORE a process is spawned (fail-closed, no guessing).
      if (language !== undefined && language !== "js" && language !== "python") {
        return {
          content: `run_script failed: language must be "js" or "python" (got ${JSON.stringify(language)})`,
          isError: true,
        };
      }
      const isPython = language === "python";
      // Private RPC dir; realpath so the --permission allowlist string matches
      // the paths the child actually opens (darwin /var → /private/var etc.).
      let rpcDir: string;
      try {
        rpcDir = await realpath(await mkdtemp(join(tmpdir(), "wudao-ptc-")));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: `run_script failed: cannot create the RPC channel: ${message}`, isError: true };
      }
      const shimPath = join(rpcDir, isPython ? "shim.py" : "shim.js");
      const shimHead = isPython ? PY_SHIM_HEAD : SHIM_HEAD;
      const shimTail = isPython ? PY_SHIM_TAIL : SHIM_TAIL;
      await writeFile(shimPath, `${shimHead}\n${String(code)}\n${shimTail}\n`, "utf8");

      // Credential-scrubbed env + the two channel variables. NODE_OPTIONS is
      // dropped so a preloaded module cannot widen the sandbox behind us.
      const env = scrubChildEnv();
      delete env.NODE_OPTIONS;
      env.WUDAO_PTC_DIR = rpcDir;
      env.WUDAO_PTC_CALL_TIMEOUT_MS = String(callTimeoutMs);

      const nodeArgs = [
        ...(NODE_HAS_PERMISSION_MODEL
          ? ["--permission", `--allow-fs-read=${rpcDir}`, `--allow-fs-write=${rpcDir}`]
          : []),
        shimPath,
      ];
      // Python lane: plain `python3`. python3 has NO --permission equivalent
      // (python -I isolates imports/env, not the filesystem), so there are
      // deliberately no sandbox flags to pretend otherwise — the lane's trust
      // level is shell's, disclosed in the description/README and
      // asserted by tests. Discovery is fail-closed (typed error below):
      // no python/python3.x alias guessing, no env override, no js fallback.
      // Both lanes share the same stdio/cwd/env shape.
      const child = isPython
        ? spawn("python3", [shimPath], { cwd: cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
        : spawn(nodePath, nodeArgs, { cwd: cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stdoutTruncated = false;
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= maxStdoutBytes) {
          stdoutTruncated = true;
          return;
        }
        if (stdoutBytes + chunk.length > maxStdoutBytes) {
          stdoutChunks.push(chunk.subarray(0, maxStdoutBytes - stdoutBytes));
          stdoutBytes = maxStdoutBytes;
          stdoutTruncated = true;
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      });
      // stderr is collected PASSIVELY (never awaited before the pump —
      // awaiting stream close would deadlock the RPC: the child waits on the
      // res file only the pump can write). Assembled after the child closes.
      const stderrChunks: Buffer[] = [];
      let stderrBytes = 0;
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes < MAX_STDERR_BYTES) {
          stderrChunks.push(chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes));
        }
        stderrBytes += chunk.length;
      });

      // Exit receipt: code / signal / our own timeout kill.
      let timedOut = false;
      // Spawn failure (captured from the error event) — read after close to
      // produce the python lane's typed discovery rejection.
      let spawnError: Error | undefined;
      // Timeout escalation: SIGTERM first, then a short grace, then SIGKILL —
      // a script can trap SIGTERM (process.on) and outlive the cap otherwise.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Grace then SIGKILL — a script can trap SIGTERM and outlive the cap.
        const killTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 2_000);
        killTimer.unref?.();
      }, scriptTimeoutMs);
      const closePromise = new Promise<{ code: number | null; signal: string | null }>((resolveClose) => {
        child.on("close", (code, signal) => resolveClose({ code: code ?? null, signal: signal ?? null }));
        child.on("error", (err) => {
          // spawn failure (missing binary etc.) — synthesize exit 127.
          spawnError = err;
          process.stderr.write(`run_script: ${isPython ? "python3" : "node"} spawn failed: ${err.message}\n`);
          resolveClose({ code: 127, signal: null });
        });
      });
      let closed = false;
      void closePromise.then(() => {
        closed = true;
      });

      // The pump: poll for request files, serve them one at a time, stop once
      // the child has exited AND the dir is drained.
      const served = new Set<number>();
      const callCounts = new Map<string, number>();
      let pumpError: string | undefined;
      try {
        for (;;) {
          const files = await readdir(rpcDir).catch(() => [] as string[]);
          const pending = files
            .map((f) => /^req-(\d+)\.json$/.exec(f))
            .filter((m): m is RegExpExecArray => m !== null)
            .map((m) => Number(m[1]))
            .filter((n) => !served.has(n))
            .sort((a, b) => a - b);
          for (const n of pending) {
            served.add(n);
            const { payload, tool } = await serve(n, rpcDir);
            callCounts.set(tool, (callCounts.get(tool) ?? 0) + 1);
            await writeRes(n, payload, rpcDir);
          }
          if (pending.length === 0) {
            if (closed) break;
            await sleep(POLL_MS);
          }
        }
      } catch (err) {
        pumpError = err instanceof Error ? err.message : String(err);
      }
      const close = await closePromise;
      clearTimeout(timer);
      const stderrText = Buffer.concat(stderrChunks).toString("utf8");
      await rm(rpcDir, { recursive: true, force: true }).catch(() => {});
      // Fail-closed python3 discovery: a missing binary is a typed error with
      // deterministic copy — never a silent js fallback, never an exit-127
      // receipt that reads like the script itself failed.
      if (isPython && spawnError !== undefined) {
        const code = (spawnError as NodeJS.ErrnoException).code;
        return code === "ENOENT"
          ? {
              content:
                'run_script failed: python3 not found on PATH — the "python" lane requires a python3 binary; no silent fallback to the js lane',
              isError: true,
            }
          : { content: `run_script failed: python3 spawn failed: ${spawnError.message}`, isError: true };
      }

      // Call receipt: names × counts in first-seen order (deterministic).
      const callsLine =
        callCounts.size === 0
          ? "calls: (none)"
          : `calls: ${[...callCounts].map(([name, count]) => `${name} ×${count}`).join(", ")}`;
      const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
      const truncateNote = stdoutTruncated
        ? `\n[stdout truncated at ${maxStdoutBytes} bytes — print less; only stdout enters context]`
        : "";
      const exitLabel = timedOut
        ? `[timeout after ${scriptTimeoutMs / 1000}s]`
        : close.signal !== null && close.signal !== "SIGTERM"
          ? `[killed by ${close.signal}]`
          : close.signal === "SIGTERM"
            ? `[killed by SIGTERM]`
            : `[exit ${close.code}]`;
      const isError = timedOut || (close.code !== 0);
      const stderrNote = isError && stderrText.trim() !== "" ? `\n[stderr]\n${stderrText.trim()}` : "";
      const failureNote = pumpError !== undefined ? `\n[rpc pump error: ${pumpError}]` : "";
      const header = `[run_script${isPython ? ":python" : ""}] ${typeof description === "string" && description !== "" ? description : "(no description)"}`;
      return {
        content: `${header}\n${callsLine}\n${stdoutText}${truncateNote}${stderrNote}${failureNote}\n${exitLabel}`,
        isError,
      };
    },
  });
}
