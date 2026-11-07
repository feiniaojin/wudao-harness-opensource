// 压缩的「保前段 + 按未来占用定深度」策略（2026-11-06 KV 缓存弧）。
//
// 为什么需要它：压缩是唯一必须改写历史的地方，而前缀缓存是**头锚定**的——
// 改写点之前逐字节相同才命中。此前的实现只保留尾部 keepRecent 条、把最旧的
// 消息压掉，等于从消息列表**最靠前的位置**就分叉：系统提示词之后的所有历史
// 全部掉出缓存。
//
// 两件事：
//
//   ① **保前段（headKeep）**。开头那一段（任务原话 + 最初的探索）一旦进了
//      摘要就永久丢失，而且它恰好是最值钱的缓存前缀。保留它同时赢两件事：
//      改写点往后挪（缓存多命中一截），任务原话原样在场（质量）。
//      被缓存的前缀 token 大约只花 1/10 的钱，所以「留着」通常比「删掉再
//      重算」更便宜。
//
//   ② **按未来占用定深度**。压到「够撑完未来 N 轮」为止，而不是压到「当前
//      占用回到某个水位」。理由：每一次压缩都是一次**冷轮**（改写点后全部
//      重算），所以真正的成本是**压缩次数**。压太浅 → 很快又要压一次 → 又
//      一次冷轮。压够一个视野，比压到水位线更省。
//
// 没有任何旋钮：阈值是常量，行为是确定的。不行就整体回滚，不做配置开关。
import type { AgentMessage } from "./types.js";
import { estimateTokens } from "./compaction-estimation.js";

/** 采样窗口：用最近这么多条估「每轮占用」。 */
const SAMPLE_MESSAGES = 6;
/** 要撑过的轮数。与 keepRecent 的默认值同量级——压一次至少顶一段路。 */
const HORIZON_TURNS = 6;
/** 前段在「可保留预算」里的份额；其余留给尾部近轮。 */
const HEAD_SHARE = 0.35;
/** 前段最多吃掉可压区间的比例。绝对上限（HEAD_MAX_TOKENS）在小上下文里会
 *  把整个中段吞掉，导致「压缩」退化成「什么都不压」——必须同时受这条相对
 *  上限约束，保证中段始终有真正被压掉的部分。 */
const HEAD_MAX_FRACTION = 0.5;
/** 可压区间至少要这么大才值得保前段。压 3 条里保 2 条毫无意义——那只是把
 *  压缩本身变小，换来一次同样贵的冷轮。小对话保持历史行为，逐字节不变。 */
const MIN_COMPACTABLE_FOR_HEAD = 8;

export interface CompactionPlan {
  /** 从可压区间起点再往前冻结多少条（0 = 不额外保前段）。 */
  readonly headKeep: number;
  /** 尾部保留条数（>= 调用方给定的 keepRecent）。 */
  readonly tailKeep: number;
  /** 预估未来 HORIZON_TURNS 轮的 token 占用；深度决策的依据。 */
  readonly projectedTokens: number;
  /** 本次压缩需要挤掉的 token（0 = 还不到压的时候）。 */
  readonly shedTokens: number;
}

export interface CompactionPlanInput {
  /** 压缩后的目标水位（token）。调用方按自己的阈值算好传进来。 */
  readonly targetTokens: number;
  /** 调用方原本的尾部保留条数（默认 6）。 */
  readonly keepRecent?: number;
}

/** 消息段的 token 估算（系统提示词与工具不参与——这里只关心消息占用）。 */
function tokensOf(messages: readonly AgentMessage[]): number {
  return estimateTokens("", [], messages);
}

/**
 * 决定本次压缩保留多少、压多少。纯函数：同一输入恒定输出。
 *
 * 前段保留的边界是**确定性**的：从可压区间起点开始，按 token 预算吃下整段，
 * 但绝不会停在一条 assistant/tool 消息之后而没有对应的 user——配对完整性由
 * 调用方现有的 floorCutoff 纪律负责，这里只给条数。
 */
