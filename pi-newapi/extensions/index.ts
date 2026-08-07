/**
 * pi-newapi — auto-discover models, pricing, and reasoning compatibility for
 * any OpenAI-compatible NewAPI / one-api gateway.
 *
 * Gateway base URL and API key are configurable (no hardcoded site), so the
 * same package works for anyone:
 *   - Set `NEWAPI_BASE_URL` (e.g. https://your-gateway.example/v1) and
 *     `NEWAPI_API_KEY` in the environment, OR
 *   - Run `/login newapi` once and paste the key interactively.
 *
 * The extension is an async factory: at startup it fetches the gateway's
 * `/api/pricing` endpoint (NewAPI's public pricing/catalog API — no key
 * required for listing) and registers every available model with resolved
 * $/M-token pricing, detected reasoning behavior, and per-vendor thinking
 * compatibility. Models then appear in `/model` and `--list-models` just like
 * built-in providers. If the network fetch fails, it falls back to the last
 * cached model list in `~/.pi/agent/newapi-models-cache.json`.
 *
 * Per-model corrections live in `~/.pi/agent/newapi-overrides.json`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";

import { detectVendor, vendorDefaults } from "./vendor-detect.ts";
import { resolveCost, pickGroupRatio } from "./pricing.ts";
import type { NewApiPricingResponse, NewApiPricingEntry } from "./pricing.ts";
import { loadOverrides } from "./overrides.ts";
import type { ModelOverride } from "./overrides.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const PROVIDER_ID = "newapi";

/** Resolve the pi agent config directory, honoring PI_CODING_AGENT_DIR override. */
function agentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return join(homedir(), ".pi", "agent");
}
const CACHE_PATH = join(agentDir(), "newapi-models-cache.json");
const CONFIG_PATH = join(agentDir(), "newapi-config.json");

interface NewApiConfig {
  /** Gateway base URL, e.g. https://your-gateway.example/v1 */
  baseUrl?: string;
  /** API key (sk-...). Stored in plaintext on disk — same trust level as env. */
  apiKey?: string;
}

/** Read the user config file if present. Malformed file is ignored. */
function readConfigFile(): NewApiConfig | undefined {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as NewApiConfig;
    }
  } catch {
    /* malformed config — ignore */
  }
  return undefined;
}

/** Write the config file (merges with existing fields). */
function writeConfigFile(patch: NewApiConfig): void {
  mkdirSync(agentDir(), { recursive: true });
  const existing = readConfigFile() ?? {};
  const merged = { ...existing, ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/**
 * Normalize a user-entered gateway URL into the canonical `https://host/v1`
 * form used by OpenAI-compatible APIs. Accepts:
 *   - https://api.example.com
 *   - https://api.example.com/
 *   - https://api.example.com/v1
 *   - https://api.example.com/v1/
 * Trims, strips trailing slashes, and appends `/v1` if no `/vN` suffix is
 * present. Raises on obviously invalid input (empty / no scheme).
 */
function normalizeBaseUrl(input: string): { url: string; appended: boolean } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "URL is empty" };
  if (!/^https?:\/\//i.test(raw)) return { error: "URL must start with http:// or https://" };
  // Strip all trailing slashes.
  let url = raw.replace(/\/+$/, "");
  // If the last path segment is not a version like /v1, /v2, append /v1.
  const appended = !/\/v\d+$/i.test(url);
  if (appended) url += "/v1";
  return { url, appended };
}

/** Resolve base URL: config file > env var. */
function resolveBaseUrl(): string | undefined {
  const fromFile = readConfigFile()?.baseUrl?.trim().replace(/\/+$/, "");
  if (fromFile) return fromFile;
  return process.env.NEWAPI_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
}

/** Resolve API key: config file > env var. */
function resolveApiKey(): string | undefined {
  const fromFile = readConfigFile()?.apiKey?.trim();
  if (fromFile) return fromFile;
  return process.env.NEWAPI_API_KEY?.trim() || undefined;
}

/**
 * The pricing endpoint is `/api/pricing` on the gateway *root*, i.e. the same
 * host as the configured base but without the `/v1` suffix. Derive it from the
 * OpenAI base URL by stripping a trailing `/v1`.
 */
function pricingUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/v\d+\/?$/, "") || baseUrl;
  return `${root}/api/pricing`;
}

interface CachedCatalog {
  baseUrl: string;
  fetchedAt: number;
  groupRatio: number;
  entries: NewApiPricingEntry[];
}

function readCache(): CachedCatalog | undefined {
  try {
    if (existsSync(CACHE_PATH)) {
      return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as CachedCatalog;
    }
  } catch {
    /* malformed cache — ignore */
  }
  return undefined;
}

function writeCache(c: CachedCatalog): void {
  try {
    mkdirSync(agentDir(), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2), "utf-8");
  } catch {
    /* non-fatal */
  }
}

