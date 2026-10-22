// ω99-17 — mission-scoped typed knowledge + claim-time mechanical replay
// (brief: 任务知识资产). Conventions/decisions/pitfalls/checklists live IN
// the mission ledger (same mission.json, same recovery authority); plan()
// PINS note references onto tasks (notes field) and nextReady()/claim()
// replay the live ones VERBATIM at claim time — discipline, not recall.
// Same fixtures as m81-mission.test.ts: injected in-memory store, tmpdir fs
// for the persistence round-trip — zero real shell, zero network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, PermissionDecision } from "@wudao/core";
import {
  createMissionController,
  createMissionTools,
  loadMissionStore,
  MISSION_STORE_FILE,
  type MissionController,
  type MissionState,
  type MissionStoreHandle,
} from "../src/mission.js";
import { buildToolSet } from "../src/tools.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m81-know-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** In-memory store fixture (m81-mission.test.ts's pattern): the `mission`
 *  getter stays live so a second controller reads what the first wrote. */
async function fixture(o: { store?: MissionStoreHandle; maxNotes?: number } = {}) {
  const notices: string[] = [];
  let persisted: MissionState | null = null;
  const store: MissionStoreHandle = o.store ?? {
    get mission() {
      return persisted;
    },
    save: async (next) => {
      persisted = next;
    },
  };
  const controller = await createMissionController({
    workspaceRoot: ws,
    notify: (t) => notices.push(t),
    store,
    ...(o.maxNotes !== undefined ? { maxNotes: o.maxNotes } : {}),
  });
  return { controller, notices, persisted: () => persisted };
}

