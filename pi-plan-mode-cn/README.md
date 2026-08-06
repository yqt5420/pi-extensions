# pi-plan-mode-cn

[pi](https://github.com/earendil-works/pi) 的 **Plan mode** 扩展中文界面版。

Fork 自 [@narumitw/pi-plan-mode](https://www.npmjs.com/package/@narumitw/pi-plan-mode)，将全部面向用户的操作提示翻译为简体中文（约 240 处文案），其余功能与上游保持一致。

## 功能

Codex 风格的只读 `/plan` 协作模式：

- `/plan` 进入交互式菜单：开始计划、选择工具、设置、帮助
- 规划阶段只读探索（read / bash 受控子命令 / grep / find / ls），**禁止修改文件**
- `plan_mode_question` 工具：规划中向用户提问决策问题
- `plan_mode_complete` 工具：提交决策完备的实现计划
- 计划就绪后菜单提供：在此实现 / 全新开始并实现 / 导出计划 / 稍后保存 / 留在计划模式 / 放弃计划并退出
- 设置：思考级别、计划工具默认集、实现后计划保留策略、导出目标

## 安装

```bash
pi install npm:@yqt5421/pi-plan-mode-cn
```

## 与上游的差异

| 项目 | 上游 | 本包 |
|------|------|------|
| 界面文案 | 英文 | 简体中文 |
| 系统提示词（prompt.ts） | 英文 | 英文（保持模型指令稳定） |
| `**Proposed Plan**` 等消息标记 | 英文 | 英文（保持协议兼容） |
| 命令 / 工具标识符 | 英文 | 英文（`/plan start`、`plan_mode_complete` 等） |
| 内部错误匹配串 | 英文 | 英文（`isStaleExtensionContextError` 依赖） |

## 更新上游后如何同步翻译（自动流程）

本包附带**自动翻译脚本**，上游发布新版本后无需手工翻译：

```bash
# 1. 拉取上游新版本源码
npm pack @narumitw/pi-plan-mode        # 解压出 package/ 目录
# （或 git clone 上游仓库后 checkout 新 tag）

# 2. 自动重放翻译（基于 zh-cn.json 映射表）
node scripts/translate.mjs package/ --out ../pi-plan-mode-cn-synced/
# 输出：完成：替换 N 处；若有未命中的英文文案会列出（新增/改动的文案）

# 3. 构建验证
esbuild src/index.ts --bundle --format=esm --platform=node --outfile=/dev/null \
  --external:@earendil-works/* --external:@narumitw/pi-tui-kit --external:@earendil-works/pi-tui

# 4. 比对检查（应无差异）
diff -r ../pi-plan-mode-cn-synced/src src/

# 5. 更新版本号并发布
npm version <上游版本>-cn.1   # 如 0.50.0-cn.1
git add . && git commit -m "sync upstream 0.50.0" && git push
# GitHub Actions 自动发布到 npm（OIDC Trusted Publishing）
```

### 未命中文案（新增/改动）如何处理

脚本会输出 `⚠️ 检测到 N 处可能未翻译的英文文案` 清单。处理方法：

1. 人工翻译这些新文案
2. 将 `英文原句 -> 中文译句` 追加到 `zh-cn.json` 的 `mapping`
3. 重新运行 `node scripts/translate.mjs` 直到报告「未发现未翻译的英文文案」

### 脚本原理

- `zh-cn.json`：英文原句 → 中文译句映射表（204 条，基于上游 0.49.3 反推）
- `scripts/translate.mjs`：词法级扫描 .ts 源码，只替换字符串字面量内的完整句子
  - 不碰标识符、注释、代码结构
  - 模板字符串的 `${...}` 插值区域（标识符）绝不替换
  - 支持嵌套模板字符串（`${next.length ? `...` : ...}`）
  - 保留项（value===key）整段锁定，不被短 key 拆分
  - 幂等：对已翻译源码重跑替换数为 0

## 手动修改位置

若想自行调整某句翻译，直接编辑 `src/*.ts` 中的中文文案，或改 `zh-cn.json` 后重跑脚本（脚本输出会覆盖）。

## License

MIT。上游代码版权归 [narumiruna](https://github.com/narumiruna)（[MIT](LICENSE)），本包仅做中文翻译适配。
