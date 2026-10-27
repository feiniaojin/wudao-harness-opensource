// ω99-288: #1 — diff 分色渲染器（改动明细的精读面）。对等宽原文块的排版
// （语法高亮同族）：classifyDiffLines 把 detail 按行分类成自家 diff 方言的
// 五类（file-header / hunk / add / del / context），DiffText 按类着色渲染
// ——加行 --ok、删行 --danger（红色律的「diff 删除」正位）、hunk/文件头走
// text 弱族。两条不变式：
//   * 非 diff 文本零视觉变化——无方言前缀的行全部按 context 渲染（截断
//     标记行原样），context 行零样式，经分色器=视觉与原文块等价；
//   * 渲染纯展示——分类结果只在本组件内，任何其他组件不得 import 分类产
//     物当数据（ω99-216 裁定「渲染层不当数据层」的延续；要数据走数据层，
//     本弧的 +M/−K 就住在 changes 字段里）。
// 等宽原文保真：行 span 以 "\n" 文本节点连接，textContent 逐字节等于输入
// （可复制原文结构不变）。外壳沿用调用方的内滚块类（chg-detail /
// notice-detail），div/pre 同形（两类都显式定字体与空白处理）。
import React from "react";

/** The five dialect line classes（自家 renderer 生成的 git 风格方言）。 */
export type DiffLineKind = "file-header" | "hunk" | "add" | "del" | "context";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/** 行分类纯函数：same detail → same lines，测试直钉。方言前缀（自家
 *  turn-diff-render 生成的形状）：`diff --git `/`new file`/`--- `/`+++ ` 是
 *  文件头族，`@@` 是 hunk 头，其余 `+`/`-` 前缀是加/删行；不带这些前缀的
 *  行（空行、截断标记、meta_note 全文）一律 context——零特判。 */
export function classifyDiffLines(detail: string): readonly DiffLine[] {
  return detail.split("\n").map((text) => ({ text, kind: classifyLine(text) }));
}

function classifyLine(text: string): DiffLineKind {
  if (text.startsWith("diff --git ") || text.startsWith("new file") || text.startsWith("--- ") || text.startsWith("+++ ")) return "file-header";
  if (text.startsWith("@@")) return "hunk";
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  return "context";
}

/** Kind → 样式类名（file-header 的样式类是 .dtx-file——文件头族一类一个
 *  样式位，类名不带连字符歧义）。 */
const DTX_CLASS: Record<DiffLineKind, "file" | "hunk" | "add" | "del" | "context"> = {
  "file-header": "file",
  hunk: "hunk",
  add: "add",
  del: "del",
  context: "context",
};

/** The ledger path a `diff --git a/<path> b/<path>` header carries (the
 *  detail's own dialect; undefined for every other header shape). The
 *  panel's file-row jump uses this as its scroll target anchor. */
function headerPath(text: string): string | undefined {
  if (!text.startsWith("diff --git ")) return undefined;
  const rest = text.slice("diff --git a/".length);
  // 本仓方言恒为 `a/P b/P`（两路径相同）——镜像切分：从左扫每个 " b/"
  // 候选位，首个「前缀 === 后缀」的切点即真分隔，路径本身含 " b/" 也不
  // 误咬。外来方言（a/old b/new 两路径不同）无镜像切点 → 退回
  // lastIndexOf（既有行为，零回归）。
  let idx = rest.indexOf(" b/");
  while (idx >= 0) {
    if (rest.slice(0, idx) === rest.slice(idx + 3)) return rest.slice(0, idx);
    idx = rest.indexOf(" b/", idx + 1);
  }
  const cut = rest.lastIndexOf(" b/");
  return cut >= 0 ? rest.slice(0, cut) : rest;
}

/** ω99-294: detail 里带锚（data-dtx-file）的文件路径集合。方言解析单一
 *  事实源仍在 DiffText（216/288 裁定：渲染层不当数据层，其他组件不得
 *  自己解析 detail 当数据）；面板只问「你会锚哪些文件」，不问行分类。 */
export function detailFileAnchors(detail: string): Set<string> {
  const anchors = new Set<string>();
  for (const line of classifyDiffLines(detail)) {
    if (line.kind !== "file-header") continue;
    const path = headerPath(line.text);
    if (path !== undefined) anchors.add(path);
  }
  return anchors;
}

/** The colored diff block. `className` is the caller's shell（内滚块类原样
 *  沿用）；`as` keeps the caller's tag（pre/div 视觉同形，语义各守）。 */
export function DiffText({ detail, className, as = "div" }: {
  readonly detail: string;
  readonly className: string;
  readonly as?: "div" | "pre";
}): React.JSX.Element {
  const lines = classifyDiffLines(detail);
  const Tag = as;
  return (
    <Tag className={`${className} dtx`}>
      {lines.map((l, i) => {
        const file = l.kind === "file-header" ? headerPath(l.text) : undefined;
        return (
          <React.Fragment key={i}>
            {i > 0 ? "\n" : null}
            <span className={`dtx-line dtx-${DTX_CLASS[l.kind]}`} {...(file !== undefined ? { "data-dtx-file": file } : {})}>
              {l.text}
            </span>
          </React.Fragment>
        );
      })}
    </Tag>
  );
}
