// ω99-238: #1 — docx 页眉页脚纯层 + 工具面（零依赖）。「帮这份 Word 加个
// 页眉/页脚」是办公高频动作：三件套读/造/追加/改四环已齐（221/222/223/
// 228/229/231），但文档外围部件缺位——docx 的 header/footer 是独立部件
// （headerN.xml/footerN.xml），由 sectPr 内 <w:headerReference w:type=
// "default" r:id/> 引用 + word/_rels/document.xml.rels 关系 + [Content_Types]
// .xml override 三处布线。本面补这块装饰件：裸文档→可交付文档。
//
// 语义=**幂等覆写**（部件级）：目标 which 在末节 sectPr 已有 default 引用 →
// 原位替换该部件内容（部件名/引用/关系/content-type 布线全不动——部件数不
// 增）；没有 → 新建部件 + 三处布线（碰撞纪律沿 223：部件号与 rId 都扫
// max+1，不数数量——部件名可有空洞）。既有页眉的自定义版式（logo/表格）
// 被覆写为纯文本——「页眉就是这段文字」的语义，如实记。
//
// ω99-256: #1 — doc 部件面 v2：238 在源码自注里预声明的两块残面收口——
// ①删除语义 clearDocxChrome（「帮我把简历的页眉去掉」：sectPr default 引
// 用 + headerN.xml 部件 + rels 条目 + Content_Types Override **四处全清**，
// 部件级删除而非仅删引用——残留部件=文件里还躺着可被恢复的旧页眉+体积不
// 减，「去掉」没完成；first/even 引用不动——首页不同域归 setDocxFirstPage，
// 本面只清主页眉）；②首页不同 setDocxFirstPage（「首页不要页眉」：titlePg
// 旗标 + first 引用部件的成对管理——不给 headerText=纯开关零参数达成首页无
// 页眉；false=拆 titlePg+first 三清回全篇同款）。奇偶页 evenAndOddHeaders、
// footer 的 first/clear 变体仍记池（YAGNI）。238 的 set 机械（引用词根/插点
// 序/rels 缝）全部复用，仅把 w:type 参数化（default|first）。
//
// ω99-259: #1 — docx 部件面对称收口：256 的首页分野只对页眉族开了面
// （setDocxFirstPage 只有 headerText、false 路径只清 header first 引用、
// clear 只清 default 引用）——「首页不要页码」（信函/报告首页干净）在已有
// first footer 引用的文档上做不到：titlePg 立旗后 first footer 引用仍在渲
// 染。本弧把 first 面对 footer 族补齐 + 清除面开 first 变体（ECMA-376 对
// header/footer 双部件族对称完备，四种首页组合一次调用可达成）：
// ①clearDocxChrome 增可选 refType（缺省 "default"=今日行为字节零演进；
// "first"=清该 which 的 first 引用族四处全清——引用+部件+rels+CT，共享部
// 件守卫与 not_found 出口照 256；even 引用仍不动，YAGNI 记池）；
// ②setDocxFirstPage 增 footerText（true 时与 headerText 同语义走
// setDocxChromeRef("footer","first")——覆写=部件数不增、新建=碰撞纪律；
// false 时四清扩为双面：header/footer 的 first 引用族各自独立四清，单面
// 缺席跳过不构成 not_found——开关语义是「回到全篇一致」，如实跳过）；
// ③工具面随行（clear_docx_header 增 refType、set_docx_first_page 增
// footerText——零新工具，名册四缝零演进）。工具描述与 schema 变更=工具
// 列字节变更，跨版本一次冷转（cold turn expected，256/257 同款已声明代价）。
//
// ω99-263: #1 — docx 奇偶页不同（第三档分野收口）：Word 页眉页脚的「首页/
// 奇偶」两轴至此齐（259 §五池 #1）。①evenAndOddHeaders 文档级旗标（word/
// settings.xml——make_docx 裸包无此部件 → 缺席自动创建最小壳：部件 + CT
// Override + document rels rId 三缝布线，碰撞纪律沿 223/228 的 max+1；已在
// 场→按 EVENODD_LATER_ELEMENTS 位序插、幂等原字节回）；②header/footer 双
// 部件族的 even 引用档（setDocxChromeRef 的 refType 参数化机械直用——259
// 投资的本意兑现）；③setDocxEvenPages 一键原子（true=旗标+双文本一次落
// 盘；false=拒文本+旗标删+even 双族四清，一步回全篇一致）；④clear_docx_
// header 的 refType 值域 +even（职责分离：clear 只清引用面**不动文档级旗
// 标**——描述句指路关闭工具，不自动联动）。settings.xml 侧的移除只删旗标
// 元素——**部件永不删**（其他 Word 设置原样保留，用户文件永不删）。旗标是
// 文档级（全文档生效，与 titlePg 的节级不同——不对称如实记）；even 引用仍
// 落末节（259 池 #3 边界继承）。名册 +1 员=工具列字节变更，跨版本一次冷转
// （M24，256 同款已声明代价；名册构造序尾插，既有序零重排）。
//
// 互证（223/229 范式，超越点=部件级幂等覆写）：回装字节重新解包走一遍
// sectPr r:id → rels → 部件文本 的真链——「已设置」从读回来，不是从写
// 进去猜。smartZip 沿 230 三形裁定：未改部件原压缩载荷字节直过。
//
// 纪律（brief 钉，221/222/223/228/229/231 同款）：
// - 纯层纯函数：不碰时钟（DOS 时间由 doc-zip 钉）、不碰盘（盘只在工具面
//   execute 里 readFile/writeFile）；
// - 原包字节保真：除改到/新增的部件外逐字节过 zip 层；条目名序原样（新
//   部件尾续；确定性：同输入两次全等）；
// - typed 拒优于静默剥：坏 zip/加密/Zip64/缺部件/缺锚点直接拒，错误信息
//   用户语（unzipEntries 本体是 xlsx 口径，本面映射成 docx 词汇——223 同款
//   本地件）；
// - 校验先于副作用：which 二值/text 非空串（纯空白同拒）/控制字符拒
//   （\x00-\x08、\x0B、\x0C、\x0E-\x1F；\t \n \r 放行——doc-docx.ts :139
//   同款校验文案族）/text 帽 4,000 字符（码点计；防部件炸弹，非内容审查）；
// - 多节文档只动末节（body 级 sectPr=lastIndexOf 落点，223 同款纪律）：
//   前节的页眉不受影响——v1 边界如实记。
//
// ω99 file-size discipline arc A — this module keeps the TOOL FACES (the
// four create*Tool builders + summarize fns); the pure layers live beside it
// and are re-exported below so the public face is unchanged:
//   doc-chrome-xml.ts          — validation family + OOXML/zip primitives +
//                                set/clear chrome core (四缝布线/四处全清)
//   doc-chrome-first-page.ts   — titlePg flag + first-reference pair layer
//   doc-chrome-even-pages.ts   — evenAndOddHeaders flag + even-reference layer
import { buildTool, resolveWorkspacePath } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { validateDocxChrome, setDocxChrome, clearDocxChrome } from "./doc-chrome-xml.js";
import { validateDocxFirstPage, setDocxFirstPage } from "./doc-chrome-first-page.js";
import { validateDocxEvenPages, setDocxEvenPages } from "./doc-chrome-even-pages.js";

