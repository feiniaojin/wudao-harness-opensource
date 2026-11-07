import { buildTool } from "../tool.js";
import { listWorkspaceFiles } from "./workspace.js";
import { capOutputLines } from "./output-caps.js";

/** ω99-30 (F): the literal dot segments a pattern NAMES — path segments that
 *  start with "." and carry no wildcard (`*` / `?`). Naming a dot directory
 *  in the pattern is the intent signal that lets the walker enter it
 *  (pattern-as-intent: an implicit recursive pattern names nothing, so the
 *  default hidden face is unchanged). `.git` is HARD-EXCLUDED here — the
 *  same immune-protected posture the permission pipeline gives .git: never
 *  reachable, even named. */
function literalDotSegments(pattern: string): ReadonlySet<string> {
  const segments = new Set<string>();
  for (const seg of pattern.split("/")) {
    if (seg.startsWith(".") && !seg.includes("*") && !seg.includes("?")) segments.add(seg);
  }
  segments.delete(".git");
  return segments;
}

export function createGlobTool(options: { workspaceRoot: string }) {
  return buildTool({
    name: "glob",
    promptSnippet: "find files by path pattern",
    description: "Find files whose path matches a glob pattern ('**/' matches recursively). Returns up to 200 matches, relative to the workspace (output capped at 2000 lines / 50KB). " +
    "Example: {pattern: 'src/**/*.test.ts'} lists the test files under src. " +
    "Do NOT use glob to search file CONTENTS (grep) or to fetch a file you already know the path of (read_file it directly). " +
    "Dot-directories (and dot-files) are skipped unless the pattern names one explicitly (e.g. '.wudao/**'); .git is never matched.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts' or 'src/*.js'." } },
      required: ["pattern"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute({ pattern }) {
      try {
        const files = await listWorkspaceFiles(options.workspaceRoot, literalDotSegments(pattern as string));
        const re = globToRegex(pattern as string);
        const matches = files.filter((p) => re.test(p)).sort().slice(0, 200);
        if (matches.length === 0) return { content: "(no matches)" };
        return { content: capOutputLines(matches.join("\n")) };
      } catch (err) {
        return { content: `glob failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

/** M62 §1: the builtin glob matcher, exported for the CLI's path-gated
 *  context rules (`.wudao/rules/**` `paths:` globs) so rule scoping and the
 *  glob tool agree on semantics — one matcher, no second dialect. */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === undefined) break;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if ("+.^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
