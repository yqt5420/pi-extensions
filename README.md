# pi-extensions

个人 pi (coding agent) 扩展插件集合仓库。

## 插件列表

| 插件 | npm 包名 | 说明 |
|------|----------|------|
| [vision-router](vision-router/) | `pi-vision-router` | 视觉通道自动维护与智能路由，让任何模型都能识图 |

## 发布机制

每个插件目录包含独立的 `package.json` 和 `.github/workflows/publish.yml`，通过 **npm Trusted Publishing (OIDC)** 自动发布：

- 推送代码到 `main` 分支 → 自动发布对应插件
- 无需 npm token、无需 2FA、无需 OTP
- 使用 `paths` 过滤：只改某插件目录时只发布该插件

## 开发流程

```bash
# 在插件目录改代码
cd vision-router
# 更新版本号
npm version patch
# 提交并推送（自动发布）
git add .
git commit -m "fix: xxx"
git push
```
