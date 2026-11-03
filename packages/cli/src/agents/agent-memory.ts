// M64-B §B — agent memory: every roster role carries a persistent MEMORY.md
// its children read at spawn (the FIRST 200 LINES / 25KB, whichever first —
// deterministic truncation with a pruned marker) and write back through the
// ORDINARY file tools (no special tool). The tier routes the file and the
// lifecycle:
//
//   project (default)  <workspaceRoot>/.wudao/agent-memory/<role>/MEMORY.md
//                      — expires with cleanupPeriodDays (M62 §2 sweep)
//   local              <workspaceRoot>/.wudao/agent-memory-local/<role>/MEMORY.md
//                      — NEVER cleaned (lifecycle exception, pinned)
//   user               <globalHome>/agent-memory/<role>/MEMORY.md
//                      — NEVER cleaned, and lives OUTSIDE the workspace: the
//                      child's ordinary file tools reach it through the
//                      memory-root routing wrapper below (read_file/write_file/
//                      edit re-route memory-file calls to instances rooted at
//                      the memory root — same tools, same args, no new names).
//
// Truncation marker family (the parseSkillPrunedMarker analog): when the
// injection window truncates, the section ends with `[MEMORY_PRUNED: <role>
// — read_file <path> for the rest]`; any stale marker line already inside
// the file body is FILTERED on re-read so an appended note that copied a
// marker never re-injects stale content or cascades nested markers.
//
// Spec ruling: memory files are FILES, not peer messages — the §A
// untrusted-message machinery does not apply to them (nothing special here).
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createEditTool, createReadFileTool, createWriteFileTool } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";

export type AgentMemoryTier = "project" | "local" | "user";

/** The effective tier: the profile's `memory` field, defaulting to project
 *  (spec §B — unset means project-tier memory, not "no memory"). */
export function effectiveMemoryTier(declared: AgentMemoryTier | undefined): AgentMemoryTier {
  return declared ?? "project";
}

/** Fix round 1 (LOW): a memory-bearing role name must be a plain path
 *  segment — no separators, no dot segments — or the harness's OWN
 *  mkdir/read/injection would resolve OUTSIDE the tier root. The roster
 *  (ROLE_ID_RE) already refuses such ids at load; this is the boundary's
 *  fail-closed backstop (agentMemoryPaths throws). */
export const MEMORY_SAFE_ROLE_NAME = /^[A-Za-z0-9_-]+$/;

export function isMemorySafeRoleName(name: string): boolean {
  return MEMORY_SAFE_ROLE_NAME.test(name);
}

export interface AgentMemoryPaths {
  readonly tier: AgentMemoryTier;
  /** The tier's memory ROOT (cleanable boundary + the routing target). */
  readonly root: string;
  /** This role's memory file, absolute. */
  readonly file: string;
}

/** The three directory routings (spec §B). Pure; throws on a role name
 *  that is not a plain path segment (the load-time guard's backstop —
 *  a `../`-shaped id must never move the memory file outside the tier). */
export function agentMemoryPaths(
  tier: AgentMemoryTier,
  roleName: string,
  opts: { readonly workspaceRoot: string; readonly globalHome: string },
): AgentMemoryPaths {
  if (!isMemorySafeRoleName(roleName)) {
    throw new Error(`agent memory: role name "${roleName}" is not a plain path segment (letters/digits/_/-) — refusing to route outside the tier root`);
  }
  const root =
    tier === "project"
      ? join(opts.workspaceRoot, ".wudao", "agent-memory")
      : tier === "local"
        ? join(opts.workspaceRoot, ".wudao", "agent-memory-local")
        : join(opts.globalHome, "agent-memory");
  return { tier, root, file: join(root, roleName, "MEMORY.md") };
}

// ---------------------------------------------------------------------------
// Injection bounds + the pruned-marker family
// ---------------------------------------------------------------------------

export const MEMORY_INJECTION_MAX_LINES = 200;
export const MEMORY_INJECTION_MAX_BYTES = 25 * 1024;

export const MEMORY_PRUNED_PREFIX = "[MEMORY_PRUNED:";