describe("ω99-17 N1 — knowAdd: sequential controller-assigned ids + kind gate", () => {
  it("three adds get n1,n2,n3 in order; a fresh mission starts notes:[]; illegal kind refuses", async () => {
    const f = await fixture();
    await f.controller.start("long campaign");
    expect(f.controller.snapshot()?.notes).toEqual([]);
    const a = await f.controller.knowAdd({ kind: "convention", title: "端口一律 8080", content: "所有本地服务端口 8080" });
    expect(a.ok).toBe(true);
    expect(a.text).toContain("n1");
    const b = await f.controller.knowAdd({ kind: "decision", title: "API schema 冻结", content: "v2 schema 冻结，字段只增不改", taskRef: "t1" });
    expect(b.text).toContain("n2");
    const c = await f.controller.knowAdd({ kind: "pitfall", title: "单测跑 vitest", content: "单测一律 vitest，禁 jest" });
    expect(c.text).toContain("n3");
    const snap = f.controller.snapshot();
    expect(snap?.notes?.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
    expect(snap?.notes?.[0]).toMatchObject({ id: "n1", kind: "convention", title: "端口一律 8080" });
    expect(snap?.notes?.[1]).toMatchObject({ id: "n2", kind: "decision", taskRef: "t1" });
    // kind is a closed enum — anything else refuses BEFORE any write lands.
    const bad = await f.controller.knowAdd({ kind: "vibe", title: "x", content: "y" });
    expect(bad.ok).toBe(false);
    expect(f.controller.snapshot()?.notes?.length).toBe(3);
  });
});

describe("ω99-17 N2 — supersede: linear, auditable, drops out of live surfaces", () => {
  it("supersedes marks the old note (kept in the ledger); re-superseding the same note refuses", async () => {
    const f = await fixture();
    await f.controller.start("campaign");
    await f.controller.knowAdd({ kind: "convention", title: "端口 3000", content: "旧端口 3000" }); // n1
    await f.controller.knowAdd({ kind: "convention", title: "端口 8080", content: "改用 8080", supersedes: "n1" }); // n2
    const snap = f.controller.snapshot();
    expect(snap?.notes?.find((n) => n.id === "n1")?.supersededBy).toBe("n2"); // kept + marked, never deleted
    expect(snap?.notes?.length).toBe(2); // append-only audit trail
    const list = await f.controller.know();
    expect(list.ok).toBe(true);
    expect(list.text).not.toMatch(/n1「/); // superseded drops out of the live list
    expect(list.text).toMatch(/n2「端口 8080」/);
    // Linear only: n1 already carries a supersededBy — a chain refuses.
    const again = await f.controller.knowAdd({ kind: "convention", title: "再改", content: "x", supersedes: "n1" });
    expect(again.ok).toBe(false);
    expect(again.text).toContain("n2"); // names the current holder
  });
});

describe("ω99-17 N3 — plan reference discipline: unknown note ids refuse the WHOLE batch", () => {
  it("notes:['n9'] (unknown) refuses atomically and names the unknowns", async () => {
    const f = await fixture();
    await f.controller.start("campaign");
    await f.controller.knowAdd({ kind: "convention", title: "t", content: "c" }); // n1 exists
    const r = await f.controller.plan([
      { title: "好任务" },
      { title: "坏引用", notes: ["n9"] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("n9"); // the unknown id is named
    expect(f.controller.snapshot()?.tasks.length).toBe(0); // whole batch refused
  });
});

describe("ω99-17 N4 — claim-time mechanical replay (the discipline's soul)", () => {
  it("nextReady/claim append 〔约定回放〕 with the LIVE referenced notes verbatim; superseded never replay; no refs → no header", async () => {
    const f = await fixture();
    await f.controller.start("campaign");
    await f.controller.knowAdd({ kind: "convention", title: "端口 3000", content: "旧约定正文" }); // n1
    await f.controller.knowAdd({ kind: "convention", title: "端口 8080", content: "所有服务端口 8080", supersedes: "n1" }); // n2
    await f.controller.knowAdd({ kind: "checklist", title: "发版前三查", content: "测试、类型、文档" }); // n3
    await f.controller.plan([
      { title: "接线任务", notes: ["n2", "n1"] }, // n1 superseded → replay n2 only
      { title: "收尾任务", dependsOn: ["t1"], notes: ["n3"] },
    ]);
    const first = await f.controller.nextReady();
    expect(first.task?.id).toBe("t1");
    expect(first.text).toContain("〔约定回放〕");
    expect(first.text).toContain("n2「端口 8080」：所有服务端口 8080"); // verbatim title+content
    expect(first.text).not.toContain("旧约定正文"); // n1's content never leaks
    expect(first.text).not.toMatch(/n1「/);
    await f.controller.complete("t1", "done");
    const second = await f.controller.claim("t2");
    expect(second.text).toContain("〔约定回放〕");
    expect(second.text).toContain("n3「发版前三查」：测试、类型、文档");
    // A task without noteRefs gets NO replay section (no empty header).
    await f.controller.plan([{ title: "无引用任务" }]);
    const bare = await f.controller.nextReady();
    expect(bare.task?.id).toBe("t3");
    expect(bare.text).not.toContain("〔约定回放〕");
  });
});

describe("ω99-17 N5 — persistence: notes ride the SAME mission.json ledger", () => {
  it("a second controller (same workspace) reloads notes/noteRefs equivalent; pre-ω99-17 ledgers load clean", async () => {
    // Round-trip against the REAL store (tmpdir .wudao/mission.json).
    const a = await createMissionController({ workspaceRoot: ws, notify: () => {} });
    await a.start("persist campaign");
    await a.knowAdd({ kind: "decision", title: "冻结 schema", content: "字段只增", taskRef: "t1" }); // n1
    await a.knowAdd({ kind: "convention", title: "端口 8080", content: "8080", supersedes: "n1" }); // n2
    await a.plan([{ title: "任务", notes: ["n2"] }]);
    const snapA = a.snapshot();
    const b = await createMissionController({ workspaceRoot: ws, notify: () => {} });
    const snapB = b.snapshot();
    expect(snapB?.notes).toEqual(snapA?.notes);
    expect(snapB?.tasks.map((t) => t.noteRefs)).toEqual([["n2"]]);
    // Old format (pre-ω99-17: no notes field) hand-written to disk loads clean.
    const oldWs = await mkdtemp(join(tmpdir(), "m81-know-old-"));
    try {
      await mkdir(join(oldWs, ".wudao"), { recursive: true });
      await writeFile(
        join(oldWs, ".wudao", MISSION_STORE_FILE),
        JSON.stringify(
          {
            version: 1,
            mission: {
              id: "m-old",
              objective: "老战役",
              createdAt: "2026-01-01T00:00:00.000Z",
              status: "active",
              tasks: [{ id: "t1", title: "x", dependsOn: [], status: "todo", attempts: 0 }],
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      const handle = await loadMissionStore({ workspaceRoot: oldWs });
      expect(handle.mission?.tasks.length).toBe(1);
      const old = await createMissionController({ workspaceRoot: oldWs, notify: () => {} });
      expect(old.refusal).toBeUndefined();
      expect(old.snapshot()?.notes).toEqual([]); // normalized empty
      expect(old.status()).toContain("知识：0 条");
    } finally {
      await rm(oldWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    }
  });
});

describe("ω99-17 N6 — listing: kind filter, newest-first, fold past 40, injectable cap", () => {
  it("know filters by kind and lists newest-first", async () => {
    const f = await fixture();
    await f.controller.start("campaign");
    await f.controller.knowAdd({ kind: "decision", title: "d1", content: "一" }); // n1
    await f.controller.knowAdd({ kind: "pitfall", title: "p1", content: "二" }); // n2
    await f.controller.knowAdd({ kind: "decision", title: "d2", content: "三" }); // n3
    const all = await f.controller.know();
    expect(all.ok).toBe(true);
    expect(all.text.indexOf("n3")).toBeLessThan(all.text.indexOf("n1")); // 倒序
    const decisions = await f.controller.know("decision");
    expect(decisions.text).toMatch(/n3「d2」/);
    expect(decisions.text).not.toMatch(/n2「p1」/);
    const bad = await f.controller.know("vibe");
    expect(bad.ok).toBe(false);
  });

  it("the cap (injectable, default 200) refuses plain adds at the limit while supersede stays open; >40 live notes fold", async () => {
    const f = await fixture({ maxNotes: 3 });
    await f.controller.start("campaign");
    for (let i = 1; i <= 3; i++) await f.controller.knowAdd({ kind: "convention", title: `c${i}`, content: "x" });
    const fourth = await f.controller.knowAdd({ kind: "convention", title: "c4", content: "x" });
    expect(fourth.ok).toBe(false);
    expect(fourth.text).toContain("上限 3"); // the refusal reports the limit
    // At the cap SUPERSEDE stays open (merge, don't pile): n4 replaces n1.
    const merged = await f.controller.knowAdd({ kind: "convention", title: "合并版", content: "y", supersedes: "n1" });
    expect(merged.ok).toBe(true);
    expect(f.controller.snapshot()?.notes?.length).toBe(4); // append-only audit
    // Fold: 45 live notes (cap raised) → 40 shown + 「还有 5 条」.
    const g = await fixture({ maxNotes: 60 });
    await g.controller.start("big");
    for (let i = 1; i <= 45; i++) await g.controller.knowAdd({ kind: "pitfall", title: `坑${i}`, content: "x" });
    const folded = await g.controller.know();
    expect(folded.text).toContain("还有 5 条");
    expect(folded.text).toMatch(/n45「坑45」/); // newest still visible
  });
});

describe("ω99-17 N7 — tool wrappers: real buildToolSet, validation precedes the controller", () => {
  const stubModel: ModelClient = {
    async generate() {
      return { role: "assistant", content: "" };
    },
  } as unknown as ModelClient;
  const allowAll = async (): Promise<PermissionDecision> => "allow";

  it("mission_know_add / mission_know ride the shared set; shape rejects never reach the controller", async () => {
    const log: string[] = [];
    const stub = {
      knowAdd: async (input: { kind: string; title: string }) => {
        log.push(`knowAdd:${input.kind}:${input.title}`);
        return { ok: true, text: "已登记 n1" };
      },
      know: async (kind?: string) => {
        log.push(`know:${kind ?? ""}`);
        return { ok: true, text: "知识 1 条" };
      },
    } as unknown as MissionController;
    const box: { current?: MissionController } = { current: stub };
    const set = buildToolSet({
      workspaceRoot: "/tmp/m81k-ws",
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
      mission: { getController: () => box.current },
    });
    const add = set.find((t) => t.name === "mission_know_add")!;
    const list = set.find((t) => t.name === "mission_know")!;
    expect(add).toBeDefined();
    expect(list).toBeDefined();
    // Fail-closed risk annotations: both are state writers on the ledger.
    for (const t of [add, list]) {
      expect(t.isReadOnly?.({})).toBe(false);
      expect(t.isDestructive?.({})).toBe(false);
      expect(t.isOpenWorld?.({})).toBe(false);
      expect(t.isConcurrencySafe?.({})).toBe(false);
    }
    const ok = await add.execute({ kind: "convention", title: "端口 8080", content: "统一 8080" });
    expect(ok.isError).toBeUndefined();
    expect(log).toEqual(["knowAdd:convention:端口 8080"]);
    const listed = await list.execute({ kind: "convention" });
    expect(listed.isError).toBeUndefined();
    // Shape rejects fire BEFORE the controller (zero side effects).
    const before = log.length;
    const emptyTitle = await add.execute({ kind: "convention", title: "   ", content: "x" });
    expect(emptyTitle.isError).toBe(true);
    const longContent = await add.execute({ kind: "convention", title: "t", content: "x".repeat(501) });
    expect(longContent.isError).toBe(true);
    const badKind = await add.execute({ kind: "vibe", title: "t", content: "x" });
    expect(badKind.isError).toBe(true);
    const longTitle = await add.execute({ kind: "decision", title: "t".repeat(81), content: "x" });
    expect(longTitle.isError).toBe(true);
    expect(log.length).toBe(before); // zero controller calls from the rejects
    // Semantic refusal (unknown supersedes) goes THROUGH a real controller
    // and commits nothing.
    const f = await fixture();
    await f.controller.start("campaign");
    box.current = f.controller;
    const unknown = await add.execute({ kind: "decision", title: "t", content: "c", supersedes: "n99" });
    expect(unknown.isError).toBe(true);
    expect(f.controller.snapshot()?.notes ?? []).toEqual([]);
    // An empty box (controller not yet created / absent) is a loud refusal.
    box.current = undefined;
    const none = await add.execute({ kind: "decision", title: "t", content: "c" });
    expect(none.isError).toBe(true);
  });

  it("the nine-tool face keeps createMissionTools' fixed order (registration untouched)", () => {
    const tools = createMissionTools(() => undefined);
    expect(tools.map((t) => t.name)).toEqual([
      "mission_plan",
      "mission_next",
      "mission_complete",
      "mission_fail",
      "mission_ratchet",
      "mission_know_add",
      "mission_know",
      "mission_bundle",
      "mission_start",
    ]);
  });
});

describe("ω99-17 N8 — status carries the live-knowledge count", () => {
  it("the knowledge line counts only non-superseded notes with a kind breakdown", async () => {
    const f = await fixture();
    await f.controller.start("campaign");
    expect(f.controller.status()).toContain("知识：0 条");
    await f.controller.knowAdd({ kind: "decision", title: "d", content: "x" }); // n1
    await f.controller.knowAdd({ kind: "convention", title: "c1", content: "x" }); // n2
    await f.controller.knowAdd({ kind: "pitfall", title: "p", content: "x" }); // n3
    await f.controller.knowAdd({ kind: "convention", title: "c2", content: "y", supersedes: "n2" }); // n4
    const s = f.controller.status();
    expect(s).toContain("知识：3 条"); // n1 + n3 + n4 — the superseded n2 is not counted
    expect(s).toContain("decision 1");
    expect(s).toContain("convention 1");
    expect(s).toContain("pitfall 1");
    expect(s).toContain("checklist 0");
  });
});
