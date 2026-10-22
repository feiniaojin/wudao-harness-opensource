// ω99-236: #1 — 三件套名册模块（doc suite roster）。09-09 用户指令 ①原文：
// 「你的这些xlsx等功能，都应该是插件，你不能整合到内核里」——doc 三件套十
// 二面（make/read/append/replace × xlsx/docx/pptx）此前是内核织入：四缝
// 逐名硬编码（tools.ts 静态导入+逐个挂载、permission.ts 双名册、
// driver/file-receipt.ts 名门、log.ts 摘要 switch）。本模块把它翻成「内置
// 插件」单元：单一描述清单（构造序 + 读册 + 写册 + 回执册 + 摘要器映射），
// 四缝从「逐名硬编码」变「消费名册」——内核缝零 doc 名，可证明的边界。
//
// 范式来源（不许照搬，本弧已超越）：lsp 设置门先例（lsp/tools.ts 的
// 条件注册：enabled→尾部追加，disabled→[]）——但 lsp 是 opt-in（缺省零工
// 具零进程），doc 三件套是已随产品在跑的能力，所以这里是 **opt-out**（缺
// 省 true，settings `docSuite.enabled` 显式 false 才关）；repo 双插件系统
// （plugins.ts 纯配置 / extensions 真代码但 ext_ 前缀）不可走——重命名会
// 破会话史；MCP 条件注册先例（工具列表稳定前缀+尾部追加）。行业对照：
// the upstream formatplugins 面板列 builtin 可关项、ChatGPT tools 内置项可关——内置能力也
// 有开关与身份，不与核心熔死。web 设置页插件 tab 的「内置」段就是它的身
// 份面（PluginTab）。
//
// **默认态字节等值宣言**：默认（未写 docSuite.enabled）时工具列表顺序、字
// 节逐字不变——宪法切片（constitution.test.ts slice(0,13)/slice(13,37)）
// 与 ω99-221..231 六弧邻接钉全数零演进。挂载位维持历史交错位：make 三面
// 在 constitution_suggest 之后、computer 八件之前；read/append/replace 九
// 面在 computer 八件之后、defer 尾之前（tools.ts 消费 DOC_SUITE_MAKE_COUNT
// 常量分两段展开——名册单一序，交错位是 tools.ts 自己的挂载知识）。
//
// **缓存代价声明（M24 纪律）**：off 是一次性冷转——doc 面不在工具列表绝
// 对尾，摘除会移动后位工具（computer 八件与 defer 尾之间）的位置，跨版本
// 一次前缀断裂；会话中途无运行时摘除缝（off 需新会话生效，lsp 同款边界，
// M24 稳妥面）。名册静态消费（off 态名册惰性在册——permission/file-
// receipt/log 照旧展开名单，缺席名无害；最小面裁定，如实记）。
//
// 物理分仓（独立 npm 包）已向用户报价待复——当前为逻辑分仓（物理同包），
// auto 模式先行，用户明示再升级。
//
// ω99-238 — 名册增员：两枚文档部件面（set_docx_header / set_pptx_notes）
// 生来就在名册（构造序尾 + 写册 + 回执册 + 摘要器映射四处同缝进），四缝零
// 新名硬编码；read_pptx 的备注行升级同弧落地（notes 键缺席 → 无备注 deck
// 输出逐字节不变）。
//
// ω99-256: #2 — 名册再增员两枚：doc 部件面 v2（clear_docx_header 删页眉/
// 页脚 + set_docx_first_page 首页不同）沿 238 同缝进名册尾（构造序尾 + 写
// 册 + 回执册 + 摘要器映射四处同缝，四缝依旧零新名硬编码）；工具列尾再追
// 加两枚=跨版本一次冷转（M24，247/238 同款已声明代价——挂载位在 doc 名册
// 尾、defer 尾前，后位 task 等再顺移两位，constitution 切片与 212/223/
// 228/229/231/236 邻接钉同形演进）。
//
// ω99-263: #2 — 名册再增员一枚：doc 部件面 v3（set_docx_even_pages 奇偶页
// 不同——settings.xml 的 evenAndOddHeaders 文档级旗标 + header/footer 双部
// 件族的 even 引用档，「首页/奇偶」两轴三档齐）沿 256 同缝进名册尾（构造
// 序尾 + 写册 + 回执册 + 摘要器映射四处同缝）；工具列尾再追加一枚=跨版本
// 一次冷转（M24，256 同款已声明代价——挂载位在 doc 名册尾、defer 尾前，
// 后位 task 等再顺移一位，constitution 切片与名册钉族同形演进）；clear_
// docx_header 的 refType 值域 +even（描述句变更，同版一次冷转内合并）。
//
// ★红线（09-09 用户令，逐字）：「注意，开发、测试过程禁止删除用户文件/
// 文件夹。」——本模块零文件副作用，纯构造与名册。
import type { Tool } from "@wudao/core";
// —— 名册构造的十七 import（236 的十二自 tools.ts 迁入，注释链随迁；
// ω99-238 两枚 + ω99-256 两枚 + ω99-263 一枚部件面 import 附后）——
// ω99-123: make_xlsx — the zero-dependency real-file face (stored-zip xlsx).
import { createMakeXlsxTool } from "./doc-xlsx.js";
// ω99-124: make_pptx — the zero-dependency real-file face (stored-zip pptx).
import { createMakePptxTool } from "./doc-pptx.js";
// ω99-126: make_docx — the zero-dependency real-file face (stored-zip docx).
import { createMakeDocxTool } from "./doc-docx.js";
// ω99-221: read_xlsx — the read half of the Excel built-in (make_xlsx wrote;
// this reads). Pure layers (unzip / workbook / rows) live in doc-xlsx-read.ts.
import { createReadXlsxTool } from "./doc-xlsx-read.js";
// ω99-222: read_docx / read_pptx — the read halves of the Word & PPT built-ins
// (make_docx / make_pptx wrote; these read). Pure layers live in
// doc-docx-read.ts / doc-pptx-read.ts (both reuse the shared unzipEntries now
// homed in doc-zip.ts).
import { createReadDocxTool } from "./doc-docx-read.js";
import { createReadPptxTool } from "./doc-pptx-read.js";
// ω99-223: append_docx / append_pptx — the append halves of the Word & PPT
// built-ins: existing content rides the zip layer byte-identical, only the
// small parts that must move are spliced. Pure layers live in
// doc-docx-append.ts / doc-pptx-append.ts (doc-zip.ts's unzipEntries /
// storedZip pair).
import { createAppendDocxTool } from "./doc-docx-append.js";
import { createAppendPptxTool } from "./doc-pptx-append.js";
// ω99-228: append_xlsx — the append half of the Excel built-in: new rows splice
// into ONE part (the target worksheet), new strings go inlineStr so
// sharedStrings is never touched. Pure layer lives in doc-xlsx-append.ts.
import { createAppendXlsxTool } from "./doc-xlsx-append.js";
// ω99-229: replace_docx / replace_pptx — the in-place rewrite halves of the
// Word & PPT built-ins (run-boundary-honest refusals instead of silent misses).
import { createReplaceDocxTool, createReplacePptxTool } from "./doc-replace.js";
// ω99-231: replace_xlsx — cell-level string surgery that never touches
// sharedStrings.xml (hit cells repoint to inlineStr).
import { createReplaceXlsxTool } from "./doc-xlsx-replace.js";
// ω99-238: set_docx_header / set_pptx_notes — the document chrome faces (docx
// header/footer parts + pptx speaker notes; idempotent part-level overwrite).
// Pure layers live in doc-chrome.ts / doc-notes.ts.
// ω99-256: clear_docx_header / set_docx_first_page — the doc-chrome v2 faces
// (header/footer REMOVAL + first-page-different titlePg switch; part-level
// four-way clearing), same file doc-chrome.ts.
// ω99-263: set_docx_even_pages — the doc-chrome v3 face (even/odd pages
// different: the document-level evenAndOddHeaders flag in word/settings.xml +
// the even reference档 of both part families), same file doc-chrome.ts.
import {
  createSetDocxHeaderTool,
  summarizeSetDocxHeader,
  createClearDocxHeaderTool,
  createSetDocxFirstPageTool,
  summarizeClearDocxHeader,
  summarizeSetDocxFirstPage,
  createSetDocxEvenPagesTool,
  summarizeSetDocxEvenPages,
} from "./doc-chrome.js";
import { createSetPptxNotesTool, summarizeSetPptxNotes } from "./doc-notes.js";
// —— 摘要器映射的纯件 import（自 log.ts 迁入，一件一条缝）——
import { summarizeXlsxWindow } from "./doc-xlsx-read.js";
import { summarizeDocxWindow } from "./doc-docx-read.js";
import { summarizePptxWindow } from "./doc-pptx-read.js";
import { summarizeAppendDocx } from "./doc-docx-append.js";
import { summarizeAppendPptx } from "./doc-pptx-append.js";
import { summarizeAppendXlsx } from "./doc-xlsx-append.js";
import { summarizeReplaceDocx } from "./doc-replace.js";
import { summarizeReplacePptx } from "./doc-replace.js";
import { summarizeReplaceXlsx } from "./doc-xlsx-replace.js";

