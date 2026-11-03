// 夜移 032 — the wiring seam: the SAME tracker instance threaded into the
// tool set (write_file/edit record committed writes) and the driver (reset
// at run start, receipt at run settle) — the session-engine shape exercised
// end-to-end at the driver level. A scripted run whose tool calls write real
// files in a tmpdir lands exactly ONE net-change notice — preview in text,
// git-style diff in detail — AHEAD of the run-stats receipt; a run with no
// writes lands none; the next run starts from an empty ledger (resetRun).
import { describe, it, expect } from "vitest";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, createTurnDiffTracker, createWriteFileTool, createEditTool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

interface NoticeEntry {
  kind: "notice";
  text: string;
  detail?: string;
  /** ω99-216（托付闭环·亲验改动）：净变更收据的轻摘要——同 seam 落、随
   *  本测试的 NoticeEntry 视角演进（census 点名）。 */
  changes?: readonly { path: string; op: "created" | "modified"; writes: number }[];
}

function notices(d: ReturnType<typeof createAgentDriver>): NoticeEntry[] {
  return d.getHistory().filter((e): e is NoticeEntry => e.kind === "notice");
}

describe("夜移 032 driver seam — net-change receipt", () => {
  it("a write-then-edit run lands ONE net-change notice (preview + git diff) before the stats receipt", async () => {
    // realpath: macOS tmpdir is a symlink (/tmp → /private/tmp) — the
    // resolved write target is canonical, so the root must be too.
    const ws = await realpath(await mkdtemp(join(tmpdir(), "td-drv-")));
    try {
      const t = createTurnDiffTracker();
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "out.ts", content: "one\n" } }] },
          { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "edit", arguments: { path: "out.ts", old_string: "one", new_string: "two" } }] },
          { role: "assistant", content: "done" },
        ]),
        tools: [
          createWriteFileTool({ workspaceRoot: ws, turnDiff: t }),
          createEditTool({ workspaceRoot: ws, turnDiff: t }),
        ],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.submit("make it");
      await until(() => driver.getStatus().busy === false && notices(driver).some((n) => n.text.includes("耗时")), "run settled");
      const ns = notices(driver);
      const netIdx = ns.findIndex((n) => n.text.includes("回合净变更"));
      expect(netIdx).toBeGreaterThanOrEqual(0);
      // two writes, one net entry: create + edit collapse, created keeps 新建
      expect(ns[netIdx]?.text).toBe("回合净变更 1 文件：out.ts(新建)");
      // the full diff rides the detail: new-file shape, no a-side deletions
      const detail = ns[netIdx]?.detail ?? "";
      expect(detail).toContain("diff --git a/out.ts b/out.ts");
      expect(detail).toContain("new file");
      expect(detail).toContain("+two");
      expect(detail).not.toContain("-one");
      // ω99-216（托付闭环·亲验改动）: the light summary the changes panel
      // aggregates rides the SAME entry — rel path, created-vs-modified, and
      // the write count (create + edit collapse to writes=2); before/after
      // snapshots NEVER ride the entry (detail already carries the diff).
      // ω99-288: #8 — lockstep 同形演进：数据层补齐的每文件 +M/−K 随轻摘
      // 要过境（created 净内容 "two\n" vs 空 → +1/−0）。
      expect(ns[netIdx]?.changes).toEqual([{ path: "out.ts", op: "created", writes: 2, plus: 1, minus: 0 }]);
      // ordering: the net-change receipt lands BEFORE the run-stats receipt
      const statsIdx = ns.findIndex((n) => n.text.includes("耗时"));
      expect(statsIdx).toBeGreaterThan(netIdx);
      // exactly one net-change notice for the run
      expect(ns.filter((n) => n.text.includes("回合净变更"))).toHaveLength(1);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a run with no writes lands NO net-change notice, and the next run's ledger is fresh", async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), "td-drv2-")));
    try {
      const t = createTurnDiffTracker();
      // run 1 writes; run 2 is a pure answer — no notice for run 2.
      const driver = createAgentDriver({
        model: createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "a.ts", content: "v1\n" } }] },
          { role: "assistant", content: "wrote" },
          { role: "assistant", content: "just talking" },
        ]),
        tools: [createWriteFileTool({ workspaceRoot: ws, turnDiff: t })],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        turnDiff: t,
        onPermissionAsk: async () => ({ kind: "allow" as const }),
      });
      driver.submit("run one");
      await until(() => notices(driver).some((n) => n.text.includes("回合净变更")), "run-1 receipt");
      driver.submit("run two");
      await until(() => driver.getStatus().busy === false, "run two settled");
      await wait(50);
      // resetRun cleared the ledger at run-2 start: still exactly one receipt
      expect(notices(driver).filter((n) => n.text.includes("回合净变更"))).toHaveLength(1);
      // ω99-216: the summary too is per-run — one entry, the single write
      // ω99-288（续，标记见上）: counts ride along (created "v1\n" → +1/−0).
      const run1 = notices(driver).find((n) => n.text.includes("回合净变更"));
      expect(run1?.changes).toEqual([{ path: "a.ts", op: "created", writes: 1, plus: 1, minus: 0 }]);
      // and the tracker itself is empty for the next run
      expect(t.files()).toHaveLength(0);
      driver.dispose();
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
