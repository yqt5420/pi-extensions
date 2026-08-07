/**
 * Per-model user overrides.
 *
 * Users can drop a JSON file at ~/.pi/agent/newapi-overrides.json to correct
 * anything the heuristics get wrong for their specific gateway, e.g. exact
 * context windows, real pricing, or forcing reasoning off for a model that
 * doesn't actually support thinking.
 *
 * Example:
 * {
 *   "DeepSeek-V4-Flash": {
 *     "contextWindow": 128000,
 *     "maxTokens": 16384,
 *     "reasoning": true
 *   },
 *   "SomeNonReasoningModel": {
 *     "reasoning": false
 *   }
 * }
 *
 * All fields optional; unspecified fields fall back to heuristics.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface ModelOverride {
  reasoning?: boolean;
  thinkingFormat?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Set true to skip this model entirely (don't register it). */
  ignore?: boolean;
  displayName?: string;
}

export type OverridesMap = Record<string, ModelOverride>;

/** Resolve the pi agent config directory, honoring PI_CODING_AGENT_DIR override. */
function agentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return join(homedir(), ".pi", "agent");
}

const OVERRIDE_PATH = join(agentDir(), "newapi-overrides.json");

let cached: OverridesMap | null = null;

export function loadOverrides(): OverridesMap {
  if (cached !== null) return cached;
  try {
    if (existsSync(OVERRIDE_PATH)) {
      const raw = readFileSync(OVERRIDE_PATH, "utf-8");
      cached = JSON.parse(raw) as OverridesMap;
    } else {
      cached = {};
    }
  } catch (err) {
    // Don't hard-fail startup over a malformed overrides file.
    cached = {};
  }
  return cached!;
}

/** Allow tests / reload to reset the cache. */
export function resetOverridesCache(): void {
  cached = null;
}
