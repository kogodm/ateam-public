# Ateam

[English](README.md) | 中文

用于管理 AI 编程会话的桌面工作台：终端和 Stream 视图、成员记忆、会话交接，
以及经过项目授权的外部 MCP。基于 Tauri、React、TypeScript 和 Node sidecar。

**源码采用 PolyForm Noncommercial 1.0.0 非商业许可公开。**
商业使用须另行获得著作权人的许可，完整条款见 [LICENSE](LICENSE)。
这不是允许任意商业使用的开源许可证。

## 功能

- 统一管理项目及多个 CLI 会话。
- Claude、Codex、Cursor CLI、OpenCode provider；能力取决于 provider 和 CLI 版本。
- 终端和结构化 Stream、工具输出、问答和历史恢复。
- 长期成员身份（Human）、技能、知识和会话交接。
- 支持项目审批、撤销授权及命令过程展示的外部 MCP。
- 可选的局域网访问、远程访问与同步。

各 provider CLI 及账号需要独立安装、登录；其收费、条款和功能与 Ateam 分开。

## 从源码构建

使用 Node 22、package.json 固定的 pnpm 9.15.9；桌面构建还需要 Rust stable。
原生模块需要在目标操作系统上构建。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @ateam/desktop-ui build
pnpm --filter @ateam/sidecar build
pnpm --filter @ateam/desktop build
```

最后一条命令仅生成桌面安装包，不会安装或重启应用。
平台依赖见 [桌面构建说明](apps/desktop/BUILD.md)。
开发模式先构建 sidecar，再执行 `pnpm --filter @ateam/desktop dev`。

## 服务器服务与未来收费

公开源码保留现有托管 Relay 和更新服务地址。远程账号注册/登录连接托管服务，
桌面更新检查使用配置的更新地址；LAN、Remote、Sync 为可选功能。
启用前请阅读 [服务和数据边界](HOSTED_SERVICES.md)。

**托管服务器服务未来可能收费**，具体价格、额度和条件另行公布。
源码公开不承诺服务器永久免费或持续可用。源码许可与服务器收费分开：
支付服务器费用，本身不代表获得软件的商业使用许可。

仓库包含 `apps/relay` 服务器源码。自托管需要自行配置和维护，
不代表拥有对现有托管服务的访问权限。

## 参与与安全

请阅读 [贡献说明](CONTRIBUTING.md)、[安全说明](SECURITY.md) 和
[第三方组件说明](THIRD_PARTY_NOTICES.md)。公开 issue 不要附带凭据、
私人会话或 Ateam 数据目录。项目仍处于 alpha 阶段，升级前请备份本地数据。
