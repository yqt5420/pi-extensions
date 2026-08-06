# pi-token-speed

> [pi](https://github.com/earendil-works/pi-mono) coding agent extension — real-time token speed display in the TUI footer.

在 pi 的 TUI 底部状态栏实时显示 **token 吐字速度** 和 **首字延迟（TTFT）**，帮你直观感受模型的响应快慢。

## ✨ 功能

- **实时吐字速度** — 流式生成中显示 `⚡ 1.2k tok @ 15.2 t/s | 首 1.2s`
- **首字延迟（TTFT）** — 从发消息到模型吐出第一个 token 的时间
- **精确 token 数** — 完成后用模型返回的 `usage.output` 显示真实值，流式中用 `char/4` 估算
- **三种输出全覆盖** — 文本回答（text）、思考推理（thinking）、工具调用参数（toolcall，如写文件）
- **子代理速度** — 阻塞式子代理（`subagent` / `subagent_consult`，来自 [@narumitw/pi-subagents](https://github.com/narumiruna/pi-extensions)）运行期间，显示其生成速度 `⚡ 子代理 [worker] 1.2k tok @ 15.2 t/s | 首 1.2s`，支持 single / parallel / chain / consult 模式
- **自动消失** — 完成后的统计保留 10 秒后自动清除
- **一键开关** — `/tokenspeed` 命令随时切换

## 📺 显示效果

| 阶段 | 显示 | 说明 |
|------|------|------|
| 流式中 | `⚡ 1.2k tok @ 15.2 t/s \| 首 1.2s` | accent 色（蓝） |
| 完成（精确） | `✓ 12.3k tok @ 25.0 t/s (8.0s) \| 首 0.8s` | success 色（绿） |
| 完成（兜底） | `≈ 892 tok @ 14.8 t/s (60.2s) \| 首 1.2s` | warning 色（黄） |
| 子代理运行中 | `⚡ 子代理 [worker] 1.2k tok @ 15.2 t/s \| 首 1.2s` | accent 色（蓝） |
| 子代理完成（精确） | `✓ 子代理 [scout+worker] 170 tok @ 25.0 t/s (8.0s)` | success 色（绿） |
| 子代理完成（兜底） | `≈ 子代理 [worker] 892 tok @ 14.8 t/s (60.2s)` | warning 色（黄） |

- **首** = 首字延迟，从 `turn_start` 到第一个 token 到达
- **t/s** = tokens per second，每秒生成 token 数
- token 数单位：`< 1k` 原样显示，`1.0k–9.9k` 保留一位小数，`≥ 10k` 取整（如 `15k`）

## 📦 安装

### 方式 1：npm（推荐）

```bash
pi install npm:@yqt5421/pi-token-speed
```

### 方式 2：本地试用

```bash
pi -e ./path/to/pi-token-speed
```

安装后启动 pi 即可，无需额外配置。

## 🎮 使用

安装后自动生效，直接和模型对话就能看到底部状态栏的速度显示。

| 命令 | 作用 |
|------|------|
| `/tokenspeed` | 开启 / 关闭显示 |

## 🔧 实现原理

监听 pi 的生命周期事件：

| 事件 | 用途 |
|------|------|
| `turn_start` | 开始计时，启动 200ms 定时器刷新显示 |
| `message_update` | 监听 `text_delta` / `thinking_delta` / `toolcall_delta`，累计字符数 + 记录首字时间 |
| `message_end` | 拿到 assistant 消息的精确 `usage.output` |
| `turn_end` | 停止计时，显示最终统计，10 秒后清除 |
| `tool_execution_start` | 子代理工具开始：重置计时，显示启动状态 |
| `tool_execution_update` | 子代理每条 assistant 消息结束：从 `partialResult.details.results` 汇总 usage，刷新速度 |
| `tool_execution_end` | 子代理完成：显示最终统计，10 秒后清除 |
| `session_shutdown` | 清理定时器，防止资源泄漏 |

**Token 估算**：流式中按 `字符数 / 4` 近似（标准英文约 4 字符/token），完成后用模型返回的精确 `usage.output` 替换。

### 子代理速度的原理

子代理（[@narumitw/pi-subagents](https://github.com/narumiruna/pi-extensions)）以独立 `pi --mode json -p` 子进程运行，没有 TUI，其流式输出无法直接在主进程显示。pi-subagents 会在子代理**每条 assistant 消息结束时**通过工具 `onUpdate` 回调触发主进程的 `tool_execution_update` 事件，事件携带该子代理的精确 `usage`（output tokens）和消息内容。本扩展监听该事件链，计算子代理的累计 token 数与平均速度；无精确 usage 时用字符数/4 兜底估算。

- 粒度：每段消息（thinking / 文本 / 工具调用参数）结束更新一次，思考期间由 500ms 心跳保持显示
- 并行模式汇总所有子代理的 usage，agent 名合并显示（如 `[scout+worker]`）
- 子代理运行期间暂停主 agent 的速度刷新，避免互相覆盖

## 📁 项目结构

```
token-speed/
├── package.json
├── README.md
└── extensions/
    └── token-speed.ts
```

## 📄 License

MIT