// ---------------------------------------------------------------------------
// 使能门（lsp/tools.ts 的 runtime-flag 同款形，缺省相反：opt-out）
// ---------------------------------------------------------------------------

/** The gate's runtime state. TRUE by default — the doc trio already ships on
 *  (unlike lsp's fail-closed false): an ability the product has been running
 *  is opt-out, so every existing session (and every test that never touches
 *  the gate) keeps the exact same tool list. The boot (index.ts) resolves
 *  misc-config.resolveDocSuiteEnabled ONCE beside setLspRuntimeEnabled —
 *  session-static like every tools-defining knob (a mid-session flip would
 *  shift tool-list bytes and break the prefix cache; restart to apply). */
let runtimeEnabled = true;

/** The boot-time settings gate (index.ts calls this once beside lsp's). */
export function setDocSuiteRuntimeEnabled(enabled: boolean): void {
  runtimeEnabled = enabled;
}

/** The current gate state (tests/diagnostics). */
export function docSuiteRuntimeEnabled(): boolean {
  return runtimeEnabled;
}

// ---------------------------------------------------------------------------
// 名册——十六面的单一描述清单（236 十二面 + ω99-238 两枚 + ω99-256 两枚部件面 v2）
// ---------------------------------------------------------------------------

/** The trio's read faces, in mount order (READ_TOOLS' doc names). */
export const DOC_SUITE_READ_TOOLS: readonly string[] = ["read_xlsx", "read_docx", "read_pptx"];