export function formatMemoryPrunedMarker(role: string, path: string): string {
  return `${MEMORY_PRUNED_PREFIX} ${role} — memory truncated at ${MEMORY_INJECTION_MAX_LINES} lines/${MEMORY_INJECTION_MAX_BYTES} bytes for this spawn — read_file ${path} for the rest]`;
}

/** Parse a `[MEMORY_PRUNED: <role> — … read_file <path> …]` line; undefined
 *  when the text is not one (the parseSkillPrunedMarker analog — the marker
 *  family's parser, used to FILTER stale markers on re-read). */
export function parseMemoryPrunedMarker(content: string): { readonly role: string; readonly path: string } | undefined {
  const line = content.split(/\r?\n/, 1)[0] ?? "";
  if (!line.startsWith(MEMORY_PRUNED_PREFIX)) return undefined;
  const role = /^\s*([^—]+?)\s*—/.exec(line.slice(MEMORY_PRUNED_PREFIX.length))?.[1];
  const path = /read_file\s+(\S+?)\s+for the rest\]/.exec(line)?.[1];
  if (role === undefined || path === undefined) return undefined;
  return { role, path };
}

export interface MemoryInjection {
  /** The bounded body (stale markers filtered; the fresh marker line already
   *  appended when truncated). */
  readonly body: string;
  readonly truncated: boolean;
  /** Lines dropped from the window (beyond the bounds or filtered markers). */
  readonly droppedLines: number;
}

/** Build the spawn injection from the file text: FIRST 200 LINES or 25KB,
 *  whichever comes first. Deterministic: lines accumulate in file order; a
 *  line that would cross the BYTE bound ends the window (never a partial
 *  line); any stale `[MEMORY_PRUNED: …]` line inside the window is filtered
 *  (appended notes never re-inject stale content) and a fresh marker is
 *  appended when anything was dropped. Pure. */
export function buildMemoryInjection(text: string): MemoryInjection {
  // Fix round 1 (LOW): strip ONE trailing newline before splitting — a file
  // of exactly 200 content lines that ends with a newline must not read as
  // 201 lines (a phantom empty 201st line tripped TRUNCATED).
  const allLines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  const window: string[] = [];
  let bytes = 0;
  let truncated = false;
  let dropped = 0;
  for (const line of allLines) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const nextBytes = bytes + lineBytes + (window.length > 0 ? 1 : 0);
    if (window.length >= MEMORY_INJECTION_MAX_LINES || nextBytes > MEMORY_INJECTION_MAX_BYTES) {
      truncated = true;
      dropped = allLines.length - window.length;
      break;
    }
    if (line.trimStart().startsWith(MEMORY_PRUNED_PREFIX)) {
      dropped += 1; // stale marker inside the file — filtered, never re-injected
      continue;
    }
    window.push(line);
    bytes = nextBytes;
  }
  // Trailing empties from a trailing newline are content, not drops.
  return { body: window.join("\n"), truncated, droppedLines: dropped };
}

/** Read the role's memory file; undefined when absent/unreadable (a fresh
 *  role starts empty). */
