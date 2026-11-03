// M31 §1 — the write-scope tool guard. Applied at the CHILD tool-set
// construction inside the task tool (never globally): a role with an
// effective write scope gets write_file/edit/shell wrapped so a
// target outside the scope fails closed with a message that names the
// scope. Read tools are never wrapped. shell is exempt only when the
// SESSION is sandboxed or the role explicitly declared allowShell — a shell
// can write anywhere, so without an exemption it is refused with a pointer
// at worktree-isolated roles.
import { relative, resolve } from "node:path";
import type { Tool, WriteScopeDeclaration } from "@wudao-org/core";
import { formatWriteScope, pathInWriteScope } from "@wudao-org/core";

/** Tools with write semantics the guard knows how to police. */
const WRITE_GUARDED_TOOLS = new Set(["write_file", "edit", "shell"]);

export interface WriteScopeGuardOptions {
  readonly workspaceRoot: string;
  readonly scope: WriteScopeDeclaration;
  /** shell exemption: sandboxed session OR role allowShell. */
  readonly allowShell: boolean;
  /** M64-B §B + fix round 1: absolute roots the guard ALWAYS admits
   *  regardless of the declared scope — the caller passes the role's OWN
   *  memory directory (never the tier root: a scoped role may write ITS
   *  memory, not its tier-mates'). The underlying tool's own containment
   *  still applies; this only lifts the SCOPE refusal. */
  readonly alwaysAllowAbs?: readonly string[];
}

/** Lexically collapse `inputPath` against the root and return it
 *  workspace-relative; undefined when it lands at/above the root (outside
 *  every declared scope by construction). Symlink escapes stay the wrapped
 *  tool's own job — this guard never widens what the tool allows. */
function toWorkspaceRelative(workspaceRoot: string, inputPath: string): string | undefined {
  const abs = resolve(workspaceRoot, inputPath);
  const rel = relative(resolve(workspaceRoot), abs);
  if (rel === "" || rel.startsWith("..")) return undefined;
  return rel;
}

export function applyWriteScopeGuard(tools: readonly Tool[], options: WriteScopeGuardOptions): Tool[] {
  return tools.map((tool) => {
    if (!WRITE_GUARDED_TOOLS.has(tool.name)) return tool;
    return {
      ...tool,
      async execute(args: Record<string, unknown>) {
        if (tool.name === "shell") {
          if (options.allowShell) return tool.execute(args);
          return {
            content:
              "shell refused: this role's writes are scoped, and a shell can write anywhere — " +
              "use a worktree role (\"worktree\": true), a sandboxed session (--sandbox), or declare \"allowShell\": true on the role",
            isError: true,
          };
        }
        const target = typeof args.path === "string" ? args.path : undefined;
        if (target === undefined) return tool.execute(args); // its own arg validation answers
        // M64-B §B: the role's memory root rides ABOVE the declared scope —
        // a scoped role can always read/write its own memory file.
        if (options.alwaysAllowAbs !== undefined && options.alwaysAllowAbs.length > 0) {
          const abs = resolve(options.workspaceRoot, target);
          const admitted = options.alwaysAllowAbs.some((root) => {
            const relFromRoot = relative(resolve(root), abs);
            return relFromRoot !== "" && !relFromRoot.startsWith("..") && relFromRoot !== "..";
          });
          if (admitted) return tool.execute(args);
        }
        const rel = toWorkspaceRelative(options.workspaceRoot, target);
        if (rel === undefined || !pathInWriteScope(options.scope, rel)) {
          return {
            content:
              `${tool.name} refused: "${target}" is outside this role's write scope (${formatWriteScope(options.scope)}) — ` +
              "reads stay unrestricted; write inside the scope or ask the parent to dispatch a role that owns this path",
            isError: true,
          };
        }
        return tool.execute(args);
      },
    };
  });
}
