// M71 §1 — unit tests for the snapshot normalizer + differ (synthetic data,
// no fixtures, no key). The normalizer is what makes a record-once fixture
// diffable forever: it strips the volatile fields (timestamps, session ids,
// durations, workspace paths, platform) so only deterministic bytes remain.
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import {
  normalizeValue,
  normalizeText,
  diffValues,
  diffPromptBytes,
  INJECTION_MARKER,
  containsMarker,
  canonicalJson,
} from "../src/snapshot/normalize.js";

const CTX = { workspaceRoot: "/tmp/wudao-snap-abc123", platform: "darwin" };

describe("normalizeValue", () => {
  it("drops volatile keys at every depth (uuid/parentUuid/sessionId/timestamps/durations)", () => {
    const input = {
      role: "assistant",
      uuid: "a1b2c3",
      parentUuid: "0000",
      content: "hello",
      usage: { promptTokens: 10, durationMs: 1234, sessionId: "sess-9" },
      at: "2026-08-20T00:00:00.000Z",
      createdAt: "2026-08-20T00:00:00.000Z",
      timestamp: "2026-08-20T00:00:00.000Z",
      elapsedMs: 42,
    };
    expect(normalizeValue(input, CTX)).toEqual({
      role: "assistant",
      content: "hello",
      usage: { promptTokens: 10 },
    });
  });

  it("replaces the workspace root inside strings (deep, repeated, mid-string)", () => {
    const input = {
      system: `# Environment\n- Working directory: ${CTX.workspaceRoot}\n`,
      note: `wrote ${CTX.workspaceRoot}/x.txt then read ${CTX.workspaceRoot}/y.txt`,
      nested: [{ path: `${CTX.workspaceRoot}/deep/z.md` }],
    };
    const out = normalizeValue(input, CTX) as ReturnType<typeof JSON.parse>;
    expect(JSON.stringify(out)).not.toContain(CTX.workspaceRoot);
    expect(out.note).toBe("wrote <WORKSPACE>/x.txt then read <WORKSPACE>/y.txt");
    expect(out.nested[0].path).toBe("<WORKSPACE>/deep/z.md");
  });

  it("replaces ISO-8601 timestamps anywhere in strings", () => {
    const out = normalizeValue({ line: "ran at 2026-08-20T10:11:12.000Z ok" }, CTX) as { line: string };
    expect(out.line).toBe("ran at <TIME> ok");
  });

  it("replaces the run's platform token (darwin/linux fixtures must converge)", () => {
    const darwin = normalizeValue({ env: "- Platform: darwin" }, { workspaceRoot: "/w", platform: "darwin" });
    const linux = normalizeValue({ env: "- Platform: linux" }, { workspaceRoot: "/w", platform: "linux" });
    expect(darwin).toEqual({ env: "- Platform: <PLATFORM>" });
    expect(darwin).toEqual(linux);
  });

  it("normalizes the OS tmpdir prefix that survives outside the workspace root", () => {
    const otherRun = `${tmpdir()}/some-OTHER-eval-run/session.jsonl`;
    const out = normalizeValue({ log: otherRun }, CTX) as { log: string };
    expect(out.log.startsWith("<TMP>")).toBe(true);
    expect(out.log).not.toContain(tmpdir());
  });

  it("folds the macOS realpath spelling BEFORE the workspace substitution (F3)", () => {
    for (const root of ["/var/folders/yy/wudao-snap-abc123", "/tmp/wudao-snap-abc123"]) {
      const ctx = { workspaceRoot: root, platform: "darwin" };
      const realPath = root.replace(/^\/(var|tmp)/, "/private/$1") + "/deep/z.md";
      expect(realPath.startsWith(root)).toBe(false); // precondition: symlink spelling
      const out = normalizeValue({ path: realPath }, ctx) as { path: string };
      expect(out.path).toBe("<WORKSPACE>/deep/z.md");
      // Both spellings converge.
      expect(normalizeText(`${root}/z.md`, ctx)).toBe(normalizeText(realPath.replace("/deep/z.md", "/z.md"), ctx));
    }
  });

  it("leaves deterministic content untouched (arrays keep order, keys keep values)", () => {
    const input = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }], n: 7, b: true, none: null };
    expect(normalizeValue(input, CTX)).toEqual(input);
  });

  it("survives cycles-free arbitrary JSON scalars", () => {
    expect(normalizeValue("plain", CTX)).toBe("plain");
    expect(normalizeValue(3, CTX)).toBe(3);
    expect(normalizeValue(null, CTX)).toBe(null);
  });
});