/** The trio's write faces (make/append/replace/set-chrome), in mount order
 *  (FILE_EDIT_TOOLS' doc names). ω99-238: the two set_* chrome faces join the
 *  tail (replace_xlsx 之后——工具列表尾部追加=一次性冷转，与前每次面增
 *  212/221/222/223/228/229/231 同款 M24 声明). */
export const DOC_SUITE_EDIT_TOOLS: readonly string[] = [
  "make_xlsx", "make_pptx", "make_docx",
  "append_docx", "append_pptx", "append_xlsx",
  "replace_docx", "replace_pptx", "replace_xlsx",
  "set_docx_header", "set_pptx_notes",
  "clear_docx_header", "set_docx_first_page",
  "set_docx_even_pages",
];

/** The receipt-gated faces (file-receipt.ts's name gate — the deliverable
 *  card lands on every face whose execute tail lands the receipt shape; the
 *  read faces never produce one). Identical membership to
 *  DOC_SUITE_EDIT_TOOLS — kept as its own roster so each consuming seam
 *  self-describes (grep-verified against the pre-refactor gate). */
export const DOC_SUITE_RECEIPT_TOOLS: readonly string[] = [...DOC_SUITE_EDIT_TOOLS];

/** How many of the roster's head entries are the make faces — tools.ts splits
 *  its single roster spread around the computer octet's historical slot
 *  (make×3 before the octet, the read/append/replace nine + the 238 chrome
 *  pair after it);
 *  the split constant lives HERE because it describes the roster's own
 *  shape, not the consumer's. */
