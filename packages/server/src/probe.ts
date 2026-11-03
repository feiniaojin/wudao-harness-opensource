// PB-2（探针基础设施弧）— server 侧探针遥测车道：宿主 ProbeBus 的 WS 中继。
// 结构化注入如 petDriver/recovery（本包不 import core，工作区图保持无环——
// PB-1 落地 core 的 ProbeBus 天然满足 UiProbeBusPort，形状由本包孪生测试钉）。
// 三个读面 op（全部 never vaulted——不进 vault 不重放，ω99-260 memoryList 读表
// 先例）：
//   probeStream  {cat?}        订阅：其后每条匹配事件转发一帧 {t:"probe",event}
//                              （139：cat:"off" 退订——仪表盘关页停流）
//   probeEnable  {on}          139：运行时翻转探针总闸（WUDAO_PROBE）
//   probeRecent  {cat?,limit?} 拉环形缓冲（recent 同形直通）
//   probeStats   {}            拉统计面（stats 原样回）
// 缺省纪律（缺省零变化）：未挂 bus → 三 op 干净拒答（optional-ops 既有文案族）、
// 零 probe 帧、零订阅副作用；挂了 bus 但客户端未 probeStream → 同样零帧（订阅
// 门在 relay 内，emit 永不主动上链）。UI 主车道消费：probe 帧走既有单连接（单
// 连接车道寻址先例），绝不另开 WS。

/** 探针类别（PB-1 的 cat 域，单一来源）。 */
export const PROBE_CATS = ["model", "tool", "ui", "system", "agent"] as const;
export type ProbeCat = (typeof PROBE_CATS)[number];

/** 一条探针事件（PB-1 ProbeEvent 的 wire 镜像——结构端口，不 import core）。
 *  `data` 是探针自带的自由负载（JSON 可序列化），server 原样中继。 */
export interface ProbeEventWire {
  readonly ts: number;
  readonly cat: ProbeCat;
  readonly name: string;
  readonly sessionId?: string;
  readonly lane?: string;
  readonly data: Record<string, unknown>;
  readonly dur?: number;
}

/** 宿主挂载的探针 bus 面（PB-1 ProbeBus 的结构镜像；stats 按 name 计数——
 *  {count, lastTs}，与探针名一对一）。 */
export interface UiProbeBusPort {
  emit(e: ProbeEventWire): void;
  subscribe(cat: ProbeCat | "*", cb: (e: ProbeEventWire) => void): () => void;
  recent(cat?: string, limit?: number): readonly ProbeEventWire[];
  stats(): Record<string, { count: number; lastTs: number }>;
}

/** probeRecent 的 limit 帽（环形缓冲同量级；防一帧拉 O(∞) 的形状门）。 */
export const PROBE_RECENT_LIMIT_CAP = 1000;

export interface ProbeRelay {
  /** 三个 probe op 的统一入口（index.ts 的 switch case 直递；未知 op 名不
   *  进来——dispatch 已按 case 名收敛）。 */
  handleOp(o: Record<string, unknown>, reply: (ok: unknown, err?: string) => void): void;
  /** 退订（server.close 时调用；未挂 bus 为 no-op）。 */
  close(): void;
}

export function createProbeRelay(opts: {
  readonly bus: UiProbeBusPort | undefined;
  readonly send: (frame: unknown) => void;
}): ProbeRelay {
  const { bus, send } = opts;
  // 订阅门：null=未订阅（零帧）；cat=undefined=订阅全部类别；其余=单类别过滤。
  // v1-A 单客户端：一个过滤槽足够；重发 probeStream 即换槽（幂等语义，最后
  // 一次为准）。断线重连不重置——send 已按已认证槽位门控，无槽=零帧落地。
  let filter: { readonly cat: ProbeCat | undefined } | null = null;
  const unsubscribe = bus?.subscribe("*", (event) => {
    if (filter !== null && (filter.cat === undefined || filter.cat === event.cat)) {
      send({ t: "probe", event });
    }
  });
  const isCat = (v: string): v is ProbeCat => (PROBE_CATS as readonly string[]).includes(v);
  return {
    handleOp(o, reply) {
      if (bus === undefined) {
        reply(undefined, "probe not supported by this server");
        return;
      }
      switch (o.op) {
        case "probeStream": {
          // cat 缺省=全部；"*" 同义（subscribe 域）；"off" 退订（139 仪表盘
          // 关页即停流——单过滤槽无独立 unsubscribe，语义走换槽）；其余串拒。
          if (o.cat !== undefined && o.cat !== "*" && o.cat !== "off" && (typeof o.cat !== "string" || !isCat(o.cat))) {
            reply(undefined, `probeStream cat must be one of ${PROBE_CATS.join("|")}|*|off when present`);
            return;
          }
          if (o.cat === "off") {
            filter = null;
            reply(true);
            return;
          }
          const cat = typeof o.cat === "string" && o.cat !== "*" ? (o.cat as ProbeCat) : undefined;
          filter = { cat };
          reply(true);
          return;
        }
        case "probeEnable": {
          // 139（用户令：默认仪表盘实时采集探针）：运行时翻转探针总闸——
          // probeEnabled() 逐调用读环境（probe.ts §3），翻 process.env 即全
          // 部挂载点即时生效。loop 挂载（agent.* 与 tool.*）按 run 重裹，下一
          // run 起可见；model.call 的包装在 provider 工厂构造时一次成形，
          // 运行时开闸对它不追溯（回执字段说明，前端照实提示）。
          if (typeof o.on !== "boolean") {
            reply(undefined, "probeEnable on must be a boolean");
            return;
          }
          if (o.on) process.env.WUDAO_PROBE = "on";
          else delete process.env.WUDAO_PROBE;
          reply({ enabled: o.on, modelCallNeedsRestart: true });
          return;
        }
        case "probeRecent": {
          if (o.cat !== undefined && o.cat !== "*" && (typeof o.cat !== "string" || !isCat(o.cat))) {
            reply(undefined, `probeRecent cat must be one of ${PROBE_CATS.join("|")}|* when present`);
            return;
          }
          if (o.limit !== undefined &&
              (typeof o.limit !== "number" || !Number.isInteger(o.limit) || o.limit < 1 || o.limit > PROBE_RECENT_LIMIT_CAP)) {
            reply(undefined, `probeRecent limit must be an integer 1..${PROBE_RECENT_LIMIT_CAP} when present`);
            return;
          }
          const cat = typeof o.cat === "string" && o.cat !== "*" ? o.cat : undefined;
          reply(bus.recent(cat, typeof o.limit === "number" ? o.limit : undefined));
          return;
        }
        case "probeStats":
          reply(bus.stats());
          return;
        default:
          reply(undefined, `unknown op: ${String(o.op)}`);
      }
    },
    close: () => unsubscribe?.(),
  };
}