export function planCompaction(
  messages: readonly AgentMessage[],
  input: CompactionPlanInput,
): CompactionPlan {
  const keepRecent = input.keepRecent ?? SAMPLE_MESSAGES;
  const sample = messages.slice(Math.max(0, messages.length - keepRecent));
  const perTurn = sample.length > 0 ? tokensOf(sample) / sample.length : 0;
  const projectedTokens = Math.round(perTurn * HORIZON_TURNS);

  const totalTokens = tokensOf(messages);
  // 目标：压完之后的占用要能撑住下一个视野，所以目标里已经扣掉 projected。
  const wantAfter = Math.max(0, input.targetTokens - projectedTokens);
  const shedTokens = Math.max(0, Math.round(totalTokens - wantAfter));

  // ---- 尾部先定（前段的相对上限要参考它）----
  // 尾部至少保留调用方给的条数；但如果近几轮本身就吃掉超过半个视野，就把它
  // 压短一点——「近几段占用多的时候也要压缩」。守卫：收缩不能让可压区间消失，
  // 否则压缩就退化成「什么都不压」。
  let tailKeep = Math.min(keepRecent, messages.length);
  const tailTokens = tokensOf(messages.slice(Math.max(0, messages.length - tailKeep)));
  // 关闭开关：先只验证「保前段」单独的效果。
  // 小对话不做任何保留策略调整：那里 floorCutoff 的配对/未读保护才是主角，
  // 动边界只会与它打架。与保前段同一道门槛。
  const smallConversation = messages.length - tailKeep < MIN_COMPACTABLE_FOR_HEAD;
  if (!smallConversation && projectedTokens > 0 && tailTokens > projectedTokens / 2) {
    while (tailKeep > 2) {
      tailKeep -= 1;
      if (tokensOf(messages.slice(Math.max(0, messages.length - tailKeep))) <= projectedTokens / 2) break;
    }
    if (messages.length - tailKeep <= 1) tailKeep = Math.min(keepRecent, messages.length);
  }

  // ---- 保前段的预算（纯相对，不设绝对 token 上限）----
  // 两条约束同时生效：
  //   · 目标余额里分给前段的份额（wantAfter × HEAD_SHARE）——保前段不能挤掉
  //     本该留给未来几轮的空间，否则会逼出更频繁的压缩；
  //   · 可压区间的一半（compactableTokens × HEAD_MAX_FRACTION）——小上下文里
  //     前段会把整个中段吞掉，压缩就退化成空操作。
  // 两者都随窗口缩放，所以 200K 和 1M 的模型自动得到不同的前段预算。
  const compactableTokens = tokensOf(messages.slice(0, Math.max(0, messages.length - tailKeep)));
  const headBudget = Math.min(
    Math.max(0, Math.floor(wantAfter * HEAD_SHARE)),
    Math.floor(compactableTokens * HEAD_MAX_FRACTION),
  );
  let headKeep = 0;
  let headTokens = 0;
  const compactableCount = Math.max(0, messages.length - tailKeep);
  while (compactableCount >= MIN_COMPACTABLE_FOR_HEAD && headKeep < messages.length) {
    const t = tokensOf([messages[headKeep] as AgentMessage]);
    if (headTokens + t > headBudget) break;
    headTokens += t;
    headKeep += 1;
  }

  const maxHead = Math.max(0, messages.length - tailKeep);
  return {
    headKeep: Math.min(headKeep, maxHead),
    tailKeep,
    projectedTokens,
    shedTokens,
  };
}

/** 压完之后是否值得动手：需要挤掉的量至少要超过一条消息，否则纯亏一次冷轮。 */
export function worthCompacting(plan: CompactionPlan, minShedTokens = 512): boolean {
  return plan.shedTokens >= minShedTokens;
}
