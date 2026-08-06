/**
 * tdai-memory — pi coding agent 的 MemoryCore 长期记忆扩展。
 *
 * 直连自建 MemoryCore 后端 HTTP API，提供：
 * - 对话记忆（L0）/ 结构化原子记忆（L1）/ 场景（L2）/ 核心画像（L3）
 * - 团队技能库（skill/*）+ 知识库（wiki/*）
 *
 * 功能：
 * - before_agent_start 并行召回（L1 + L3 + L2，L3/L2 10 分钟缓存）并注入
 * - agent_end fire-and-forget 捕获本回合对话写 L0（失败回合跳过）
 * - 10 个 tdai_* 工具
 * - /tdai-setup 交互式配置
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentToolResult,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { performCapture, extractText } from "./lib/capture.js";
import { MemoryClient, deriveAgentName, type AgentInfo } from "./lib/client.js";
import { performRecall, type L3L2CacheEntry } from "./lib/recall.js";

// =============================================================================
// 配置
// =============================================================================

export interface TdaiConfig {
  endpoint: string;
  apiKey: string;
  gatewayToken?: string;
  serviceId: string;
  teamId: string;
  userId: string;
  fixedAgentId?: string;
  projectAgent: boolean;
  recall: {
    maxResults: number;
    includePersona: boolean;
    includeSceneNav: boolean;
  };
  capture: {
    enabled: boolean;
  };
  wiki: {
    /** wiki 功能开关（默认 false：实验中，接口/鉴权待重设）。开启后注册 wiki 工具。 */
    enabled: boolean;
  };
}

const DEFAULT_CONFIG: TdaiConfig = {
  endpoint: "",
  apiKey: "",
  gatewayToken: "",
  serviceId: "default",
  teamId: "",
  userId: "",
  fixedAgentId: "",
  projectAgent: false,
  recall: { maxResults: 5, includePersona: true, includeSceneNav: true },
  capture: { enabled: true },
  wiki: { enabled: false },
};

/** 项目级配置路径缓存（按 import.meta.url 计算，进程内不变）。 */
let cachedProjectPath: string | undefined;

/**
 * 全局配置路径：~/.pi/agent/extensions/tdai-memory/config.json
 * 仅用于全局安装场景（扩展本身位于 agentDir 下时回退到此）。 */
export function configPathGlobal(): string {
  return join(getAgentDir(), "extensions", "tdai-memory", "config.json");
}

/**
 * 扩展目录内 fallback 配置路径（开发时用；会被 pi update 覆盖，不推荐落盘）。 */
export function configPathLocal(): string {
  return fileURLToPath(new URL("./config.json", import.meta.url));
}

/**
 * 项目级配置路径：{项目根}/.pi/tdai-memory.json
 *
 * 通过扩展自身路径（import.meta.url）向上查找 `.pi` 目录定位项目根——
 * 项目级 npm 安装的扩展位于 `{project}/.pi/npm/node_modules/...`，
 * 向上一定能找到 `{project}/.pi`。全局安装时向上找不到项目 `.pi`，返回空（回退全局）。
 * 配置文件名用 tdai-memory.json（而非 config.json），避免与 .pi 下其他 config 混淆，
 * 且不会被 pi update 覆盖（不在包目录内）。 */