export async function readAgentMemory(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The system-prompt section the child gains at spawn. `content` is the
 *  bounded file body. `fileExists: false` → the bootstrap line (create it);
 *  `fileExists: true` + `fileEmpty: true` → the file exists but is EMPTY
 *  (write your first notes into it); `fileExists: true` with an empty
 *  window and content in the file → the first line alone exceeds the
 *  200-line/25KB bound — a "too large" note with NO creation suggestion
 *  (following the bootstrap would have OVERWRITTEN the role's memory). */
export function memoryPromptSection(args: {
  readonly tier: AgentMemoryTier;
  readonly role: string;
  readonly file: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly fileExists: boolean;
  /** The file exists but has no content (0 bytes / whitespace only). */
  readonly fileEmpty?: boolean;
}): string {
  const header =
    `# Your persistent memory (${args.tier} tier)\n` +
    `This role has a memory file at ${args.file} that persists across every run of this role.\n` +
    `- Read it above (this spawn's view${args.truncated ? " — TRUNCATED, the full file has more; read_file it" : ""}).\n` +
    `- Write back with your ORDINARY file tools (read_file/write_file/edit on that exact path) — append dated notes about what you learned; keep it concise.\n` +
    `${args.tier === "project" ? "- Project-tier memory expires with the workspace's cleanupPeriodDays — durable knowledge belongs in the repo, not here.\n" : "- This tier's memory is never auto-cleaned.\n"}`;
  let body: string;
  if (args.content.trim() !== "") {
    body = args.content;
  } else if (!args.fileExists) {
    body = "(no memory yet — create the file with write_file and start your notes)";
  } else if (args.fileEmpty === true) {
    body = "(this memory file exists but is empty — write your first notes into it)";
  } else {
    body = `(this file EXISTS but its first line alone exceeds the ${MEMORY_INJECTION_MAX_LINES}-line/${MEMORY_INJECTION_MAX_BYTES}-byte spawn bound — read_file ${args.file} yourself; do NOT overwrite it)`;
  }
  return `${header}\n${body.trim()}`;
}

// ---------------------------------------------------------------------------
// Tool admission: the ordinary file tools reach the memory file
// ---------------------------------------------------------------------------

const MEMORY_ROUTED_TOOLS = new Set(["read_file", "write_file", "edit"]);

/** Lexically resolve a tool target against a root; undefined when the arg is
 *  not a string path. */
function targetAbs(root: string, args: Record<string, unknown>): string | undefined {
  const p = args.path;
  if (typeof p !== "string" || p.trim() === "") return undefined;
  return resolve(root, p);
}

/** Is `candidate` inside `root` (lexical)? */
function inside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), candidate);
  return rel !== "" && !rel.startsWith("..") && rel !== "..";
}

export interface MemoryToolRoutingOptions {
  readonly workspaceRoot: string;
  /** Fix round 1 (MEDIUM): the ROLE'S OWN memory directory (dirname of its
   *  MEMORY.md) — never the tier root. A child reaches exactly its own
   *  memory; a sibling role's file (same tier) stays out of reach. */
  readonly memoryDir: string;
  /** Route in-workspace memory targets too — only for children whose tools
   *  are rooted ELSEWHERE (worktree children: the main workspace's memory
   *  tree is outside their worktree). Ordinary children keep their SESSION
   *  tools for in-workspace memory writes, so the M32 staleness gate,
   *  rewind snapshots, and write-verify all still apply (fix round 1 LOW:
   *  routing bare instances everywhere silently bypassed them). */
  readonly routeInWorkspace?: boolean;
}

/** Wrap read_file/write_file/edit so calls targeting the role's OWN memory
 *  directory reach tool instances rooted there. In-workspace targets fall
 *  through to the (possibly guard-wrapped) SESSION tool — the ordinary
 *  machinery (staleness gate, history, write-verify) stays in the loop;
 *  only genuinely out-of-workspace targets (the USER tier) route to the
 *  memory-rooted instances. Non-memory targets fall through untouched.
 *  Same tool names, same arguments — no special tool. */
export function applyMemoryFileRouting(tools: readonly Tool[], opts: MemoryToolRoutingOptions): Tool[] {
  const dir = resolve(opts.memoryDir);
  const ws = resolve(opts.workspaceRoot);
  const rooted: Record<string, Tool> = {
    read_file: createReadFileTool({ workspaceRoot: dir }),
    write_file: createWriteFileTool({ workspaceRoot: dir }),
    edit: createEditTool({ workspaceRoot: dir }),
  };
  const routeInWorkspace = opts.routeInWorkspace === true;
  return tools.map((tool) => {
    if (!MEMORY_ROUTED_TOOLS.has(tool.name)) return tool;
    return {
      ...tool,
      async execute(args: Record<string, unknown>) {
        const target = targetAbs(ws, args) ?? targetAbs(dir, args);
        if (target !== undefined && inside(dir, target)) {
          const outOfWorkspace = !inside(ws, target);
          if (outOfWorkspace || routeInWorkspace) {
            const rel = relative(dir, target);
            return rooted[tool.name]!.execute({ ...args, path: rel });
          }
        }
        return tool.execute(args);
      },
    };
  });
}
