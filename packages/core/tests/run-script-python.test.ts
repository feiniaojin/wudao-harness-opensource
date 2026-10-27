// ω99-61 — run_script python lane (PTC lane #2). The python shim is a PEER
// implementation of the SAME req-/res- file RPC protocol: the parent routing,
// gate, timeout, and stdout-cap code is shared verbatim, so these tests pin
// protocol parity (not a second PTC machine), per-lane sandbox honesty (the
// capability difference is ASSERTED in tests, not left to marketing copy),
// and fail-closed python3 discovery. JS-lane twins live in run-script.test.ts.
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createRunScriptTool } from "../src/index.js";
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

// Returns a marker the script never prints — pins context purity: the tool
// result must stay out of the run_script result unless printed to stdout.
const secretEcho = (): Tool =>
  buildTool({
    name: "secret",
    description: "returns a secret the script does not print",
    parameters: { type: "object", properties: { n: { type: "number" } } },
    async execute() {
      return { content: "SECRET-NEVER-PRINTED-XYZ" };
    },
  });

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

async function runScript(
  code: string,
  opts: ReturnType<typeof fastOpts>,
  language?: string,
): Promise<{ content: string; isError?: boolean }> {
  const tool = createRunScriptTool(opts);
  const input: Record<string, unknown> = { code };
  if (language !== undefined) input.language = language;
  return tool.execute(input);
}

describe("run_script python lane — PTC full chain", () => {
  it("routes call() through the tool pool and returns only stdout", async () => {
    const result = await runScript(
      'a = call("echo", {"text": "hi"})\nb = call("echo", {"text": "there"})\nprint(a["ok"], a["content"], b["content"], sep="|")',
      fastOpts([echoTool()]),
      "python",
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("True|echo:hi|echo:there");
    expect(result.content).toContain("calls: echo ×2");
    expect(result.content).toContain("[run_script:python]");
    expect(result.content).toContain("[exit 0]");
  }, 20_000);

  it("context purity: tool results never leak unless printed", async () => {
    const result = await runScript(
      'call("secret", {"n": 1})\nprint("done")',
      fastOpts([secretEcho()]),
      "python",
    );
    expect(result.content).toContain("done");
    expect(result.content).toContain("calls: secret ×1");
    expect(result.content).not.toContain("SECRET-NEVER-PRINTED-XYZ");
  }, 20_000);
});

describe("protocol parity — one parent router, two lane shims", () => {
  it("delivers field-identical args through both lanes (unicode + nested)", async () => {
    const seen: unknown[] = [];
    const rec: Tool = buildTool({
      name: "rec",
      description: "records args",
      parameters: { type: "object", properties: { payload: { type: "object" } } },
      async execute({ payload }) {
        seen.push(payload);
        return { content: "ok" };
      },
    });
    const jsArgs = '{ payload: { s: "héllo→中文", nested: { b: [1, 2, true, null] } } }';
    const pyArgs = '{"payload": {"s": "héllo→中文", "nested": {"b": [1, 2, True, None]}}}';
    const js = await runScript(
      `const r = await call("rec", ${jsArgs}); console.log(r.content);`,
      fastOpts([rec]),
    );
    const py = await runScript(
      `r = call("rec", ${pyArgs})\nprint(r["content"])`,
      fastOpts([rec]),
      "python",
    );
    expect(js.content).toContain("ok");
    expect(py.content).toContain("ok");
    expect(seen).toHaveLength(2);
    // python True/None must land as JSON true/null — same parsed fields.
    expect(seen[1]).toEqual(seen[0]);
  }, 20_000);

  it("shares the parent receipt: calls line + exit label shape", async () => {
    const js = await runScript('console.log("x")', fastOpts([echoTool()]));
    const py = await runScript('print("x")', fastOpts([echoTool()]), "python");
    expect(js.content).toContain("calls: (none)");
    expect(py.content).toContain("calls: (none)");
    expect(js.content).toContain("[exit 0]");
    expect(py.content).toContain("[exit 0]");
  }, 20_000);
});

describe("python failure semantics (same shape as js)", () => {
  it("a raised exception surfaces as a stderr tail + exit 1", async () => {
    const result = await runScript('raise RuntimeError("boom-marker")', fastOpts([echoTool()]), "python");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom-marker");
    expect(result.content).toContain("Traceback");
    expect(result.content).toContain("[exit 1]");
  }, 20_000);

  it("a hung call times out to an ok:false value without killing the script", async () => {
    const result = await runScript(
      'a = call("hang", {"text": "x"})\nprint(a["ok"], a["error"], sep=":")',
      fastOpts([hangTool()], { callTimeoutMs: 400 }),
      "python",
    );
    expect(result.content).toContain("False:call timeout after 400ms");
    expect(result.content).toContain("[exit 0]");
  }, 15_000);
});

describe("sandbox honesty — per-lane capability, asserted", () => {
  it("js lane: fs read outside the RPC dir is DENIED (node --permission)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-py-honesty-"));
    const secretPath = join(dir, "secret.txt");
    await writeFile(secretPath, "JS-OUTSIDE-MARKER", "utf8");
    const result = await runScript(
      `try { require("node:fs").readFileSync(${JSON.stringify(secretPath)}, "utf8"); console.log("fs=open"); } catch (e) { console.log("fs=" + e.code); }`,
      fastOpts([echoTool()]),
    );
    expect(result.content).toContain("fs=ERR_ACCESS_DENIED");
    expect(result.content).not.toContain("JS-OUTSIDE-MARKER");
  }, 20_000);

  it("python lane: NO fs sandbox — an outside read succeeds and is reported truthfully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-py-honesty-"));
    const secretPath = join(dir, "secret.txt");
    await writeFile(secretPath, "PY-OUTSIDE-MARKER", "utf8");
    const result = await runScript(
      `print("fs=open:" + open(${JSON.stringify(secretPath)}, encoding="utf-8").read().strip())`,
      fastOpts([echoTool()]),
      "python",
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("fs=open:PY-OUTSIDE-MARKER");
  }, 20_000);
});

describe("fail-closed python3 discovery", () => {
  it("python3 missing from PATH → typed rejection, no silent js fallback", async () => {
    const savedPath = process.env.PATH;
    const emptyDir = await mkdtemp(join(tmpdir(), "wudao-no-python3-"));
    process.env.PATH = emptyDir;
    try {
      const result = await runScript('print("should-never-run")', fastOpts([echoTool()]), "python");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("python3 not found on PATH");
      expect(result.content).toContain("no silent fallback");
      expect(result.content).not.toContain("should-never-run");
    } finally {
      process.env.PATH = savedPath;
    }
  }, 20_000);
});

describe("default lane is byte-stable js (language omitted)", () => {
  it("schema: language is a new OPTIONAL enum key; required stays ['code']", () => {
    const tool = createRunScriptTool(fastOpts([]));
    const params = tool.parameters as unknown as {
      properties: Record<string, { type?: string; enum?: string[] }>;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(Object.keys(params.properties).sort()).toEqual(["code", "description", "language"]);
    expect(params.required).toEqual(["code"]);
    expect(params.additionalProperties).toBe(false);
    expect(params.properties.language?.enum).toEqual(["js", "python"]);
    expect(params.properties.code?.type).toBe("string");
  });

  it("an invalid language is a typed rejection (not a js misrun)", async () => {
    const result = await runScript('console.log("ran")', fastOpts([echoTool()]), "ruby");
    expect(result.isError).toBe(true);
    expect(result.content).toContain('language must be "js" or "python"');
    expect(result.content).not.toContain("ran");
  }, 20_000);
});
