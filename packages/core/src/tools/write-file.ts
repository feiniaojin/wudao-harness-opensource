import { writeFile, stat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { buildTool } from "../tool.js";
import { resolveWorkspacePath } from "./workspace.js";
import { freshnessError, readStateEntry, type ReadStateTable } from "./read-state.js";
import type { FileHistory } from "./file-history.js";
import type { TurnDiffTracker } from "../turn-diff.js";
import { verifyWrittenFile, shapeVerifiedResult, appendDiagnosticsLines, type WriteVerifyConfig, type DiagnosticsLayer } from "./write-verify.js";
import type { PendingWriteGate } from "../pending-actions.js";

export function createWriteFileTool(options: {
  workspaceRoot: string;
  readState?: ReadStateTable;
  history?: FileHistory;
  /** 夜移 032 (codex turn-diff): the per-run net-change ledger. Only a
   *  COMMITTED write is recorded (after the bytes land); absent → unchanged
   *  behavior. */
  turnDiff?: TurnDiffTracker;
  /** M46 §1: post-write syntax verification (receipts ride the result; a
   *  failed check is feedback, NOT isError). Absent → plain "wrote" result
   *  (the pre-M46 behavior); the cli injects the resolved settings. */
  writeVerify?: WriteVerifyConfig;
  /** M51 §2: diagnostic baseline-diff (new-only lines ride the result after
   *  the verify output). Absent → the M46 result unchanged. */
  diagnostics?: DiagnosticsLayer;
  /** 借鉴弧 ζ1: 陈旧未决写拒绝——本会话链里对同一目标的写从未等到结果
   *  （崩溃/中断）时，不同指纹的盲写被拒（fail-open：门缺席/链不可读绝不
   *  阻塞写入）。Absent → 行为与 ζ1 之前逐字节一致。 */
  pendingWrites?: PendingWriteGate;
}) {
  return buildTool({
    name: "write_file",
    description:
      "Create or overwrite a file with the given UTF-8 content. Path must be inside the workspace. Fails with 'file changed since your last read' when the target changed externally after your last read_file — re-read it first.",
    // M51 §3: overwrites disk (destructive: true) but never leaves the local
    // filesystem (closed-world).
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path inside the workspace." },
        content: { type: "string", description: "Full file contents to write." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async execute({ path, content }) {
      const resolved = await resolveWorkspacePath(options.workspaceRoot, path as string);
      if (!resolved.ok) return { content: resolved.error, isError: true };
      try {
        const current = await stat(resolved.absPath).catch(() => undefined);
        // Freshness gate (fail-closed, mtime-based): overwriting a file the
        // session read, but which changed since, is a blind write against a
        // stale mental model. A vanished file (ENOENT) is a plain create —
        // no staleness to guard. The bytes just written refresh the entry so
        // our own writes never trip the next edit.
        if (current !== undefined && options.readState?.get(resolved.absPath) !== undefined) {
          const stale = freshnessError(options.readState, resolved.absPath, current.mtimeMs);
          if (stale !== undefined) return { content: `write_file failed: ${stale}`, isError: true };
        }
        // 借鉴弧 ζ1: 陈旧未决写拒绝——freshness 的姊妹门（freshness 管「读
        // 过但变了」，本门管「没等到结果的写悬着且你还没重新读过」；崩溃后
        // readState 清空、freshness 失效的窗口由本门接管）。
        const pendingBlock = options.pendingWrites?.staleFor("write_file", path as string, { path, content }, resolved.absPath);
        if (pendingBlock !== undefined) return { content: `write_file failed: ${pendingBlock}`, isError: true };
        await mkdir(dirname(resolved.absPath), { recursive: true });
        // M37 §2: snapshot the PRE-write state before the write lands (an
        // overwrite keeps its old bytes; a create records existed=false).
        // Fail-open: a snapshoting error never blocks the write itself.
        // 夜移 032: the pre-read is hoisted so history and the turn-diff
        // ledger share one read (history snapshots it; the ledger's baseline
        // is the first write's pre-state).
        let preWrite: string | undefined;
        if (options.history !== undefined || options.turnDiff !== undefined) {
          try {
            if (current === undefined) {
              await options.history?.record(resolved.absPath, false, undefined, 0, "write_file");
            } else {
              preWrite = await readFile(resolved.absPath, "utf8").catch(() => undefined);
              if (preWrite !== undefined) {
                await options.history?.record(resolved.absPath, true, preWrite, current.mtimeMs, "write_file");
              }
            }
          } catch {
            // no rewind coverage for this step — the write still proceeds
          }
        }
        const text = content as string;
        // M51 §2: capture the diagnostic baseline BEFORE the bytes land (the
        // layer's checkers read the on-disk pre-write state). Never blocks
        // the write — a layer error must not break the write path it audits.
        await options.diagnostics?.beforeWrite(resolved.absPath).catch(() => {});
        await writeFile(resolved.absPath, text, "utf8");
        // 夜移 032: only a committed write is ledger evidence. An existing
        // file whose pre-read failed is skipped rather than falsely
        // classified as a create.
        if (options.turnDiff !== undefined && (current === undefined || preWrite !== undefined)) {
          options.turnDiff.record(resolved.absPath, current === undefined ? undefined : preWrite, text);
        }
        if (options.readState?.get(resolved.absPath) !== undefined) {
          const after = await stat(resolved.absPath);
          options.readState.record(resolved.absPath, readStateEntry(text, after.mtimeMs));
        }
        // M46 §1: the write succeeded — now verify it. Feedback folds into the
        // result (never isError, never a rollback); verifyWrittenFile itself
        // never throws, so this cannot break the write path it decorates.
        if (options.writeVerify === undefined) return { content: `wrote ${path}` };
        const outcome = await verifyWrittenFile({
          absPath: resolved.absPath,
          content: text,
          workspaceRoot: options.workspaceRoot,
          config: options.writeVerify,
        });
        // M51 §2: fold the NEW-only diagnostic lines in after the verify output.
        const newOnly = options.diagnostics !== undefined
          ? await options.diagnostics.afterWrite({ absPath: resolved.absPath, outcome }).catch(() => [] as const)
          : [];
        return { content: appendDiagnosticsLines(shapeVerifiedResult(`wrote ${path}`, outcome), newOnly) };
      } catch (err) {
        return { content: `write_file failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}
