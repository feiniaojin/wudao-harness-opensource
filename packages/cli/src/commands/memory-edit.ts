// M55 §A6 — `/memory edit`: open the session's CONTEXT FILES (the
// project-context markdown the system prompt loads) in $EDITOR. The memory
// STORE (.wudao/memory.jsonl) is deliberately not the target — it is an
// append-only, id-addressed journal that is not hand-edit friendly; its
// command face stays list/del/ok. Editing context files is what humans
// actually edit. Because the project-context section is session-static
// (loaded once per process for prefix-cache stability, M54), the receipt
// reminds the user to restart. Fallback (no $EDITOR / spawn failure): print
// the paths + guidance instead of failing.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { relative } from "node:path";

/** Candidate context files at the workspace root, native-first (the same
 *  filenames project-context.ts loads; AGENTS.md/CLAUDE.md are the compat
 *  spellings). */
export const CONTEXT_FILE_CANDIDATES: readonly string[] = ["WUDAO.md", "AGENTS.md", "CLAUDE.md"];

/** The first existing workspace context file (undefined when none exists). */
export function findContextFile(workspaceRoot: string): string | undefined {
  for (const name of CONTEXT_FILE_CANDIDATES) {
    const path = join(workspaceRoot, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** All existing context paths for the fallback listing (workspace + global). */
export function listContextPaths(workspaceRoot: string): string[] {
  const out: string[] = [];
  const local = findContextFile(workspaceRoot);
  if (local !== undefined) out.push(relative(workspaceRoot, local));
  const global = join(homedir(), ".wudao", "WUDAO.md");
  if (existsSync(global)) out.push("~/.wudao/WUDAO.md");
  return out;
}

/** The seam tests inject; resolves with the exit code, rejects never (spawn
 *  failures resolve as code -1 + the error message). */
export type EditorSpawnFn = (editor: string, args: readonly string[]) => Promise<{ code: number; error?: string }>;

/** The real spawn: stdio inherit so the editor owns the terminal. */
export function createEditorSpawn(cwd: string): EditorSpawnFn {
  return (editor, args) =>
    new Promise((resolve) => {
      const child = spawn(editor, [...args], { stdio: "inherit", cwd, shell: false });
      child.on("error", (err) => resolve({ code: -1, error: err.message }));
      child.on("exit", (code) => resolve({ code: code ?? -1 }));
    });
}

function editorFrom(env: NodeJS.ProcessEnv): string | undefined {
  const raw = (env.EDITOR ?? env.VISUAL ?? "").trim();
  return raw === "" ? undefined : raw;
}

/** `/memory edit` — returns the notice text (never throws). */
export async function runMemoryEditCommand(
  workspaceRoot: string,
  opts: { readonly env?: NodeJS.ProcessEnv; readonly spawnEditor?: EditorSpawnFn } = {},
): Promise<string> {
  const env = opts.env ?? process.env;
  const paths = listContextPaths(workspaceRoot);
  const editor = editorFrom(env);
  const target = findContextFile(workspaceRoot);
  if (editor === undefined || target === undefined) {
    // Fallback: no editor configured, or no workspace context file to open.
    const lines = ["/memory edit — no editor ran."];
    lines.push(
      paths.length > 0
        ? `context files present: ${paths.join(", ")} — set $EDITOR (or $VISUAL) to open them here next time`
        : "no context file found at the workspace root — create WUDAO.md (or AGENTS.md / CLAUDE.md) to add project rules the system prompt loads",
    );
    lines.push("(the memory STORE .wudao/memory.jsonl is append-only and not hand-edit friendly — manage it with /memory list|del <id>|ok <id>)");
    lines.push("(edits load on the next start: the project-context section is session-static to keep the prefix cache warm)");
    return lines.join("\n");
  }
  const spawnEditor = opts.spawnEditor ?? createEditorSpawn(workspaceRoot);
  const r = await spawnEditor(editor, [target]);
  if (r.code !== 0) {
    return `⚠️ editor "${editor}" exited with code ${r.code}${r.error !== undefined ? ` (${r.error})` : ""} — no edits applied`;
  }
  return [
    `edited ${relative(workspaceRoot, target)} with ${editor}`,
    "restart wudao to load the new project context (the section is session-static for prefix-cache stability)",
  ].join("\n");
}
