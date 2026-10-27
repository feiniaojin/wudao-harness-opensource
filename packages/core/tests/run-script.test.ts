// M50 §1 — run_script (PTC, programmatic tool calling). Unit coverage for the
// file-RPC channel: roundtrip, per-call permission gate, per-call timeout,
// stdout cap, sandbox denial, recursion/unknown-tool errors, script error
// surfacing. The context-purity property (tool results NEVER enter the
// conversation — only stdout) is pinned end to end by det-35.
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createReadFileTool, createRunScriptTool } from "../src/index.js";
import type { Tool } from "../src/index.js";

const echoTool = (name = "echo"): Tool =>
  buildTool({
    name,
    description: "echo",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, deny: { type: "boolean" } },
      additionalProperties: false,
    },
    async execute({ text }) {
      return { content: `echo:${String(text)}` };
    },
  });

// A tool that never settles — the per-call RPC timeout must cut it.
const hangTool = (): Tool =>
  buildTool({
    name: "hang",
    description: "never resolves",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    async execute() {
      return new Promise<never>(() => {});
    },
  });

const fastOpts = (tools: readonly Tool[], extra: Record<string, unknown> = {}) => ({
  tools,
  callTimeoutMs: 3_000,
  scriptTimeoutMs: 20_000,
  ...extra,
});

async function runScript(code: string, opts: ReturnType<typeof fastOpts>, description?: string) {
  const tool = createRunScriptTool(opts);
  return tool.execute(description === undefined ? { code } : { code, description });
}

describe("run_script file-RPC roundtrip", () => {
  it("routes call() through the tool and returns only stdout", async () => {
    const result = await runScript(
      'const a = await call("echo", { text: "hi" });\nconsole.log(a.ok + ":" + a.content);',
      fastOpts([echoTool()]),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("true:echo:hi");
    expect(result.content).toContain("calls: echo ×1");
    expect(result.content).toContain("[exit 0]");
  });

  it("carries the description line when given", async () => {
    const result = await runScript('console.log("x")', fastOpts([echoTool()]), "batch three reads");
    expect(result.content).toContain("[run_script] batch three reads");
  });

  it("serves concurrent call()s with sequential gate+execute", async () => {
    const order: string[] = [];
    const slow: Tool = buildTool({
      name: "slow",
      description: "slow",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      async execute({ text }) {
        order.push(`start:${String(text)}`);
        await new Promise((r) => setTimeout(r, 30));
        order.push(`end:${String(text)}`);
        return { content: `slow:${String(text)}` };
      },
    });
    const result = await runScript(
      'const r = await Promise.all([call("slow", { text: "a" }), call("slow", { text: "b" })]);\nconsole.log(r.map(x => x.content).join(","));',
      fastOpts([slow]),
    );
    // Requests are served one at a time (a gate may prompt a human — never
    // concurrently), so the two slow calls cannot interleave.
    expect(result.content).toContain("slow:a,slow:b");
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});

describe("run_script per-call permissions", () => {
  it("re-enters the gate for EVERY call and denies with the loop's message", async () => {
    const gateCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await runScript(
      'const a = await call("echo", { text: "hi" });\nconst b = await call("echo", { text: "hi", deny: true });\nconsole.log(JSON.stringify([a, b]));',
      fastOpts([echoTool()], {
        gate: async (name, args) => {
          gateCalls.push({ name, args });
          return args["deny"] === true ? { behavior: "deny", reason: "not allowed in scripts" } : { behavior: "allow" };
        },
      }),
    );
    expect(gateCalls).toHaveLength(2);
    expect(result.content).toContain("permission denied: not allowed in scripts");
    // The allowed call still executed and its result reached the script.
    expect(result.content).toContain("echo:hi");
    expect(result.content).toContain("[exit 0]");
  });

  it("a throwing gate degrades to deny (never a crashed script host)", async () => {
    const result = await runScript(
      'const a = await call("echo", { text: "hi" });\nconsole.log(a.ok + "|" + a.error);',
      fastOpts([echoTool()], { gate: async () => { throw new Error("gate exploded"); } }),
    );
    // Byte-identical to the loop's own throwing-gate deny message.
    expect(result.content).toContain("false|permission denied: permission check failed");
  });

  it("denies recursion (run_script inside a script) and unknown tools", async () => {
    const result = await runScript(
      'const a = await call("run_script", { code: "console.log(1)" });\nconst b = await call("nope", {});\nconsole.log(a.error.includes("recursion") + "|" + b.error.includes("unknown tool"));',
      fastOpts([echoTool()]),
    );
    expect(result.content).toContain("true|true");
  });
});

describe("run_script timeouts and output cap", () => {
  it("times out a single hung call without killing the script", async () => {
    const result = await runScript(
      'const a = await call("hang", { text: "x" });\nconsole.log(a.ok + ":" + a.error);',
      fastOpts([hangTool()], { callTimeoutMs: 400 }),
    );
    expect(result.content).toContain("false:call timeout after 400ms");
    expect(result.content).toContain("[exit 0]");
  }, 15_000);

  it("kills the whole script at the wall-clock cap", async () => {
    // A long TIMER (not a bare pending promise) — the event loop must stay
    // alive for the wall-clock kill to be the thing that ends the script.
    const result = await runScript(
      'await new Promise((r) => setTimeout(r, 100000));',
      fastOpts([echoTool()], { scriptTimeoutMs: 500 }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("[timeout after 0.5s]");
  }, 15_000);

  it("caps stdout at maxStdoutBytes with a visible note", async () => {
    const result = await runScript(
      'console.log("A".repeat(200));',
      fastOpts([echoTool()], { maxStdoutBytes: 64 }),
    );
    expect(result.isError).toBeFalsy();
    const body = result.content;
    expect(body).toContain("[stdout truncated at 64 bytes");
    expect(body.match(/A{20}/)).not.toBeNull(); // head kept
    expect(body.match(/^A{100}/m)).toBeNull(); // …but not 200
  });
});

describe("run_script sandbox (node --permission)", () => {
  it("denies fs reads outside the RPC dir and child_process", async () => {
    const result = await runScript(
      [
        'const fs = require("node:fs");',
        'const cp = require("node:child_process");',
        'let fsCode = "allowed", cpCode = "allowed";',
        'try { fs.readFileSync("/etc/hosts", "utf8"); } catch (e) { fsCode = e.code; }',
        'try { cp.execSync("true"); } catch (e) { cpCode = e.code; }',
        'console.log("fs=" + fsCode + " cp=" + cpCode);',
      ].join("\n"),
      fastOpts([echoTool()]),
    );
    expect(result.content).toContain("fs=ERR_ACCESS_DENIED");
    expect(result.content).toContain("cp=ERR_ACCESS_DENIED");
  }, 20_000);
});

describe("run_script failure surfacing", () => {
  it("reports a thrown script error with a stderr tail and exit 1", async () => {
    const result = await runScript('throw new Error("boom-marker");', fastOpts([echoTool()]));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom-marker");
    expect(result.content).toContain("[exit 1]");
  });

  it("routes call() at real workspace tools (read_file through the RPC channel)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-run-script-"));
    await writeFile(join(dir, "note.txt"), "PTC-ROUNDTRIP", "utf8");
    const readFile = createReadFileTool({ workspaceRoot: dir });
    const result = await runScript(
      'const r = await call("read_file", { path: "note.txt" });\nconsole.log(r.ok + ":" + r.content.trim());',
      fastOpts([readFile]),
    );
    expect(result.content).toContain("true:PTC-ROUNDTRIP");
  }, 20_000);
});
