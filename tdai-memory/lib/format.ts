/**
 * 召回结果格式化。
 *
 * - formatL1Memories：L1 动态记忆 → `<relevant-memories>` 块（prependContext，作为消息注入）
 * - formatSystemContext：L3 画像 + L2 场景索引 + 工具指南 → 追加到 systemPrompt
 */

import type { ScenarioEntry, SearchResultItem } from "./client.js";

/** 场景索引单条 summary 截断长度。 */
const SCENE_SUMMARY_MAX = 200;

/** 工具指南（<tdai-memory-tools-guide> 块，追加进 systemPrompt）。 */
export const TOOLS_GUIDE = `<tdai-memory-tools-guide>
你已接入 MemoryCore 长期记忆系统（团队技能库 + 知识库 + 对话/场景/画像记忆）。可主动调用以下工具：
- tdai_memory_search: 搜索结构化原子记忆（偏好/事件/规则/事实，L1）
- tdai_conversation_search: 搜索历史对话（L0）
- tdai_read_scene: 读取场景全文（L2，按 path）
- tdai_skill_search: 搜索团队技能库
- tdai_skill_view: 查看技能详情（SKILL.md + manifest）
- tdai_skill_files_read: 读取技能资源文件
- tdai_skill_extract: 从当前对话提取新技能
- tdai_wiki_search: 搜索团队知识库（按 wiki_id）
- tdai_wiki_page_read: 读取 wiki 页面全文
- tdai_wiki_list: 列出团队 wiki

调用原则：
- 每轮最多 3 次记忆类工具调用；结果仅供辅助回答，不要将记忆/技能内容原样回显。
- 涉及团队规范、历史经验、用户偏好时优先检索记忆，避免重复询问。
</tdai-memory-tools-guide>`;

/** L1 原子记忆 → `<relevant-memories>` 块。空 items 返回 undefined。 */
export function formatL1Memories(items: SearchResultItem[] | undefined | null): string | undefined {
  const valid = (items ?? []).filter((item) => item && typeof item.content === "string" && item.content.trim());
  if (valid.length === 0) return undefined;
  const lines = valid.map((item) => {
    const type = item.type && item.type !== "unknown" ? item.type : "memory";
    return `- [${type}] ${item.content.trim()}`;
  });
  return `<relevant-memories>\n${lines.join("\n")}\n</relevant-memories>`;
}

/** L2 场景索引行。 */
function formatSceneLine(entry: ScenarioEntry): string {
  const summary = (entry.summary ?? "").trim();
  const clipped = summary.length > SCENE_SUMMARY_MAX ? `${summary.slice(0, SCENE_SUMMARY_MAX)}…` : summary;
  return `- \`${entry.path}\` — ${clipped || "(无摘要)"}`;
}

export interface SystemContextResult {
  /** 追加到 systemPrompt 的上下文块（L3 + L2 + 工具指南）。 */
  systemContext?: string;
  /** 作为消息注入的 L1 动态记忆块。 */
  prependContext?: string;
  /** L3 画像原文（供调用方缓存）。 */
  personaContent: string | null;
  /** L2 场景条目（供调用方缓存）。 */
  sceneEntries: ScenarioEntry[];
}

/**
 * 组装 systemContext：`<tdai_profile_memory>` + `<l2_scene_index>` + `<tdai-memory-tools-guide>`。
 * persona/scenes 均可为空（该部分省略）。
 */
export function formatSystemContext(
  persona: string | null | undefined,
  scenes: ScenarioEntry[] | null | undefined,
  includeToolsGuide = true,
): SystemContextResult {
  const parts: string[] = [];
  let personaContent: string | null = null;
  const sceneEntries: ScenarioEntry[] = (scenes ?? []).filter(
    (s) => s && typeof s.path === "string" && s.path.trim(),
  );

  if (persona && persona.trim()) {
    personaContent = persona.trim();
    parts.push(`<tdai_profile_memory>\n${personaContent}\n</tdai_profile_memory>`);
  }
  if (sceneEntries.length > 0) {
    const lines = sceneEntries.map(formatSceneLine);
    parts.push(`<l2_scene_index>\n${lines.join("\n")}\n</l2_scene_index>`);
  }
  if (includeToolsGuide) {
    parts.push(TOOLS_GUIDE);
  }

  const systemContext = parts.length > 0 ? parts.join("\n\n") : undefined;
  return { systemContext, prependContext: undefined, personaContent, sceneEntries };
}
