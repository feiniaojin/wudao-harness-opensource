// tauri-invoke — workspace-ux A1: the ONE seam for desktop-plugin calls
// (directory dialog / finish notification / window drag), so no caller
// hand-rolls a `__TAURI__` optional-chain again. Resolution is three-tier:
// the webview's own __TAURI_INTERNALS__.invoke first (always injected by
// Tauri v2, even without withGlobalTauri), then the withGlobalTauri
// core-only `__TAURI__.core.invoke`, else undefined. An absent OR throwing
// bridge reads as null/false — the caller falls back to its browser path,
// never an unhandled rejection.

/** A raw Tauri plugin-invoke function (plugin command + args object). */
export type TauriInvoke = (cmd: string, args?: unknown) => Promise<unknown>;

type TauriWindow = typeof window & {
  __TAURI_INTERNALS__?: { invoke?: unknown; transformCallback?: unknown };
  __TAURI__?: { core?: { invoke?: unknown } };
};

/** 三层解析：__TAURI_INTERNALS__.invoke → __TAURI__.core.invoke → undefined。 */
export function resolveTauriInvoke(): TauriInvoke | undefined {
  const w = window as TauriWindow;
  const internals = w.__TAURI_INTERNALS__?.invoke;
  if (typeof internals === "function") return internals as TauriInvoke;
  const bundled = w.__TAURI__?.core?.invoke;
  if (typeof bundled === "function") return bundled as TauriInvoke;
  return undefined;
}

/** plugin:dialog|open 的 multiple:false 结果归一：本桥返回 string|null，
 *  数组只是防御分支；null / 空串 / 非字符串一律 null（=用户取消）。 */
function pickPath(r: unknown): string | null {
  return Array.isArray(r) ? (typeof r[0] === "string" ? r[0] : null) : typeof r === "string" && r !== "" ? r : null;
}

/** 目录选择（原生框）；非 Tauri 环境 → null（调用方走浏览器回退）。 */
export async function tauriPickDirectory(): Promise<string | null> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return null;
  try {
    // multiple:false keeps the bridge contract: string|null, never an array.
    return pickPath(await invoke("plugin:dialog|open", { options: { directory: true, multiple: false } }));
  } catch {
    return null; // a failed dialog = no pick; stay put
  }
}

/** 完成通知；非 Tauri → false（调用方走标题闪烁回退）。
 *  ω99-254: #1 — body 可选（等待授权通知带会话标题进 body；finish 调用不
 *  带——notification API 原生支持 body 字段）。缺席时 options 键集与既有
 *  调用逐字节同形，唯一调用方 tauriNotifyFinish 与 tauri-invoke.test.ts
 *  的形状钉零演进。 */
export async function tauriNotify(title: string, body?: string): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try {
    // body 缺席 → 恰 title 一键：finish 通知的请求字节零演进。
    await invoke(
      "plugin:notification|notify",
      body === undefined ? { options: { title } } : { options: { title, body } },
    );
    return true;
  } catch {
    return false; // a missing plugin = the fallback's job, not a crash
  }
}

/** 拖拽启动兜底（topbar 拖拽区）；非 Tauri → false。 */
export async function tauriStartDrag(): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke("plugin:window|start_dragging"); // 无参数调用
    return true;
  } catch {
    return false;
  }
}

/** 顶栏双击最大化（workspace-ux C1）；非 Tauri / 拒绝 → false。
 *  无 label = 调用方所在窗口：workspace-* 多窗同享 topbar，写死 "main"
 *  会在子窗上切错主窗（start_dragging 同一约定）。 */
export async function tauriToggleMaximize(): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke("plugin:window|toggle_maximize");
    return true;
  } catch {
    return false; // 缺 capability / 插件缺失 = 调用方静默回退，不是崩溃
  }
}

// --- ω99-99 事件总线缝（主窗↔宠物窗的跨窗通道） ---------------------------
// wire 形状按 tauri-2.11.5 源码（src/event/plugin.rs + event/mod.rs）：
// EventTarget 是 #[serde(tag="kind")] 的单态枚举（{"kind":"Any"}），listen
// 返回 EventId=u32，unlisten 以该 EventId 收回。全部沿用本文件的纪律：任
// 一步缺失/抛错 → false/null，浏览器路径绝不抛。

/** 广播事件（plugin:event|emit）；非 Tauri / 拒绝 → false。 */
export async function tauriEmitEvent(event: string, payload: unknown): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke("plugin:event|emit", { event, payload });
    return true;
  } catch {
    return false;
  }
}

/** ω99-107：解包原生事件回调收到的 Tauri Event 包装。live 逐字线格式
 *  （0.3.44 真机注入诊断）：
 *  {"event":"wudao-diag-test","payload":{"probe":42},"id":1}
 *  键为 event(字符串)/payload(emit 端对象)/id(数字)。@tauri-apps/api 的
 *  listen() 会替你解包；我们走裸 plugin 命令缝，必须在 seam 单点解。
 *  判据：raw 为非 null、非数组的 object 且 typeof event==="string" 且
 *  "payload" in raw → 返回 raw.payload；裸 payload / 原始值 / null 一律
 *  原样透传（不猜）。权衡：启发式理论上会误伤「自身恰好带 event+payload
 *  键」的 payload——本仓四个 payload（ask 文本/宠物帧/drop/delivery）都
 *  不含此类键，风险为零。
 */
