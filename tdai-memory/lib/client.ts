/**
 * MemoryClient — MemoryCore HTTP API 客户端（三套鉴权 + Gateway 可选兼容）。
 *
 * - 数据层 `/v3/conversation|atomic|scenario|core|skill/*`：Bearer + x-tdai-service-id，body 带三元组
 * - meta 层 `/v3/meta/*`：x-tdai-user-key + x-tdai-service-id，body 原样
 * - Wiki 层 `/v3/wiki/*`（hub 容器 8424）：Bearer + x-tdai-service-id，body 只带 team_id
 *
 * Gateway 兼容：配置 gatewayToken 后，所有层改用 gatewayToken 作为 Bearer token，
 * apiKey 则作为 meta 层的 x-tdai-user-key。不配 gatewayToken 时行为与之前一致。
 *
 * 统一响应体 `{ code, data, message? }`：code === 0 成功（Wiki 例外：code === 200 也算成功）。
 */

import { createHash } from "node:crypto";

export interface MemoryClientOptions {
  /** MemoryCore core 容器地址，如 http://your-host:8420 */
  endpoint: string;
  /** 数据层 / Wiki 层 Bearer token（未配 gatewayToken 时也用于 meta 层 x-tdai-user-key） */
  apiKey: string;
  /** Gateway Bearer token（可选，配置后所有层使用此 token 做 Bearer 鉴权，apiKey 改为仅用于 meta 层 x-tdai-user-key） */
  gatewayToken?: string;
  /** 服务标识 */
  serviceId?: string;
  /** 团队 id（三元组之一） */
  teamId: string;
  /** 用户 id（三元组之一） */
  userId: string;
  /** agent id（三元组之一；由项目级 agent 注册或 fixedAgentId 提供） */
  agentId?: string;
  /** 会话 id（conversation/add 的 session_id 默认值） */
  sessionId?: string;
  /** 请求超时（毫秒），默认 15000 */
  timeoutMs?: number;
  /** 自定义 fetch（可选，便于测试注入 mock；默认用 globalThis.fetch） */
  fetch?: typeof globalThis.fetch;
}