// ---- facade re-exports (bodies moved ω99 arc A; public face unchanged) ----
export type { DocxChromeWhich, ValidateChromeCheck, SetDocxChromeCheck, ClearDocxChromeCheck, DocxChromeRefType } from "./doc-chrome-xml.js";
export { DOCX_CHROME_TEXT_MAX, validateDocxChrome, setDocxChrome, clearDocxChrome } from "./doc-chrome-xml.js";
export type { DocxFirstPageInput, ValidateFirstPageCheck, SetDocxFirstPageCheck } from "./doc-chrome-first-page.js";
export { validateDocxFirstPage, setDocxFirstPage } from "./doc-chrome-first-page.js";
export type { DocxEvenPagesInput, ValidateEvenPagesCheck, SetDocxEvenPagesCheck } from "./doc-chrome-even-pages.js";
export { validateDocxEvenPages, setDocxEvenPages } from "./doc-chrome-even-pages.js";

// ---------------------------------------------------------------------------
// C — 工具面：set_docx_header（页眉页脚共用一个面，which 参数分派）。path
// （必填，相对工作区）+ which（header|footer）+ text（非空，帽 4,000）；魔数
// 嗅探：OLE（旧版 .doc）给「另存为 .docx」出路、非 PK 拒；覆写只落目标文件
// 本身（零删除面）。
// ---------------------------------------------------------------------------

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0] as const;

