// ω99-2a — MCP stdio 服务器 spawn 前的 OSV 恶意包检查（供应链安全闸门）。
//
// wudao 的 MCP stdio 服务器用 `npx`/`uvx` 按名冷拉包——这是恶意包进入
// 用户机器的真实入口。本模块在 connectServer 构造 JsonRpcClient（即
// spawn）之前查 OSV（osv.dev）的已知恶意软件通告：命中 `MAL-*` → throw
// （loadMcpTools 的既有 catch 把它变成标准的 warn+skip）；**其余一切错误
// （网络/HTTP/JSON/超时）一律静默放行**——fail-open 是刻意的：离线用户
// 不能因为 OSV 查不通而丢掉所有 MCP 服务器。只有"OSV 明确说这个包有
// MAL 通告"才构成拒绝，语义上等价于 the upstream project 的 extension_malware_check
// （移植参考，只读）。
//
// 与 the upstream project 的两处刻意分歧（都在 fail-open 安全方向）：
//   1. 不搬 uvx 的"选项-带独立值"大表（the upstream project :142-198），只认 --from=/
//      --from 两种形态（见 uvxFromPackage 注释）；
//   2. PyPI 版本提取只认 `==`/`===` 精确形——漏解析版本只会把查询放宽到
//      全版本（MAL 通告本来就按包生效，更保守），不会放行已知恶意包。

/** 每请求 5s 超时：检查串行挡在 spawn 前，不能让一个不响应的 OSV 端点
 *  拖慢整个启动路径；超时走 fail-open。 */
const OSV_TIMEOUT_MS = 5_000;
/** 翻页硬上限：一个包的 MAL 通告不该有 10 页；上限防止 next_page_token
 *  异常（自引用/超长链）把闸门变成 DoS。到顶即停，按已收集结果判定。 */
const OSV_MAX_PAGES = 10;
const DEFAULT_OSV_ENDPOINT = "https://api.osv.dev/v1/query";

/** 命令 → 包生态。最后路径段（`/` 与 `\` 都切）、小写后精确匹配：只认
 *  npx/npx.cmd/npx.exe（npm）与 uvx/uvx.exe（PyPI）这几个冷拉启动器；
 *  lookalike（my-npx、npx.cmd.bak、uvx.cmd）与 node/python 等一律
 *  undefined → 跳过检查（不是放行查询，是根本不查——那些命令不从公共
 *  仓库按名拉包，没有这个攻击面）。 */
export function commandEcosystem(cmd: string): "npm" | "PyPI" | undefined {
  const executable = (cmd.split(/[\\/]/).pop() ?? "").toLowerCase();
  switch (executable) {
    case "npx":
    case "npx.cmd":
    case "npx.exe":
      return "npm";
    case "uvx":
    case "uvx.exe":
      return "PyPI";
    default:
      return undefined;
  }
}

/** 从启动器参数里解出的包引用（version 缺省 = 按名查全部版本）。 */
export interface PackageRef {
  readonly name: string;
  readonly version?: string;
}

/** 第一个包参数 → PackageRef；解析不出合法包名 → undefined。
 *  positional = 第一个不以 `-` 开头的参数（朴素规则，不展开选项表）；
 *  PyPI 先扫 `--from=`/`--from`（uvx 的"跑这个包" selector）。 */
export function parseFirstPackageArg(ecosystem: "npm" | "PyPI", args: readonly string[]): PackageRef | undefined {
  const positional = args.find((a) => !a.startsWith("-"));
  const token = (ecosystem === "PyPI" ? (uvxFromPackage(args) ?? positional) : positional)?.trim();
  if (token === undefined || token.length === 0) return undefined;
  return ecosystem === "npm" ? parseNpmToken(token) : parsePypiToken(token);
}

/** 只扫参数头部的旗标区（第一个 positional / `--` 之前）：出现在包名之后
 *  的 --from 是被拉起工具自己的透传参数，不是 uvx 冷拉的包。the upstream project 为
 *  uvx 维护了一张完整的"选项-带独立值"大表（:142-198），让
 *  `--directory /tmp --from pkg` 也能命中 pkg；这里**刻意不搬**——最坏情况
 *  是把某选项的独立值误当包名查了个不存在的包，OSV 查无此包 → 无 MAL
 *  → 放行（fail-open 方向），绝不会误伤；换来零维护一张随 uvx 演进的表。 */
