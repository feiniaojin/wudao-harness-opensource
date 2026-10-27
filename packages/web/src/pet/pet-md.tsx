// ω99-210: #3 — the pet window's LIGHT markdown renderer. The 0.3.57 验装
// 回执: 「小精灵的回答是markdown的话，没有进行渲染，导致我看到很多**
// --这种符号」 — both answer faces (Bubble's .pet-bubble-a transcript cell
// and .pet-bubble-stream tail) were plain text nodes. Deliberately a
// SEPARATE renderer, NOT an import of ../markdown.js: the pet window is its
// own Tauri webview whose module graph must stay free of the main UI
// (pet-root.test.tsx pins the App/WS boundary), and markdown.tsx drags
// highlight.js + ContextMenu — the shared seam is the pure lexer
// (../md-lex.js). ONE lexer, MANY renderERS. Deliberate degradations of
// this companion face (伴读面不是阅读面，产品判断):
//  - href spans degrade to PLAIN TEXT — the link gate (ω99-155 open_url)
//    is the MAIN window's domain; a floating bubble offers no link path;
//  - fenced code is plain mono — no highlighter, no copy button;
//  - para lines join with "\n" inside ONE div (the .pet-bubble-a /
//    .pet-bubble-stream pre-wrap keeps the line shape) so plain-text
//    textContent stays byte-equal to the source — the constructive
//    guarantee that existing plain-text pins evolve zero (receipts ④).
import React from "react";
import { getBlocks, parseInline } from "../md-lex.js";
import type { Block } from "../md-lex.js";

/** Inline: bold/code spans only; href spans degrade to plain text (头注释
 *  的有意降级——parseInline 的 href 分支在这里只取 label 文本)。 */
function PetInline({ s }: { s: string }): React.JSX.Element {
  return (
    <>
      {parseInline(s).map((sp, idx) =>
        sp.code
          ? <code key={idx} className="pet-md-code">{sp.text}</code>
          : sp.bold
            ? <span key={idx} className="pet-md-bold">{sp.text}</span>
            : <span key={idx}>{sp.text}</span>,
      )}
    </>
  );
}

/** The six-block light render (pet-md-* 类名——不占主窗 .md-* 命名域)：
 *  code→纯 mono pre；heading→data-level 无 # 前缀（主窗同律）；list→• 行；
 *  quote→| 行；table→thead/tbody（窄窗 overflow-x 由 CSS 承载）；para→单
 *  div 行以 \n 连接（textContent 逐字等值的构造保证——头注释）。 */
function renderPetBlocks(blocks: readonly Block[]): React.JSX.Element[] {
  return blocks.map((b, i) => {
    if (b.kind === "code") {
      return (
        <div key={i} className="pet-md-pre">
          <code>{b.lines.join("\n")}</code>
        </div>
      );
    }
    if (b.kind === "heading") {
      return <div key={i} className="pet-md-heading" data-level={b.level}><PetInline s={b.text} /></div>;
    }
    if (b.kind === "list") {
      return (
        <div key={i} className="pet-md-list">
          {b.items.map((it, j) => <div key={j}>• <PetInline s={it} /></div>)}
        </div>
      );
    }
    if (b.kind === "quote") {
      return (
        <div key={i} className="pet-md-quote">
          {b.lines.map((ln, j) => <div key={j}>{`| ${ln}`}</div>)}
        </div>
      );
    }
    if (b.kind === "table") {
      return (
        <table key={i} className="pet-md-table">
          <thead><tr>{b.header.map((h, j) => <th key={j}><PetInline s={h} /></th>)}</tr></thead>
          <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><PetInline s={c} /></td>)}</tr>)}</tbody>
        </table>
      );
    }
    return (
      <div key={i} className="pet-md-para">
        {b.lines.map((ln, j) => (
          <React.Fragment key={j}>
            {j > 0 ? "\n" : null}
            <PetInline s={ln} />
          </React.Fragment>
        ))}
      </div>
    );
  });
}

// memo（主窗 Markdown 同族理由）：stream 形态每 delta 重渲，浅比较 bail 掉
// 未变回答的整棵子树；词法缓存（md-lex getBlocks 的 LRU）盖住其余路径。
export const PetMarkdown = React.memo(function PetMarkdown({ source }: { source: string }): React.JSX.Element {
  return <div className="pet-md">{renderPetBlocks(getBlocks(source))}</div>;
});
