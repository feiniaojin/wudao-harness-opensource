// M63-B — the ConfigChange consult on the permission settings watcher (the
// real hot-reload consumer): a settings change with an ALLOWING hook swaps
// the rules; a BLOCKING hook vetoes the swap (the previously accepted rules
// stay cached) and the revalidate window still ticks. Plus the A-round (c)
// end-to-end ORDER test through a REAL createPermissionGate: a settings deny
// rule outranks the hook (never consulted), an ask outcome consults the hook
// BEFORE the sidecar, and a hook allow skips both the classifier and the
// human ask.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermissionSettingsWatcher, createPermissionGate } from "../src/permission.js";
import type { Sidecar, SidecarVerdict } from "../src/sidecar.js";
import type { PermissionDecision } from "@wudao-org/core";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (name: string): string => join(FIXTURES, name);

async function tmpWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wudao-cfg-"));
  await mkdir(join(dir, ".wudao"), { recursive: true });
  return dir;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writePerm(root: string, allow: string[]): Promise<void> {
  await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({ permissions: { allow } }), "utf8");
}

describe("ConfigChange consult on the permission watcher", () => {
  it("an allowing consult swaps the rules; a blocking consult keeps the previous rules", async () => {
    const root = await tmpWorkspace();
    try {
      await writePerm(root, ["read_file"]);
      const notices: string[] = [];
      let veto = false;
      const positions: string[][] = [];
      const watcher = createPermissionSettingsWatcher(root, (l) => notices.push(l), {
        revalidateMs: 50,
        configChange: async (changed) => {
          positions.push([...changed]);
          return !veto;
        },
      });
      expect((await watcher.get()).allow).toEqual(["read_file"]);

      // Change 1 — allowed: the rules swap.
      await writePerm(root, ["read_file", "grep"]);
      await wait(120);
      expect((await watcher.get()).allow).toEqual(["read_file", "grep"]);
      expect(positions).toEqual([["project"]]);

      // Change 2 — vetoed: the PREVIOUS rules stay cached.
      veto = true;
      await writePerm(root, ["shell"]);
      await wait(120);
      expect((await watcher.get()).allow).toEqual(["read_file", "grep"]);
      expect(notices.some((n) => n.includes("被 configChange 钩子拦截"))).toBe(true); // ω99-166f-iii: 钉随源演进
      // R1: the veto does NOT loop — the observed state is pinned, so further
      // revalidations re-consult NOTHING until an actual further rewrite.
      const consultsBefore = positions.length;
      const noticesBefore = notices.filter((n) => n.includes("BLOCKED")).length;
      for (let i = 0; i < 4; i += 1) {
        await wait(80);
        await watcher.get();
      }
      expect(positions.length).toBe(consultsBefore);
      expect(notices.filter((n) => n.includes("BLOCKED")).length).toBe(noticesBefore);

      // Change 3 — a RE-write (after fixing the blocker) re-proposes and swaps.
      veto = false;
      await writePerm(root, ["shell", "glob"]);
      await wait(120);
      expect((await watcher.get()).allow).toEqual(["shell", "glob"]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 8000);
});

describe("A-round (c): end-to-end order through a REAL createPermissionGate", () => {
  // A recording sidecar: its check() call order is the assertion surface.
  const recordingSidecar = (log: string[]): Sidecar => ({
    check: async (tool: string) => {
      log.push(`sidecar:${tool}`);
      const verdict: SidecarVerdict = { kind: "low", reason: "stub-low" } as SidecarVerdict;
      return verdict;
    },
    breakerOpen: () => false,
    consecutiveHighs: () => 0,
    resetBreaker: () => {},
    resetRun: () => {},
  } as unknown as Sidecar);

  const hookFn = async (log: string[]): Promise<PermissionDecision | undefined> => {
    // The REAL fixture command runs (appending "hook-ran" to ./hook.log in
    // cwd) and answers allow — its execution IS the order evidence. win32:
    // a .sh cannot be exec'd — run it under Git Bash's sh (the interpreter
    // runHookCommand's fallback discovers).
    const fixture = fx("perm-log-allow.sh");
    const { execFile } = await import("node:child_process");
    const [exe, args] = process.platform === "win32"
      ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"), [fixture]]
      : [fixture, [] as string[]];
    return await new Promise<PermissionDecision>((resolve) => {
      const child = execFile(exe, args, { timeout: 5000, encoding: "utf8" }, (err) => {
        log.push(`hook:${err ? "error" : "ran"}`);
        resolve({ behavior: "allow" });
      });
      // The fixture reads stdin (cat > /dev/null) — close it or the child
      // blocks until the timeout (the bridge's runHookCommand does this).
      child.stdin?.on("error", () => {});
      child.stdin?.end();
    });
  };

  it("deny rule → hook never consulted; ask → hook BEFORE sidecar; hook allow skips sidecar AND ask", async () => {
    const root = await tmpWorkspace();
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      // A settings DENY rule on write_file; read tools allow; grep is the
      // ask-class probe (not in READ_TOOLS, denied? no — default mode asks).
      await writeFile(join(root, ".wudao", "settings.json"), JSON.stringify({
        permissions: { deny: ["write_file"], allow: ["read_file"] },
      }), "utf8");
      const log: string[] = [];
      const gate = createPermissionGate(
        ["--auto"],
        recordingSidecar(log),
        undefined,
        undefined,
        undefined,
        (toolName, _input) => {
          log.push(`hook-consult:${toolName}`);
          return hookFn(log);
        },
      );

      // (1) The deny rule outranks the hook: denied WITHOUT a consultation.
      const denied = await gate("write_file", { path: "a.txt" });
      expect(denied).toEqual({ behavior: "deny", reason: 'settings deny rule "write_file"' });
      expect(log.filter((l) => l.startsWith("hook-consult"))).toEqual([]);

      // (2) A read tool (static allow, sidecar-ungated): no hook, no sidecar.
      log.length = 0;
      const read = await gate("read_file", { path: "a.txt" });
      expect(read).toEqual({ behavior: "allow" });
      expect(log).toEqual([]);

      // (3) A write/exec-class tool in AUTO mode with a sidecar present: the
      // static layer allows (auto mode), the sidecar WOULD classify — so the
      // hook runs FIRST (before the classifier) and its ALLOW skips the
      // sidecar AND the human ask. The order evidence is the log sequence.
      log.length = 0;
      const classified = await gate("shell", { command: "ls" });
      expect(classified).toEqual({ behavior: "allow" });
      expect(log).toEqual(["hook-consult:shell", "hook:ran"]);
      // The real fixture command ran (its marker file proves execution).
      expect(await readFile(join(root, "hook.log"), "utf8")).toContain("hook-ran");
    } finally {
      process.chdir(prevCwd);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 10_000);
});
