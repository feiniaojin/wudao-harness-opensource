// 121 §1 续章 — the CLI side of the persistent-notes pair: the tool-surface
// mount (TOP-LEVEL set, fixed position right after search_history — the
// retrieval family's proactive-save sibling; append-only tail, M24: the new
// slots are one declared cross-version cold point), the fail-absent seam,
// the permission posture (note_read rides the read class / plan-mode read
// fence; note_write deliberately keeps the fail-closed DEFAULT ASK — it is
// a write face in no auto-allow roster), and the end-to-end write→read
// round-trip through the mounted tools over a real tmpdir.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ModelClient, AgentMessage, PermissionDecision } from "@wudao-org/core";
import { buildToolSet } from "../src/tools.js";
import { READ_TOOLS, WORKSPACE_TOOLS, META_TOOLS, decidePermission } from "../src/permission.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "notes-cli-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const stubModel: ModelClient = {
  async generate(): Promise<AgentMessage> {
    return { role: "assistant", content: "" };
  },
};
const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });

const toolSet = (sid: string, extras?: { readonly historySearch?: boolean; readonly sessionResult?: boolean }): readonly Tool[] =>
  buildToolSet({
    workspaceRoot: root,
    model: stubModel,
    canUseTool: allowAll,
    contextWindowTokens: 64_000,
    notes: { sessionId: () => sid },
    ...(extras?.historySearch === true ? { historySearch: { load: async () => ({ entries: [], totalMessages: 0 }) } } : {}),
    ...(extras?.sessionResult === true ? { sessionResult: { load: async () => [] } } : {}),
  });

describe("notes tool surface (121 §1 续章)", () => {
  it("joins the TOP-LEVEL set at a FIXED position right after search_history (write face first, read face second)", () => {
    // Both notes + historySearch are conditional seams; the position pin only
    // holds when both are present (the retrieval family's pair contract).
    const names = toolSet("surface-pin", { historySearch: true, sessionResult: true }).map((t) => t.name);
    expect(names).toContain("note_write");
    expect(names).toContain("note_read");
    expect(names.indexOf("note_write")).toBe(names.indexOf("search_history") + 1);
    expect(names.indexOf("note_read")).toBe(names.indexOf("search_history") + 2);
  });

  it("fail-absent seam: no notes wiring, no surface (every existing fixture's bytes unchanged)", () => {
    const names = buildToolSet({
      workspaceRoot: root,
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
    }).map((t) => t.name);
    expect(names).not.toContain("note_write");
    expect(names).not.toContain("note_read");
  });

  it("note_read carries the read posture; note_write keeps the fail-closed DEFAULT ASK (the write face)", () => {
    expect(READ_TOOLS.has("note_read")).toBe(true);
    expect(decidePermission("plan", "note_read")).toEqual({ behavior: "allow" }); // the plan read fence lets a planner reread its own notes
    // the write face: in NO auto-allow roster — workspace asks, plan denies
    expect(READ_TOOLS.has("note_write")).toBe(false);
    expect(WORKSPACE_TOOLS.has("note_write")).toBe(false);
    expect(META_TOOLS.has("note_write")).toBe(false);
    expect(decidePermission("workspace", "note_write")).toBe("ask");
    expect(decidePermission("plan", "note_write")).toEqual({ behavior: "deny", reason: expect.stringContaining("read-only") });
    expect(decidePermission("auto", "note_write")).toEqual({ behavior: "allow" }); // auto is真放行 (sidecar 照审)
  });

  it("the seam composes end-to-end: mounted note_write lands the file under .wudao/notes/<sid>/; note_read lists it back newest-first", async () => {
    const sid = "e2e-notes";
    const tools = toolSet(sid);
    const write = tools.find((t) => t.name === "note_write");
    const read = tools.find((t) => t.name === "note_read");
    expect(write).toBeDefined();
    expect(read).toBeDefined();
    const r1 = await write!.execute({ content: "结论：缓存失效是根因", tag: "finding" }, undefined as never);
    expect(r1.isError).toBeUndefined();
    expect(r1.content).toContain("已保存笔记 [finding]");
    await new Promise((res) => setTimeout(res, 3)); // distinct ms timestamps → distinct lexical order
    const r2 = await write!.execute({ content: "decision: ship behind a flag", tag: "decision" }, undefined as never);
    expect(r2.isError).toBeUndefined();
    const files = await readdir(join(root, ".wudao", "notes", sid));
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith(".md"))).toBe(true);
    const back = await read!.execute({ tag: "finding" }, undefined as never);
    expect(back.isError).toBeUndefined();
    const lines = (back.content as string).split("\n");
    expect(JSON.parse(lines[0] as string)).toMatchObject({ tag: "finding", matches: 1, returned: 1 });
    expect(lines[1]).toContain("缓存失效是根因");
    // a different session's directory is invisible (session isolation)
    const otherRead = toolSet("e2e-other").find((t) => t.name === "note_read");
    const other = await otherRead!.execute({}, undefined as never);
    expect(other.content).toContain("没有笔记");
  });
});