function uvxFromPackage(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--" || !a.startsWith("-")) break;
    if (a.startsWith("--from=") && a.length > "--from=".length) return a.slice("--from=".length);
    if (a === "--from") return args[i + 1]; // 悬空（无值）→ undefined → 回落 positional
  }
  return undefined;
}

/** npm token：`react@18.3.1`、`@scope/pkg@1.2.3`（版本分隔是**最后一个**
 *  @ ——scope 自己还带一个 @）、`pkg@latest`/`pkg@`/裸 `pkg` → 无版本。
 *  无版本 = 按名查全版本：对恶意包闸门是更保守的方向。 */
function parseNpmToken(token: string): PackageRef | undefined {
  const first = token.indexOf("@");
  if (first === -1) return { name: token };
  if (first === 0) {
    const last = token.lastIndexOf("@");
    if (last === 0) return { name: token }; // 裸 "@"：OSV 查无此包 → 放行
    const name = token.slice(0, last);
    const ver = token.slice(last + 1);
    return ver.length > 0 && ver !== "latest" ? { name, version: ver } : { name };
  }
  const name = token.slice(0, first);
  const ver = token.slice(first + 1);
  return ver.length > 0 && ver !== "latest" ? { name, version: ver } : { name };
}

/** PyPI token 的包名 = 连续 `[A-Za-z0-9._-]`（extras `[...]` 跳过；版本只
 *  认 `==`/`===` 精确形）。首尾必须是字母数字——挡住 `==1.0`、`-pkg`、
 *  `pkg-` 这类非包名形态。 */
const PYPI_NAME_RE = /^[A-Za-z0-9._-]+/;

function parsePypiToken(token: string): PackageRef | undefined {
  const name = PYPI_NAME_RE.exec(token)?.[0] ?? "";
  if (name.length === 0) return undefined;
  if (!/[A-Za-z0-9]/.test(name[0] ?? "") || !/[A-Za-z0-9]/.test(name[name.length - 1] ?? "")) return undefined;
  let rest = token.slice(name.length).trimStart();
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    if (close === -1) return undefined; // extras 未闭合 —— 非法 token
    rest = rest.slice(close + 1).trimStart();
  }
  const version = rest.startsWith("==") ? exactPypiVersion(rest.slice(2)) : undefined;
  return { name: normalizePypiName(name), ...(version !== undefined ? { version } : {}) };
}

/** `==`/`===` 之后的精确版本：`===`（PEP 440 任意等值）剥掉一个 `=` 后
 *  按 `==` 对待；通配（`0.3.*`）、逗号并列约束、非数字开头都不是精确
 *  版本 → undefined（查询放宽到全版本，保守方向）。 */
function exactPypiVersion(raw: string): string | undefined {
  let version = raw.trim();
  if (version.startsWith("=")) version = version.slice(1).trim();
  if (version.length === 0 || version.toLowerCase() === "latest") return undefined;
  const numeric = version.startsWith("v") || version.startsWith("V") ? version.slice(1) : version;
  if (!/^[0-9]/.test(numeric)) return undefined;
  if (!/^[A-Za-z0-9._+!-]+$/.test(version)) return undefined;
  return version;
}

/** PEP 503 规范名：小写、连续的 `-_.` 折叠为单个 `-`。OSV 按规范名索引
 *  PyPI，`Evil_Pkg` 必须查成 `evil-pkg` 才查得到通告。 */
function normalizePypiName(name: string): string {
  let out = "";
  let pendingSep = false;
  for (const ch of name) {
    if (ch === "-" || ch === "_" || ch === ".") pendingSep = true;
    else {
      if (pendingSep && out.length > 0) out += "-";
      out += ch.toLowerCase();
      pendingSep = false;
    }
  }
  return out;
}

/** 测试接缝：注入 fetch（确定性剧本）与 endpoint（fake server）。 */
export interface OsvCheckDeps {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
}