/** Build a pi ProviderModelConfig from a pricing entry, applying heuristics + overrides. */
function buildModelConfig(
  entry: NewApiPricingEntry,
  baseUrl: string,
  groupRatio: number,
  ov: ModelOverride | undefined,
) {
  const id = entry.model_name;
  const vc = detectVendor(id);
  const defs = vendorDefaults(vc.vendor);

  const reasoning = ov?.reasoning ?? vc.reasoning;
  const contextWindow = ov?.contextWindow ?? defs.contextWindow;
  const maxTokens = ov?.maxTokens ?? defs.maxTokens;
  const input = ov?.input ?? defs.input;

  const heuristicCost = resolveCost(entry, groupRatio);
  const cost = {
    input: ov?.cost?.input ?? heuristicCost.input,
    output: ov?.cost?.output ?? heuristicCost.output,
    cacheRead: ov?.cost?.cacheRead ?? heuristicCost.cacheRead,
    cacheWrite: ov?.cost?.cacheWrite ?? heuristicCost.cacheWrite,
  };

  const compat: Record<string, unknown> = {};
  const thinkingFormat = ov?.thinkingFormat ?? vc.thinkingFormat;
  if (thinkingFormat) compat.thinkingFormat = thinkingFormat;
  if (vc.requiresReasoningContentOnAssistantMessages)
    compat.requiresReasoningContentOnAssistantMessages = true;
  if (vc.supportsReasoningEffort !== undefined)
    compat.supportsReasoningEffort = vc.supportsReasoningEffort;
  if (vc.maxTokensField) compat.maxTokensField = vc.maxTokensField;

  return {
    id,
    name: ov?.displayName ?? id,
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    ...(Object.keys(compat).length ? { compat } : {}),
  };
}

/** Fetch the pricing catalog; fall back to cache on network failure. */
async function fetchCatalog(
  baseUrl: string,
): Promise<{ entries: NewApiPricingEntry[]; groupRatio: number } | undefined> {
  try {
    const res = await fetch(pricingUrl(baseUrl), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = (await res.json()) as NewApiPricingResponse;
    const groupRatio = pickGroupRatio(payload);
    writeCache({
      baseUrl,
      fetchedAt: Date.now(),
      groupRatio,
      entries: payload.data ?? [],
    });
    return { entries: payload.data ?? [], groupRatio };
  } catch (err) {
    // Fall back to cache if it is for the same base URL.
    const cache = readCache();
    if (cache && cache.baseUrl === baseUrl) {
      return { entries: cache.entries, groupRatio: cache.groupRatio };
    }
    throw new Error(
      `newapi: could not fetch ${pricingUrl(baseUrl)} and no usable cache: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

export default async function (pi: ExtensionAPI) {
  // Commands are registered first so they work regardless of whether a base
  // URL is currently configured (lets the user bootstrap from nothing).
  pi.registerCommand("newapi-url", {
    description: "Set the NewAPI gateway URL (e.g. /newapi-url https://host/v1). Re-fetches models.",
    async handler(args, ctx) {
      let input = args.trim();
      if (!input) {
        const current = resolveBaseUrl() ?? "(not set)";
        input = (await ctx.ui.input(`New gateway URL (current: ${current})`, "https://api.example.com/v1")) ?? "";
        if (!input.trim()) {
          ctx.ui.notify("newapi: cancelled", "info");
          return;
        }
      }
      const result = normalizeBaseUrl(input);
      if ("error" in result) {
        ctx.ui.notify(`newapi: invalid URL — ${result.error}`, "error");
        return;
      }
      writeConfigFile({ baseUrl: result.url });
      const note = result.appended
        ? `newapi: URL normalized to ${result.url} (appended /v1). Reloading…`
        : `newapi: URL set to ${result.url}. Reloading…`;
      ctx.ui.notify(note, "info");
      try {
        await ctx.reload();
      } catch (err) {
        ctx.ui.notify(
          `newapi: URL saved but reload failed — restart pi. (${err instanceof Error ? err.message : String(err)})`,
          "warning",
        );
      }
    },
  });

  const baseUrl = resolveBaseUrl();

  if (!baseUrl) {
    // No base URL configured: register a minimal shell so `/login newapi`
    // works, then warn. Once configured (config file or env) and reloaded,
    // models appear.
    pi.registerProvider(PROVIDER_ID, {
      name: "NewAPI Gateway",
      baseUrl: "https://placeholder.invalid/v1",
      apiKey: "$NEWAPI_API_KEY",
      api: "openai-completions",
      models: [],
    });
    pi.on("session_start", (_e, ctx) => {
      ctx.ui.notify(
        "newapi: not configured — create ~/.pi/agent/newapi-config.json with {\"baseUrl\":\"https://your-gateway/v1\",\"apiKey\":\"sk-...\"} or set NEWAPI_BASE_URL/NEWAPI_API_KEY, then /reload",
        "warn",
      );
    });
    return;
  }

  const apiKey = resolveApiKey();
  let models: ReturnType<typeof buildModelConfig>[] = [];
  let fetchError: string | undefined;

  try {
    const catalog = await fetchCatalog(baseUrl);
    if (catalog) {
      const overrides = loadOverrides();
      const seen = new Map<string, ReturnType<typeof buildModelConfig>>();
      for (const entry of catalog.entries) {
        const ov = overrides[entry.model_name];
        if (ov?.ignore) continue;
        seen.set(entry.model_name, buildModelConfig(entry, baseUrl, catalog.groupRatio, ov));
      }
      models = [...seen.values()];
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  const providerConfig: Parameters<typeof pi.registerProvider>[1] = {
    name: "NewAPI Gateway",
    baseUrl,
    api: "openai-completions" as Api,
    ...(apiKey ? { apiKey } : {}),
    authHeader: true, // OpenAI-compatible: Authorization: Bearer <key>
    models,
  };

  pi.registerProvider(PROVIDER_ID, providerConfig);

  pi.on("session_start", (_e, ctx) => {
    if (fetchError) {
      ctx.ui.notify(`newapi: model discovery failed — ${fetchError}`, "error");
    } else if (!apiKey) {
      ctx.ui.notify(
        "newapi: no API key set — set `apiKey` in ~/.pi/agent/newapi-config.json or /login newapi",
        "warn",
      );
    } else if (models.length > 0) {
      ctx.ui.notify(`newapi: ${models.length} models available`, "info");
    }
  });
}
