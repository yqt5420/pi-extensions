/**
 * performRecall — before_agent_start 时的并行召回 + 注入。
 *
 * - 并行 Promise.allSettled：searchAtomic(query, maxResults)（L1）+ readCore()（L3）+ listScenarios({})（L2）
 * - L3/L2 缓存：Map<sessionId, {persona, scenes, ts}>，TTL 10 分钟。
 *   命中（cachedPersona !== undefined）则跳过 HTTP，recall 从 3 个 HTTP 降到 1 个。
 * - 失败不阻断：单路失败只影响该部分内容。
 */

import { formatL1Memories, formatSystemContext } from "./format.js";
import type { MemoryClient, ScenarioEntry, SearchResultItem } from "./client.js";

export interface L3L2CacheEntry {
  /** 画像内容；undefined 表示从未成功拉取（不命中缓存） */
  persona: string | null | undefined;
  scenes: ScenarioEntry[] | undefined;
  ts: number;
}

/** L3/L2 缓存 TTL：10 分钟（画像与场景索引是稳定内容）。 */
export const L3L2_CACHE_TTL_MS = 10 * 60 * 1000;

export interface RecallOptions {
  client: MemoryClient;
  sessionId: string;
  /** 召回 query（通常为本次用户 prompt） */
  query: string;
  maxResults: number;
  includePersona: boolean;
  includeSceneNav: boolean;
  /** L3/L2 缓存（由扩展持有，跨轮共享，按 sessionId 收敛） */
  cache: Map<string, L3L2CacheEntry>;
}

export interface RecallResult {
  /** 追加到 systemPrompt 的上下文块（L3 画像 + L2 场景索引 + 工具指南） */
  systemContext?: string;
  /** 作为消息注入的 L1 动态记忆块 */
  prependContext?: string;
}

export async function performRecall(opts: RecallOptions): Promise<RecallResult> {
  const { client, sessionId, query, maxResults, includePersona, includeSceneNav, cache } = opts;

  const cached = cache.get(sessionId);
  const hit =
    cached !== undefined &&
    Date.now() - cached.ts < L3L2_CACHE_TTL_MS &&
    cached.persona !== undefined;

  let l1Items: SearchResultItem[] = [];
  let persona: string | null | undefined;
  let scenes: ScenarioEntry[] | undefined;

  if (hit) {
    // L3/L2 缓存命中：画像与场景索引用缓存，只发 1 个 HTTP（L1 动态检索）
    persona = cached.persona;
    scenes = cached.scenes;
    try {
      const res = await client.searchAtomic({ query, limit: maxResults });
      l1Items = res?.items ?? [];
    } catch {
      l1Items = [];
    }
  } else {
    const [atomicRes, coreRes, sceneRes] = await Promise.allSettled([
      client.searchAtomic({ query, limit: maxResults }),
      includePersona ? client.readCore() : Promise.resolve(undefined),
      includeSceneNav ? client.listScenarios() : Promise.resolve(undefined),
    ]);

    if (atomicRes.status === "fulfilled") {
      l1Items = atomicRes.value?.items ?? [];
    }
    if (coreRes.status === "fulfilled") {
      persona = (coreRes.value as { content?: string | null } | undefined)?.content ?? null;
    } else {
      // 拉取失败：不写缓存（undefined 表示未成功拉取，下次仍会重试）
      persona = undefined;
    }
    if (sceneRes.status === "fulfilled") {
      scenes = (sceneRes.value as { entries?: ScenarioEntry[] } | undefined)?.entries ?? [];
    } else {
      scenes = undefined;
    }

    // 写缓存：includePersona/includeSceneNav 关闭或拉取失败时存 undefined（不参与命中判定）
    cache.set(sessionId, {
      persona: includePersona ? persona : undefined,
      scenes: includeSceneNav ? scenes : undefined,
      ts: Date.now(),
    });
  }

  // 展示层面按开关收敛（缓存命中时 persona/scenes 可能来自缓存，仍需尊重开关）
  const personaOut = includePersona ? persona : null;
  const scenesOut = includeSceneNav ? scenes : [];

  const { systemContext } = formatSystemContext(personaOut, scenesOut, true);
  const prependContext = formatL1Memories(l1Items);

  return {
    systemContext,
    prependContext,
  };
}