export const DOC_SUITE_MAKE_COUNT = 3;

/**
 * The seventeen faces in canonical mount order (236's twelve + ω99-238's two + ω99-256's two
 * + ω99-263's one chrome faces at the tail). The gate rides the constructor
 * head: off → [] (zero construction, zero list surface — the lspToolsFor
 * conditional-registration shape with the default flipped). Order is pinned
 * by tests/omega99-236-doc-suite.test.ts R1(b) against the constitution
 * slice — byte-stable is the law (M24).
 */
export function createDocSuiteTools(workspaceRoot: string): Tool[] {
  // ω99-236: the mount gate — resolveDocSuiteEnabled's boot-time verdict,
  // consulted here (constructor head, the brief's 使能门裁定).
  if (!runtimeEnabled) return [];
  return [
    // ω99-123: make_xlsx — top-level only, fixed position right after
    // constitution_suggest (append-only tail, prefix stability), ZERO-CONFIG
    // always-on (workspaceRoot is always present): the model can always turn
    // a list/inventory into a real .xlsx inside the workspace. Output is
    // workspace-confined via resolveWorkspacePath (escape/absolute = typed
    // refusal, fail-closed); the permission layer carries it as a file-edit
    // tool (FILE_EDIT_TOOLS) so it shares write_file's mode posture and
    // bypass-immune hard gate.
    createMakeXlsxTool(workspaceRoot),
    // ω99-124: make_pptx — top-level only, fixed position right after
    // make_xlsx (append-only tail, prefix stability), ZERO-CONFIG always-on:
    // the model can always turn an outline into a real .pptx inside the
    // workspace. Same posture as make_xlsx: workspace-confined via
    // resolveWorkspacePath, FILE_EDIT_TOOLS mode posture + bypass-immune
    // hard gate reading its filename key.
    createMakePptxTool(workspaceRoot),
    // ω99-126: make_docx — top-level only, fixed position right after
    // make_pptx (append-only tail, prefix stability), ZERO-CONFIG always-on:
    // the model can always write a real .docx (title/headings/body/bullets/
    // tables) inside the workspace. Same posture as make_xlsx/make_pptx:
    // workspace-confined via resolveWorkspacePath, FILE_EDIT_TOOLS mode
    // posture + bypass-immune hard gate reading its filename key.
    createMakeDocxTool(workspaceRoot),
    // ω99-221: #3 — read_xlsx, top-level only, append-only tail right after
    // the computer octet (prefix stability), ZERO-CONFIG always-on
    // (workspaceRoot is always present): the model can always read an
    // existing workspace .xlsx as table text (the read half of the Excel
    // built-in — make_xlsx is the write half). Read posture: no
    // parent-facing gate needed (unlike the physical-input octet above) and
    // it never joins DEFAULT_ASK_TOOLS — the ordinary mode tiers carry it.
    // ω99-221 M24 note: mounting here shifts the deferred tail (task …) one
    // slot — re-pinned in constitution.test.ts on the 123/124/126/212/220
    // precedent. One cross-version cold turn for sessions spanning the
    // upgrade, never inside a session.
    createReadXlsxTool(workspaceRoot),
    // ω99-222: #5 — read_docx / read_pptx, top-level only, append-only tail
    // right after read_xlsx (prefix stability), ZERO-CONFIG always-on: the
    // model can always read an existing workspace .docx/.pptx as text (the
    // read halves of the Word/PPT built-ins — make_docx/make_pptx are the
    // write halves; the Excel/Word/PPT trio's read-write pairing is now
    // complete). Same read posture as read_xlsx: no parent-facing gate,
    // never in DEFAULT_ASK_TOOLS — the ordinary mode tiers carry it
    // (READ_TOOLS carries both names, 221 fix1 precedent).
    // ω99-222 M24 note: mounting here shifts the deferred tail (task …) two
    // slots — re-pinned in constitution.test.ts on the
    // 123/124/126/212/220/221 precedent. One cross-version cold turn for
    // sessions spanning the upgrade, never inside a session.
    createReadDocxTool(workspaceRoot),
    createReadPptxTool(workspaceRoot),
    // ω99-223: #5 — append_docx / append_pptx, top-level only, append-only tail
    // right after read_pptx (prefix stability), ZERO-CONFIG always-on: the
    // model can always add blocks to an existing workspace .docx or pages to
    // an existing .pptx (the append halves of the Word/PPT built-ins — the
    // read/write/append trio now lands the "edit" half's first cut: append,
    // not in-place rewrite). Existing content rides the zip layer
    // byte-identical (only the parts that must move are spliced); posture
    // mirrors the make_* write faces (FILE_EDIT_TOOLS carries both names, the
    // hard gate reads their path key); never in DEFAULT_ASK_TOOLS — the
    // ordinary mode tiers carry it (the edit/write class, edit 同形).
    // ω99-223 M24 note: mounting here shifts the deferred tail (task …) two
    // slots — re-pinned in constitution.test.ts on the
    // 123/124/126/212/220/221/222 precedent. One cross-version cold turn for
    // sessions spanning the upgrade, never inside a session.
    createAppendDocxTool(workspaceRoot),
    createAppendPptxTool(workspaceRoot),
    // ω99-228: #2 — append_xlsx, top-level only, append-only tail right after
    // append_pptx (prefix stability), ZERO-CONFIG always-on: the model can
    // always add rows to an existing workspace .xlsx (the append half of the
    // Excel built-in — the 「帮我看下这个表，再把新数据添进去」 scenario's
    // missing link: read_xlsx reads, make_xlsx creates fresh, append_xlsx adds
    // into the user's existing table). The trio's append faces complete here.
    // Posture mirrors the make_*/append_* write faces (FILE_EDIT_TOOLS carries
    // the name; the hard gate reads its path key); never in DEFAULT_ASK_TOOLS
    // — the ordinary mode tiers carry it (edit/write_file class, 同形).
    // ω99-228 M24 note: mounting here shifts the deferred tail (task …) ONE
    // slot — re-pinned in constitution.test.ts on the
    // 123/124/126/212/220/221/222/223 precedent. One cross-version cold turn
    // for sessions spanning the upgrade, never inside a session.
    createAppendXlsxTool(workspaceRoot),
    // ω99-229: #2 — replace_docx / replace_pptx, top-level only, append-only tail
    // right after append_xlsx (prefix stability), ZERO-CONFIG always-on: the
    // model can always swap a text span inside an existing workspace .docx or
    // .pptx in place (the in-place rewrite cut of the Word/PPT built-ins —
    // the 「把这份文档里的旧公司名换成新的」 scenario's missing link: read gives
    // the source, make re-creates whole, append adds at the tail, replace edits
    // in place with run-boundary-honest refusals instead of silent misses).
    // Existing content rides the zip layer byte-identical except the spliced
    // text nodes (format fully preserved — only text-node contents move);
    // posture mirrors the make_*/append_* write faces (FILE_EDIT_TOOLS carries
    // both names, the hard gate reads their path key); never in
    // DEFAULT_ASK_TOOLS — the ordinary mode tiers carry it (edit/write class,
    // 同形).
    // ω99-229 M24 note: mounting here shifts the deferred tail (task …) TWO
    // slots — re-pinned in constitution.test.ts on the
    // 123/124/126/212/220/221/222/223/228 precedent. One cross-version cold
    // turn for sessions spanning the upgrade, never inside a session.
    createReplaceDocxTool(workspaceRoot),
    createReplacePptxTool(workspaceRoot),
    // ω99-231: #2 — replace_xlsx, top-level only, append-only tail right after
    // replace_pptx (prefix stability), ZERO-CONFIG always-on: the model can
    // always swap a text span inside an existing workspace .xlsx in place (the
    // trio's edit half closes — read/make/append/replace all four rings live;
    // the 「把表里这格的旧值换成新值」「把旧公司名全表换掉」 scenario's
    // missing link). Hit cells are rewritten in place (shared-string cells
    // repoint to inlineStr so sharedStrings.xml stays byte-identical — other
    // cells referencing the same string are untouched); number cells get a
    // safety gate (non-finite result = named-cell refusal); rich text spanning
    // run boundaries gets an honest named-cell refusal instead of a silent
    // miss. Posture mirrors the make_*/append_*/replace_* write faces
    // (FILE_EDIT_TOOLS carries the name, the hard gate reads its path key);
    // never in DEFAULT_ASK_TOOLS — the ordinary mode tiers carry it
    // (edit/write class, 同形).
    // ω99-231 M24 note: mounting here shifts the deferred tail (task …) ONE
    // slot — re-pinned in constitution.test.ts on the
    // 123/124/126/212/220/221/222/223/228/229 precedent. One cross-version
    // cold turn for sessions spanning the upgrade, never inside a session.
    createReplaceXlsxTool(workspaceRoot),
    // ω99-238: #4 — set_docx_header / set_pptx_notes, top-level only,
    // append-only tail right after replace_xlsx (prefix stability),
    // ZERO-CONFIG always-on: the model can always set a Word document's
    // header/footer or a PPT page's speaker notes (the document-chrome faces —
    // the 「帮这份 Word 加个页眉」「给 PPT 第 3 页加演讲备注」 scenarios'
    // missing link; bare document → deliverable document). Idempotent
    // part-level overwrite (existing part content swapped in place, wiring
    // untouched; new part = sectPr/rels/content-type four-way splice with
    // 223's max+1 collision discipline). read_pptx grows a 备注 line the same
    // arc (notes-key absence keeps no-notes decks byte-identical). Posture
    // mirrors the replace_* write faces (FILE_EDIT_TOOLS carries both names,
    // the hard gate reads their path key); never in DEFAULT_ASK_TOOLS — the
    // ordinary mode tiers carry them (edit/write class, 同形).
    // ω99-238 M24 note: mounting here shifts the deferred tail (task …) TWO
    // slots — re-pinned in constitution.test.ts on the
    // 123/124/126/212/220/221/222/223/228/229/231 precedent. One cross-version
    // cold turn for sessions spanning the upgrade, never inside a session
    // (same-turn sibling: read_pptx's description gains the notes clause —
    // one cold turn total, both land in this version).
    createSetDocxHeaderTool(workspaceRoot),
    createSetPptxNotesTool(workspaceRoot),
    // ω99-256 — clear_docx_header / set_docx_first_page, top-level only,
    // append-only tail right after set_pptx_notes (prefix stability),
    // ZERO-CONFIG always-on: the model can always REMOVE a Word document's
    // header/footer or set first-page-different (the doc-chrome v2 faces — the
    // 「帮我把简历的页眉去掉」「首页不要页眉」 scenarios' missing link; 238's
    // source-note 残面收口). clear = part-level four-way clearing (reference +
    // part + rels + content-type override — removal, not blanking);
    // first-page = titlePg switch + optional first-reference part (zero-arg =
    // first page no header, the most common narrative). Posture mirrors the
    // set_* write faces (FILE_EDIT_TOOLS carries both names via the roster,
    // the hard gate reads their path key); never in DEFAULT_ASK_TOOLS — the
    // ordinary mode tiers carry them (edit/write class, 同形).
    // ω99-256 M24 note: mounting here shifts the deferred tail (task …) TWO
    // slots — re-pinned in constitution.test.ts on the
    // 123/124/126/212/220/221/222/223/228/229/231/238 precedent. One
    // cross-version cold turn for sessions spanning the upgrade, never inside
    // a session.
    createClearDocxHeaderTool(workspaceRoot),
    createSetDocxFirstPageTool(workspaceRoot),
    // ω99-263 — set_docx_even_pages, top-level only, append-only tail right
    // after set_docx_first_page (prefix stability), ZERO-CONFIG always-on: the
    // model can always set a Word document's even/odd pages different (the
    // doc-chrome v3 face — the 「偶数页页眉放书名、奇数页放章节名」双面打印
    // scenario's missing link; the document-level evenAndOddHeaders flag +
    // even-reference parts of both families in ONE call; false = one call back
    // to all-pages-alike). Posture mirrors the set_* write faces
    // (FILE_EDIT_TOOLS carries the name via the roster, the hard gate reads
    // its path key); never in DEFAULT_ASK_TOOLS — the ordinary mode tiers
    // carry it (edit/write class, 同形).
    // ω99-263 M24 note: mounting here shifts the deferred tail (task …) ONE
    // slot — re-pinned in constitution.test.ts on the 123/…/256 precedent.
    // One cross-version cold turn for sessions spanning the upgrade, never
    // inside a session (same-turn sibling: clear_docx_header's description
    // gains the even 档 clause — same version, one cold turn total).
    createSetDocxEvenPagesTool(workspaceRoot),
  ];
}

