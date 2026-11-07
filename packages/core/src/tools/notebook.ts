// 夜移 027 — notebook 会话内草稿板 (Strands strands-ts notebook, disk-backed).
// The model's working memory: intermediate findings, plan drafts,
// observations to fold into the final answer — WITHOUT polluting the
// user's tree (write_file rides the permission pipeline) or the context
// (compaction stubs old tool results). Disk-backed under
// <bootRoot>/.wudao/notebooks/ (the plan.md convention: .wudao is session
// runtime data, not workspace files): survives resume, survives
// compaction, user-inspectable as plain markdown.
//
// Divergences from Strands (recorded in the ledger): insertLine mode
// dropped (line-number/negative-index/search-text insertion is a
// complexity trap; append/replace/clear cover the draft shapes); no
// implicit default notebook (explicit create); a per-notebook char cap
// (Strands is unbounded); names validated fail-closed because they
// become file paths — Strands' in-memory map had no such surface.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTool } from "../tool.js";

export const NOTEBOOK_MAX_CHARS = 20_000;

/** Notebook names become file names — fail-closed charset: alphanumerics,
 *  dot, underscore, hyphen; 1-64 chars; never all dots ("." / ".." are
 *  path-special). Rejects every path shape (slashes, traversal, empty)
 *  before it ever touches the filesystem. */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const isLegalName = (name: string): boolean => NAME_RE.test(name) && !/^\.*$/.test(name);

const NOTEBOOK_DESCRIPTION = `Scratchpad for working notes that must survive context compaction: intermediate findings, plan drafts, observations to fold into the final answer. Lives outside the user's tree (<workspace>/.wudao/notebooks/) — no permission round, no workspace pollution. Not the todo board (task state) and not memory (persistent facts): a notebook is throw-away working state.

Modes:
- create {name, newStr?} — start a notebook (REPLACES any existing content)
- append {name, newStr} — add a line to the end (notebook must exist)
- replace {name, oldStr, newStr} — swap the FIRST occurrence of oldStr
- read {name} — full contents
- list — names + line counts
- clear {name} — empty it (the file stays)

Names: 1-64 chars of letters/digits/dot/underscore/hyphen. Each notebook holds at most ${NOTEBOOK_MAX_CHARS} chars.`;

function invalid(content: string): { content: string; isError: true } {
  return { content: `notebook invalid arguments: ${content}`, isError: true };
}

