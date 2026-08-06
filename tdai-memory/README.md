# @yqt5421/pi-tdai-memory

> 为 [pi coding agent](https://pi.dev) 提供 **MemoryCore（TencentDB Agent Memory）长期记忆** 的扩展。
> 直连 MemoryCore 服务端 HTTP API，让 AI coding agent 拥有跨会话的对话记忆、结构化记忆、场景、画像、团队技能库与知识库。
> 支持两种部署模式：**直连模式**（直接访问服务端）与 **Gateway 模式**（经公网网关鉴权，适合多用户共享）。

[![pi](https://img.shields.io/badge/pi-coding--agent-blue)](https://github.com/earendil-works/pi-coding-agent)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## ✨ 功能特性

- **自动捕获（L0）**：每轮对话结束后自动将 user/assistant 消息写入 MemoryCore（失败回合自动跳过、时间戳游标增量、注入标签清洗防回流）
- **自动召回（L1/L2/L3）**：每轮对话前并行召回结构化原子记忆（偏好/事件/规则/事实）+ 核心画像 + 场景索引，注入 system prompt；画像/场景缓存 10 分钟，命中时仅 1 次 HTTP
- **固定 agent 绑定**：初始化（`/tdai-setup`）时选择绑定已有 agent 或新建一个并固定，后续所有会话统一复用该 agent，记忆按 agent 隔离
- **团队技能库**：搜索 / 查看 SKILL.md / 读取资源文件 / 从对话自动提取技能（服务端 LLM 异步生成）
- **知识库（Wiki）**：搜索 / 读取 / 直接写页面 / **LLM 知识库加工**（上传素材 → 异步生成页面与索引）/ 创建 / 删除
- **双部署模式**：直连服务端（`apiKey` 单 token）或经 Gateway 网关（`apiKey` + `gatewayToken` 双凭证，公网共享）
- **菜单式配置**：`/tdai-setup` 菜单式交互，本地已有配置直接预填显示，逐项可选修改；保存时若未绑定 agent，弹出选择「绑定已有 / 新建 / 取消」
- **固定 agent 绑定（初始化）**：首次 `/tdai-setup` 保存时引导绑定一个固定 agent（选已有或新建），写入 `fixedAgentId`，之后所有会话复用，不自动创建
- **项目级配置落盘**：项目级安装的扩展配置写到 `{project}/.pi/tdai-memory.json`（跟着项目走，不被 `pi update` 覆盖）；全局安装回退到 `~/.pi/agent/extensions/tdai-memory/config.json`
- **endpoint 容错**：配置中 endpoint 带尾部斜杠自动规范化，避免拼出 `//v3/...` 双斜杠
- **降级加载**：未配置凭证时扩展正常加载，仅提供 `/tdai-setup` 引导命令
- **零运行时依赖**：纯 `fetch` + `node:fs`，pi 用 jiti 直接加载 TypeScript 源码，无需编译

## 🏗️ 架构

```
┌──────────────┐         ┌─────────────────┐         ┌──────────────────────────────┐
│  pi (本机)    │  Bearer │  Gateway (可选)  │  Bearer │  MemoryCore 服务端           │
│  扩展 14 工具  │────────▶│  公网鉴权网关    │────────▶│  L0 对话 · L1 原子记忆        │
│  hooks 自动   │         │  (mem.xxx.xyz)  │         │  L2 场景 · L3 画像            │
│  捕获/召回    │         └─────────────────┘         │  技能库 · 知识库(Wiki)        │
└──────────────┘                                      └──────────────────────────────┘
       │ 直接模式：跳过 Gateway，apiKey 直接做 Bearer
       └─ meta 层额外发 x-tdai-user-key: <apiKey>（无论是否经 Gateway）
```

- **直连模式**：`apiKey` 同时用于数据层 `Bearer` 与 meta 层 `x-tdai-user-key`，不配 `gatewayToken`
- **Gateway 模式**：`gatewayToken` 用于所有层 `Bearer`，`apiKey` 仅用于 meta 层 `x-tdai-user-key`
- 数据全部存储于 MemoryCore 服务端（团队共享，按 team/agent/user 三元组隔离），本机仅保留连接配置

## 🔌 MemoryCore 服务端搭建（简易）

本项目是 **MemoryCore 客户端**，需要先有一个可用的服务端：

| 路径 | 说明 |
|------|------|
| **TencentDB 托管**（推荐） | 项目地址：[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)。开通后在控制台创建团队，获取 `team_id`、`user_id`、API Key（`sk-mem-...`）与服务地址 |
| **自托管（Hermes 网关）** | 开源仓库提供 Hermes 集成：`docker build -f docker/opensource/Dockerfile.hermes -t hermes-memory .` → `docker run -d -p 8420:8420 ...`（详见仓库 `docker/opensource/README-hermes.md`） |
| **Gateway 公网模式** | 自建 MemoryCore 时开启 gateway 鉴权功能，对外暴露 `https://mem.xxx.xyz`，分发独立 `gatewayToken` 给使用者；使用者各自配 `apiKey`（meta 层用户凭证）+ `gatewayToken`（网关凭证） |

> ⚠️ 开源仓库当前开源的是**客户端插件/SDK**与本地记忆网关；核心服务端能力（`/v3/*` API、LLM 技能提取、知识库加工）为托管服务提供。

## 📦 安装

### 方式一：npm 包（推荐）

```bash
pi install npm:@yqt5421/pi-tdai-memory
```

> npm 包通过 `pi.extensions` 字段自动注册扩展。也可临时试用：`pi -e npm:@yqt5421/pi-tdai-memory`

### 方式二：手动复制

将本项目放到 pi 扩展目录（任选其一）：

```
~/.pi/agent/extensions/tdai-memory/    # 全局（所有项目）
.pi/extensions/tdai-memory/            # 项目本地（需信任项目）
```

### 配置凭证

**方式 A：交互式菜单**（TUI 中运行，推荐）

```
/tdai-setup
```

菜单式交互——本地已有配置直接预填显示（apiKey/gatewayToken 脱敏，含 env 生效值），选要改的项即可，无需逐项重输：

```
tdai-memory 配置（选一项修改或保存）
  endpoint:        https://mem.xxx.xyz
  apiKey:          sk-m****k2p
  gatewayToken:    404d****0a6
  teamId:          team-xxx
  userId:          usr-xxx
  ──────────────
  测试连接并保存
  直接保存
  取消
```

选「测试连接并保存」会验证 meta 层鉴权（listAgents），通过后写入配置。**首次保存（未绑定 agent）会弹出选择：**

```
选择要绑定的 agent（或新建）
  绑定已有: pi-windows (agt-xxx)        ← 团队现有 active agents
  绑定已有: pi-pi-69392894 (agt-yyy)
  ──────────────
  新建 agent
  取消
```

- 选「绑定已有」→ 直接复用该 agent，写入 `fixedAgentId`
- 选「新建」→ 按项目名创建一个新 agent 并绑定
- 选「取消」/ Esc → 放弃保存
- 已有绑定（`fixedAgentId` 非空）时跳过选择，直接保存

保存后 `/reload` 生效。

### 配置文件位置

| 安装方式 | 配置落盘位置 | 说明 |
|------|------|------|
| **项目级**（`pi install` 在项目 `.pi/npm` 下） | `{project}/.pi/tdai-memory.json` | 跟着项目走，不被 `pi update` 覆盖 |
| **全局**（在 `~/.pi/agent` 下） | `~/.pi/agent/extensions/tdai-memory/config.json` | 全局共享 |
| **包内 fallback**（开发用） | 扩展目录内 `config.json` | 会被 `pi update` 覆盖，不推荐落盘 |

加载优先级：**项目本地 > 全局 > 包内 fallback > 环境变量覆盖**。

**方式 B：手动 config.json**

```bash
cp config.example.json config.json   # 填写真实值
```

**方式 C：环境变量**（优先级最高，不落盘）

```bash
export TDAI_MEMORY_ENDPOINT=https://mem.xxx.xyz
export TDAI_MEMORY_API_KEY=sk-mem-...        # meta 层 x-tdai-user-key
export TDAI_MEMORY_GATEWAY_TOKEN=404d...    # 可选，Gateway 模式 Bearer token
export TDAI_MEMORY_TEAM_ID=team-xxx
export TDAI_MEMORY_USER_ID=usr-xxx
```

> 配置好后执行 `/reload` 即可；首次保存时若尚未绑定 agent，会引导选择/创建固定 agent（见上方说明）。

## ⚙️ 配置项

| 环境变量 | 字段 | 默认 | 说明 |
|----------|------|------|------|
| `TDAI_MEMORY_ENDPOINT` | endpoint | — | MemoryCore 地址（直连如 `http://host:8420`，Gateway 如 `https://mem.xxx.xyz`） |
| `TDAI_MEMORY_API_KEY` | apiKey | — | meta 层 `x-tdai-user-key`（直连模式也用于 Bearer） |
| `TDAI_MEMORY_GATEWAY_TOKEN` | gatewayToken | — | **可选**，Gateway 模式 Bearer token（配置后所有层用此 token 做 Bearer，apiKey 仅用于 meta 层） |
| `TDAI_MEMORY_SERVICE_ID` | serviceId | `default` | 租户标识（多租户路由） |
| `TDAI_MEMORY_TEAM_ID` | teamId | — | 团队 id（三元组之一） |
| `TDAI_MEMORY_USER_ID` | userId | — | 用户 id（三元组之一） |
| `TDAI_MEMORY_AGENT_ID` | fixedAgentId | — | 固定 agent（`/tdai-setup` 初始化时绑定；所有会话复用） |
| `TDAI_RECALL_MAX_RESULTS` | recall.maxResults | `5` | 每轮召回 L1 条数上限 |
| `TDAI_RECALL_PERSONA` | recall.includePersona | `true` | 是否注入 L3 画像 |
| `TDAI_RECALL_SCENE` | recall.includeSceneNav | `true` | 是否注入 L2 场景索引 |
| `TDAI_CAPTURE` | capture.enabled | `true` | 是否自动捕获 L0 |
| `TDAI_WIKI` | wiki.enabled | `false` | **实验中**：是否启用 wiki 知识库工具（接口/鉴权待重设，默认关闭）|
| `TDAI_MEMORY_HUB_PORT` | — | `8424` | Wiki 层 hub 端口（默认由 core 推导） |

### 🔑 鉴权模式选择

| 模式 | 配置 | 请求头 |
|------|------|--------|
| **直连模式** | 只配 `apiKey` | 数据层/Wiki：`Authorization: Bearer <apiKey>`；meta 层：`x-tdai-user-key: <apiKey>` |
| **Gateway 模式** | 配 `apiKey` + `gatewayToken` | 所有层：`Authorization: Bearer <gatewayToken>`；meta 层额外：`x-tdai-user-key: <apiKey>` |

> 不配 `gatewayToken` 自动走直连模式，完全向后兼容。

## 🎛️ 命令

| 命令 | 作用 |
|------|------|
| `/tdai-setup` | 配置 endpoint/apiKey/teamId/userId/gatewayToken，可测试连接，菜单式预填修改；首次保存时引导绑定固定 agent（选已有/新建） |

## 🧰 工具清单（14 个）

| 工具 | 作用 |
|------|------|
| `tdai_memory_search` | 搜索 L1 结构化记忆（偏好/事件/规则/事实） |
| `tdai_conversation_search` | 搜索 L0 历史对话（可限定 session） |
| `tdai_read_scene` | 读取 L2 场景全文（路径穿越防御） |
| `tdai_skill_search` | 搜索团队技能库 |
| `tdai_skill_view` | 查看技能详情（SKILL.md + manifest） |
| `tdai_skill_files_read` | 读取技能资源文件（路径穿越防御） |
| `tdai_skill_extract` | 从当前对话提取技能（服务端 LLM 异步生成） |
| `tdai_wiki_list` | 列出团队知识库及状态 |
| `tdai_wiki_search` | 搜索知识库页面 |
| `tdai_wiki_page_read` | 读取知识库页面全文（路径穿越防御） |
| `tdai_wiki_page_write` | 直接写入/更新页面（写入后服务端加 locked 标记） |
| `tdai_wiki_ingest` | **知识库加工**：上传素材 → 触发 LLM 异步生成页面 + 索引 |
| `tdai_wiki_create` | 创建知识库（幂等） |
| `tdai_wiki_delete` | 批量删除知识库（危险操作） |

> ⚠️ **wiki 工具（tdai_wiki_*）为实验性功能，默认关闭**（`wiki.enabled=false`）。开启方式：
> - 环境变量 `TDAI_WIKI=true`
> - 或配置文件 `{ "wiki": { "enabled": true } }`
>
> wiki 层 HTTP 接口地址与鉴权方式正在重新设计，开启后可能不稳定。

## 🔄 工作原理

```
用户发消息
  └─ before_agent_start
       ├─ 并行召回 L1（动态检索）+ L3 画像 + L2 场景索引（10 分钟缓存）
       ├─ L3/L2 + 工具指南 → 追加 systemPrompt
       └─ L1 → 隐藏消息注入对话（display: false）
session_start
  └─ 固定 agent 由 /tdai-setup 初始化时绑定（config.fixedAgentId）；无绑定则不做 agent 隔离
agent_end（fire-and-forget，不阻塞 TUI）
  └─ 提取本轮 user/assistant → 清洗（标签回流防护）→ 时间戳游标增量写 L0
```

- **鉴权分层**：数据层 `Bearer + x-tdai-service-id + 三元组`；meta 层 `x-tdai-user-key + x-tdai-service-id`；Wiki 层 `Bearer + service-id`（hub 端口，只带 team_id）。Gateway 模式下所有层 Bearer 改用 `gatewayToken`。
- **agent 绑定**：`/tdai-setup` 初始化时选「绑定已有」或「新建」，写入 `fixedAgentId` 后所有会话复用；后端按 `(team_id, user_id, agent_id)` 三元组存储，不同 agent 记忆不串台
- **失败不阻断**：召回/捕获任何失败仅告警，不阻塞对话
- **配置热更新**：修改 config.json 后 `/reload` 即可

## 🛡️ 安全

- `config.json` 含真实凭证，**已被 .gitignore 排除**，请勿提交/打包分发
- 推荐将 apiKey/gatewayToken 走环境变量（`TDAI_MEMORY_API_KEY` / `TDAI_MEMORY_GATEWAY_TOKEN`）而非落盘
- apiKey = 记忆库读写权：**不要把包含 apiKey 的 config.json 发给别人**，让对方自建服务或用各自 team 隔离
- 所有路径类工具均有路径穿越校验（`..`/绝对路径/URL 编码变体）

## 📋 已知限制

- L0 捕获游标为内存态：跨进程重启后首轮会重复捕获历史（服务端需容忍重复或去重）
- 知识库加工（ingest）为异步任务：素材上传后需等待 LLM 生成完成（约 1 分钟），`tdai_wiki_list` 的 `status: ready` 表示可查询
- 技能提取（extract）同样为异步：提交后由服务端判断价值并生成 SKILL.md
- **wiki 知识库工具为实验性，默认关闭**：wiki 层 HTTP 接口地址与鉴权方式正在重新设计，需手动开启（`TDAI_WIKI=true` 或 `wiki.enabled=true`）才能使用 `tdai_wiki_*` 工具

## 🧪 开发与验证

扩展为纯 TypeScript 源码，pi 用 jiti 直接加载，无需编译。开发时可：

- 修改 `index.ts` / `lib/*.ts` 后在 pi 中 `/reload` 即时生效
- 用 mock 后端调试：拦截 `globalThis.fetch` 返回 `{ ok:true, status:200, text:async()=>JSON.stringify({code:0,data:{...}}) }`

## 📄 License

MIT
