// packages/providers/src/persona/builtins.ts
// The five v1 builtin personas, transcribed from doc 90
// (internal doc 90) — the sole data source.
// Discipline: every value traces to a doc 90 row (file:line provenance kept
// inline as `// doc90:` comments); keys not settled by doc 90 are NOT written
// (Partial semantics = no-op). Conditional rows (doc 90 "Task 4 使用注意" #2)
// are omitted unless a persona-semantic constant is pinned.
import type { PersonaDefinition } from "./types.js";

export const BUILTIN_PERSONAS: readonly PersonaDefinition[] = [
  {
    // doc90 §1 (anthropic-protocol reference snapshot, 2026-08)
    id: "anthropic-cli",
    displayName: "Anthropic CLI",
    source: {
      kind: "workspace-source",
      provenance:
        "doc90 §1 (the anthropic-protocol reference source): headers http.ts:34 + services/api/client.ts:106-108; betas constants/betas.ts:3; prompt constants/system.ts:10. Anthropic Messages protocol only — openai-chat/responses undefined ⇒ byte-identical on those wires.",
      pinnedVersion: "reference snapshot a8a678cb (2026-08); upstream client 2.1.88",
    },
    confidence: "byte-verified",
    headers: {
      anthropic: {
        // 恒发 (SDK defaultHeaders). doc90 §1.1 rows 1/3.
        // doc90 §1.1: utils/http.ts:34 getUserAgent() — 求值形 (pinned build):
        // ${MACRO.VERSION}→钉定 npm 2.1.88; USER_TYPE→external (npm 发行,'ant' 为
        // Anthropic 员工环境); 入口缺省 cli; agent-sdk/client-app/workload 后缀在
        // 普通 CLI 运行下为空。模板原文会把未解析的 ${…} 发上线 — 按 UA 白名单
        // 认编程工具的供应商直接拒收 (用户反馈 2026-08-31, kimi 后台显示模板原文),
        // persona 等于不可用,故钉定求值常量。
        "user-agent": "wudao-harness/2.1.88 (external, cli)",
        "anthropic-version": "2023-06-01", // doc90 §1.1: 恒发, codeSessionApi.ts:16 等
        "x-app": "cli", // doc90 §1.1: client.ts:106, 恒发
        "X-Claude-Code-Session-Id": "{{sessionId}}", // doc90 §1.1: client.ts:108, 会话 UUID 恒发
        "anthropic-beta": "claude-code-20250219", // doc90 §1.1 beta 表: 非 haiku 模型恒发 (betas.ts:3); 其余 beta 均条件发,不编码
      },
      // Conditional rows omitted: x-claude-remote-container-id / -remote-session-id /
      // x-client-app / x-anthropic-additional-protection / x-client-request-id, and the
      // model/identity-conditional betas (doc90 §1.1). Authorization / x-api-key are
      // auth headers — never persona-controlled (schema). The x-anthropic-billing-header
      // row is a system-prompt first block, NOT an HTTP header (doc90 §1.3), and its
      // fingerprint component is unpinned ⇒ not transcribed.
    },
    // body: none. doc90 §1.2 rows are wire-mechanical (stream/model/messages/system/
    // tools), runtime-valued (max_tokens), identity-bound (metadata.user_id) or
    // conditional (temperature 仅 thinking 禁用; thinking 仅模型支持且未禁用 — and a
    // partial `thinking` overlay would one-level-merge into an invalid hybrid).
    prompt: {
      system: {
        mode: "prefix", // billing 首块与各 section 未整体钉定,prefix 携带字节稳定头部
        text: "You are Anthropic CLI, Anthropic's official CLI agent.", // doc90 §1.3: constants/system.ts:10 (交互主前缀)
      },
    },
  },
  {
    // doc90 §2 (responses-protocol reference clone @ 51ebf5b1)
    id: "openai-responses",
    displayName: "OpenAI Responses",
    source: {
      kind: "workspace-source",
      provenance:
        "doc90 §2 (responses-protocol reference): originator (auth default client); session-id (request headers); store (client); instructions (base prompts). OpenAI Responses protocol only.",
      pinnedVersion: "responses-protocol reference HEAD 51ebf5b1 (2026-08-21); version 0.0.0 (rolling dev)",
    },
    confidence: "byte-verified",
    headers: {
      responses: {
        originator: "wudao_harness", // doc90 §2.1: DEFAULT_ORIGINATOR (default_client.rs:40), 进程级 default_headers 恒发
        "session-id": "{{sessionId}}", // doc90 §2.1: build_session_headers (headers.rs:5-13), Responses 请求恒发 — 连字符头名,brief 草图的 session_id 以 doc90+源码为准
        // doc90 §2.1: the originator user-agent builder (default client) — 求值形:
        // originator/version 用钉定值 (workspace 0.0.0); os/arch/terminal 段为运行
        // 机器值 (os_info::os_type()/version()/architecture() + terminal-detection
        // user_agent_token),无 slot 可解析 — 钉定为常见 macOS/Apple Silicon 形
        // ("Mac OS"/arm64 即 os_info 在 macOS 的取值,Apple_Terminal 为终端名回退
        // token 形)。原模板 ${…} 占位与 anthropic-cli UA 同病:按 UA 认工具的供应商
        // 拒收 (2026-08-31),求值常量才可上线。
        "User-Agent": "wudao_harness/0.0.0 (Mac OS 15.5; arm64) Apple_Terminal",
      },
      // Omitted: thread-id (no v1 slot), installation-id / beta-features /
      // turn-state / routing-hint, attestation, residency / responses-lite —
      // all conditional or runtime-valued (doc90 §2.1).
    },
    body: {
      responses: {
        store: false, // doc90 §2.2: 恒发 (core/src/client.rs:946)
        // reasoning 恒发但其字段 (effort/summary/context) 均配置决定,值未钉定 ⇒ 不写。
        // instructions 走 prompt 层(见下),不作为 body 常量。
      },
    },
    prompt: {
      system: {
        mode: "prefix", // default.md 仅钉定开头段("+能力清单等"未转录),snapshot 会断言不完整文本
        text: "You are a coding agent running in a terminal-based coding assistant powered by the OpenAI Responses API. You are expected to be precise, safe, and helpful.", // doc90 §2.3: base_instructions/default.md:1
      },
    },
  },
  {
    // doc90 §5 (closed-source; community reverse engineering read 2026-08-23)
    id: "cursor",
    displayName: "Cursor",
    source: {
      kind: "external-research",
      provenance:
        "doc90 §5 (community-reverse-engineered; sources S1 eisbaw/cursor_api_demo, S2 dcrebbin/cursor-unchained, S3 xwartz/cursor-api, read 2026-08-23). Headers: only the S1+S2(+S3) cross-confirmed, non-auth subset; 12 single-source-flagged rows (x-client-key, x-ghost-mode, x-cursor-config-version, x-cursor-timezone, client os/arch/os-version triple, x-cursor-client-device-type, x-new-onboarding-completed, x-amzn-trace-id, x-conversation-id, x-cursor-streaming, user-agent connect-es/1.6.1, connect-content-encoding) intentionally omitted — schema has no per-header single-source flag. x-cursor-checksum needs machine identity (no slot); content-type application/connect+proto would corrupt an openai-chat JSON wire. Wire is Connect-RPC/protobuf (doc90 使用注意 #1) — placed under openai-chat as the nearest supported protocol; body/prompt not mappable, prompt 未定 (doc90 §5.3).",
      pinnedVersion: "closed-source; community reverse-engineering read 2026-08-23; target Cursor IDE v2.6.22 (per doc90 钉定版本表)",
    },
    confidence: "community-reverse-engineered",
    headers: {
      "openai-chat": {
        "connect-protocol-version": "1", // doc90 §5.1: S1+S2
        "connect-accept-encoding": "gzip", // doc90 §5.1: S1+S2
        "x-cursor-client-version": "2.6.22", // doc90 §5.1 (S1+S2) + 钉定版本表: 逆向目标 v2.6.22
        "x-cursor-client-type": "ide", // doc90 §5.1: S1+S2
        "x-session-id": "{{sessionId}}", // doc90 §5.1: S1+S2 (会话 id)
        "x-request-id": "{{uuid}}", // doc90 §5.1: S1+S2 (随机 UUID)
      },
    },
    // no body (protobuf transport, nothing mappable) and NO prompt (doc90 §5.3: 未定 — never guess)
  },
  {
    // doc90 §4 (multi-protocol reference snapshot 2026-08) — multi-protocol
    id: "multi-wire",
    displayName: "multi-wire",
    source: {
      kind: "workspace-source",
      provenance:
        "doc90 §4 (the multi-protocol reference): session headers core/src/session/runner/llm.ts:209-211 (每个 LLM 请求恒发,协议无关); anthropic-beta core/src/plugin/provider/anthropic.ts:13-14; store=false packages/llm/src/protocols/openai-responses.ts:990-991,1017-1019 (route 级默认); prompt core/src/plugin/agent.ts:12-13 (BUILD_SYSTEM).",
      pinnedVersion: "multi-protocol reference snapshot 3a31c4ea (2026-08-22)",
    },
    confidence: "byte-verified",
    headers: {
      anthropic: {
        "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14", // doc90 §4.1: @ai-sdk/anthropic provider 恒发
        "x-session-affinity": "{{sessionId}}", // doc90 §4.1: llm.ts:209
        "X-Session-Id": "{{sessionId}}", // doc90 §4.1: llm.ts:210
      },
      responses: {
        "x-session-affinity": "{{sessionId}}", // doc90 §4.1: 协议无关恒发
        "X-Session-Id": "{{sessionId}}",
      },
      "openai-chat": {
        "x-session-affinity": "{{sessionId}}", // doc90 §4.1: 协议无关恒发
        "X-Session-Id": "{{sessionId}}",
      },
      // Omitted: x-parent-session-id (仅子会话), User-Agent rows (OAuth/metadata/plugin
      // 路径,非 LLM chat 请求路径), provider 级配置驱动头 (doc90 §4.1)。
    },
    body: {
      responses: {
        store: false, // doc90 §4.2: openai-responses 两条 route 的恒定默认
        // openai-chat 的 reasoningEffort 'medium' 未编码: 源码中为 gpt-5 模型族门控
        // (openai-options.ts:48-51),非该协议无条件默认 — 静态 persona 常量会偏离
        // 真实客户端行为。promptCacheKey 不在 v1 responses 白名单。
      },
    },
    prompt: {
      system: {
        mode: "prefix", // 组装序 [agent.system, baseline] (llm.ts:221-226): agent 段领头
        text: "You are an AI coding agent. Help the user accomplish software engineering tasks by inspecting the workspace, making targeted changes, and using tools according to the configured permissions.", // doc90 §4.3: BUILD_SYSTEM (agent.ts:12-13)
      },
    },
  },
  {
    // doc90 §3 (openai-chat reference @ b150a551, snapshot 2026-08)
    id: "deepseek-native",
    displayName: "DeepSeek Native",
    source: {
      kind: "workspace-source",
      provenance:
        "doc90 §3 (openai-chat reference): attribution user-agent (版本取自包清单); session 头 (llm adapter); 身份段 system-prompt index.ts:358-363 (harness:identity, order -100). OpenAI 兼容 chat-completions 协议 (relay 场景)。",
      pinnedVersion: "openai-chat reference snapshot b150a551 (2026-08)",
    },
    confidence: "byte-verified",
    headers: {
      "openai-chat": {
        "user-agent": "wudao-harness/0.4.20 (+https://github.com/feiniaojin/wudao-harness-opensource)", // doc90 §3.1: attribution 恒发不可关闭; 版本=本 harness 版本
        "x-deepseek-harness-session-id": "{{sessionId}}", // doc90 §3.1: adapter.ts:526-528 (sessionId 存在时; v1 槽位语义=必须提供,见 task-4 report)
        // Omitted: authorization (auth — schema 拒绝), content-type/accept (传输机械头,
        // 适配器自管), x-deepseek-harness-user-id (稳定匿名用户 id,无忠实槽位 — {{uuid}}
        // 为逐请求随机,语义不符), x-deepseek-harness-compact (仅 compaction)。
      },
    },
    // no body: thinking (§3.2 该参考的签名开关) 不在 v1 openai-chat 白名单 — 冲突已披露,
    // 不强行写入; reasoning_effort 值(low/high/max)配置驱动未钉定; temperature/max_tokens/
    // stop 为透传可选。
    prompt: {
      system: {
        mode: "prefix", // harness:identity order -100 = system 首段
        text: "You are an AI agent powered by wudao-harness.", // doc90 §3.3: index.ts:361
      },
    },
  },
];
