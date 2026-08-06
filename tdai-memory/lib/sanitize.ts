/**
 * 文本清洗纯函数。
 *
 * 核心目标：捕获写 L0 前必须剥离 recall 注入的标签块，否则
 * capture → recall → capture 形成正反馈循环，记忆里塞满标签垃圾。
 */

/** 9 种注入标签（recall 注入 + 框架注入），单个正则 + 反向引用，一次全文遍历移除。 */
const INJECTION_TAG_BLOCK_RE =
  /<(relevant-memories|user-persona|relevant-scenes|scene-navigation|tdai-memory-tools-guide|tdai_profile_memory|l3_core_memory|l2_scene_index|knowledge_tools)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi;

/**
 * 框架元数据 JSON 块：独立成行/成块的 `{...}`，且必须是合法 JSON（JSON.parse 验证通过才删）。
 * 避免误删用户消息里的 JSON 片段或嵌套花括号文本。
 */
const META_JSON_BLOCK_RE = /(^|\n)[ \t]*(\{[\s\S]*?\})[ \t]*(\n|$)/g;

/** 整行时间戳（如 `[12:34:56]` / `2025-01-02 12:34:56`，整行只有时间戳才删，不剥行内前缀）。 */
const TIMESTAMP_ONLY_LINE_RE =
  /(^|\n)[ \t]*(?:\[\d{2}:\d{2}(?::\d{2})?\]|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)[ \t]*(\n|$)/g;

/** inline base64 图片（data:image/...;base64,...）。 */
const INLINE_BASE64_IMAGE_RE = /!?\[[^\]]*\]\(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+\)/g;

/** null 字符。 */
const NULL_CHAR_RE = /\u0000/g;

/** 3 行及以上连续空行 → 最多 2 行。 */
const EXCESS_BLANK_LINES_RE = /\n{3,}/g;

/**
 * 清洗文本：移除注入标签块、框架元数据 JSON 块（仅合法 JSON）、整行时间戳、
 * inline base64 图、null 字符，合并多余空行。所有替换在单次遍历中完成。
 */
export function sanitizeText(text: string): string {
  if (!text) return "";
  return text
    .replace(INJECTION_TAG_BLOCK_RE, "")
    .replace(META_JSON_BLOCK_RE, (_match, pre: string, block: string, post: string) => {
      // 仅当整块是合法 JSON 才移除（防误删用户消息中的 JSON 片段/嵌套花括号）
      try {
        JSON.parse(block);
        return `${pre ?? ""}${post ?? ""}`;
      } catch {
        return _match;
      }
    })
    .replace(TIMESTAMP_ONLY_LINE_RE, "$1$3")
    .replace(INLINE_BASE64_IMAGE_RE, "")
    .replace(NULL_CHAR_RE, "")
    .replace(EXCESS_BLANK_LINES_RE, "\n\n")
    .trim();
}

/** 去除 assistant 回复里的 ``` 代码块。 */
export function stripCodeBlocks(text: string): string {
  if (!text) return "";
  return text
    .replace(/```[a-zA-Z0-9_+-]*\n?[\s\S]*?```/g, "[code block]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 框架噪声片段（命中任一即视为不该捕获 L0）。 */
const FRAME_NOISE_MARKERS = [
  "(session bootstrap)",
  "A new session was started via",
  "✅ New session started",
  "Pre-compaction memory flush",
  "NO_REPLY",
] as const;

/**
 * 是否应写入 L0：过滤空文本、`/` 开头命令、框架噪声。
 */
export function shouldCaptureL0(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return false;
  return !FRAME_NOISE_MARKERS.some((marker) => trimmed.includes(marker));
}
