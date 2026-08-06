# pi-goal-cn

[pi](https://github.com/earendil-works/pi) 的 **Goal 目标管理扩展**中文界面版。

Fork 自 [@narumitw/pi-goal](https://www.npmjs.com/package/@narumitw/pi-goal)，将用户可见的 UI 文案（菜单、通知、设置项、错误消息）翻译为简体中文，功能与上游保持一致。

## 功能

- `/goal <目标>` 运行目标直到完成（含 token 预算）
- `/goal` 交互菜单：开始、暂停、恢复、编辑、替换、清除、队列、设置
- 自动工作上限（按响应次数暂停）、无进展保护
- 有序目标队列（实验性：添加、优先、跳过、丢弃最后一个）
- 目标工具可见性、受管运行 RPC 设置

## 安装

```bash
pi install npm:@yqt5421/pi-goal-cn
```

## 与上游的差异

| 项目 | 上游 | 本包 |
|------|------|------|
| 界面文案 | 英文 | 简体中文 |
| 模型提示词（prompts.ts） | 英文 | 英文（保持模型指令稳定） |
| 状态值（Active/Paused/Complete 等） | 英文 | 英文（参与逻辑判断，不可翻译） |
| 命令 / 工具标识符 | 英文 | 英文（`/goal`、`goal_complete` 等） |

> ⚠️ **安全说明**：目标状态值（`active`/`paused`/`complete` 等）参与内部逻辑判断，**有意保留英文**。设置菜单中的选项值（如「始终」「第一个目标后」「关闭」「实验」「开启」）已与判断逻辑同步翻译，功能不受影响。

## 更新上游后如何同步翻译（自动流程）

```bash
# 1. 拉取上游新版本
npm pack @narumitw/pi-goal   # 解压出 package/ 目录

# 2. 自动重放翻译（基于 zh-cn.json 映射表）
node scripts/translate.mjs package/ --out ../pi-goal-cn-synced/
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

- `zh-cn.json`：英文原句 → 中文译句映射表（基于上游 0.49.5 反推）
- `scripts/translate.mjs`：词法级扫描 .ts 源码，只替换字符串字面量
  - 不碰标识符、注释、代码结构
  - `${...}` 插值区域内的标识符受保护
  - 状态值等参与逻辑判断的字符串（黑名单）不翻译，保证功能安全
  - 幂等：对已翻译源码重跑替换数为 0

## License

MIT。上游代码版权归 [narumiruna](https://github.com/narumiruna)，本包仅做中文翻译适配。
