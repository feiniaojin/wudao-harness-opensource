// ω99 拆分运动 弧 B：mission 存储层外提（指针/档案的读写原子性 + 台账装载 +
// 活跃技能包根只读面——原 mission.ts 模块级段逐字保留；mission.ts re-export
// 门面保公共面）。
import { truncateSafe } from "@wudao/core"; // 113-A4
import { lstat, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MISSION_STORE_FILE, MISSIONS_DIR, MISSION_ARCHIVE_ID_PATTERN, MISSION_BUNDLE_NAME_PATTERN, missionBundleSkillsRoot, validMission } from "./mission-model.js";
import type { MissionState, MissionPointerSummary } from "./mission-model.js";

const POINTER_SUMMARY_OBJECTIVE_MAX_CHARS = 160;

const pointerSummaryOf = (m: MissionState): MissionPointerSummary => ({
  id: m.id,
  objective: truncateSafe(m.objective, POINTER_SUMMARY_OBJECTIVE_MAX_CHARS),
  status: m.status,
  createdAt: m.createdAt,
  tasksDone: m.tasks.filter((t) => t.status === "done").length,
  tasksTotal: m.tasks.length,
});

/** The archive path for a mission id — the filename-safety gate runs BEFORE
 *  any join (a tampered pointer cannot smuggle a traversal path). */
function missionArchivePath(workspaceRoot: string, id: string): string {
  if (!MISSION_ARCHIVE_ID_PATTERN.test(id)) throw new MissionStoreError("corrupt", join(workspaceRoot, ".wudao", MISSIONS_DIR, `${id}.json`));
  return join(workspaceRoot, ".wudao", MISSIONS_DIR, `${id}.json`);
}

/** cron.json's atomic write: write beside, rename over. */
async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

/** Corrupt (unparseable / wrong shape) or symlinked store — the controller
 *  refuses to operate rather than silently rebuilding the ledger. */
export class MissionStoreError extends Error {
  constructor(readonly kind: "corrupt" | "symlink", readonly path: string) {
    super(`mission store ${kind}: ${path}`);
  }
}

export interface MissionStoreHandle {
  /** The loaded mission (null = none/completed-and-cleared record absent). */
  readonly mission: MissionState | null;
  save(next: MissionState | null): Promise<void>;
}


/** Load (or create) the mission store. A symlinked target refuses (the
 *  pointer AND the archive it names); an unparseable/invalid file THROWS
 *  (fail-closed — the caller surfaces the refusal; the ledger is never
 *  silently rebuilt). Reads: version 2 pointer → the pointed-at archive
 *  file; legacy version 1 → the inline mission, in place. */
