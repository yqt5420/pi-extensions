/**
 * Vendor detection + reasoning compatibility heuristics for OpenAI-compatible
 * gateways (NewAPI / one-api / etc.).
 *
 * pi-ai's openai-completions provider is fully static-config driven: there is
 * no runtime response probing. The request-side behavior (whether to send
 * `reasoning_effort`, `thinking:{type:"enabled"}`, `enable_thinking`, etc.)
 * is decided entirely by `model.reasoning`, `model.thinkingLevelMap`, and
 * `model.compat.thinkingFormat`. The response-side is lenient: any of
 * `reasoning_content` / `reasoning` / `reasoning_text` is auto-consumed as a
 * thinking block, so gateways that transparently forward upstream fields just
 * work without extra config.
 *
 * This module inspects a model id and returns the vendor it most likely came
 * from, plus the compat hints that make pi-ai talk to that upstream correctly
 * when the request needs thinking controls.
 */

export type ThinkingFormat =
  | "deepseek"
  | "qwen"
  | "zai"
  | "openrouter"
  | "together"
  | "openai" // default: top-level reasoning_effort
  | undefined; // undefined => let pi-ai detectCompat default apply

export interface VendorCompat {
  /** Detected upstream vendor slug, for logging only. */
  vendor: string;
  /** Whether this model looks like a reasoning/thinking model. */
  reasoning: boolean;
  /** Suggested thinkingFormat to set on the model. */
  thinkingFormat?: ThinkingFormat;
  /** True for deepseek upstream: forces empty reasoning_content on history. */
  requiresReasoningContentOnAssistantMessages?: boolean;
  /** Some upstreams reject reasoning_effort; set false to suppress it. */
  supportsReasoningEffort?: boolean;
  /** Some upstreams only understand max_tokens (not max_completion_tokens). */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

interface Rule {
  /** Case-insensitive substring(s) that match the model id. */
  match: string | RegExp;
  vendor: string;
  reasoning: boolean;
  thinkingFormat?: ThinkingFormat;
  requiresReasoningContentOnAssistantMessages?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Default context window hint, used when pricing API gives nothing. */
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
}

/**
 * Rule table, ordered most-specific first. First match wins.
 *
 * These are based on the upstream model families commonly proxied through
 * NewAPI. When a gateway transparently forwards the upstream response,
 * pi-ai's lenient reasoning-field consumption handles thinking output even
 * without a perfect match; the rules here mainly affect the *request* side
 * (how thinking is requested/controlled).
 */
const RULES: Rule[] = [
  // --- DeepSeek (reasoning_content style) ---
  {
    match: /deepseek/i,
    vendor: "deepseek",
    reasoning: true,
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
    supportsReasoningEffort: true,
    contextWindow: 64000,
    maxTokens: 8192,
    input: ["text"],
  },
  // --- Qwen (DashScope enable_thinking style) ---
  {
    match: /qwen/i,
    vendor: "qwen",
    reasoning: true,
    thinkingFormat: "qwen",
    supportsReasoningEffort: true,
    contextWindow: 131072,
    maxTokens: 8192,
    input: ["text", "image"],
  },
  // --- GLM / ChatGLM (z.ai & 智谱; newapi often proxies via qwen-compat or zai) ---
  {
    match: /glm/i,
    vendor: "zhipu",
    reasoning: true,
    thinkingFormat: "qwen",
    supportsReasoningEffort: true,
    contextWindow: 131072,
    maxTokens: 8192,
    input: ["text", "image"],
  },
  // --- Kimi / Moonshot (k2.x non-reasoning; newer reasoning variants exist) ---
  {
    match: /kimi|moonshot/i,
    vendor: "moonshot",
    reasoning: false,
    thinkingFormat: "openai",
    maxTokensField: "max_tokens",
    contextWindow: 131072,
    maxTokens: 8192,
    input: ["text"],
  },
  // --- OpenAI o-series reasoning (top-level reasoning_effort) ---
  {
    match: /\bo[134]\b|o1-mini|o3-mini|o4-mini/i,
    vendor: "openai",
    reasoning: true,
    thinkingFormat: "openai",
    supportsReasoningEffort: true,
    contextWindow: 200000,
    maxTokens: 100000,
    input: ["text", "image"],
  },
  // --- Claude via openai-compat gateway (usually non-reasoning passthrough) ---
  {
    match: /claude/i,
    vendor: "anthropic",
    reasoning: false,
    thinkingFormat: "openai",
    contextWindow: 200000,
    maxTokens: 8192,
    input: ["text", "image"],
  },
  // --- Gemini ---
  {
    match: /gemini/i,
    vendor: "google",
    reasoning: false,
    thinkingFormat: "openai",
    contextWindow: 1000000,
    maxTokens: 8192,
    input: ["text", "image"],
  },
  // --- MiniMax (reasoning_content passthrough; treat like deepseek request style) ---
  {
    match: /minimax|abab/i,
    vendor: "minimax",
    reasoning: true,
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
    supportsReasoningEffort: false,
    contextWindow: 1000000,
    maxTokens: 8192,
    input: ["text"],
  },
  // --- Doubao / 字节 ---
  {
    match: /doubao|skylark/i,
    vendor: "doubao",
    reasoning: false,
    thinkingFormat: "openai",
    contextWindow: 131072,
    maxTokens: 8192,
    input: ["text"],
  },
  // --- Generic reasoning suffixes ---
  {
    match: /r1|reason|reasoning|thinking/i,
    vendor: "reasoning",
    reasoning: true,
    thinkingFormat: "openai",
    supportsReasoningEffort: true,
    contextWindow: 64000,
    maxTokens: 8192,
    input: ["text"],
  },
];

/** NewAPI "pool-*" prefix marks pooled/aggregate models; strip it to detect upstream. */
function stripPool(id: string): string {
  return id.startsWith("pool-") ? id.slice(5) : id;
}

export function detectVendor(id: string): VendorCompat {
  const probe = stripPool(id).toLowerCase();
  for (const rule of RULES) {
    const matched =
      typeof rule.match === "string"
        ? probe.includes(rule.match.toLowerCase())
        : rule.match.test(id);
    if (matched) {
      return {
        vendor: rule.vendor,
        reasoning: rule.reasoning,
        thinkingFormat: rule.thinkingFormat,
        requiresReasoningContentOnAssistantMessages:
          rule.requiresReasoningContentOnAssistantMessages,
        supportsReasoningEffort: rule.supportsReasoningEffort,
        maxTokensField: rule.maxTokensField,
      };
    }
  }
  return { vendor: "unknown", reasoning: false, thinkingFormat: "openai" };
}

/** Context-window / maxTokens / input defaults, keyed by detected vendor. */
export function vendorDefaults(vendor: string): {
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
} {
  const byRule = RULES.find((r) => r.vendor === vendor);
  return {
    contextWindow: byRule?.contextWindow ?? 131072,
    maxTokens: byRule?.maxTokens ?? 4096,
    input: byRule?.input ?? ["text", "image"],
  };
}
