import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { buildTool } from "../tool.js";
import { truncateSafe } from "../text-truncate.js";
import { listWorkspaceFiles } from "./workspace.js";
import { capOutputLines } from "./output-caps.js";

export function createGrepTool(options: { workspaceRoot: string }) {
  return buildTool({
    name: "grep",
    promptSnippet: "search file contents by regex",
    description: "Search file contents for a regular expression. Returns matching lines as 'path:line: text' (up to 100 hits; output capped at 2000 lines / 50KB). Skips node_modules and binary files. " +
    "Example: {pattern: 'TODO\\(\\w+\\):'} finds owner-tagged TODOs across the workspace — always prefer this over reading many files one by one. " +
    "Do NOT use grep to find files by NAME (glob) or to fetch a file's full contents (read_file).",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string", description: "Regular expression to search for." } },
      required: ["pattern"],
      additionalProperties: false,
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute({ pattern }) {
      try {
        const files = await listWorkspaceFiles(options.workspaceRoot);
        const re = new RegExp(pattern as string);
        const hits: string[] = [];
        for (const rel of files) {
          if (hits.length >= 100) break;
          let content: string;
          try {
            content = await readFile(join(options.workspaceRoot, rel), "utf8");
          } catch {
            continue;
          }
          if (content.includes("\0")) continue; // binary
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line !== undefined && re.test(line)) {
              hits.push(`${rel}:${i + 1}: ${truncateSafe(line.trim(), 500)}`); // 113-A4：命中行帽代理对安全
              if (hits.length >= 100) break;
            }
          }
        }
        hits.sort((x, y) => {
          const xParts = x.split(":", 2);
          const yParts = y.split(":", 2);
          const xp = xParts[0];
          const yp = yParts[0];
          if (xp !== yp) return xp !== undefined && yp !== undefined && xp < yp ? -1 : 1;
          const xl = xParts[1];
          const yl = yParts[1];
          if (xl === undefined || yl === undefined) return 0;
          return Number(xl) - Number(yl);
        });
        return { content: hits.length ? capOutputLines(hits.join("\n")) : "(no matches)" };
      } catch (err) {
        return { content: `grep failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}
