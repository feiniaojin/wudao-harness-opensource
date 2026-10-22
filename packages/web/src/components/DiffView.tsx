// DiffView — the edit entry's red/green inline diff (BOTH modes share it;
// M63 §D upgraded it with research 35 #3). Same hunk computation as the TUI
// (ctx/del/add middle-only marking); the web's richer view additionally
// collapses long unchanged runs (head/tail context windows), and a hunk that
// is EXACTLY one deleted + one added line gets word-level intra-line
// highlight — the common token prefix/suffix stay quiet, only the changed
// words carry the stronger background (indentation is never marked).
//
// Timing note (the pattern's other half): the driver pushes the edit history
// entry at tool-call START — the diff is visible before the write lands. A
// preview during ARGUMENT STREAMING would need partial tool args in the
// state frames; live.busyTools carries only {name, summary}, so that seam
// does not exist yet (not forced in this batch — the entry renders on call
// start instead).
import React from "react";
import { collapseContext, computeDiff, diffWords } from "../diff.js";
import type { DiffRow, WordSpan } from "../diff.js";
import { languageFromPath } from "../highlight.js";
import { IconFileText } from "./icons.js";
import { TokenSpans } from "./Tokens.js";

/** Map of row-index → word spans, for every maximal del/add run that is
 *  exactly one del + one add row. */
function wordPairs(
  rows: readonly DiffRow[],
): ReadonlyMap<number, { readonly old: readonly WordSpan[]; readonly new: readonly WordSpan[] }> {
  const out = new Map<number, { old: readonly WordSpan[]; new: readonly WordSpan[] }>();
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r !== undefined && (r.kind === "del" || r.kind === "add")) {
      let j = i;
      while (j < rows.length) {
        const t = rows[j];
        if (t === undefined || (t.kind !== "del" && t.kind !== "add")) break;
        j++;
      }
      const del = rows[i];
      const add = rows[i + 1];
      if (j - i === 2 && del?.kind === "del" && add?.kind === "add") {
        out.set(i, diffWords(del.text, add.text));
      }
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

function Spans({ spans, lang }: { spans: readonly WordSpan[]; lang: string | undefined }): React.JSX.Element {
  return (
    <>
      {spans.map((s, k) =>
        s.changed ? (
          <span key={k} className="wchg">
            <TokenSpans text={s.text} lang={lang} />
          </span>
        ) : (
          <TokenSpans key={k} text={s.text} lang={lang} />
        ),
      )}
    </>
  );
}

export function DiffView({ path, oldString, newString, rows: providedRows, onOpenFile }: {
  path: string;
  oldString: string;
  newString: string;
  /** #455: pre-computed rows override (the EditCard's balanced preview).
   *  Absent on every other consumer — the default path stays
   *  collapseContext(computeDiff(...)) byte-for-byte. */
  rows?: readonly DiffRow[];
  onOpenFile?(path: string): void;
}): React.JSX.Element {
  const rows = providedRows ?? collapseContext(computeDiff(oldString, newString));
  const pairs = wordPairs(rows);
  const lang = languageFromPath(path);
  return (
    <div className="diff">
      {/* inkline T3 (spec §1.5): the ✏️ prefix was an icon slot, not copy —
          the 13px IconFileText rides the shared 1.5-stroke set now. */}
      <div className="path">
        <IconFileText size={13} />{" "}
        {onOpenFile !== undefined ? (
          <button type="button" className="fv-chip" title={path} onClick={() => onOpenFile(path)}>
            {path}
          </button>
        ) : (
          path
        )}
      </div>
      {rows.map((l, i) =>
        l.kind === "gap" ? (
          <div key={i} className="ctx">{l.label ?? `  ⋯ ${l.count} 行未变 ⋯`}</div>
        ) : l.kind === "del" ? (
          <div key={i} className="del">
            {`- `}
            {pairs.has(i) ? <Spans spans={pairs.get(i)?.old ?? []} lang={lang} /> : <TokenSpans text={l.text} lang={lang} />}
          </div>
        ) : l.kind === "add" ? (
          <div key={i} className="add">
            {`+ `}
            {pairs.has(i - 1) ? <Spans spans={pairs.get(i - 1)?.new ?? []} lang={lang} /> : <TokenSpans text={l.text} lang={lang} />}
          </div>
        ) : (
          <div key={i} className="ctx">{`  `}<TokenSpans text={l.text} lang={lang} /></div>
        ),
      )}
    </div>
  );
}