/** MCP 启动命令的恶意包闸门入口（connectServer 的 stdio 分支在 spawn 前
 *  调用）。WUDAO_OSV_CHECK=off → 整闸下线（CLI kill-switch 先例：
 *  output-config.ts 的 WUDAO_LONG_OUTPUT=off）；非 npx/uvx 或解析不出
 *  合法包名 → 直接 return；命中 MAL-* → throw（消息含包名与全部 MAL id）。 */
export async function checkMcpCommand(command: string, args: readonly string[], deps: OsvCheckDeps = {}): Promise<void> {
  if ((process.env["WUDAO_OSV_CHECK"] ?? "").trim().toLowerCase() === "off") return;
  const ecosystem = commandEcosystem(command);
  if (ecosystem === undefined) return;
  const ref = parseFirstPackageArg(ecosystem, args);
  if (ref === undefined) return;
  await denyIfMalicious(ref.name, ecosystem, ref.version, deps);
}

// OSV query 响应的最小面：vulns[].id/summary + next_page_token（snake_case
// 照 API 原样）。字段类型不可信——一律运行时校验后再用。
interface OsvQueryResponse {
  readonly vulns?: unknown;
  readonly next_page_token?: unknown;
}

interface MalAdvisory {
  readonly id: string;
  readonly summary?: string;
}

/** POST OSV /v1/query，收集 `MAL-*` 通告；非空 → throw。endpoint 优先级：
 *  deps.endpoint > env WUDAO_OSV_ENDPOINT > 默认 api.osv.dev。404 = 查无
 *  此包 → 放行；fetch reject / 其他非 2xx / JSON 解析失败 / 超时 → 静默
 *  放行（fail-open 红线：只有 MAL-* 命中才拒绝）。 */
async function denyIfMalicious(
  name: string,
  ecosystem: "npm" | "PyPI",
  version: string | undefined,
  deps: OsvCheckDeps = {},
): Promise<void> {
  const endpoint = deps.endpoint ?? process.env["WUDAO_OSV_ENDPOINT"] ?? DEFAULT_OSV_ENDPOINT;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let pageToken: string | undefined;
  const mal: MalAdvisory[] = [];
  for (let page = 0; page < OSV_MAX_PAGES; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OSV_TIMEOUT_MS);
    let text: string | undefined;
    try {
      let resp: Response;
      try {
        resp = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            package: { name, ecosystem },
            ...(version !== undefined ? { version } : {}),
            ...(pageToken !== undefined ? { page_token: pageToken } : {}),
          }),
          signal: controller.signal,
        });
      } catch {
        return; // 网络不通 / 超时 abort —— fail-open
      }
      if (resp.status === 404) return; // 查无此包
      if (!resp.ok) return; // 其余非 2xx —— fail-open
      try {
        text = await resp.text();
      } catch {
        return; // body 读失败（含中途 abort）—— fail-open
      }
    } finally {
      clearTimeout(timer);
    }
    let payload: OsvQueryResponse;
    try {
      payload = JSON.parse(text ?? "") as OsvQueryResponse;
    } catch {
      return; // 响应体非 JSON —— fail-open
    }
    if (Array.isArray(payload.vulns)) {
      for (const v of payload.vulns) {
        if (typeof v !== "object" || v === null) continue;
        const { id, summary } = v as { id?: unknown; summary?: unknown };
        if (typeof id === "string" && id.startsWith("MAL-")) {
          mal.push({ id, summary: typeof summary === "string" && summary.length > 0 ? summary : undefined });
        }
      }
    }
    const next = typeof payload.next_page_token === "string" && payload.next_page_token.length > 0
      ? payload.next_page_token
      : undefined;
    if (next === undefined) break;
    pageToken = next;
  }
  if (mal.length > 0) {
    // 消息沿 loadMcpTools 的既有 warn 通道浮出（mcp server "x" unavailable
    // (...)），包名 + 全部 MAL id（含 summary）都在场。
    throw new Error(`OSV malware advisory: ${name}@${version ?? "<any>"} — ${mal
      .map((m) => (m.summary !== undefined ? `${m.id}: ${m.summary}` : m.id))
      .join("; ")}`);
  }
}