export function unwrapTauriEventPayload(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const maybe = raw as { event?: unknown; payload?: unknown };
  if (typeof maybe.event === "string" && "payload" in raw) return maybe.payload;
  return raw;
}

/** 订阅事件（plugin:event|listen，target 缺省 {"kind":"Any"}）。事件到达时
 *  调 handler(payload)——契约：seam 负责解包，消费者只见 payload。原生回调
 *  实际收到的是 Event 包装对象
 *  {"event":"wudao-diag-test","payload":{"probe":42},"id":1}，由
 *  unwrapTauriEventPayload 在本缝解掉。成功返回 unlisten（内部再 invoke
 *  plugin:event|unlisten，失败静默）；桥缺失、transformCallback 缺失、
 *  listen 抛错 → null（浏览器=无跨窗，静默降级）。
 *  注意 eventId 是 listen 的返回值，不是 transformCallback 的回调 id。 */
/** ω99-287: #2 — 可选 target 参数（tauri EventTarget 的 serde 形
 * `#[serde(tag="kind")]`：{"kind":"Any"} / {"kind":"Window","label":…}）。
 * 缺省 Any 与既有调用逐字节同形；关窗分叉传 Window 名 target——tauri 的
 * CloseRequested 自动 prevent 只认窗名 target 的监听（has_js_listener），
 * Any 监听收得到事件但不改默认关闭。 */
export async function tauriListenEvent(
  event: string,
  handler: (payload: unknown) => void,
  target: { kind: "Any" } | { kind: "Window"; label: string } = { kind: "Any" },
): Promise<(() => void) | null> {
  const w = window as TauriWindow;
  const internals = w.__TAURI_INTERNALS__;
  const transform = internals?.transformCallback;
  const invoke = resolveTauriInvoke();
  if (!invoke || !internals || typeof transform !== "function") return null;
  let eventId: unknown;
  try {
    // transformCallback 注册原生回调并返回其 u32 id，只随 internals 注入；
    // 注册的是解包适配器，消费者 handler 永远只拿 payload（ω99-107）。
    const handlerId = (transform as (cb: (payload: unknown) => void) => number).call(
      internals,
      (raw: unknown) => handler(unwrapTauriEventPayload(raw)),
    );
    eventId = await invoke("plugin:event|listen", { event, target, handler: handlerId });
  } catch {
    return null;
  }
  return () => {
    void invoke("plugin:event|unlisten", { event, eventId }).catch(() => {});
  };
}

/** 把本窗口提到前台（plugin:window|set_focus）；非 Tauri / 拒绝 → false。
 *  D8 纪律：仅用户主动点击后调用（意图确认），不做后台抢焦点。 */
export async function tauriFocusWindow(): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke("plugin:window|set_focus");
    return true;
  } catch {
    return false;
  }
}

// --- ω99-104 自定义 app command 缝 ------------------------------------------
// 非 plugin 前缀的命令名（read_dropped_file 这类 Rust 侧 generate_handler
// 注册的命令）：同一条 invoke 桥、同一套纪律——桥缺失/抛错 → null，调用
// 方窄化失败即走自己的放弃路径，浏览器绝不抛。返回值原样透传。

/** 自定义 app command invoke；非 Tauri / 拒绝 → null。 */
export async function tauriInvokeCommand(cmd: string, args?: unknown): Promise<unknown | null> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return null;
  try {
    return await invoke(cmd, args);
  } catch {
    return null;
  }
}

/** ω99-155: markdown 链接外开（桌面 open_url 命令——scheme 白名单在 Rust
 *  侧 open_url_gate）；非 Tauri 或失败 → false（调用方浏览器回退）。 */
export async function tauriOpenUrl(url: string): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try { await invoke("open_url", { url }); return true; } catch { return false; }
}

/** 117 玻璃化：窗口主题随 CSS 主题联动（plugin:window|set_theme）。探针
 *  117 P2 真机定谳：vibrancy 材质的明暗随窗口主题当场翻转（state:"active"
 *  只是不随失焦压暗，明暗仍跟 theme）——所以 CSS data-theme 切换必须在
 *  同一动作里拨窗口主题，否则浅色页面压暗玻璃是可读性事故。命令形状按
 *  tauri-2.11.5 window/plugin.rs 的 setter!(set_theme, Option<Theme>)：
 *  参数名 value，"dark"|"light"（serde 小写）；label 缺省 = 当前窗口
 *  （与 start_dragging 同一约定，workspace-* 子窗各拨各的）。权限位
 *  core:window:allow-set-theme 在 main-capability。非 Tauri / 拒绝 →
 *  false（浏览器 = 无窗口材质，纯 CSS 主题本就自洽）。 */
export async function tauriSetWindowTheme(theme: "dark" | "light"): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke("plugin:window|set_theme", { value: theme });
    return true;
  } catch {
    return false;
  }
}
