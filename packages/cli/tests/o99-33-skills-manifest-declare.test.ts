// ω99-33 rider — the reason-less rescan declaration gap (round-1 report
// 顾虑2): the ω99-24 B poll parks an M24 attribution only for TYPED bundle
// reasons, but a rescan with no reason can still MOVE the trailing
// <available_skills> manifest (a skill dir added/removed, a SKILL.md
// description edit) — that header break read as an unexplained ⚠️. The
// manifest bytes are the only prompt bytes a rescan may move (the byte
// invariant), so comparing exactly them declares exactly that cost.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExtensionState,
  initExtensionRuntime,
  rescanExtensionsAt,
  resetExtensionRuntime,
  takePendingBundleColdAttribution,
} from "../src/extension-state.js";

let ws: string;
let home: string; // isolated WUDAO_GLOBAL_HOME — the global tier never reaches the dev's real home
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "o99-33-rider-"));
  home = await mkdtemp(join(tmpdir(), "o99-33-home-"));
});
afterEach(async () => {
  resetExtensionRuntime();
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const skillMd = (name: string): string => `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${name} body.\n`;
const writeSkill = async (name: string): Promise<void> => {
  const dir = join(ws, ".claude", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd(name), "utf8");
};

describe("ω99-33 rider — a reason-less rescan that moves the manifest declares its cost", () => {
  it("① manifest change (skill added) parks the M24 attribution the next row consumes", async () => {
    const env = { ...process.env, WUDAO_GLOBAL_HOME: home };
    await writeSkill("alpha");
    const boot = await buildExtensionState(ws, [], { env });
    initExtensionRuntime(ws, [], boot, { env });
    expect(takePendingBundleColdAttribution()).toBeUndefined(); // boot parks nothing

    await writeSkill("beta"); // the manifest WILL move — no bundle ops involved
    await rescanExtensionsAt(ws); // reason-LESS
    expect(takePendingBundleColdAttribution()).toBe("skills manifest changed (reason-less rescan)");

    // one-shot: a second read owes nothing
    expect(takePendingBundleColdAttribution()).toBeUndefined();
  });

  it("② a byte-stable reason-less rescan parks nothing (no bytes moved, no declaration)", async () => {
    const env = { ...process.env, WUDAO_GLOBAL_HOME: home };
    await writeSkill("alpha");
    initExtensionRuntime(ws, [], await buildExtensionState(ws, [], { env }), { env });
    await rescanExtensionsAt(ws); // nothing changed on disk
    expect(takePendingBundleColdAttribution()).toBeUndefined();
  });

  it("③ a typed bundle reason keeps its own (more specific) attribution", async () => {
    const env = { ...process.env, WUDAO_GLOBAL_HOME: home };
    await writeSkill("alpha");
    initExtensionRuntime(ws, [], await buildExtensionState(ws, [], { env }), { env });
    await rescanExtensionsAt(ws, { op: "mount", names: ["migration"] });
    expect(takePendingBundleColdAttribution()).toBe("mission-bundle:mount migration");
  });
});