export function createNotebookTool(options: { readonly workspaceRoot?: string; readonly dir?: string } = {}) {
  const dir = options.dir ?? (options.workspaceRoot !== undefined
    ? join(options.workspaceRoot, ".wudao", "notebooks")
    : join(".wudao", "notebooks"));
  const fileFor = (name: string): string => join(dir, `${name}.md`);

  const readNotebook = async (name: string): Promise<string> => readFile(fileFor(name), "utf8");
  const writeNotebook = async (name: string, content: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await writeFile(fileFor(name), content, "utf8");
  };

  return buildTool({
    name: "notebook",
    promptSnippet: "read or edit a Jupyter notebook's cells",
    description: NOTEBOOK_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "create | append | replace | read | list | clear",
          enum: ["create", "append", "replace", "read", "list", "clear"],
        },
        name: { type: "string", description: "Notebook name (1-64 chars of [A-Za-z0-9._-]). Default target for every mode except list." },
        newStr: { type: "string", description: "create: initial content; append: the line to add; replace: the replacement text." },
        oldStr: { type: "string", description: "replace: the text to swap out (first occurrence)." },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    // Writes stay under .wudao (session runtime data, plan.md convention) —
    // no workspace write, no permission ask. Read-modify-write on a shared
    // file is NOT concurrency-safe; the loop serializes unsafe batches.
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isOpenWorld: () => false,
    isDestructive: (args) => args.mode === "create" || args.mode === "clear",
    async execute(args) {
      // Every mode except list carries a name; narrow it once, up front
      // (list never touches the filesystem by name).
      if (args.mode !== "list" && (typeof args.name !== "string" || !isLegalName(args.name))) {
        return invalid(`name must be 1-64 chars of letters/digits/dot/underscore/hyphen (got ${JSON.stringify(args.name)})`);
      }
      const name = typeof args.name === "string" ? args.name : "";
      const newStr = args.newStr;

      switch (args.mode) {
        case "create": {
          if (newStr !== undefined && typeof newStr !== "string") return invalid("newStr must be a string");
          if (typeof newStr === "string" && newStr.length > NOTEBOOK_MAX_CHARS) {
            return invalid(`newStr exceeds the ${NOTEBOOK_MAX_CHARS}-char notebook cap`);
          }
          await writeNotebook(name, newStr ?? "");
          return { content: `Created notebook '${name}'${newStr ? " with content" : " (empty)"}` };
        }
        case "append": {
          if (typeof newStr !== "string" || newStr.length === 0) return invalid("append requires a non-empty newStr");
          let content: string;
          try {
            content = await readNotebook(name);
          } catch {
            return invalid(`notebook '${name}' not found — create it first (a write only succeeds on an existing notebook)`);
          }
          const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
          const next = `${content}${separator}${newStr}`;
          if (next.length > NOTEBOOK_MAX_CHARS) {
            return invalid(`append would exceed the ${NOTEBOOK_MAX_CHARS}-char notebook cap (currently ${content.length}) — clear or replace instead`);
          }
          await writeNotebook(name, next);
          return { content: `Appended to notebook '${name}' (${next.length}/${NOTEBOOK_MAX_CHARS} chars)` };
        }
        case "replace": {
          if (typeof args.oldStr !== "string" || typeof newStr !== "string" || args.oldStr.length === 0) {
            return invalid("replace requires oldStr (non-empty) and newStr");
          }
          let content: string;
          try {
            content = await readNotebook(name);
          } catch {
            return invalid(`notebook '${name}' not found — create it first`);
          }
          if (!content.includes(args.oldStr)) {
            return invalid(`oldStr not found in notebook '${name}'`);
          }
          const next = content.replace(args.oldStr, () => newStr); // function form: $ patterns in newStr stay literal
          if (next.length > NOTEBOOK_MAX_CHARS) {
            return invalid(`replacement would exceed the ${NOTEBOOK_MAX_CHARS}-char notebook cap`);
          }
          await writeNotebook(name, next);
          return { content: `Replaced in notebook '${name}' (${next.length}/${NOTEBOOK_MAX_CHARS} chars)` };
        }
        case "read": {
          let content: string;
          try {
            content = await readNotebook(name);
          } catch {
            return invalid(`notebook '${name}' not found`);
          }
          if (content.length === 0) return { content: `Notebook '${name}' is empty` };
          return { content };
        }
        case "list": {
          let entries: string[];
          try {
            entries = await readdir(dir);
          } catch {
            return { content: "No notebooks yet — create one with mode:create" };
          }
          const names = entries.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
          if (names.length === 0) return { content: "No notebooks yet — create one with mode:create" };
          const lines = await Promise.all(names.map(async (n) => {
            const content = await readFile(fileFor(n), "utf8");
            const lineCount = content.length === 0 ? 0 : content.split("\n").length;
            return `- ${n}: ${lineCount === 0 ? "Empty" : `${lineCount} lines`}`;
          }));
          return { content: `Notebooks:\n${lines.join("\n")}` };
        }
        case "clear": {
          try {
            await readNotebook(name);
          } catch {
            return invalid(`notebook '${name}' not found`);
          }
          await writeNotebook(name, "");
          return { content: `Cleared notebook '${name}'` };
        }
        default:
          return invalid(`unknown mode ${JSON.stringify(args.mode)}`);
      }
    },
  });
}
