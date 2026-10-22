// M79 §3 — per-model input-modality metadata. Capability is EXACT MODEL
// METADATA, never a provider-level fact (research 40 §1): an uncataloged
// model — including every text-only default and any custom endpoint name —
// resolves to ['text'], so images addressed at it fail closed with
// UNSUPPORTED_CONTENT before any network call. An explicit ProviderConfig
// pin (inputModalities) beats the catalog: a custom OpenAI-compatible
// endpoint fronting a vision model can declare itself precisely.

export type InputModality = "text" | "image";

/** What one cataloged model accepts as request content. */
export interface ModelDescriptor {
  readonly inputModalities: readonly InputModality[];
}

const TEXT_ONLY: readonly InputModality[] = ["text"];
const TEXT_AND_IMAGE: readonly InputModality[] = ["text", "image"];

/** Exact-name catalog entries (checked before the family prefixes). */
const KNOWN_VISION_MODELS: Readonly<Record<string, readonly InputModality[]>> = {
  // GLM-4V line (zhipu bigmodel OpenAI-compatible endpoint).
  "glm-4v": TEXT_AND_IMAGE,
  "glm-4v-plus": TEXT_AND_IMAGE,
  "glm-4v-flash": TEXT_AND_IMAGE,
  "glm-4v-plus-0111": TEXT_AND_IMAGE,
  // Qwen-VL line (dashscope compatible-mode).
  "qwen-vl-plus": TEXT_AND_IMAGE,
  "qwen-vl-max": TEXT_AND_IMAGE,
  "qwen-vl-ocr": TEXT_AND_IMAGE,
};

/** Versioned family prefixes: `glm-4v…`, `glm-4.1v…`, `glm-4.5v…` and the
 *  qwen `vl`/`omni`/`qvq` lines (e.g. `qwen2.5-vl-72b-instruct`,
 *  `qwen3-vl-plus`, `qwen2.5-omni-7b`). A prefix that later gains a text-only
 *  sibling gets an exact-name entry above, which wins. */
const VISION_MODEL_PREFIXES: readonly RegExp[] = [
  /^glm-[\d.]+v/, // glm-4v / glm-4.1v / glm-4.5v families
  /^qwen[\d.]*-vl/, // qwen-vl / qwen2-vl / qwen2.5-vl / qwen3-vl
  /^qwen[\d.]*-omni/, // omni variants take image input
  /^qvq/, // QVQ vision-reasoning line
];

/** The input modalities one model accepts. Uncataloged → ['text']
 *  (fail-closed default; the provider adapter refuses images for it). */
export function modelInputModalities(model: string): readonly InputModality[] {
  const name = model.trim().toLowerCase();
  const exact = KNOWN_VISION_MODELS[name];
  if (exact !== undefined) return exact;
  if (VISION_MODEL_PREFIXES.some((re) => re.test(name))) return TEXT_AND_IMAGE;
  return TEXT_ONLY;
}

/** The descriptor lookup for a config: an explicit pin beats the catalog,
 *  the catalog beats the text-only default. */
export function resolveInputModalities(config: { readonly model: string; readonly inputModalities?: readonly InputModality[] }): readonly InputModality[] {
  if (config.inputModalities !== undefined && config.inputModalities.length > 0) {
    return config.inputModalities;
  }
  return modelInputModalities(config.model);
}

/** Convenience for callers that only gate images. */
export function modelAcceptsImages(config: { readonly model: string; readonly inputModalities?: readonly InputModality[] }): boolean {
  return resolveInputModalities(config).includes("image");
}
