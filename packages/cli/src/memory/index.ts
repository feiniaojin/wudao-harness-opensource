// M49 §1/§2 — the memory subsystem's public seam (also exported as the
// `wudao-harness/memory` package subpath for evals). Storage: append-only
// `.wudao/memory.jsonl`; writes pass the assessment gate; recall is bounded
// and rides the MetaNote channel; the background review fork (§2) turns a
// settled run into ≤3 assessed suggestions.
export {
  openMemoryStore,
  openSessionMemoryStore,
  setSessionMemorySettings,
  memoryStorePath,
  assessMemoryWrite,
  CREDENTIAL_RE,
  MEMORY_MAX_CONTENT_CHARS,
  MEMORY_NOVELTY_JACCARD,
  // 借鉴弧 C2（a reference project C4）：盲 held-out 的精化入口标记（refine/dream 过滤）。
  HELDOUT_MEMORY_TAG,
  isHeldOutEntry,
} from "./store.js";
export type { MemoryStore, MemoryEntry, MemoryKind, MemoryScope, MemoryWriteInput, MemoryWriteResult, MemoryAssessment } from "./store.js";
// 永续迭代 v6 · reef 借鉴弧 A（digest C3）——学习入口防污染三件套：nonce 围栏
// （dream/refine 嵌入面）、凭据值/指令覆盖双正则块档门（store 写入汇聚点）、
// 有界拦截台账（可见，绝不静默丢）。比较裁决与设计纪律见 guard.ts 头注。
export {
  BLOCKED_LEDGER_FILE,
  BLOCKED_LEDGER_MAX,
  blockedLedgerPathFor,
  blockedLearningCountAt,
  fenceUntrusted,
  fenceMarkers,
  freshFenceNonce,
  CREDENTIAL_VALUE_RE,
  DIRECTIVE_RE,
  screenLearningInput,
  redactSecretShaped,
  readBlockedLearningAt,
  appendBlockedLearningAt,
  buildBlockedRecord,
  blockedLearningHint,
} from "./guard.js";
export type { LearningScreen, LearningSource, BlockedLearningRecord } from "./guard.js";
export { recallMemories, formatPendingReview, escapeRecallField, RECALL_MAX_ITEMS, RECALL_MAX_CHARS, RECALL_LEAD, RECALL_POOL_CAP, RECALL_STALENESS_NOTE, memoryAgeDays, memoryAgeLabel } from "./recall.js";
export type { RecallInput, RecallResult } from "./recall.js";
export { createMemoryWriteTool, createMemorySearchTool, createMemoryTools } from "./tools.js";
export { runMemoryCommand, surfacePendingReview, formatMemoryList, createMemoryRuntime } from "./commands.js";
export { spawnBackgroundReview, backgroundReviewEnabled, REVIEW_PROMPT, REVIEW_MAX_TURNS, REVIEW_MIN_TOOL_CALLS, REVIEW_ROLE_ID } from "./review.js";
export type { BackgroundReviewSpawn, BackgroundReviewOptions } from "./review.js";
// 记忆两库收敛（docs/specs/memory-system.md 实施裁决的后续弧）：M49 存量
// 一次性迁移 + dream/refine 调度停用门（WUDAO_M49_LEGACY=1 回滚态）。
export { migrateLegacyMemory, legacyMemoryMigrated, legacyMemoryMigrationMarker, legacyMemorySchedulingEnabled } from "./migrate.js";
// ω-4f (design 84): Dream memory consolidation — stage 2 (ledger→curated
// ledger) of the two-stage composition over the review fork's stage 1.
export { memoryDirectory } from "./store.js";
export {
  DREAM_ROLE_ID,
  DREAM_SYSTEM_PROMPT,
  DREAM_PROMPT,
  DREAM_TOOL_NAMES,
  DREAM_MAX_TURNS,
  DREAM_TIMEOUT_MS,
  DREAM_BATCH_MAX_ENTRIES,
  DREAM_EMBED_MAX_CHARS,
  DREAM_EMBED_ENTRY_CHARS,
  DREAM_MIN_UNPROCESSED,
  DREAM_MIN_INTERVAL_MS,
  dreamCursorPath,
  dreamAuditPath,
  readDreamCursor,
  writeDreamCursor,
  dreamEnabled,
  dreamDue,
  dreamUnprocessedCount,
  renderDreamLedgerEmbed,
  buildDreamPrompt,
  spawnDreamRun,
  runDreamVerb,
  appendDreamAudit,
  readDreamAudit,
} from "./dream.js";
export type { DreamCursor, DreamPrompt, DreamPromptInput, DreamOptions, DreamSpawn, DreamAuditRecord } from "./dream.js";
// ω99-3a (Continual Harness stage 1): /refine — the on-demand, current-
// session, evidence-carrying refiner over the version-extended store.
export {
  REFINE_SYSTEM_PROMPT,
  REFINE_TRAJECTORY_CHARS,
  REFINE_MAX_EDITS,
  REFINE_REJECTED_SUMMARY,
  extractProposalJson,
  validateProposal,
  renderRefineOverview,
  serializeTrajectory,
  planRefinement,
  applyRefinement,
  runRefineCommand,
} from "./refine.js";
export type { RefineContext, ProposedEdit, RefineProposal, ValidatedProposal } from "./refine.js";
// ω99-7 (自进化二期): auto-refine — the automatic trigger layer over /refine
// (two-level trigger + cheap JSON gate; default OFF via refine.auto.enabled).
export {
  AUTO_REFINE_GATE_SYSTEM_PROMPT,
  shouldTriggerAutoRefine,
  countAssistantTurns,
  reviewAutoRefineGate,
  createAutoRefineRuntime,
  observeAutoRefineOnHooks,
  refineAutoRuntimeFor,
  resetRefineAutoRuntimeCache,
} from "./auto-refine.js";
export type {
  AutoRefineTriggerReason,
  AutoRefineDecision,
  AutoRefineDecisionInput,
  AutoRefineGateVerdict,
  AutoRefineSnapshot,
  AutoRefineRuntime,
  AutoRefineDeps,
} from "./auto-refine.js";
export {
  refinementsPath,
  refinementsPathFor,
  appendRefinementAudit,
  appendRefinementAuditAt,
  readRefinementAudit,
  readRefinementAuditAt,
} from "./refinements.js";
export type { RefineEdit, RefinementAuditLine } from "./refinements.js";