export function configPathProject(): string {
  if (!cachedProjectPath) {
    const extDir = dirname(fileURLToPath(import.meta.url));
    // 仅当扩展位于项目级 .pi/npm 下时才查找项目配置；全局安装（在 agentDir 下）跳过，避免误判
    const normalizedExt = extDir.replace(/\\/g, "/");
    const isProjectInstall = normalizedExt.includes("/.pi/npm/");
    if (isProjectInstall) {
      let cur = extDir;
      // 向上最多 10 层查找 .pi 目录（项目根标志）
      for (let i = 0; i < 10; i++) {
        const candidate = join(cur, ".pi");
        try {
          if (statSync(candidate).isDirectory()) {
            // 确认是项目根而非恰好同名子目录：.pi 下应存在 settings.json 或 npm 目录
            if (existsSync(join(candidate, "settings.json")) || existsSync(join(candidate, "npm"))) {
              cachedProjectPath = join(candidate, "tdai-memory.json");
              break;
            }
          }
        } catch {}
        const parent = dirname(cur);
        if (parent === cur) break; // 到根了
        cur = parent;
      }
    }
    cachedProjectPath = cachedProjectPath ?? ""; // 找不到 → 空串（调用方回退全局）
  }
  return cachedProjectPath;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function intFromEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function mergeConfig(file: Record<string, unknown> | undefined): TdaiConfig {
  const f = file ?? {};
  const recall = (f.recall ?? {}) as Record<string, unknown>;
  const capture = (f.capture ?? {}) as Record<string, unknown>;
  const wiki = (f.wiki ?? {}) as Record<string, unknown>;
  return {
    endpoint: (f.endpoint as string) ?? DEFAULT_CONFIG.endpoint,
    apiKey: (f.apiKey as string) ?? DEFAULT_CONFIG.apiKey,
    gatewayToken: (f.gatewayToken as string) ?? DEFAULT_CONFIG.gatewayToken,
    serviceId: (f.serviceId as string) ?? DEFAULT_CONFIG.serviceId,
    teamId: (f.teamId as string) ?? DEFAULT_CONFIG.teamId,
    userId: (f.userId as string) ?? DEFAULT_CONFIG.userId,
    fixedAgentId: (f.fixedAgentId as string) ?? DEFAULT_CONFIG.fixedAgentId,
    projectAgent: (f.projectAgent as boolean) ?? DEFAULT_CONFIG.projectAgent,
    recall: {
      maxResults: (recall.maxResults as number) ?? DEFAULT_CONFIG.recall.maxResults,
      includePersona: (recall.includePersona as boolean) ?? DEFAULT_CONFIG.recall.includePersona,
      includeSceneNav: (recall.includeSceneNav as boolean) ?? DEFAULT_CONFIG.recall.includeSceneNav,
    },
    capture: {
      enabled: (capture.enabled as boolean) ?? DEFAULT_CONFIG.capture.enabled,
    },
    wiki: {
      enabled: (((wiki as Record<string, unknown>)?.enabled) as boolean) ?? DEFAULT_CONFIG.wiki.enabled,
    },
  };
}

/** 仅从文件加载配置（不经 env 覆盖；供 /tdai-setup 合并旧值时用，避免把 env 值落盘）。
 * 优先级：项目本地 .pi/tdai-memory.json > 全局 > 包内 fallback。 */
function loadConfigFromFiles(): TdaiConfig {
  const projectPath = configPathProject();
  const file =
    (projectPath ? readJsonFile(projectPath) : undefined) ??
    readJsonFile(configPathGlobal()) ??
    readJsonFile(configPathLocal());
  return mergeConfig(file);
}

/** 加载配置：全局 config.json → 本地 fallback → env 覆盖。 */
export function loadConfig(): TdaiConfig {
  const cfg = loadConfigFromFiles();

  // env 覆盖（优先级最高）
  if (process.env.TDAI_MEMORY_ENDPOINT) cfg.endpoint = process.env.TDAI_MEMORY_ENDPOINT;
  if (process.env.TDAI_MEMORY_API_KEY) cfg.apiKey = process.env.TDAI_MEMORY_API_KEY;
  if (process.env.TDAI_MEMORY_SERVICE_ID) cfg.serviceId = process.env.TDAI_MEMORY_SERVICE_ID;
  if (process.env.TDAI_MEMORY_TEAM_ID) cfg.teamId = process.env.TDAI_MEMORY_TEAM_ID;
  if (process.env.TDAI_MEMORY_USER_ID) cfg.userId = process.env.TDAI_MEMORY_USER_ID;
  if (process.env.TDAI_MEMORY_AGENT_ID) cfg.fixedAgentId = process.env.TDAI_MEMORY_AGENT_ID;
  if (process.env.TDAI_MEMORY_GATEWAY_TOKEN) cfg.gatewayToken = process.env.TDAI_MEMORY_GATEWAY_TOKEN;
  cfg.recall.maxResults = intFromEnv("TDAI_RECALL_MAX_RESULTS", cfg.recall.maxResults);
  cfg.recall.includePersona = boolFromEnv("TDAI_RECALL_PERSONA", cfg.recall.includePersona);
  cfg.recall.includeSceneNav = boolFromEnv("TDAI_RECALL_SCENE", cfg.recall.includeSceneNav);
  cfg.capture.enabled = boolFromEnv("TDAI_CAPTURE", cfg.capture.enabled);
  cfg.wiki.enabled = boolFromEnv("TDAI_WIKI", cfg.wiki.enabled);
  cfg.projectAgent = boolFromEnv("TDAI_PROJECT_AGENT", cfg.projectAgent);

  return cfg;
}

/** 写入配置（/tdai-setup / /tdai-agent 用），合并旧值。
 * 落盘目标：优先项目本地 .pi/tdai-memory.json（项目级安装时跟着项目走，
 * 不被 pi update 覆盖）；找不到项目根时回退全局 agentDir。 */
export function writeConfig(cfg: TdaiConfig): void {
  const projectPath = configPathProject();
  const target = projectPath || configPathGlobal();
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function errorMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// =============================================================================
// 日志（pi 的 ExtensionAPI.logger 可能不存在，无 logger 静默）
// =============================================================================

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

function makeLogger(pi: ExtensionAPI): Logger {
  const logger = (pi as unknown as { logger?: { info?: (m: string) => void; warn?: (m: string) => void } }).logger;
  return {
    info: (msg) => logger?.info?.(msg),
    warn: (msg) => logger?.warn?.(msg),
  };
}

// =============================================================================
// 会话级状态（扩展实例生命周期内有效）
// =============================================================================

/** sessionId → 干净用户 prompt（before_agent_start 缓存，agent_end 消费后删除）。 */
const pendingPrompt = new Map<string, { text: string; ts: number }>();
/** 干净 prompt 新鲜度上限：超过该时长不再用于替换（防跨轮误用）。 */
const PENDING_PROMPT_TTL_MS = 10 * 60 * 1000;
/** sessionId → 上次捕获最大时间戳（L0 增量游标）。 */
const sessionCursors = new Map<string, number>();
/** sessionId → 项目级 agentId（session_start 注册结果）。 */
const sessionAgentId = new Map<string, string>();
/** cwd → {agentId, ts}（工具用，多会话共享）。ts 用于 TTL：超过 CWD_AGENT_TTL 则视为陈旧重新推导。 */
const cwdAgentId = new Map<string, { agentId: string; ts: number }>();
/** cwd→agentId 映射 TTL：超时重新解析，防后端 agent 被删后仍用失效 id。 */
const CWD_AGENT_TTL_MS = 30 * 60 * 1000;
/** sessionId → L3/L2 缓存（画像 + 场景索引，TTL 10 分钟）。 */
const l3l2Cache = new Map<string, L3L2CacheEntry>();
/** 进行中的捕获（fire-and-forget；session_shutdown 等它们最多 3s）。用 Set 追踪全部在途 capture，防止并发覆盖丢引用。 */
const inflightCaptures = new Set<Promise<void>>();

// =============================================================================
// 工具辅助
// =============================================================================

/** 工具输出超长截断阈值。 */
const MAX_TOOL_OUTPUT = 50000;

/**
 * 按 cwd 取项目级 agentId（必须传 ctx.cwd，不是 process.cwd()——
 * 与 session_start 存储的 key 保持一致，否则错位回退 fixedAgentId）。
 */
function getAgentIdByCwd(cwd: string): string | undefined {
  const entry = cwdAgentId.get(cwd);
  if (entry && Date.now() - entry.ts < CWD_AGENT_TTL_MS) {
    return entry.agentId;
  }
  // 陈旧或无 → 清除并回退 fixedAgentId
  if (entry) cwdAgentId.delete(cwd);
  // 回退固定 agent（/tdai-setup 初始化时创建并绑定），不再自动创建
  return config.fixedAgentId || undefined;
}

function baseClient(timeoutMs?: number): MemoryClient {
  return new MemoryClient({
    endpoint: config.endpoint,
    apiKey: config.apiKey,
    gatewayToken: config.gatewayToken || undefined,
    serviceId: config.serviceId,
    teamId: config.teamId,
    userId: config.userId,
    timeoutMs,
  });
}

/** 构造按会话收敛的 client。timeoutMs 可覆盖默认 15s（recall 等关键路径用短超时防卡顿）。 */
function makeClient(ctx: ExtensionContext, timeoutMs?: number): MemoryClient {
  const sessionId = ctx.sessionManager.getSessionId();
  const agentId = sessionAgentId.get(sessionId) ?? getAgentIdByCwd(ctx.cwd);
  return baseClient(timeoutMs).withIsolation({ sessionId, agentId });
}

/**
 * 路径穿越防御：拒绝空、绝对路径、含 `..`（含 URL 编码变体，循环解码防双重编码绕过）。
 * 返回错误信息（string）或 null（安全）。
 * 注意：这是客户端启发式防护，服务端必须自行校验路径。
 */
export function rejectUnsafePath(p: string, label: string): string | null {
  if (!p || typeof p !== "string") return `${label}: path 为空`;
  const trimmed = p.trim();
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return `${label}: 不允许绝对路径 "${trimmed}"`;
  }
  // 循环解码（上限 3 轮）：%252e%252e%252f 这类双重编码也要拦下
  let decoded = trimmed;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return `${label}: path 解码失败 "${trimmed}"`;
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (decoded.includes("..")) {
    return `${label}: 不允许路径穿越 ".."`;
  }
  return null;
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n…[输出已截断]`;
}

/** 安全字符串守卫：后端返回非 string（对象/数组/数字）时返回 undefined，避免拼出 [object Object]。 */
function safeStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** 从 AgentToolResult.content 提取文本。 */
function resultText(result: AgentToolResult<unknown>): string {
  const content = result.content ?? [];
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/**
 * ToolRenderContext 未从 pi 包导出（仅定义于 types.d.ts），此处声明结构兼容的最小接口。
 * 只用到 lastComponent 与 isError，其余按框架契约保留。
 */
interface ToolRenderContextLike {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: import("@earendil-works/pi-tui").Component | undefined;
  state: unknown;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  showImages: boolean;
  isError: boolean;
}

/**
 * 工具结果 TUI 渲染（对齐 pi 内置 read/write 工具契约）：
 * - 签名 4 参数 (result, options, theme, context)
 * - 复用 context.lastComponent 做 setText 更新，不每次 new Text()
 * - 空 text 时返回空 Text，绝不返回 undefined
 * - 折叠时 1 行摘要 + 行数（首行用 indexOf("\n")，O(1)）；展开时前 50 行
 */
export function renderToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContextLike,
) {
  const text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
  const content = resultText(result);

  let display: string;
  if (context.isError) {
    const nl = content.indexOf("\n");
    display = `[tdai] 错误: ${nl === -1 ? content : content.slice(0, nl)}`;
  } else if (options.expanded) {
    const lines = content.split("\n");
    const shown = lines.slice(0, 50);
    if (lines.length > 50) shown.push(`… (共 ${lines.length} 行，已截断)`);
    display = shown.join("\n");
  } else {
    const nl = content.indexOf("\n");
    const firstLine = nl === -1 ? content : content.slice(0, nl);
    const lineCount = content === "" ? 0 : content.split("\n").length;
    display = lineCount <= 1 ? content : `${firstLine} … (${lineCount} 行)`;
  }

  text.setText(display);
  return text;
}

// =============================================================================
// 工具定义（14 个）
// =============================================================================

function toolResult(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: {} };
}

const tdaiTools: ToolDefinition[] = [
  // 1. L1 原子记忆搜索
  defineTool({
    name: "tdai_memory_search",
    label: "搜索长期记忆",
    description:
      "搜索 MemoryCore 结构化原子记忆（L1：用户偏好/事件/规则/事实）。用于回忆用户偏好、项目约定、历史经验等。",
    promptSnippet: "搜索长期记忆（偏好/事件/规则/事实）",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词或语义查询" }),
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
      type: Type.Optional(Type.String({ description: "记忆类型过滤：preference/event/rule/fact 等" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = makeClient(ctx);
      const { items } = await client.searchAtomic({
        query: params.query,
        limit: params.limit,
        type: params.type,
      });
      const text =
        items.length === 0
          ? "（无匹配记忆）"
          : items
              .map((it, i) => {
                const score = typeof it.score === "number" ? ` (score ${it.score.toFixed(3)})` : "";
                return `${i + 1}. [${it.type ?? "memory"}] ${it.content}${score}`;
              })
              .join("\n");
      return toolResult(truncate(text));
    },
    renderResult: renderToolResult,
  }),

  // 2. L0 对话搜索
  defineTool({
    name: "tdai_conversation_search",
    label: "搜索历史对话",
    description: "搜索 MemoryCore 历史对话消息（L0）。用于回忆之前轮次讨论过的内容。",
    promptSnippet: "搜索历史对话",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词或语义查询" }),
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
      session_id: Type.Optional(Type.String({ description: "限定会话 id（不传则跨会话搜索）" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = makeClient(ctx);
      const { messages } = await client.searchConversation({
        query: params.query,
        limit: params.limit,
        session_id: params.session_id,
      });
      const text =
        messages.length === 0
          ? "（无匹配对话）"
          : messages
              .map((m, i) => {
                const score = typeof m.score === "number" ? ` (score ${m.score.toFixed(3)})` : "";
                return `${i + 1}. [${m.role}] ${m.content}${score}`;
              })
              .join("\n");
      return toolResult(truncate(text));
    },
    renderResult: renderToolResult,
  }),

  // 3. L2 场景全文
  defineTool({
    name: "tdai_read_scene",
    label: "读取场景",
    description: "读取 MemoryCore 场景块全文（L2）。path 来自 recall 注入的 <l2_scene_index> 或场景工具。",
    promptSnippet: "读取场景全文",
    parameters: Type.Object({
      path: Type.String({ description: "场景路径（如 work/2025-01/project-x）" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const err = rejectUnsafePath(params.path, "tdai_read_scene");
      if (err) return toolResult(err);
      const client = makeClient(ctx);
      const { content } = await client.readScenario({ path: params.path });
      return toolResult(truncate(content ?? "（场景内容为空）"));
    },
    renderResult: renderToolResult,
  }),

  // 4. 技能搜索
  defineTool({
    name: "tdai_skill_search",
    label: "搜索技能",
    description: "搜索团队技能库（scope=team）。用于查找团队沉淀的编码规范、工作流、工具用法等技能。",
    promptSnippet: "搜索团队技能库",
    parameters: Type.Object({
      query: Type.String({ description: "搜索关键词" }),
      top_k: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = makeClient(ctx);
      const { items } = await client.searchSkills({ query: params.query, top_k: params.top_k, scope: "team" });
      const text =
        items.length === 0
          ? "（无匹配技能）"
          : items
              .map((it, i) => `${i + 1}. ${it.name} (${it.skill_id})${it.description ? ` — ${it.description}` : ""}`)
              .join("\n");
      return toolResult(truncate(text));
    },
    renderResult: renderToolResult,
  }),

  // 5. 技能详情
  defineTool({
    name: "tdai_skill_view",
    label: "查看技能",
    description: "查看技能详情（SKILL.md 内容 + manifest 元数据）。用于完整理解一个技能。",
    promptSnippet: "查看技能详情",
    parameters: Type.Object({
      skill_id: Type.String({ description: "技能 id（来自 tdai_skill_search）" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = makeClient(ctx);
      const data = await client.getSkill({
        skill_id: params.skill_id,
        include_content: true,
        include_manifest: true,
      });
      const parts: string[] = [];
      const skill = data.skill as { name?: string; description?: string } | undefined;
      if (skill?.name) parts.push(`# ${skill.name}`);
      if (skill?.description) parts.push(skill.description);
      const skillContent = safeStr(data.content);
      if (skillContent) parts.push(skillContent);
      const manifest = data.manifest;
      if (manifest !== undefined && manifest !== null) {
        parts.push(`manifest: ${JSON.stringify(manifest)}`);
      }
      return toolResult(truncate(parts.join("\n\n") || "（技能内容为空）"));
    },
    renderResult: renderToolResult,
  }),

  // 6. 技能文件读取
  defineTool({
    name: "tdai_skill_files_read",
    label: "读取技能文件",
    description: "读取技能包内资源文件（脚本/模板等）。path 为技能包内相对路径。",
    promptSnippet: "读取技能资源文件",
    parameters: Type.Object({
      skill_id: Type.String({ description: "技能 id" }),
      path: Type.String({ description: "技能包内相对路径（如 scripts/setup.sh）" }),
      encoding: Type.Optional(Type.String({ description: "文件编码，默认 utf-8" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const err = rejectUnsafePath(params.path, "tdai_skill_files_read");
      if (err) return toolResult(err);
      const client = makeClient(ctx);
      const data = await client.readSkillFile({
        skill_id: params.skill_id,
        path: params.path,
        encoding: params.encoding,
      });
      const rawContent = data.content ?? data.data;
      const content = safeStr(rawContent);
      return toolResult(truncate(content ?? "（文件为空或为二进制数据）"));
    },
    renderResult: renderToolResult,
  }),

  // 7. 技能提取
  defineTool({
    name: "tdai_skill_extract",
    label: "提取技能",
    description:
      "从当前会话的对话（最近 40 条 user/assistant 消息）中提取新技能到团队技能库。当发现可复用的经验/流程时调用。",
    promptSnippet: "从当前对话提取技能",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: "提取原因/背景说明" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((e) => e.type === "message")
        .map((e) => e.message)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-40)
        .map((m) => ({ role: m.role, content: extractText(m) ?? "" }))
        .filter((m) => m.content.trim());
      if (messages.length === 0) return toolResult("（会话中没有可提取的 user/assistant 消息）");
      const client = makeClient(ctx);
      const data = await client.extractSkill({ messages, reason: params.reason });
      return toolResult(truncate(`已提交技能提取（异步任务）：${JSON.stringify(data)}`));
    },
    renderResult: renderToolResult,
  }),

  // 8. Wiki 搜索
  defineTool({
    name: "tdai_wiki_search",
    label: "搜索知识库",
    description: "【实验中】搜索团队知识库（Wiki）页面。用于查找团队文档、规范、FAQ 等。需开启 wiki.enabled。",
    promptSnippet: "搜索团队知识库",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "wiki id（来自 tdai_wiki_list）" }),
      query: Type.String({ description: "搜索关键词" }),
      limit: Type.Optional(Type.Number({ description: "返回条数，默认 5" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = makeClient(ctx);
      const { results } = await client.wikiSearch({
        wiki_id: params.wiki_id,
        query: params.query,
        limit: params.limit,
      });
      const text =
        results.length === 0
          ? "（无匹配页面）"
          : results
              .map((r, i) => {
                const title = r.title ?? r.path ?? "(无标题)";
                const score = typeof r.score === "number" ? ` (score ${r.score.toFixed(3)})` : "";
                const snippet = r.snippet ? `\n   ${r.snippet}` : "";
                return `${i + 1}. ${title}${score}${snippet}`;
              })
              .join("\n");
      return toolResult(truncate(text));
    },
    renderResult: renderToolResult,
  }),

  // 9. Wiki 页面读取（服务端要求 refs 数组）
  defineTool({
    name: "tdai_wiki_page_read",
    label: "读取知识库页面",
    description: "【实验中】读取团队知识库（Wiki）页面全文。page_path 来自 tdai_wiki_search 结果（ref 字段）。需开启 wiki.enabled。",
    promptSnippet: "读取知识库页面全文",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "wiki id" }),
      page_path: Type.String({ description: "页面 ref 路径（如 docs/architecture/overview）" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const err = rejectUnsafePath(params.page_path, "tdai_wiki_page_read");
      if (err) return toolResult(err);
      const client = makeClient(ctx);
      return client
        .wikiPageRead({ wiki_id: params.wiki_id, refs: [params.page_path] })
        .then((data) => {
          const item = (data.items ?? [])[0];
          const content = safeStr(item?.content);
          return toolResult(truncate(content ?? "（页面内容为空）"));
        });
    },
    renderResult: renderToolResult,
  }),

  // 10. Wiki 页面写入（知识库加工）
  defineTool({
    name: "tdai_wiki_page_write",
    label: "写入知识库页面",
    description:
      "【实验中】写入/更新团队知识库（Wiki）页面（知识库加工）。当用户要求把文档/结论沉淀到知识库时调用；写入后服务端会加 locked 标记。需开启 wiki.enabled。",
    promptSnippet: "写入知识库页面",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "wiki id（来自 tdai_wiki_list）" }),
      pages: Type.Array(
        Type.Object({
          ref: Type.String({ description: "页面 ref 路径（如 docs/architecture/overview）" }),
          content: Type.String({ description: "页面 Markdown 内容" }),
          title: Type.Optional(Type.String({ description: "页面标题（可选）" })),
        }),
        { description: "要写入的页面列表（至少 1 个）" },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      for (const page of params.pages) {
        const err = rejectUnsafePath(page.ref, "tdai_wiki_page_write");
        if (err) return toolResult(err);
      }
      const client = makeClient(ctx);
      const data = await client.wikiPageWrite({
        wiki_id: params.wiki_id,
        pages: params.pages.map((p) => ({ ref: p.ref, content: p.content, title: p.title })),
      });
      const written = (data.items ?? [])
        .map((it) => `${it.ref}${it.locked_injected ? " (已锁定)" : ""}`)
        .join(", ");
      return toolResult(truncate(`已写入 ${(data.items ?? []).length} 个页面：${written}`));
    },
    renderResult: renderToolResult,
  }),

  // 10b. Wiki 知识库加工（raw 素材 + LLM ingest）
  defineTool({
    name: "tdai_wiki_ingest",
    label: "知识库加工",
    description:
      "【实验中】知识库加工：上传原始素材（文档/笔记/代码片段）到 wiki，并触发 LLM 异步加工生成页面 + 索引。" +
      "当用户要求把资料沉淀到知识库时优先使用（区别于 tdai_wiki_page_write 的直接写页面）。加工为异步任务，完成后可通过 tdai_wiki_search 检索。需开启 wiki.enabled。",
    promptSnippet: "知识库加工（素材→LLM生成页面）",
    parameters: Type.Object({
      wiki_id: Type.String({ description: "wiki id（来自 tdai_wiki_list）" }),
      files: Type.Array(
        Type.Object({
          filename: Type.String({ description: "素材文件名（如 pi-extension-notes.md，不要带 sources/ 前缀）" }),
          content: Type.String({ description: "素材 Markdown/文本内容" }),
        }),
        { description: "要加工的原始素材（1-50 个）" },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      for (const f of params.files) {
        const err = rejectUnsafePath(f.filename, "tdai_wiki_ingest");
        if (err) return toolResult(err);
      }
      const client = makeClient(ctx);
      const written = await client.wikiRawWrite({ wiki_id: params.wiki_id, files: params.files });
      const sizes = (written.items ?? []).map((it) => `${it.filename}(${it.size ?? "?"}B)`).join(", ");
      const ingest = await client.wikiIngest({ wiki_id: params.wiki_id });
      return toolResult(
        truncate(`已上传素材 ${(written.items ?? []).length} 个：${sizes}\nLLM 加工已触发：${JSON.stringify(ingest)}`),
      );
    },
    renderResult: renderToolResult,
  }),

  // 11. Wiki 列表
  defineTool({
    name: "tdai_wiki_list",
    label: "列出知识库",
    description: "【实验中】列出团队知识库（Wiki）列表及状态。用于确定可搜索的 wiki_id。需开启 wiki.enabled。",
    promptSnippet: "列出团队知识库",
    parameters: Type.Object({
      team_id: Type.Optional(Type.String({ description: "团队 id，默认当前团队" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = makeClient(ctx);
      return client
        .wikiList({ team_id: params.team_id })
        .then(({ items }) => {
          const text =
            items.length === 0
              ? "（无 wiki）"
              : items
                  .map((w, i) => {
                    const pages = typeof w.page_count === "number" ? `，${w.page_count} 页` : "";
                    const summary = w.summary ? ` — ${w.summary}` : "";
                    return `${i + 1}. ${w.name} (${w.wiki_id}) [${w.status}]${pages}${summary}`;
                  })
                  .join("\n");
          return toolResult(truncate(text));
        });
    },
    renderResult: renderToolResult,
  }),

  // 12. Wiki 创建
  defineTool({
    name: "tdai_wiki_create",
    label: "创建知识库",
    description:
      "【实验中】创建团队知识库（Wiki）。幂等：同名已存在时返回已创建的 wiki。创建后为 draft 状态，需用 tdai_wiki_ingest 上传素材并触发加工。需开启 wiki.enabled。",
    promptSnippet: "创建知识库",
    parameters: Type.Object({
      name: Type.String({ description: "知识库名称（同一团队内应唯一）" }),
      team_id: Type.Optional(Type.String({ description: "团队 id，默认当前团队" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = makeClient(ctx);
      const w = await client.wikiCreate({ team_id: params.team_id, name: params.name });
      return toolResult(
        truncate(`已创建知识库：${w.name} (${w.wiki_id}) [${w.status}]\n下一步：用 tdai_wiki_ingest 上传素材触发加工`),
      );
    },
    renderResult: renderToolResult,
  }),

  // 13. Wiki 删除
  defineTool({
    name: "tdai_wiki_delete",
    label: "删除知识库",
    description: "【实验中】批量删除知识库（Wiki）。危险操作：会删除该 wiki 的全部页面与素材，删除前请与用户确认。需开启 wiki.enabled。",
    promptSnippet: "删除知识库",
    parameters: Type.Object({
      wiki_ids: Type.Array(Type.String({ description: "要删除的 wiki id 列表（来自 tdai_wiki_list）" }), {
        description: "要删除的 wiki（1-100 个）",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const client = makeClient(ctx);
      const r = await client.wikiDelete({ wiki_ids: params.wiki_ids });
      return toolResult(truncate(`已删除 ${r.deleted_ids.length} 个知识库：${r.deleted_ids.join(", ")}${r.failed.length ? `\n失败：${JSON.stringify(r.failed)}` : ""}`));
    },
    renderResult: renderToolResult,
  }),
];

// =============================================================================
// 扩展入口
// =============================================================================

export default async function tdaiMemoryExtension(pi: ExtensionAPI): Promise<void> {
  const log = makeLogger(pi);
  config = loadConfig();

  // 缺凭证：降级为只注册 /tdai-setup，不注册 hooks/工具（首次安装可正常加载）
  // endpoint 也纳入校验：配齐了三元组但漏了 endpoint 会全量激活后每轮超时
  const needsSetup = !config.endpoint || !config.apiKey || !config.teamId || !config.userId;
  if (needsSetup) {
    log.warn("[tdai-memory] 缺少 apiKey/teamId/userId，降级为仅 /tdai-setup 模式（配置后 /reload 生效）");
  }

  // /tdai-setup 命令
  pi.registerCommand("tdai-setup", {
    description: "配置 tdai-memory（endpoint/apiKey/teamId/userId/gatewayToken）并测试连接",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("请在 TUI 模式运行 /tdai-setup（RPC/print 模式不支持交互配置）", "warning");
        return;
      }
      // 菜单式配置：预填当前生效值（含 env；避免用 env 配置的用户打开菜单看到空值）
      const existing = loadConfig();
      let endpoint = existing.endpoint;
      let apiKey = existing.apiKey;
      let gatewayToken = existing.gatewayToken || "";
      let teamId = existing.teamId;
      let userId = existing.userId;

      const mask = (s: string) => (s ? `${s.slice(0, 4)}****${s.slice(-4)}` : "(空)");
      const SEP = "──────────────";
      const SAVE_TEST = "测试连接并保存";
      const SAVE_DIRECT = "直接保存";
      const CANCEL = "取消";
      const buildMenu = () => [
        `endpoint:        ${endpoint || "(空)"}`,
        `apiKey:          ${mask(apiKey)}`,
        `gatewayToken:    ${mask(gatewayToken)}${gatewayToken ? "" : "  (直连模式)"}`,
        `teamId:          ${teamId || "(空)"}`,
        `userId:          ${userId || "(空)"}`,
        SEP,
        SAVE_TEST,
        SAVE_DIRECT,
        CANCEL,
      ];

      for (;;) {
        const choice = await ctx.ui.select("tdai-memory 配置（选一项修改或保存）", buildMenu());
        if (choice === undefined) return; // Esc
        // 用值匹配而非脆弱的索引（数组中间的分隔符会使后续项 idx 错位）
        if (choice.startsWith("endpoint:")) {
          const v = await ctx.ui.input("endpoint", endpoint || "http://your-host:8420");
          if (v === undefined) continue;
          endpoint = v;
        } else if (choice.startsWith("apiKey:")) {
          const v = await ctx.ui.input("apiKey", apiKey || "sk-mem-...");
          if (v === undefined) continue;
          apiKey = v;
        } else if (choice.startsWith("gatewayToken:")) {
          const v = await ctx.ui.input("gatewayToken (可选，直连模式留空)", gatewayToken);
          if (v === undefined) continue;
          gatewayToken = v;
        } else if (choice.startsWith("teamId:")) {
          const v = await ctx.ui.input("teamId", teamId);
          if (v === undefined) continue;
          teamId = v;
        } else if (choice.startsWith("userId:")) {
          const v = await ctx.ui.input("userId", userId);
          if (v === undefined) continue;
          userId = v;
        } else if (choice === SEP) {
          continue; // 分隔符不可选（兜底）
        } else if (choice === SAVE_TEST) {
          // 测试连接并保存
          try {
            const client = new MemoryClient({
              endpoint,
              apiKey,
              gatewayToken: gatewayToken || undefined,
              serviceId: existing.serviceId,
              teamId,
              userId,
            });
            await client.listAgents({ team_id: teamId, owner_user_id: userId });
            ctx.ui.notify("连接成功 ✓，保存配置中", "info");
          } catch (error) {
            const saveAnyway = await ctx.ui.confirm("连接失败", `无法连接：${errorMsg(error)}\n仍要保存吗？`);
            if (!saveAnyway) continue;
          }
        } else if (choice === SAVE_DIRECT) {
          // 直接保存
        } else if (choice === CANCEL) {
          return; // 取消
        } else {
          return; // 未知项，安全退出
        }

        if (choice === SAVE_TEST || choice === SAVE_DIRECT) {
          try {
            // 初始化步骤：若尚未绑定固定 agent，让用户选择「绑定已有」或「新建」
            let fixedAgentId = existing.fixedAgentId || "";
            if (!fixedAgentId) {
              const client = new MemoryClient({
                endpoint,
                apiKey,
                gatewayToken: gatewayToken || undefined,
                serviceId: existing.serviceId,
                teamId,
                userId,
              });
              // 拉取团队已有 agents（限当前用户）
              let existingAgents: AgentInfo[] = [];
              try {
                const r = await client.listAgents({ team_id: teamId, owner_user_id: userId });
                existingAgents = (r?.items ?? []).filter((a) => a.status === "active");
              } catch { /* 列表拉取失败不阻断，仅无法提供选择 */ }

              if (existingAgents.length > 0) {
                const menuLabels = [
                  ...existingAgents.map((a) => `绑定已有: ${a.name} (${a.agent_id})`),
                  "──────",
                  "新建 agent",
                  "取消",
                ];
                const sel = await ctx.ui.select("选择要绑定的 agent（或新建）", menuLabels);
                if (sel === undefined) return; // Esc 取消保存
                const existingPick = existingAgents.find((a) => `绑定已有: ${a.name} (${a.agent_id})` === sel);
                if (existingPick) {
                  fixedAgentId = existingPick.agent_id;
                  ctx.ui.notify(`已绑定已有 agent: ${existingPick.name}`, "info");
                } else if (sel === "新建 agent") {
                  const name = deriveAgentName(ctx.cwd || process.cwd());
                  const agent = await client.createAgent({
                    team_id: teamId,
                    owner_user_id: userId,
                    name,
                    description: `pi coding agent for ${ctx.cwd || process.cwd()}`,
                    metadata_json: JSON.stringify({ cwd: ctx.cwd || process.cwd(), init: true }),
                  });
                  fixedAgentId = agent.agent_id;
                  ctx.ui.notify(`已创建并绑定 agent: ${agent.name} (${agent.agent_id})`, "info");
                } else {
                  return; // 取消
                }
              } else {
                // 无已有 agent：直接新建
                const name = deriveAgentName(ctx.cwd || process.cwd());
                const agent = await client.createAgent({
                  team_id: teamId,
                  owner_user_id: userId,
                  name,
                  description: `pi coding agent for ${ctx.cwd || process.cwd()}`,
                  metadata_json: JSON.stringify({ cwd: ctx.cwd || process.cwd(), init: true }),
                });
                fixedAgentId = agent.agent_id;
                ctx.ui.notify(`已创建并绑定 agent: ${agent.name} (${agent.agent_id})`, "info");
              }
            }
            writeConfig({ ...existing, endpoint, apiKey, gatewayToken, teamId, userId, fixedAgentId });
            ctx.ui.notify("配置已保存，运行 /reload 生效", "info");
          } catch (error) {
            ctx.ui.notify(`保存配置失败: ${errorMsg(error)}`, "error");
          }
          return;
        }
      }
    },
  });

  if (needsSetup) return;

  // 注册工具：wiki 工具（tdai_wiki_*）仅当 config.wiki.enabled=true 时注册（实验中，默认关闭）
  const isWikiTool = (name: string) => name.startsWith("tdai_wiki_");
  for (const tool of tdaiTools) {
    if (isWikiTool(tool.name) && !config.wiki.enabled) continue;
    pi.registerTool(tool);
  }

  // -------------------------------------------------------------------------
  // before_agent_start：召回 + 注入（L1 消息注入 + L3/L2/systemPrompt 追加）
  // -------------------------------------------------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const out: BeforeAgentStartEventResult = {};
    try {
      // 召回等关键路径用 5s 短超时：后端不可达时避免每轮卡 15s
      const client = makeClient(ctx, 5000);
      const result = await performRecall({
        client,
        sessionId,
        query: event.prompt,
        maxResults: config.recall.maxResults,
        includePersona: config.recall.includePersona,
        includeSceneNav: config.recall.includeSceneNav,
        cache: l3l2Cache,
      });
      if (result.systemContext) {
        out.systemPrompt = `${event.systemPrompt}\n\n${result.systemContext}`;
      }
      if (result.prependContext) {
        out.message = {
          customType: "tdai-recall",
          content: result.prependContext,
          display: false,
        };
      }
    } catch (error) {
      log.warn(`[tdai-memory] recall 失败（不阻断本轮）: ${errorMsg(error)}`);
    }
    // 缓存干净 prompt（供 agent_end 替换被污染的 user 消息）
    pendingPrompt.set(sessionId, { text: event.prompt, ts: Date.now() });
    return out;
  });

  // -------------------------------------------------------------------------
  // agent_end：捕获本回合写 L0（fire-and-forget，不 await）
  // -------------------------------------------------------------------------
  pi.on("agent_end", (event, ctx) => {
    if (!config.capture.enabled) return;
    const messages = event.messages ?? [];
    if (messages.length === 0) return;

    const sessionId = ctx.sessionManager.getSessionId();
    // 立即删 pendingPrompt（防下轮 before_agent_start 覆盖竞态）
    const pending = pendingPrompt.get(sessionId);
    pendingPrompt.delete(sessionId);
    // 新鲜度校验：仅当 prompt 是本轮（10 分钟内）缓存的才用于污染替换，防跨轮误用
    const originalUserText =
      pending && Date.now() - pending.ts < PENDING_PROMPT_TTL_MS ? pending.text : undefined;

    // 失败回合跳过：AgentEndEvent 无 success 字段，检查最后一条 assistant 的 errorMessage
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant") {
        if ((m as { errorMessage?: string }).errorMessage) return;
        break;
      }
    }

    const client = makeClient(ctx);
    const cursor = sessionCursors.get(sessionId);

    // fire-and-forget：不 await，pi 在 agent_end 处理器 settle 前保持 isStreaming=true
    const capturePromise = performCapture({
      client,
      sessionId,
      rawMessages: messages,
      afterTimestamp: cursor,
      originalUserText,
    })
      .then((result) => {
        if (result.captured) {
          // 游标只前进不回退（retry/compaction 可能并发多轮 capture，防止重复写入）
          if (result.maxTimestamp !== undefined) {
            const prev = sessionCursors.get(sessionId);
            sessionCursors.set(sessionId, Math.max(prev ?? 0, result.maxTimestamp));
          }
          log.info(`[tdai-memory] L0 已捕获 ${result.messageCount} 条`);
        }
      })
      .catch((error) => {
        log.warn(`[tdai-memory] L0 捕获失败: ${errorMsg(error)}`);
      })
      .finally(() => {
        inflightCaptures.delete(capturePromise);
      });
    inflightCaptures.add(capturePromise);
  });

  // -------------------------------------------------------------------------
  // session_shutdown：等进行中的 capture（最多 3s），清会话级状态
  // -------------------------------------------------------------------------
  pi.on("session_shutdown", async () => {
    if (inflightCaptures.size > 0) {
      await Promise.race([
        Promise.allSettled([...inflightCaptures]),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    pendingPrompt.clear();
    sessionCursors.clear();
    sessionAgentId.clear();
    l3l2Cache.clear();
    // 注意：不清 cwdAgentId（多会话共享 cwd 映射）
  });
}

// 模块级可变引用（供辅助函数访问；每次扩展加载重新初始化）
let config: TdaiConfig = DEFAULT_CONFIG;