export async function loadMissionStore(opts: { readonly workspaceRoot: string }): Promise<MissionStoreHandle> {
  const dir = join(opts.workspaceRoot, ".wudao");
  const path = join(dir, MISSION_STORE_FILE);
  const archivesDir = join(dir, MISSIONS_DIR);
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new MissionStoreError("symlink", path);
  let mission: MissionState | null = null;
  // ω99-36 — set when the ledger came from a legacy v1 mission.json: those
  // bytes live ONLY in the file the next save overwrites, so that save must
  // backfill the archive before the pointer flip (migration zero-loss).
  let legacy: MissionState | undefined;
  if (info !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new MissionStoreError("corrupt", path);
    }
    const file = parsed as { version?: unknown; mission?: unknown; missionId?: unknown };
    if (typeof file !== "object" || file === null) throw new MissionStoreError("corrupt", path);
    if (file.version === 1 && "mission" in file) {
      // Legacy inline ledger — reads in place (T1: non-destructive, no .bak).
      if (file.mission !== null) {
        if (!validMission(file.mission)) throw new MissionStoreError("corrupt", path);
        mission = file.mission;
        legacy = file.mission;
      }
    } else if (file.version === 2 && "missionId" in file) {
      // ω99-36 pointer — the read side loads the POINTER'S TARGET FILE.
      if (file.missionId !== null) {
        if (typeof file.missionId !== "string") throw new MissionStoreError("corrupt", path);
        const archive = missionArchivePath(opts.workspaceRoot, file.missionId);
        const aInfo = await lstat(archive).catch(() => undefined);
        if (aInfo === undefined) throw new MissionStoreError("corrupt", archive);
        if (aInfo.isSymbolicLink()) throw new MissionStoreError("symlink", archive);
        let body: unknown;
        try {
          body = JSON.parse(await readFile(archive, "utf8"));
        } catch {
          throw new MissionStoreError("corrupt", archive);
        }
        const f = body as { version?: unknown; mission?: unknown };
        if (typeof f !== "object" || f === null || f.version !== 1 || !("mission" in f) || !validMission(f.mission)) {
          throw new MissionStoreError("corrupt", archive);
        }
        mission = f.mission;
      }
    } else {
      throw new MissionStoreError("corrupt", path);
    }
  }
  return {
    mission,
    save: async (next) => {
      await mkdir(archivesDir, { recursive: true });
      // ω99-36 — the displaced legacy mission's bytes backfill FIRST (the v1
      // file is the only place they live), then the mission's archive, then
      // the pointer flip LAST (the pointer never names a missing file).
      if (legacy !== undefined) {
        if (next === null || next.id !== legacy.id) {
          await writeAtomic(missionArchivePath(opts.workspaceRoot, legacy.id), `${JSON.stringify({ version: 1, mission: legacy }, null, 2)}\n`);
        }
        legacy = undefined; // same-id save: the archive write below carries it
      }
      if (next !== null) {
        await writeAtomic(missionArchivePath(opts.workspaceRoot, next.id), `${JSON.stringify({ version: 1, mission: next }, null, 2)}\n`);
      }
      await writeAtomic(path, `${JSON.stringify(next === null
        ? { version: 2, missionId: null, summary: null }
        : { version: 2, missionId: next.id, summary: pointerSummaryOf(next) }, null, 2)}\n`);
    },
  };
}

/** ω99-18 — the assembly-side pure read: the ACTIVE mission's bundle skills
 *  roots. Fail-closed silent — a missing/corrupt/wrong-shape/non-active
 *  ledger reads as [] (boot must never die on a broken ledger); a bundle
 *  name failing the whitelist is skipped (a tampered ledger cannot smuggle a
 *  traversal path into the discovery walk). mission.ts never imports
 *  extension-state (cycle guard); extension-state imports THIS one function.
 *  Pure read: no writes, no controller state. */
export function activeBundleSkillRoots(workspaceRoot: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(workspaceRoot, ".wudao", MISSION_STORE_FILE), "utf8"));
  } catch {
    return []; // absent / unreadable / unparseable — nothing to mount
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const file = parsed as { version?: unknown; mission?: unknown; missionId?: unknown };
  let mission: unknown;
  if (file.version === 1 && "mission" in file) {
    mission = file.mission; // legacy inline ledger — same silent-read contract
  } else if (file.version === 2 && "missionId" in file && typeof file.missionId === "string") {
    // ω99-36 — the pointer names the ledger file; follow it (one sync read).
    try {
      const body = JSON.parse(readFileSync(missionArchivePath(workspaceRoot, file.missionId), "utf8")) as { version?: unknown; mission?: unknown };
      mission = typeof body === "object" && body !== null && body.version === 1 ? body.mission : undefined;
    } catch {
      return []; // missing/unparseable archive — boot never dies on a broken ledger
    }
  } else {
    return [];
  }
  if (!validMission(mission)) return [];
  if (mission.status !== "active") return [];
  return (mission.bundles ?? [])
    .filter((b) => MISSION_BUNDLE_NAME_PATTERN.test(b))
    .map((b) => missionBundleSkillsRoot(workspaceRoot, b));
}
