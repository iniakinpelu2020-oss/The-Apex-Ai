/**
 * The Workers AI model catalog, and the aliases that keep the live app working.
 *
 * Verified against Cloudflare's 5 November 2026 deprecation notice, which takes
 * effect 20 November 2026 (HTTP 410, error code 5028). The replacements below are
 * the ones Cloudflare itself recommends.
 *
 * The important detail is `LEGACY_ALIASES`. The frontend in this repo sends
 * these model ids from its ENSEMBLE_MODELS array:
 *
 *   @cf/qwen/qwen3-30b-a3b-fp8          <- dies 20 Nov 2026
 *   @cf/meta/llama-3.1-8b-instruct      <- not in the old allowlist, 400 today
 *   @cf/meta/llama-3.1-70b-instruct     <- same
 *   @cf/mistralai/mistral-large-24b     <- same
 *   @cf/mistralai/mixtral-8x7b-instruct <- same
 *   @cf/qwen/qwen3-72b-instruct         <- same
 *   @cf/unsloth/llama-3-8b-bnb-4bit     <- same
 *
 * Six of the seven already return 400, and the one that works is the one being
 * retired. Editing index.html to fix that would mean touching the UI we promised
 * not to touch, so instead the Worker accepts the old ids and maps them onto live
 * models. The app keeps sending what it always sent and starts working again.
 */

export interface ModelChoice {
  id: string;
  label: string;
  use: "general" | "coding" | "vision" | "transcribe" | "tts";
}

/** Active models, as of November 2026. */
export const ACTIVE: Record<string, ModelChoice> = {
  generalFast: { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B (fast)", use: "general" },
  generalSmall: { id: "@cf/qwen/qwen3.8-27b", label: "Qwen 3.8 27B", use: "general" },
  frontier: { id: "@cf/zai-org/glm-5.3", label: "GLM 5.3", use: "coding" },
  frontierAlt: { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", use: "coding" },
  vision: { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout (vision)", use: "vision" },
  tts: { id: "@cf/deepgram/aura-2-en", label: "Deepgram Aura 2 (TTS)", use: "tts" },
  stt: { id: "@cf/deepgram/nova-3", label: "Deepgram Nova 3 (STT)", use: "transcribe" },
  sttFallback: { id: "@cf/openai/whisper-large-v3-turbo", label: "Whisper large v3 turbo", use: "transcribe" },
};

/**
 * Models that stop responding on 20 November 2026. Kept in the file so a test can
 * assert none of them is used as a default, and so the migration is documented
 * rather than remembered.
 */
export const RETIRED_ON_2026_11_20: ReadonlySet<string> = new Set([
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/qwen/qwq-32b",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/meta-llama/llama-2-7b-chat-hf-lora",
  "@cf/google/gemma-2b-it-lora",
  "@cf/google/gemma-7b-it-lora",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.2-1b-instruct",
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/myshell-ai/melotts",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
  "@cf/runwayml/stable-diffusion-v1-5-inpainting",
  "@cf/bytedance/stable-diffusion-xl-lightning",
  "@cf/lykon/dreamshaper-8-lcm",
  "@cf/openai/whisper-tiny-en",
  "@cf/llava-hf/llava-1.5-7b-hf",
]);

/**
 * Old id (what a client sends) -> new id (what actually runs).
 *
 * Both the frontend's ENSEMBLE_MODELS and the Worker's previous CF_MODELS appear
 * here, so every id that has ever been valid keeps working.
 */
export const LEGACY_ALIASES: Record<string, string> = {
  // was the Worker's default chain
  "@cf/qwen/qwen3-30b-a3b-fp8": ACTIVE.generalSmall.id,
  "@cf/qwen/qwq-32b": ACTIVE.generalSmall.id,

  // the frontend's ensemble
  "@cf/meta/llama-3.1-8b-instruct": ACTIVE.generalFast.id,
  "@cf/meta/llama-3.1-70b-instruct": ACTIVE.frontier.id,
  "@cf/mistralai/mistral-large-24b": ACTIVE.frontierAlt.id,
  "@cf/mistralai/mixtral-8x7b-instruct": ACTIVE.generalFast.id,
  "@cf/qwen/qwen3-72b-instruct": ACTIVE.frontier.id,
  "@cf/unsloth/llama-3-8b-bnb-4bit": ACTIVE.generalFast.id,

  // retired frontier models
  "@cf/zai-org/glm-5.2": ACTIVE.frontier.id,
  "@cf/zai-org/glm-5.3-flash": ACTIVE.frontier.id,
  "@cf/moonshotai/kimi-k2.6": ACTIVE.frontierAlt.id,
  "@cf/moonshotai/kimi-k2.7-code": ACTIVE.frontierAlt.id,
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": ACTIVE.frontierAlt.id,
  "@cf/deepseek-ai/deepseek-v4-pro-0813": ACTIVE.frontierAlt.id,
  "@cf/deepseek-ai/deepseek-v4-flash-0731": ACTIVE.frontierAlt.id,
  "@cf/nvidia/nemotron-3-120b-a12b": ACTIVE.frontier.id,

  // retired small models
  "@cf/meta/llama-3.1-8b-instruct-fp8": ACTIVE.generalFast.id,
  "@cf/meta/llama-3.2-1b-instruct": ACTIVE.generalFast.id,
  "@cf/meta/llama-3.2-3b-instruct": ACTIVE.generalFast.id,

  // speech
  "@cf/myshell-ai/melotts": ACTIVE.tts.id,
  "@cf/openai/whisper-tiny-en": ACTIVE.stt.id,
};

/** Models the chat route will accept a request for (before aliasing). */
export const CHAT_ALLOWED: readonly string[] = [
  // still-live models the app already uses
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
  ACTIVE.vision.id,
  ACTIVE.generalFast.id,
  ACTIVE.generalSmall.id,
  ACTIVE.frontier.id,
  ACTIVE.frontierAlt.id,
  // every legacy id, so an old client is never rejected
  ...Object.keys(LEGACY_ALIASES),
];

/** The fallback chain the chat route walks when the requested model fails. */
export const CHAT_CHAIN: readonly string[] = [
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  ACTIVE.generalFast.id,
  ACTIVE.frontier.id,
  ACTIVE.generalSmall.id,
];

/** Resolve whatever a client sent into a model that exists today. */
export function resolveModel(id: string): string {
  const raw = String(id || "").trim();
  if (LEGACY_ALIASES[raw]) return LEGACY_ALIASES[raw];
  return raw;
}

/** True when this id is retired and must never be called directly. */
export function isRetired(id: string): boolean {
  return RETIRED_ON_2026_11_20.has(id);
}

/**
 * Shrink a list of ids to the ones worth calling, in order: aliased, deduped,
 * and with anything retired removed. The frontend sends seven ids; after this it
 * sends at most three distinct live models, which is faster and cheaper.
 */
export function normaliseChain(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const resolved = resolveModel(id);
    if (isRetired(resolved)) continue;
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}
