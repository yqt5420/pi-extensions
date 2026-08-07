/**
 * NewAPI pricing math.
 *
 * NewAPI charges in "quota". The conventional baseline is:
 *   - 1 USD = 500,000 quota
 *   - base price = $0.002 per 1K input tokens = $2 per 1M input tokens
 *   - model_ratio is a multiplier on the base price
 *   - group_ratio is a multiplier for the user's billing group
 *   - completion_ratio multiplies output price relative to input
 *   - cache_ratio multiplies cache-read price relative to input
 *
 * So:
 *   input  $/M = model_ratio * group_ratio * 2
 *   output $/M = input * completion_ratio
 *   cacheRead $/M = input * cache_ratio
 *
 * These are estimates derived from the gateway's published ratio. The real
 * upstream price is whatever the gateway actually bills; this is the best the
 * API exposes. For pool-* aggregated models the ratio is the pool's blend.
 *
 * The group_ratio used is the one for the *default* group, since /api/pricing
 * does not tell us which group an API key belongs to. Users can override per
 * model in their overrides file if they need exact accounting.
 */

export interface NewApiPricingEntry {
  model_name: string;
  model_ratio: number;
  model_price: number; // 0 = ratio-based; nonzero = fixed price per call
  completion_ratio: number;
  cache_ratio?: number;
  quota_type: number;
  enable_groups?: string[];
  supported_endpoint_types?: string[];
}

export interface NewApiPricingResponse {
  data: NewApiPricingEntry[];
  group_ratio: Record<string, number>;
  usable_group?: Record<string, string>;
}

export interface ResolvedCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const BASE_USD_PER_M = 2.0; // $2 / 1M input tokens baseline

export function resolveCost(
  entry: NewApiPricingEntry,
  groupRatio: number,
): ResolvedCost {
  // Fixed-price-per-call models: cost-per-token is effectively 0 for tracking.
  if (entry.model_price && entry.model_price > 0) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const input = entry.model_ratio * groupRatio * BASE_USD_PER_M;
  const output = input * (entry.completion_ratio ?? 1);
  const cacheRead = entry.cache_ratio ? input * entry.cache_ratio : 0;
  // NewAPI does not publish cache-write pricing; mirror cacheRead as a safe
  // upper bound so usage tracking never under-reports.
  const cacheWrite = cacheRead;
  return { input, output, cacheRead, cacheWrite };
}

/** Pick the group ratio to apply. Prefer "default", else first available. */
export function pickGroupRatio(
  pricing: NewApiPricingResponse,
): number {
  const groups = pricing.group_ratio ?? {};
  if (typeof groups["default"] === "number") return groups["default"];
  const first = Object.values(groups)[0];
  return typeof first === "number" ? first : 1;
}
