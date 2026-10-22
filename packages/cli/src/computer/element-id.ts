// 130-C1（cua jev-use 引进）— 稳定元素 ID + 风险档。
//
// 问题：[eN] 编号是观察表的位置序号——部分重渲染（顶部插一个元素）会
// 挪动全部编号，整表 sha 守卫随即废掉所有 ref（即使绝大多数元素没变，
// 模型也得重新观察+重找编号）。cua 的解：语义稳定 ID
// `ax:<role_class>:<slug(label)>`——元素在，ID 就在；部分重渲染只影响
// 真正消失的元素。风险档（candidate.risk）：角色分类喂权限感知——
// 「往输入框写」与「点一个普通按钮」不是同一风险级别的动作。
//
// 我们的形：stable ID 作为 [eN] 的兄弟寻址面（不是替换——eN 仍是
// helper 的原生索引；ax: ID 在解析层换算成当前表的 eN）。观察表行
// 追加 `@ax:role:slug` 段；click/type 的 ref 参数两种形都收。

/** slug 化：标题压成 [a-z0-9-] 段（CJK 保留原文段——中文应用的标题
 *  是主要区分面，音译/丢弃都会把不同元素撞成同 ID）。帽 24 字符。 */
export function slugifyLabel(title: string): string {
  const cleaned = title.replace(/["'`\[\](){}]/g, "").trim();
  if (cleaned === "") return "";
  // ASCII 词字符走 kebab；CJK/其它连续非空白段原样保留。
  const parts = cleaned
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Za-z0-9一-鿿-]+/g, "").toLowerCase())
    .filter((p) => p !== "");
  return parts.join("-").slice(0, 24);
}

/** 稳定 ID：`ax:<role>:<slug>`；无标题 → `ax:<role>`（角色唯一时仍稳；
 * 同角色多无题元素会撞——诚实接受：撞了解析取首个，模型该用 eN。 */
export function elementStableId(role: string, title: string): string {
  const slug = slugifyLabel(title);
  return slug === "" ? `ax:${role}` : `ax:${role}:${slug}`;
}

/** 风险档（角色分类——静态表，cua 的 candidate.risk 我们这边的形）。 */
export type ElementRisk = "low" | "medium" | "high";

/** 输入面=medium（往哪写内容是用户可感知的状态变更）；按钮/链接/勾选=
 * low（常规导航与确认）；未知角色=high（不知道会做什么）。风险档进
 * 观察表行与回执——权限管线消费回执时自然看见。 */
export function riskTierOfRole(role: string): ElementRisk {
  const r = role.toLowerCase();
  if (r.includes("text") || r.includes("edit") || r.includes("input") || r.includes("area") || r.includes("field")) return "medium";
  if (r.includes("button") || r.includes("link") || r.includes("checkbox") || r.includes("radio") || r.includes("tab") || r.includes("menu") || r.includes("cell")) return "low";
  return "high";
}

/** ref 参数的稳定 ID 形状（`ax:...`）。 */
export function isStableIdRef(raw: unknown): raw is string {
  return typeof raw === "string" && raw.startsWith("ax:") && raw.length > 3;
}

/** 在当前 refs 里解析稳定 ID → eN ref（首个命中；撞名取首是诚实降级）。
 *  未命中 → undefined（元素不在当前观察里——调用侧给「重观察」出路）。 */
export function resolveStableId(
  stable: string,
  refs: ReadonlyMap<string, { readonly role: string; readonly title: string }>,
): string | undefined {
  for (const [ref, e] of refs) {
    if (elementStableId(e.role, e.title) === stable) return ref;
  }
  return undefined;
}

/** 观察表行追加稳定 ID + 风险档段：`[e3] button "登录" @ax:button:登录 ·中`。
 *  纯函数；行不合形原样返回。 */
export function annotateElementLine(line: string, refs: ReadonlyMap<string, { readonly role: string; readonly title: string }>): string {
  const m = /^\s*\[(e[1-9][0-9]{0,4})\]/.exec(line);
  if (m === null) return line;
  const entry = refs.get(m[1]!);
  if (entry === undefined) return line;
  const risk = riskTierOfRole(entry.role);
  const riskMark = risk === "medium" ? "·中" : risk === "high" ? "·高" : "";
  return `${line} @${elementStableId(entry.role, entry.title)}${riskMark !== "" ? ` ${riskMark}` : ""}`;
}