export interface AgentInfo {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface ConversationMessage {
  role: string;
  content: string;
  /** 后端要求 ISO 字符串（如 2026-08-05T10:14:30.932Z）；number 会被 HTTP 400 拒绝 */
  timestamp?: string;
}

export interface SearchResultItem {
  id?: string;
  content: string;
  type?: string;
  score?: number;
}

export interface ScenarioEntry {
  path: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SkillItem {
  skill_id: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface WikiResultItem {
  title?: string;
  path?: string;
  snippet?: string;
  content?: string;
  score?: number;
}

export interface WikiInfo {
  wiki_id: string;
  name: string;
  status: string;
  page_count?: number;
  summary?: string;
}

/** hub 容器端口（Wiki 层部署在 hub 8424，由 core 8420 推导；可用 TDAI_MEMORY_HUB_PORT 覆盖，便于本机 mock 测试）。 */
export const HUB_PORT = process.env.TDAI_MEMORY_HUB_PORT ?? "8424";

/** 并发创建重名错误特征（用于 create 失败后重试复用）。 */
const DUP_NAME_RE = new RegExp("exist|duplicate|conflict|already|same name", "i");

/**
 * 规范化 endpoint：去除尾部斜杠（1 个或多个），避免拼 URL 时出现 `//v3/...` 双斜杠。
 * 兼容用户在配置中填 `http://host:8420/` 带尾斜杠的情况。
 * 仅处理 http(s) URL；非 URL（如 raw host）原样返回。 */
export function normalizeEndpoint(endpoint: string): string {
  if (!endpoint) return endpoint;
  return endpoint.replace(/\/+$/, "");
}

/**
 * 由 core endpoint 推导 hub endpoint：
 * 1. URL 解析成功后 set port=HUB_PORT（默认 8424）
 * 2. 解析失败回退正则替换末尾端口
 */
export function hubEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (!/^https?:$/i.test(url.protocol)) throw new Error("not an http(s) URL");
    url.port = HUB_PORT;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return endpoint.replace(/:\d+\/?$/, `:${HUB_PORT}`).replace(/\/+$/, "");
  }
}

/**
 * 按 cwd 推导项目级 agent 名：`pi-{basename}-{cwdHash8}`。
 *
 * 设计要点：
 * - basename 保留可读性（sanitize 只留 [a-zA-Z0-9_-]，截断 24 字符）
 * - 追加 cwd 的 SHA-256 前 8 位，避免不同路径同 basename 的项目碰撞串台
 *   （如 C:/work/app 与 D:/projects/app 都叫 pi-app → 现在分别是 pi-app-cdccd355 / pi-app-xxxxxxxx）
 * - basename 字面为 "home"（如 Termux .../files/home）或 sanitize 后空 → 用 "home"
 * - 名称总长度不超过 50 字符（pi- + 24 + - + 8 = 38，有余量）
 *
 * 向后兼容：旧版名称为 `pi-{basename}`（无哈希）。resolveProjectAgent 会先查新名，
 * 再查旧名做迁移。 */
export function deriveAgentName(cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const dir = base === "" ? "home" : base.split(/[\\/]/).pop() ?? "home";
  let basename: string;
  if (dir === "home") {
    basename = "home";
  } else {
    const sanitized = dir.replace(/[^a-zA-Z0-9_-]/g, "");
    basename = sanitized || "home";
  }
  basename = basename.slice(0, 24);
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `pi-${basename}-${hash}`;
}

/**
 * 旧版 agent 名（无哈希），仅用于迁移查询：查到后复用其 agent_id。
 * 返回空串表示无旧名可查（如 cwd basename 为空等极端情况）。 */
export function legacyAgentName(cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const dir = base === "" ? "home" : base.split(/[\\/]/).pop() ?? "home";
  let name: string;
  if (dir === "home") {
    name = "pi-home";
  } else {
    const sanitized = dir.replace(/[^a-zA-Z0-9_-]/g, "");
    name = `pi-${sanitized || "home"}`;
  }
  return name.slice(0, 40);
}

type Layer = "data" | "meta" | "wiki";

export class MemoryClient {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly gatewayToken: string | undefined;
  readonly serviceId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly agentId: string | undefined;
  readonly sessionId: string | undefined;
  readonly timeoutMs: number;
  /** 自定义 fetch（默认 globalThis.fetch）。 */
  readonly fetchImpl: typeof globalThis.fetch;

