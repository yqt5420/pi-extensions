# pi-extensions

个人 pi (coding agent) 扩展插件集合仓库。所有插件通过 **GitHub Actions + npm Trusted Publishing (OIDC)** 自动发布，无需 token、无需 2FA。

## 插件列表

| 插件 | npm 包名 | 版本 | 说明 |
|------|----------|------|------|
| [vision-router](vision-router/) | `@yqt5421/vision-router` | 1.0.2 | 视觉通道自动维护与智能路由，让任何模型都能识图 |
| [token-speed](token-speed/) | `@yqt5421/pi-token-speed` | 1.1.0 | 实时显示 token 生成速度（TTFT + tokens/sec） |
| [tdai-memory](tdai-memory/) | `@yqt5421/pi-tdai-memory` | 0.4.0 | MemoryCore 长期记忆扩展（L0~L3、团队技能库、知识库） |
| [pi-plan-mode-cn](pi-plan-mode-cn/) | `@yqt5421/pi-plan-mode-cn` | 0.49.3-cn.1 | Codex 式只读 /plan 协作模式（中文界面，fork 自 @narumitw/pi-plan-mode） |

## 发布机制

`.github/workflows/publish-pi-packages.yml` 通用多包 workflow：

- 推送 `main` 分支 → 自动发现仓库内所有含 `package.json` 的子目录
- 每个包并行独立 job，互不影响（`fail-fast: false`）
- 版本已存在自动跳过（`npm view` 检查），不会重复发布
- **npm Trusted Publishing (OIDC)**：无需 npm token、无需 2FA、无需 OTP，自动生成 provenance 签名

## 添加新插件（三步，零手动）

1. **建目录**：`mkdir <plugin-name>`（仓库根目录下的子目录）
2. **写 package.json**（必须包含）：
   - `"name": "@yqt5421/<plugin-name>"`（yqt5421 scope）
   - `"author": "yqt5421"`
   - `"repository": { "type": "git", "url": "https://github.com/yqt5420/pi-extensions.git" }`（provenance 校验必需，缺失会 E422）
   - `"publishConfig": { "provenance": true }`
   - `"pi": { "extensions": [...] }` + `"keywords": ["pi", "pi-package"]`
3. **提交推送**：`git add . && git commit -m "feat: add <plugin>" && git push` → 自动发布

## 更新已有插件

```bash
cd <plugin-dir>
# 改代码 / 更新版本号
npm version patch   # 或手动改 package.json 的 version
git add .
git commit -m "chore: bump to x.y.z"
git push            # 自动发布
```

## 本机安装插件

```bash
pi install npm:@yqt5421/<plugin-name>
```

> 注意：仓库 GitHub 用户名为 `yqt5420`（npm scope 为 `yqt5421`，两者不同）。
