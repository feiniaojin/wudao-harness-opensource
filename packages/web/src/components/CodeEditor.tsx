// 高亮/编辑 spec §4 — CodeEditor: the zero-dependency overlay editor. A
// transparent textarea rides EXACTLY over a token-rendered pre; the ONE
// scroller is the textarea — the pre and the gutter mirror its scroll
// offsets onscroll. Tab inserts two spaces; Esc exits only when clean
// (leaving a dirty file is 放弃's explicit job, never an accident). The
// conflict strip is this component's chrome; its two exits (重开 / 覆盖保存)
// are App-layer seams — the value/base state lives in the parent.
import React, { useRef } from "react";
import { TokenSpans } from "./Tokens.js";
import { Icon } from "./Icon.js";

export function CodeEditor({ path, value, language, dirty, saving, conflict, onChange, onSave, onOverwrite, onReopen, onDiscard }: {
  path: string;
  value: string;
  language: string | undefined;
  dirty: boolean;
  saving: boolean;
  /** null = 无冲突；非 null = 磁盘当前内容（重开的新底稿）。 */
  conflict: string | null;
  onChange(next: string): void;
  onSave(): void;
  /** 覆盖保存: 以 base = 磁盘当前内容重试。 */
  onOverwrite(): void;
  /** 用磁盘内容重开: 采纳磁盘内容为新底稿，放弃本地草稿。 */
  onReopen(current: string): void;
  /** 放弃 / Esc-干净: 退出编辑（只读视图保留原文）。 */
  onDiscard(): void;
}): React.JSX.Element {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const hlRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lines = value.split("\n");
  const onScroll = (): void => {
    const ta = taRef.current;
    if (ta === null) return;
    if (hlRef.current !== null) {
      hlRef.current.scrollTop = ta.scrollTop;
      hlRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current !== null) gutterRef.current.scrollTop = ta.scrollTop;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Tab") {
      // 契约（Task 8 缝）：Tab 从 value 计算——父层必须同步把 onChange 落回 value，否则连续 Tab 会用旧值。
      e.preventDefault();
      const ta = e.currentTarget;
      const pos = ta.selectionStart;
      onChange(`${value.slice(0, pos)}  ${value.slice(ta.selectionEnd)}`);
      const caret = pos + 2;
      requestAnimationFrame(() => ta.setSelectionRange(caret, caret));
    } else if (e.key === "Escape" && !dirty) {
      e.preventDefault();
      onDiscard();
    }
  };
  return (
    <div className="editor-root">
      <div className="fv-edit">
        <button type="button" className="fv-btn primary" disabled={!dirty || saving} onClick={onSave}>保存</button>
        <button type="button" className="fv-btn" disabled={saving} onClick={onDiscard}>放弃</button>
        <span className="grow" />
        <span className="fv-edit-path">{path}</span>
      </div>
      {conflict !== null ? (
        <div className="fv-conflict" role="alert">
          <span><Icon name="triangle-alert" size={12} /> 文件已被外部修改</span>
          <button type="button" className="fv-btn" disabled={saving} onClick={() => onReopen(conflict)}>用磁盘内容重开</button>
          <button type="button" className="fv-btn primary" disabled={saving} onClick={onOverwrite}>覆盖保存</button>
        </div>
      ) : null}
      <div className="editor-wrap">
        <div className="editor-gutter" ref={gutterRef} aria-hidden={true}>
          {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <div className="editor-stack">
          <pre className="editor-hl" ref={hlRef} aria-hidden={true}>
            {lines.map((ln, i) => (
              <React.Fragment key={i}>
                {i > 0 ? "\n" : null}
                <TokenSpans text={ln} lang={language} />
              </React.Fragment>
            ))}
          </pre>
          <textarea
            className="editor-ta"
            ref={taRef}
            value={value}
            spellCheck={false}
            aria-label={`编辑 ${path}`}
            wrap="off"
            onChange={(e) => onChange(e.target.value)}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
    </div>
  );
}
