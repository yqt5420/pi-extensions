/**
 * performCapture — agent_end 时捕获本回合对话写 L0。
 *
 * 关键点：
 * - rawMessages 即 agent_end 的 event.messages（本 low-level run 的消息，无需位置切片）
 * - 提取 user/assistant：兼容 content: string 与 Array<{type:"text",text}>，剥离非文本（含 inline base64 图）
 * - 时间戳游标 afterTimestamp 过滤
 * - 替换被污染的 user 消息（框架在 before_agent_start 后追加的 user 消息塞入了 recall 注入块，
 *   必须还原为干净 prompt，防注入块回流 feedback loop）
 * - sanitizeText（所有）+ stripCodeBlocks（仅 assistant）+ shouldCaptureL0 过滤框架噪声
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationMessage, MemoryClient } from "./client.js";
import { sanitizeText, shouldCaptureL0, stripCodeBlocks } from "./sanitize.js";

export interface CaptureOptions {
  client: MemoryClient;
  sessionId: string;
  /** agent_end 的 event.messages */
  rawMessages: AgentMessage[];
  /** 时间戳游标：只捕获 timestamp > 该值的消息 */
  afterTimestamp?: number;
  /** before_agent_start 缓存的干净用户 prompt（替换被污染的 user 消息） */
  originalUserText?: string;
  /** 单条消息内容最大长度（超出截断），默认 50000，与工具输出口径一致 */
  maxContentLength?: number;
}

export interface CaptureResult {
  captured: boolean;
  messageCount: number;
  /** 本轮捕获到的最大消息时间戳（供调用方更新游标） */
  maxTimestamp?: number;
}

/** 注入块污染标记（命中任一即视为被框架/自身注入污染）。
 * 注：before_agent_start 注入的 tdai-recall 消息 role 为 "custom"，本会被 user/assistant 过滤跳过，
 * 标记检查仅作纵深防御（防旧版框架或其他来源把注入块拼进 user 消息）。
 * 不再使用“长度 > 原文×2”启发式：会误伤 steer/多 user 消息回合的合法长消息（静默写错 L0）。 */
const POLLUTION_MARKERS = [
  "<tdai-memory-tools-guide>",
  "<tdai_profile_memory>",
  "<l2_scene_index>",
  "<relevant-memories>",
] as const;

/** 是否被 recall/框架注入污染（仅标记匹配，无长度启发式）。 */
function isPolluted(text: string): boolean {
  return POLLUTION_MARKERS.some((marker) => text.includes(marker));
}

/** 提取消息文本：兼容 string 与内容数组；非 text 部分（图片/ToolCall/Thinking）跳过。 */
export function extractText(message: AgentMessage): string | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content.filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        part.type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    );
    if (parts.length === 0) return undefined;
    return parts.map((part) => part.text).join("\n");
  }
  return undefined;
}

export async function performCapture(opts: CaptureOptions): Promise<CaptureResult> {
  const { client, sessionId, rawMessages, afterTimestamp, originalUserText, maxContentLength = 50000 } = opts;

  const out: ConversationMessage[] = [];
  let maxTimestamp = afterTimestamp ?? 0;

  for (const m of rawMessages ?? []) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (typeof m.timestamp !== "number" || m.timestamp <= 0) continue;
    if (afterTimestamp !== undefined && m.timestamp <= afterTimestamp) continue;

    let text = extractText(m);
    if (!text || !text.trim()) continue;

    // 替换被污染的 user 消息（防注入块回流 feedback loop；仅标记匹配，无长度启发式）
    if (m.role === "user" && originalUserText && isPolluted(text)) {
      text = originalUserText;
    }

    const cleaned = sanitizeText(text);
    if (!cleaned) continue;
    if (!shouldCaptureL0(cleaned)) continue;

    const final = m.role === "assistant" ? stripCodeBlocks(cleaned) : cleaned;
    if (!final) continue;

    // 超长内容截断（防大代码 diff 整条写库后整条回灌）
    const clipped =
      final.length > maxContentLength ? `${final.slice(0, maxContentLength)}\n…[内容已截断]` : final;

    out.push({ role: m.role, content: clipped, timestamp: new Date(m.timestamp).toISOString() });
    // maxTimestamp 只统计实际写入 out 的消息（被 sanitize/shouldCapture 跳过的不计入，
    // 避免游标跳过未写入的消息导致下轮不重试）
    if (m.timestamp > maxTimestamp) maxTimestamp = m.timestamp;
  }

  if (out.length === 0) return { captured: false, messageCount: 0 };

  await client.addConversation({ session_id: sessionId, messages: out });
  return {
    captured: true,
    messageCount: out.length,
    maxTimestamp: maxTimestamp > 0 ? maxTimestamp : undefined,
  };
}
