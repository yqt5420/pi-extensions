# pi-subagents-cn

[pi](https://github.com/earendil-works/pi) 的 **Subagents 子代理管理扩展**中文界面版。

Fork 自 [@narumitw/pi-subagents](https://www.npmjs.com/package/@narumitw/pi-subagents)，将用户可见的 UI 文案（菜单、通知、设置项、错误消息）翻译为简体中文，功能与上游保持一致。

## 功能

- `/subagents` 管理当前会话子代理和用户设置
- 委派方式选择：全部方式 / 仅异步 / 仅阻塞
- 当前代理管理、清除会话代理
- 代理工具权限配置（持久白名单）
- 只读咨询（subagent_consult）、阻塞子代理（subagent）、异步子代理（spawn/follow-up/mailbox）

## 安装

```bash
pi install npm:@yqt5421/pi-subagents-cn
```

## 与上游的差异

| 项目 | 上游 | 本包 |
|------|------|------|
| 界面文案 | 英文 | 简体中文 |
| 模型提示词（agent 定义、prompt） | 英文 | 英文（保持模型指令稳定） |
| 状态值（Running/Failed/Completed 等） | 英文 | 英文（参与逻辑判断，不可翻译） |
| 命令 / 工具标识符 | 英文 | 英文（`/subagents`、`subagent_consult` 等） |

> ⚠️ **安全说明**：`Running`/`Failed`/`Completed` 等状态值参与内部逻辑判断，**有意保留英文**。设置菜单中的选项值（如「仅异步」「仅阻塞」）已与判断逻辑同步翻译，功能不受影响。

## 更新上游后如何同步翻译（自动流程）

```bash
# 1. 拉取上游新版本
npm pack @narumitw/pi-subagents   # 解压出 package/ 目录

# 2. 自动重放翻译（基于 zh-cn.json 映射表）
node scripts/translate.mjs package/ --out ../pi-subagents-cn-synced/
# 输出：完成：替换 N 处；若有未命中文案会列出

# 3. 构建验证
npm run check

# 4. 更新版本号并发布
npm version <上游版本>-cn.1
git add . && git commit -m "sync upstream <版本>" && git push
# GitHub Actions 自动发布
```

### 未命中文案处理

脚本会报告 `⚠️ 检测到 N 处可能未翻译的英文文案`。人工翻译后把 `英文原句 -> 中文译句` 加入 `zh-cn.json` 的 `mapping`，重新运行脚本。

### 脚本原理

- `zh-cn.json`：英文原句 → 中文译句映射表（基于上游 0.49.3 反推）
- `scripts/translate.mjs`：词法级扫描 .ts 源码，只替换字符串字面量
  - 不碰标识符、注释、代码结构
  - `${...}` 插值区域内的标识符受保护
  - 状态值等参与逻辑判断的字符串（黑名单）不翻译，保证功能安全
  - 幂等：对已翻译源码重跑替换数为 0

## License

MIT。上游代码版权归 [narumiruna](https://github.com/narumiruna)，本包仅做中文翻译适配。