  constructor(opts: MemoryClientOptions) {
    this.endpoint = normalizeEndpoint(opts.endpoint);
    this.apiKey = opts.apiKey;
    this.gatewayToken = opts.gatewayToken || undefined;
    this.serviceId = opts.serviceId ?? "default";
    this.teamId = opts.teamId;
    this.userId = opts.userId;
    this.agentId = opts.agentId;
    this.sessionId = opts.sessionId;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * 按会话/agent 收敛返回新实例（浅拷贝 opts，避免共享引用）。
   * agentId 覆盖为传入值；sessionId 用于 conversation/add 的默认 session_id。
   */
  withIsolation(opts: { sessionId?: string; agentId?: string }): MemoryClient {
    return new MemoryClient({
      endpoint: this.endpoint,
      apiKey: this.apiKey,
      gatewayToken: this.gatewayToken,
      serviceId: this.serviceId,
      teamId: this.teamId,
      userId: this.userId,
      agentId: opts.agentId ?? this.agentId,
      sessionId: opts.sessionId ?? this.sessionId,
      timeoutMs: this.timeoutMs,
    });
  }

  // ---------------------------------------------------------------------------
  // 底层请求
  // ---------------------------------------------------------------------------

  /**
   * 统一 POST 请求。所有 fetch 的 res.text() 受 `signal: AbortSignal.timeout(...)` 保护，
   * timeout 是整体有界兜底（连接/响应头/响应体都受其约束）。
   *
   * Gateway 兼容：
   * - 配置了 gatewayToken 时，所有层使用 gatewayToken 作为 Bearer token，
   *   apiKey 仅用于 meta 层的 x-tdai-user-key
   * - 未配置 gatewayToken 时，行为与之前一致（apiKey 同时用于 Bearer 和 x-tdai-user-key）
   */
  private async request(
    path: string,
    body: Record<string, unknown>,
    layer: Layer,
    timeoutMs?: number,
  ): Promise<unknown> {
    const ms = timeoutMs ?? this.timeoutMs;
    // Wiki 层 URL：Gateway 模式（有 gatewayToken）走原 endpoint，由网关统一路由 /v3/*；
    // 直连模式才用 hubEndpoint 推导 hub 端口（core 8420 + hub 8424 分端口部署）
    const wikiBase = this.gatewayToken ? this.endpoint : hubEndpoint(this.endpoint);
    const url = layer === "wiki" ? `${wikiBase}${path}` : `${this.endpoint}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-tdai-service-id": this.serviceId,
    };

    if (this.gatewayToken) {
      // Gateway 模式：所有层用 gatewayToken 做 Bearer，apiKey 仅用于 meta 层 x-tdai-user-key
      headers["Authorization"] = `Bearer ${this.gatewayToken}`;
    }

    let payload: Record<string, unknown>;
    if (layer === "meta") {
      // meta 层：x-tdai-user-key（始终使用 apiKey），body 原样
      headers["x-tdai-user-key"] = this.apiKey;
      payload = body;
    } else {
      if (!this.gatewayToken) {
        // 非 Gateway 模式：数据层/Wiki 层用 apiKey 做 Bearer（原始行为）
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }
      if (layer === "data") {
        // 数据层：body 注入三元组
        payload = { ...body, team_id: this.teamId, user_id: this.userId };
        if (this.agentId) payload.agent_id = this.agentId;
      } else {
        // Wiki 层：Bearer + service-id，只带 team_id（不带 agent_id）；body 自带 team_id 时尊重调用方
        payload = { ...body };
        if (!payload.team_id) payload.team_id = this.teamId;
      }
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(ms),
      });
    } catch (error) {
      throw new Error(
        `MemoryCore ${path} network error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let text = "";
    try {
      text = await res.text();
    } catch (error) {
      throw new Error(
        `MemoryCore ${path} read error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // HTTP 状态检查：非 2xx 直接报错（后端可能返回 {code:0} 的错误响应体，不能当成功）
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const err = JSON.parse(text) as { message?: string; error?: string };
        if (err?.message) detail += `: ${err.message}`;
        else if (err?.error) detail += `: ${err.error}`;
      } catch {
        // 非 JSON body，保留状态码信息
      }
      throw new Error(`MemoryCore ${path} error: ${detail}`);
    }

    let parsed: { code?: number; data?: unknown; message?: string } | undefined;
    try {
      parsed = JSON.parse(text) as { code?: number; data?: unknown; message?: string };
    } catch {
      throw new Error(`MemoryCore ${path} error: invalid JSON response (HTTP ${res.status})`);
    }

    const code = parsed?.code;
    const ok = layer === "wiki" ? code === 0 || code === 200 : code === 0;
    if (!ok) {
      throw new Error(
        `MemoryCore ${path} error: ${parsed?.message ?? String(code ?? res.status)}`,
      );
    }
    return parsed?.data;
  }

  private postData(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.request(path, body, "data", timeoutMs);
  }

  private postMeta(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.request(path, body, "meta", timeoutMs);
  }

  private postWiki(path: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    return this.request(path, body, "wiki", timeoutMs);
  }

  // ---------------------------------------------------------------------------
  // L0 对话
  // ---------------------------------------------------------------------------

  /** 写入原始对话消息（L0）。session_id 缺省用实例的 sessionId。 */
  async addConversation(
    input: { session_id?: string; messages: ConversationMessage[] },
  ): Promise<{ total_count: number; accepted_ids?: string[] }> {
    const data = (await this.postData("/v3/conversation/add", {
      session_id: input.session_id ?? this.sessionId ?? "",
      messages: input.messages,
    })) as { total_count: number; accepted_ids?: string[] };
    return data;
  }

  /** 按 query 召回历史对话（L0）。 */
  async searchConversation(
    input: { query: string; limit?: number; session_id?: string },
  ): Promise<{ messages: Array<{ role: string; content: string; timestamp?: string; score?: number }> }> {
    return (await this.postData("/v3/conversation/search", {
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
    })) as { messages: Array<{ role: string; content: string; timestamp?: string; score?: number }> };
  }

  // ---------------------------------------------------------------------------
  // L1 原子记忆
  // ---------------------------------------------------------------------------

  /** 召回结构化原子记忆（偏好/事件/规则/事实）。 */
  async searchAtomic(
    input: { query: string; limit?: number; type?: string },
  ): Promise<{ items: SearchResultItem[] }> {
    return (await this.postData("/v3/atomic/search", {
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.type ? { type: input.type } : {}),
    })) as { items: SearchResultItem[] };
  }

  // ---------------------------------------------------------------------------
  // L2 场景
  // ---------------------------------------------------------------------------

  /** 场景索引（L2）。 */
  async listScenarios(): Promise<{ entries: ScenarioEntry[]; total: number }> {
    return (await this.postData("/v3/scenario/ls", {})) as { entries: ScenarioEntry[]; total: number };
  }

  /** 场景全文（L2）。 */
  async readScenario(input: { path: string }): Promise<{ content: string; created_at?: string; updated_at?: string }> {
    return (await this.postData("/v3/scenario/read", { path: input.path })) as {
      content: string;
      created_at?: string;
      updated_at?: string;
    };
  }

  // ---------------------------------------------------------------------------
  // L3 核心画像
  // ---------------------------------------------------------------------------

  /** 读取单条核心画像（L3）。 */
  async readCore(): Promise<{ content: string | null; created_at?: string; updated_at?: string }> {
    return (await this.postData("/v3/core/read", {})) as {
      content: string | null;
      created_at?: string;
      updated_at?: string;
    };
  }

  // ---------------------------------------------------------------------------
  // 技能库
  // ---------------------------------------------------------------------------

  /** 搜索团队技能。 */
  async searchSkills(
    input: { query: string; top_k?: number; scope?: string },
  ): Promise<{ items: SkillItem[] }> {
    return (await this.postData("/v3/skill/search", {
      query: input.query,
      ...(input.top_k !== undefined ? { top_k: input.top_k } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    })) as { items: SkillItem[] };
  }

  /** 获取技能详情（含 content / manifest）。 */
  async getSkill(
    input: { skill_id: string; include_content?: boolean; include_manifest?: boolean },
  ): Promise<{ skill: SkillItem; content?: string; [key: string]: unknown }> {
    return (await this.postData("/v3/skill/get", {
      skill_id: input.skill_id,
      ...(input.include_content !== undefined ? { include_content: input.include_content } : {}),
      ...(input.include_manifest !== undefined ? { include_manifest: input.include_manifest } : {}),
    })) as { skill: SkillItem; content?: string; [key: string]: unknown };
  }

  /** 读取技能资源文件。 */
  async readSkillFile(
    input: { skill_id: string; path: string; encoding?: string },
  ): Promise<{ content?: string; data?: string; [key: string]: unknown }> {
    return (await this.postData("/v3/skill/files/read", {
      skill_id: input.skill_id,
      path: input.path,
      ...(input.encoding ? { encoding: input.encoding } : {}),
    })) as { content?: string; data?: string; [key: string]: unknown };
  }

  /** 从对话提取技能（异步任务）。 */
  async extractSkill(
    input: { messages: Array<{ role: string; content: string }>; reason?: string },
  ): Promise<unknown> {
    return this.postData("/v3/skill/extract", {
      messages: input.messages,
      ...(input.reason ? { reason: input.reason } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // meta 层：agent 管理（x-tdai-user-key，不带三元组）
  // ---------------------------------------------------------------------------

  /** 列出 agent。 */
  async listAgents(
    input: { team_id: string; owner_user_id?: string; name?: string },
  ): Promise<{ items: AgentInfo[] }> {
    return (await this.postMeta("/v3/meta/agent/list", {
      team_id: input.team_id,
      ...(input.owner_user_id ? { owner_user_id: input.owner_user_id } : {}),
      ...(input.name ? { name: input.name } : {}),
    })) as { items: AgentInfo[] };
  }

  /** 创建 agent。 */
  async createAgent(
    input: { team_id: string; owner_user_id: string; name: string; description?: string; metadata_json?: string },
  ): Promise<AgentInfo> {
    return (await this.postMeta("/v3/meta/agent/create", {
      team_id: input.team_id,
      owner_user_id: input.owner_user_id,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.metadata_json ? { metadata_json: input.metadata_json } : {}),
    })) as AgentInfo;
  }

  /**
   * 解析项目级 agent：查新名复用 → 查旧名迁移（可选）→ create → 并发竞态重试。
   *
   * 流程：
   * 1. listAgents(name=新名) 查到 active → 复用（同 cwd 哈希保证不串台）
   * 2. migrateLegacy=true 时查旧名迁移（旧版无哈希后缀，升级期兼容）
   *    ⚠️ 旧名无 cwd 标识，不同项目同 basename 可能串台；新装项目应传 migrateLegacy=false
   * 3. createAgent(新名, metadata={cwd})；create 失败（并发竞态：别人刚建了同名）
   *    → 再 listAgents(新名) 查一次复用
   * 4. 仍无 → 返回 undefined（调用方回退 fixedAgentId）
   *
   * @param cwd 项目工作目录（用于推导名称 + 写入 metadata）
   * @param migrateLegacy 是否迁移旧名 agent（默认 true，兼容 0.2.x；新装可传 false 避免碰撞）
   * @returns agent_id 或 undefined
   */
  async resolveProjectAgent(cwd: string, migrateLegacy = true): Promise<AgentInfo | undefined> {
    const name = deriveAgentName(cwd);
    const legacy = legacyAgentName(cwd);
    const description = `pi coding agent for ${cwd}`;
    const metadataJson = JSON.stringify({ cwd, pi_agent_version: 2 });

    // 1. 新名复用
    const byNew = await this.listAgents({ team_id: this.teamId, owner_user_id: this.userId, name });
    const existingNew = (byNew?.items ?? []).find((a) => a.status === "active");
    if (existingNew) return existingNew;

    // 2. 旧名迁移（旧版本创建的 agent，无哈希后缀；可选，默认开启兼容 0.2.x）
    if (migrateLegacy && legacy && legacy !== name) {
      const byLegacy = await this.listAgents({ team_id: this.teamId, owner_user_id: this.userId, name: legacy });
      const existingLegacy = (byLegacy?.items ?? []).find((a) => a.status === "active");
      if (existingLegacy) return existingLegacy;
    }

    // 3. 创建（带 metadata，便于后续排查）
    try {
      return await this.createAgent({
        team_id: this.teamId,
        owner_user_id: this.userId,
        name,
        description,
        metadata_json: metadataJson,
      });
    } catch (error) {
      // 4. 并发竞态：另一个会话刚创建了同名 agent → 再查一次复用
      const errMsg = error instanceof Error ? error.message : String(error);
      const isDup = DUP_NAME_RE.test(errMsg) || errMsg.includes("409");
      if (isDup) {
        const retry = await this.listAgents({ team_id: this.teamId, owner_user_id: this.userId, name });
        const retryHit = (retry?.items ?? []).find((a) => a.status === "active");
        if (retryHit) return retryHit;
      }
      // 其他错误（鉴权/网络）→ 抛出由调用方决定回退
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Wiki 层（hub 8424，Bearer + service-id，只带 team_id）
  // ---------------------------------------------------------------------------

  /** 搜索 wiki 页面。 */
  async wikiSearch(
    input: { wiki_id: string; query: string; limit?: number },
  ): Promise<{ results: WikiResultItem[] }> {
    return (await this.postWiki("/v3/wiki/search", {
      wiki_id: input.wiki_id,
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })) as { results: WikiResultItem[] };
  }

  /** 写入 wiki 原始素材（知识库加工的第一步：raw 素材 → ingest → LLM 生成页面）。 */
  async wikiRawWrite(
    input: {
      wiki_id: string;
      files: Array<{ filename: string; content: string }>;
    },
  ): Promise<{ items?: Array<{ filename: string; size?: number; [key: string]: unknown }>; [key: string]: unknown }> {
    return (await this.postWiki("/v3/wiki/raw/write", {
      wiki_id: input.wiki_id,
      files: input.files.map((f) => ({ filename: f.filename, content: f.content })),
    })) as { items?: Array<{ filename: string; size?: number; [key: string]: unknown }>; [key: string]: unknown };
  }

  /** 触发 LLM 异步加工（raw/sources → wiki pages + BM25 索引）。 */
  async wikiIngest(input: { wiki_id: string }): Promise<{ wiki_id?: string; status?: string; [key: string]: unknown }> {
    return (await this.postWiki("/v3/wiki/ingest", { wiki_id: input.wiki_id })) as {
      wiki_id?: string;
      status?: string;
      [key: string]: unknown;
    };
  }

  /** 读取 wiki 页面（服务端要求 refs 数组，不是 page_path）。 */
  async wikiPageRead(
    input: { wiki_id: string; refs: string[] },
  ): Promise<{ items?: Array<{ ref: string; content?: string; [key: string]: unknown }>; [key: string]: unknown }> {
    return (await this.postWiki("/v3/wiki/page/read", {
      wiki_id: input.wiki_id,
      refs: input.refs,
    })) as { items?: Array<{ ref: string; content?: string; [key: string]: unknown }>; [key: string]: unknown };
  }

  /** 写入/更新 wiki 页面（知识库加工；服务端会加 locked frontmatter）。 */
  async wikiPageWrite(
    input: {
      wiki_id: string;
      pages: Array<{ ref: string; content: string; title?: string }>;
    },
  ): Promise<{ items?: Array<{ ref: string; locked_injected?: boolean; [key: string]: unknown }>; [key: string]: unknown }> {
    return (await this.postWiki("/v3/wiki/page/write", {
      wiki_id: input.wiki_id,
      pages: input.pages.map((p) => ({
        ref: p.ref,
        content: p.content,
        ...(p.title ? { title: p.title } : {}),
      })),
    })) as { items?: Array<{ ref: string; locked_injected?: boolean; [key: string]: unknown }>; [key: string]: unknown };
  }

  /** 列出团队 wiki。 */
  async wikiList(input: { team_id?: string }): Promise<{ items: WikiInfo[] }> {
    return (await this.postWiki("/v3/wiki/list", {
      ...(input.team_id ? { team_id: input.team_id } : {}),
    })) as { items: WikiInfo[] };
  }

  /** 创建 wiki（幂等：同 (team_id, name) 返回已存在的 wiki）。 */
  async wikiCreate(input: { team_id?: string; name: string }): Promise<WikiInfo> {
    return (await this.postWiki("/v3/wiki/create", {
      ...(input.team_id ? { team_id: input.team_id } : {}),
      name: input.name,
    })) as WikiInfo;
  }

  /** 批量删除 wiki。 */
  async wikiDelete(input: { wiki_ids: string[] }): Promise<{ deleted_ids: string[]; failed: unknown[] }> {
    return (await this.postWiki("/v3/wiki/delete", {
      wiki_ids: input.wiki_ids,
    })) as { deleted_ids: string[]; failed: unknown[] };
  }
}