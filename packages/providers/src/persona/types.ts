// packages/providers/src/persona/types.ts
export type ProtocolId = "openai-chat" | "anthropic" | "responses";

export interface LayerFlags {
  readonly headers: boolean;
  readonly body: boolean;
  readonly prompt: boolean;
}

export interface PersonaSource {
  readonly kind: "workspace-source" | "external-research";
  readonly provenance: string;
  readonly pinnedVersion: string;
}

export interface SystemStyle {
  readonly mode: "snapshot" | "prefix";
  readonly text: string;
}

export interface PromptStyle {
  readonly system?: SystemStyle;
  /** 我们的工具名 → 客户端显示名。decorator 双向映射（出向改名，入向逆映射 tool_calls）。 */
  readonly toolNameMap?: Readonly<Record<string, string>>;
}

/** 声明式请求体叠加——键必须 ⊆ 该协议白名单（schema.ts），persona 是数据不是代码。 */
export type BodyStyleOverlay = Readonly<Record<string, unknown>>;

export interface PersonaDefinition {
  readonly id: string;                       // kebab-case，注册表主键
  readonly displayName: string;
  readonly source: PersonaSource;
  /** 未提供时默认 { headers: true, body: true, prompt: false }。 */
  readonly defaultLayers?: Partial<LayerFlags>;
  readonly headers: Partial<Record<ProtocolId, Readonly<Record<string, string>>>>;
  readonly body?: Partial<Record<ProtocolId, BodyStyleOverlay>>;
  readonly prompt?: PromptStyle;
  readonly confidence?: "byte-verified" | "community-reverse-engineered";
}

export interface ResolvedPersona {
  readonly definition: PersonaDefinition;
  readonly layers: LayerFlags;
}
