// 高亮 spec §2 —— 三个展示代码的面（viewer 源码行 / diff 行 / 工具卡参数行）
// 共用的 token 渲染器：cls 缺席渲染纯文本、有 cls 一个 span，markup 处处一致。
import React from "react";
import { highlightLine } from "../highlight.js";

export function TokenSpans({ text, lang }: { text: string; lang: string | undefined }): React.JSX.Element | null {
  return (
    <>
      {highlightLine(text, lang).map((t, k) =>
        t.cls === undefined ? t.text : <span key={k} className={t.cls}>{t.text}</span>,
      )}
    </>
  );
}