// ---------------------------------------------------------------------------
// 摘要器映射——log.ts 的名册消费面（命中即 return，缺席落 base switch）
// ---------------------------------------------------------------------------

/** The make faces never had an object summary (log.ts's `default: return ""`)
 *  — the explicit empty entry keeps the map's key set equal to the tool-name
 *  set (self-describing roster) without inventing copy. Byte-identical to
 *  falling through. */
const emptySummary = (): string => "";

/** Sixteen-name → summarizer map (236 twelve + ω99-238 two + ω99-256 two). The read/append/replace pure pieces are the
 *  SAME functions log.ts imported one by one before the roster refactor
 *  (纯件复用现 import；对象形与默认窗口同源钉在各自 doc-* 文件). A hit
 *  returns; a miss (non-doc tool names) falls to log.ts's base switch.
 *  ω99-238: the two set_* chrome faces join (same seam, log.ts untouched). */
export const docSuiteSummarizers: Readonly<Record<string, (input: Record<string, unknown>) => string>> = {
  make_xlsx: emptySummary,
  make_pptx: emptySummary,
  make_docx: emptySummary,
  read_xlsx: summarizeXlsxWindow,
  read_docx: summarizeDocxWindow,
  read_pptx: summarizePptxWindow,
  append_docx: summarizeAppendDocx,
  append_pptx: summarizeAppendPptx,
  append_xlsx: summarizeAppendXlsx,
  replace_docx: summarizeReplaceDocx,
  replace_pptx: summarizeReplacePptx,
  replace_xlsx: summarizeReplaceXlsx,
  set_docx_header: summarizeSetDocxHeader,
  set_pptx_notes: summarizeSetPptxNotes,
  clear_docx_header: summarizeClearDocxHeader,
  set_docx_first_page: summarizeSetDocxFirstPage,
  set_docx_even_pages: summarizeSetDocxEvenPages,
};