describe("normalizeText", () => {
  it("applies the same string-level substitutions to raw prompt bytes", () => {
    const raw = `{"role":"system","content":"dir is ${CTX.workspaceRoot} at 2026-08-20T01:02:03Z on Platform: darwin"}`;
    const out = normalizeText(raw, CTX);
    expect(out).toContain("<WORKSPACE>");
    expect(out).toContain("<TIME>");
    expect(out).toContain("Platform: <PLATFORM>");
    expect(out).not.toContain(CTX.workspaceRoot);
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and keeps array order (fixture bytes are comparable)", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: "x" } })).toBe('{"a":{"c":"x","d":[3,2]},"b":1}');
  });
});

describe("diffValues", () => {
  it("returns [] for structurally equal values regardless of key order", () => {
    expect(diffValues({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
  });

  it("names the JSON pointer of a changed scalar", () => {
    const errs = diffValues({ messages: [{ role: "user", content: "hi" }] }, { messages: [{ role: "user", content: "bye" }] });
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("messages/0/content");
    expect(errs[0]).toContain('"hi"');
    expect(errs[0]).toContain('"bye"');
  });

  it("reports missing and extra keys", () => {
    const errs = diffValues({ a: 1, keep: 2 }, { keep: 2, extra: 3 });
    expect(errs.join("\n")).toMatch(/missing key \$\.a/);
    expect(errs.join("\n")).toMatch(/extra key \$\.extra/);
  });

  it("reports array length divergence and index mismatches", () => {
    const errs = diffValues([1, 2, 3], [1, 9]);
    expect(errs.join("\n")).toMatch(/length 3 != 2/);
    expect(errs.join("\n")).toMatch(/\/1/);
  });

  it("caps findings at a small bound so diffs stay readable", () => {
    const a = Array.from({ length: 50 }, (_, i) => ({ i }));
    const b = Array.from({ length: 50 }, (_, i) => ({ i: i + 100 }));
    expect(diffValues(a, b).length).toBeLessThanOrEqual(10);
  });
});

describe("diffPromptBytes", () => {
  it("passes identical canonical prompt bytes", () => {
    const bytes = '{"role":"system","content":"s"}\n{"role":"user","content":"u"}\n';
    expect(diffPromptBytes(bytes, bytes)).toEqual([]);
  });

  it("pinpoints the first diverging line with context", () => {
    const a = "l0\nl1\nl2\nl3\nl4\n";
    const b = "l0\nl1\nCHANGED\nl3\nl4\n";
    const errs = diffPromptBytes(a, b);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("line 2");
    expect(errs[0]).toContain("l1");
    expect(errs[0]).toContain("CHANGED");
  });

  it("reports the content divergence (with context) even when lengths differ", () => {
    const errs = diffPromptBytes("", "x\n");
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("line 0");
    expect(errs[0]).toContain("+ x");
  });
});

describe("INJECTION_MARKER (M71 §2 negative prompt-injection)", () => {
  it("is found in leaky assembled requests (raw body, prompt bytes, headers)", () => {
    expect(containsMarker(`{"messages":[{"content":"${INJECTION_MARKER}"}]}`)).toBe(true);
    expect(containsMarker("authorization: none\nx-note: " + INJECTION_MARKER)).toBe(true);
  });

  it("is NOT found in clean content, including partial/case-shifted fragments", () => {
    expect(containsMarker("perfectly ordinary request body")).toBe(false);
    expect(containsMarker("this marker must not reach the model")).toBe(false);
    expect(containsMarker("")).toBe(false);
  });
});