/** 魔数嗅探（docx 写面工具共用，256 起三工具一副面孔）：旧版 .doc（OLE 复
 *  合文档）与「根本不是 Word」分开拒——前者有出路（另存为 .docx），说清
 *  楚。返回错误文案（不含工具名前缀），无问题 undefined。纯。 */
function docxMagicError(rel: string, bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && OLE_MAGIC.every((b, i) => bytes[i] === b)) {
    return `${rel} 是旧版 .doc 格式，改不了——请先用 Word 打开并「另存为」.docx 格式后再试`;
  }
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    return `${rel} 不是 Word（.docx）文档——如果它是旧版 .doc 或其他格式，请先在 Word 里另存为 .docx 再试`;
  }
  return undefined;
}

/** 收据预览：前 20 字（码点计）+ 超长「…」（brief §二钉形）。纯。 */
function receiptPreview(text: string): string {
  const chars = Array.from(text);
  return chars.slice(0, 20).join("") + (chars.length > 20 ? "…" : "");
}

/** 设置工作区里现有 Word 文档的页眉或页脚。顶级工具（doc 名册尾——tools.ts
 *  双段展开自动随名册进尾段）；路径必经 resolveWorkspacePath（外逃/绝对路
 *  径 typed 拒，fail-closed）；校验先于副作用：拒时零写盘。姿态镜像
 *  replace_docx 写面。 */
export function createSetDocxHeaderTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "set_docx_header",
    promptSnippet: "set a Word document's header or footer",
    description:
      "设置 Word 文档的页眉或页脚（每页相同；已有则替换）。适合「帮这份 Word 加个页眉」「给这份文档加个页脚」类请求；与读取的 read_docx、追加内容的 append_docx 配套。" +
      " path 是文档相对工作区的路径。which 选页眉（header）还是页脚（footer）。text 是要设置的内容（1–4000 字，可换行）。" +
      " 注意：本工具设置的是每页相同的普通页眉/页脚（首页不同用 set_docx_first_page、奇偶页不同用 set_docx_even_pages）；重复设置会替换旧内容；要清空页眉/页脚暂不支持（可设成一个空格之类的占位）；旧版 .doc 格式不支持，需先在 Word 里另存为 .docx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。覆写目标文件本身
    // → destructive 诚实标注（make_*/replace_* 同款 posture 镜像）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要设置页眉/页脚的 Word 文档路径（相对工作区，可带子目录），.docx 文件。" },
        which: { type: "string", description: "设置哪一个：header（页眉）或 footer（页脚）。" },
        text: { type: "string", description: "新的页眉/页脚内容（1–4000 字，可换行）。" },
      },
      required: ["path", "which", "text"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'set_docx_header: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();
      const checked = validateDocxChrome(args["which"], args["text"]);
      if (!checked.ok) return { content: `set_docx_header: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `set_docx_header: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `set_docx_header: 文件不存在：${rel}`, isError: true };
        }
        return { content: `set_docx_header: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }

      // 魔数嗅探先于结构解析（共用件 docxMagicError——256 起三工具一副面
      // 孔，文案逐字不变）。
      const magic = docxMagicError(rel, bytes);
      if (magic !== undefined) return { content: `set_docx_header: ${magic}`, isError: true };

      const out = setDocxChrome(bytes, checked.which, checked.text);
      if (!out.ok) return { content: `set_docx_header: ${out.error}`, isError: true };

      // 设置=覆写目标文件本身（零删除面；目录已存在——刚读过这文件）。
      try {
        await writeFile(resolved.absPath, out.bytes);
      } catch (err) {
        return { content: `set_docx_header: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      return {
        // 收据=用户语（brief §二逐字）+ 结构化字段一行（文件卡从这行提取）。
        content:
          `已设置${checked.which === "header" ? "页眉" : "页脚"}：「${receiptPreview(checked.text)}」\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            which: checked.which,
            bytes: out.bytes.byteLength,
          }),
      };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 动作，形
 *  「报告.docx 设置了页眉」（brief §二：设置了页眉/页脚，which 插值）。纯。 */
export function summarizeSetDocxHeader(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  if (input["which"] === "header") parts.push("设置了页眉");
  else if (input["which"] === "footer") parts.push("设置了页脚");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// D — ω99-256 工具面：clear_docx_header（删除页眉/页脚）+ set_docx_first_page
// （首页不同）。沿 238 单工具骨架（236 名册四缝追加，内核缝零 doc 名）；
// 删除/开关只落目标文件本身（零文件系统删除——纯层删的是内存 zip 条目）。
// ---------------------------------------------------------------------------

/** 删除工作区里现有 Word 文档的页眉或页脚（部件级全清）。路径必经
 *  resolveWorkspacePath（外逃/绝对路径 typed 拒，fail-closed）；无页眉=诚实
 *  告知零写盘；校验先于副作用。姿态镜像 set_docx_header 写面。 */
export function createClearDocxHeaderTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "clear_docx_header",
    promptSnippet: "remove a Word document's header or footer",
    description:
      "删除 Word 文档的页眉或页脚（从文件里彻底移除，不是留空）。适合「帮我把这份简历的页眉去掉」「这个文档不要页脚」「首页那页的页码去掉」「左页那栏页眉不要了」类请求；与设置页眉的 set_docx_header、设置首页不同的 set_docx_first_page 配套。" +
      " path 是文档相对工作区的路径。which 选删除页眉（header，默认）还是页脚（footer）。refType 选删哪一档：default（每页都有的普通页眉/页脚，不填默认）、first（首页专属那档——删掉后首页跟随全篇样式）或 even（偶数页专属那档——只删偶数页的引用与部件，不动「奇偶页不同」开关本身，要整个关掉开关用 set_docx_even_pages）。" +
      " 注意：删除的是所选档的页眉/页脚本体；关闭「首页不同」整个开关归 set_docx_first_page 管，关闭「奇偶页不同」整个开关归 set_docx_even_pages 管；文档本就没有所选档时会如实告知（文件保持原样）；旧版 .doc 格式不支持，需先在 Word 里另存为 .docx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。从目标文件移除部件
    // → destructive 诚实标注（238 set 面同款 posture）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除页眉/页脚的 Word 文档路径（相对工作区，可带子目录），.docx 文件。" },
        which: { type: "string", description: "删除哪一个：header（页眉，不填默认）或 footer（页脚）。" },
        refType: { type: "string", description: "删除哪一档：default（每页都有的普通页眉/页脚，不填默认）、first（首页专属那档）或 even（偶数页专属那档——不动「奇偶页不同」开关）。" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）；which 缺省=header、refType 缺省
      //=default（259 起）、even 档 263 起。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'clear_docx_header: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();
      const which = args["which"] === undefined ? "header" : args["which"];
      if (which !== "header" && which !== "footer") {
        return { content: `clear_docx_header: "which" must be "header" or "footer" (got ${JSON.stringify(which) ?? "undefined"})`, isError: true };
      }
      const refType = args["refType"] === undefined ? "default" : args["refType"];
      if (refType !== "default" && refType !== "first" && refType !== "even") {
        return { content: `clear_docx_header: "refType" must be "default", "first" or "even" (got ${JSON.stringify(refType) ?? "undefined"})`, isError: true };
      }

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `clear_docx_header: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `clear_docx_header: 文件不存在：${rel}`, isError: true };
        }
        return { content: `clear_docx_header: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const magic = docxMagicError(rel, bytes);
      if (magic !== undefined) return { content: `clear_docx_header: ${magic}`, isError: true };

      const out = clearDocxChrome(bytes, which, refType);
      if (!out.ok) {
        // 诚实 not-found（229 四出口形）：本就没有=零写盘原样回（263 起 even
        // 档插「偶数页」）。
        if (out.reason === "not_found") {
          return { content: `clear_docx_header: 这份文档本就没有${refType === "first" ? "首页" : refType === "even" ? "偶数页" : ""}${which === "header" ? "页眉" : "页脚"}——无需删除`, isError: true };
        }
        return { content: `clear_docx_header: ${out.error}`, isError: true };
      }

      // 删除=覆写目标文件本身（零文件系统删除面；目录已存在——刚读过）。
      try {
        await writeFile(resolved.absPath, out.bytes);
      } catch (err) {
        return { content: `clear_docx_header: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      return {
        // 收据=用户语（brief §二逐字，first 档插「首页」、even 档插「偶数页」）
        // + 结构化字段一行（文件卡从这行提取；259 钉 JSON 尾行结构不变——
        // refType 不进尾行）。
        content:
          `已删除${refType === "first" ? "首页" : refType === "even" ? "偶数页" : ""}${which === "header" ? "页眉" : "页脚"}\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            which,
            bytes: out.bytes.byteLength,
          }),
      };
    },
  });
}

/** 设置工作区里现有 Word 文档的首页是否与其他页不同（titlePg 开关 + 可选
 *  首页专属页眉）。路径必经 resolveWorkspacePath；关闭时若本就未设=诚实告
 *  知零写盘；校验先于副作用。姿态镜像 set_docx_header 写面。 */
export function createSetDocxFirstPageTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "set_docx_first_page",
    promptSnippet: "make a Word document's first page differ from the rest",
    description:
      "设置 Word 文档的首页是否与其他页不同（典型：「首页不要页眉」「封面不带页眉」「首页不要页码」）。与每页设置页眉的 set_docx_header、删除页眉的 clear_docx_header 配套。" +
      " path 是文档相对工作区的路径。firstDifferent 为 true 时首页与其他页分开：不填 headerText 就是首页无页眉（最常用）；填 headerText 则首页单独用这段页眉（1–4000 字，可换行）；footerText 同理给首页专属页脚（不填=首页无页脚，填了=首页单独用这段页脚）。firstDifferent 为 false 时回到全篇相同（首页专属页眉/页脚会被移除，每页的普通页眉页脚保留）。" +
      " 注意：奇偶页不同用 set_docx_even_pages；旧版 .doc 格式不支持，需先在 Word 里另存为 .docx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。改写目标文件本身
    // → destructive 诚实标注（238 set 面同款 posture）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要设置首页不同的 Word 文档路径（相对工作区，可带子目录），.docx 文件。" },
        firstDifferent: { type: "boolean", description: "true=首页与其他页不同（首页无页眉/页脚或首页专属页眉/页脚）；false=回到全篇相同。" },
        headerText: { type: "string", description: "首页专属页眉内容（1–4000 字，可换行）；不填=首页无页眉。只在 firstDifferent 为 true 时可填。" },
        footerText: { type: "string", description: "首页专属页脚内容（1–4000 字，可换行）；不填=首页无页脚。只在 firstDifferent 为 true 时可填。" },
      },
      required: ["path", "firstDifferent"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'set_docx_first_page: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();
      const checked = validateDocxFirstPage(args["firstDifferent"], args["headerText"], args["footerText"]);
      if (!checked.ok) return { content: `set_docx_first_page: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `set_docx_first_page: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `set_docx_first_page: 文件不存在：${rel}`, isError: true };
        }
        return { content: `set_docx_first_page: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const magic = docxMagicError(rel, bytes);
      if (magic !== undefined) return { content: `set_docx_first_page: ${magic}`, isError: true };

      const out = setDocxFirstPage(bytes, {
        firstDifferent: checked.firstDifferent,
        headerText: checked.headerText,
        footerText: checked.footerText,
      });
      if (!out.ok) {
        if (out.reason === "not_found") {
          return { content: "set_docx_first_page: 这份文档本就没有设置首页不同——无需关闭", isError: true };
        }
        return { content: `set_docx_first_page: ${out.error}`, isError: true };
      }

      // 开关/设置=覆写目标文件本身（零删除面；目录已存在——刚读过）。
      try {
        await writeFile(resolved.absPath, out.bytes);
      } catch (err) {
        return { content: `set_docx_first_page: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      // 收据首行（259 起 footerText 同 preview 形；双文本「；」连——256 钉形
      // 在 footerText 缺席时逐字不变）。
      let firstLine: string;
      if (!checked.firstDifferent) {
        firstLine = "首页已设为与全篇相同";
      } else {
        const bits: string[] = [];
        if (checked.headerText !== undefined) bits.push(`首页页眉：「${receiptPreview(checked.headerText)}」`);
        if (checked.footerText !== undefined) bits.push(`首页页脚：「${receiptPreview(checked.footerText)}」`);
        firstLine = bits.length === 0 ? "首页已设为不同（无首页页眉）" : `首页已设为不同（${bits.join("；")}）`;
      }
      return {
        // 收据=用户语（brief §二逐字）+ 结构化字段一行（文件卡从这行提取）。
        content:
          `${firstLine}\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            firstDifferent: checked.firstDifferent,
            ...(checked.headerText !== undefined ? { headerText: checked.headerText } : {}),
            ...(checked.footerText !== undefined ? { footerText: checked.footerText } : {}),
            bytes: out.bytes.byteLength,
          }),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// E — ω99-263 工具面：set_docx_even_pages（奇偶页不同——Word UI「奇偶页不
// 同」域：书的左右页不同页眉/页脚，双面打印的书籍与报告高频）。沿 256 单
// 工具骨架；开关/设置只落目标文件本身（零删除面——纯层删的是内存 zip 条
// 目，settings 部件永不删）。
// ---------------------------------------------------------------------------

/** 设置工作区里现有 Word 文档的奇偶页是否不同（文档级开关 + 可选偶数页专
 *  属页眉/页脚）。路径必经 resolveWorkspacePath；关闭时若本就未设=诚实告知
 *  零写盘；校验先于副作用。姿态镜像 set_docx_first_page 写面。 */
export function createSetDocxEvenPagesTool(workspaceRoot: string): Tool {
  return buildTool({
    name: "set_docx_even_pages",
    promptSnippet: "make a Word document's odd and even pages differ",
    description:
      "设置 Word 文档的奇偶页是否不同（对应 Word 的「奇偶页不同」：左右页可用不同页眉页脚——书籍、双面打印的报告常用，典型「偶数页页眉放书名、奇数页放章节名」「左页右页的页码位置分开」）。与每页设置页眉的 set_docx_header、首页不同的 set_docx_first_page 配套。" +
      " path 是文档相对工作区的路径。evenOddDifferent 为 true 时开启：不填 evenHeaderText/evenFooterText 就是偶数页不另设内容；填了则偶数页单独用这段页眉/页脚（1–4000 字，可换行）。evenOddDifferent 为 false 时关闭：偶数页专属页眉/页脚被移除，文档回到全篇相同（每页的普通页眉页脚保留）。" +
      " 注意：这是整个文档的开关（对文档所有节生效）；旧版 .doc 格式不支持，需先在 Word 里另存为 .docx。",
    // 写盘（非只读）；只在本地文件系统（closed-world）。改写目标文件本身
    // → destructive 诚实标注（238 set 面同款 posture）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要设置奇偶页不同的 Word 文档路径（相对工作区，可带子目录），.docx 文件。" },
        evenOddDifferent: { type: "boolean", description: "true=奇偶页不同（偶数页无专属内容或偶数页专属页眉/页脚）；false=回到全篇相同。" },
        evenHeaderText: { type: "string", description: "偶数页（左页）专属页眉内容（1–4000 字，可换行）；不填=偶数页不另设页眉。只在 evenOddDifferent 为 true 时可填。" },
        evenFooterText: { type: "string", description: "偶数页（左页）专属页脚内容（1–4000 字，可换行）；不填=偶数页不另设页脚。只在 evenOddDifferent 为 true 时可填。" },
      },
      required: ["path", "evenOddDifferent"],
      additionalProperties: false,
    },
    async execute(args) {
      // 参数 typed 校验（先于任何盘副作用）。
      const rawPath = args["path"];
      if (typeof rawPath !== "string" || rawPath.trim() === "") {
        return { content: 'set_docx_even_pages: "path" must be a non-empty path relative to the workspace', isError: true };
      }
      const rel = rawPath.trim();
      const checked = validateDocxEvenPages(args["evenOddDifferent"], args["evenHeaderText"], args["evenFooterText"]);
      if (!checked.ok) return { content: `set_docx_even_pages: ${checked.error}`, isError: true };

      // 工作区边界（外逃/绝对路径/符号链接诡计拒）。
      const resolved = await resolveWorkspacePath(workspaceRoot, rel);
      if (!resolved.ok) return { content: `set_docx_even_pages: ${resolved.error}`, isError: true };

      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolved.absPath);
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: `set_docx_even_pages: 文件不存在：${rel}`, isError: true };
        }
        return { content: `set_docx_even_pages: 读取失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      const magic = docxMagicError(rel, bytes);
      if (magic !== undefined) return { content: `set_docx_even_pages: ${magic}`, isError: true };

      const out = setDocxEvenPages(bytes, {
        evenOddDifferent: checked.evenOddDifferent,
        evenHeaderText: checked.evenHeaderText,
        evenFooterText: checked.evenFooterText,
      });
      if (!out.ok) {
        if (out.reason === "not_found") {
          return { content: "set_docx_even_pages: 这份文档本就没有设置奇偶页不同——无需关闭", isError: true };
        }
        return { content: `set_docx_even_pages: ${out.error}`, isError: true };
      }

      // 开关/设置=覆写目标文件本身（零删除面；目录已存在——刚读过）。
      try {
        await writeFile(resolved.absPath, out.bytes);
      } catch (err) {
        return { content: `set_docx_even_pages: 写入失败（${err instanceof Error ? err.message : String(err)}）`, isError: true };
      }
      // 收据首行（259 双文本「；」连钉形的奇偶轴复制；20 字预览帽共用件）。
      let firstLine: string;
      if (!checked.evenOddDifferent) {
        firstLine = "奇偶页不同已关闭";
      } else {
        const bits: string[] = [];
        if (checked.evenHeaderText !== undefined) bits.push(`偶数页页眉：「${receiptPreview(checked.evenHeaderText)}」`);
        if (checked.evenFooterText !== undefined) bits.push(`偶数页页脚：「${receiptPreview(checked.evenFooterText)}」`);
        firstLine = bits.length === 0 ? "奇偶页不同已开启（未设偶数页专属页眉/页脚）" : `奇偶页不同已开启（${bits.join("；")}）`;
      }
      return {
        // 收据=用户语 + 结构化字段一行（文件卡从这行提取；259 钉 JSON 尾行
        // 结构形——文本键缺席时零演进同款）。
        content:
          `${firstLine}\n` +
          JSON.stringify({
            path: resolved.absPath,
            relativePath: rel,
            evenOddDifferent: checked.evenOddDifferent,
            ...(checked.evenHeaderText !== undefined ? { evenHeaderText: checked.evenHeaderText } : {}),
            ...(checked.evenFooterText !== undefined ? { evenFooterText: checked.evenFooterText } : {}),
            bytes: out.bytes.byteLength,
          }),
      };
    },
  });
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 动作，形
 *  「书.docx 奇偶页设为不同」/「书.docx 奇偶页设为相同」。纯。 */
export function summarizeSetDocxEvenPages(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  if (input["evenOddDifferent"] === true) parts.push("奇偶页设为不同");
  else if (input["evenOddDifferent"] === false) parts.push("奇偶页设为相同");
  return parts.join(" ");
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 动作，形
 *  「报告.docx 删除了页眉」（which 插值；缺席=工具缺省 header）。纯。 */
export function summarizeClearDocxHeader(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  if (input["which"] === "footer") parts.push("删除了页脚");
  else parts.push("删除了页眉");
  return parts.join(" ");
}

/** log.ts summarize 的对象摘要件（导出给测试直钉）：文件尾名 + 动作，形
 *  「报告.docx 首页设为不同」/「报告.docx 首页设为与全篇相同」。纯。 */
export function summarizeSetDocxFirstPage(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const path = input["path"];
  if (typeof path === "string" && path.trim() !== "") parts.push(basename(path.trim()));
  if (input["firstDifferent"] === true) parts.push("首页设为不同");
  else if (input["firstDifferent"] === false) parts.push("首页设为与全篇相同");
  return parts.join(" ");
}
