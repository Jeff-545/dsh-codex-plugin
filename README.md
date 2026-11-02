# ChatGPT Plan for DeepSeek Harness

让 DeepSeek Harness 通过 OpenAI 官方 **Sign in with ChatGPT（SIWC）** 流程，使用符合条件的 ChatGPT Plus/Pro 订阅调用模型。此仓库包含插件 bundle、验证脚本与协议研究资料。

> 本插件自行完成 OAuth 2.0 + PKCE 授权；不会读取或复用 Codex CLI 或其他应用的凭据。只保存你在浏览器批准后为本插件签发的令牌。

## 功能

- 在 Harness 中提供 `chatgpt-plan` 模型供应商，并通过 Responses API 流式请求。
- 在 **Settings → ChatGPT** 中连接、查看账户与 plan 使用权限、管理或断开连接。
- 支持 `/chatgpt-plan-login`、`/chatgpt-plan-logout` 和 `/chatgpt-plan-status` 命令。
- 处理访问令牌刷新、模型列表和 plan 使用范围；适配器只发送该路由支持的请求参数。

## 环境要求

- DeepSeek Harness `>= 0.2.1-rc.5`。
- 符合 OpenAI 应用使用条件且已获准使用的 ChatGPT Plus/Pro 账户。可用性取决于账户及 OpenAI 的 plan 使用政策。
- 能访问 `auth.openai.com` 和 `api.openai.com`。受网络代理限制时，可按下文设置代理。

## 安装

在 DeepSeek Harness 的 **Plugins** 页面安装 bundle，选择本仓库中的 `bundle/` 目录。也可通过插件管理器 API 将 `target` 指向该目录。安装后打开 **Settings → ChatGPT**，点击 **Connect ChatGPT** 并在浏览器中完成授权；随后在模型选择器中选择 **ChatGPT Plan** 模型。

命令行也可启动授权：

```text
/chatgpt-plan-login
```

断开连接会尝试撤销 refresh token 并删除本地凭据。若撤销无法确认，请在 ChatGPT 的 **Settings → Usage** 中移除此应用。

## 代理配置

插件网络传输依次尝试以下配置：

1. `DSH_CHATGPT_PLAN_PROXY`（`host:port` 或 URL）；
2. `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`（遵循 `NO_PROXY`）；
3. macOS 系统代理（通过 `scutil --proxy` 读取）。

`localhost`、`127.0.0.1` 及 OAuth 回调始终直连。浏览器授权页面使用浏览器自身的代理配置。可用以下命令检查 OpenAI 登录端点连通性：

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://auth.openai.com/.well-known/openid-configuration
```

## 安全与令牌

- OAuth 使用 PKCE，并校验 `state`、`nonce` 和 ID token；回调监听绑定 loopback 地址。
- 凭据存储在 Harness 凭据库 `~/.dsh/.credentials.yaml`（文件权限 `0600`）中，不会发送到浏览器。
- 请求固定使用 `store: false` 和流式响应；插件仅在本机 Harness 凭据库保存本次授权签发的令牌。
- 仅适用于 OpenAI 允许应用使用的账户与 plan。若未获准 plan 使用范围，登录仍可完成，但 plan 模型请求不可用。

更多实现细节、限制及验证说明见 [bundle 使用文档](bundle/README.md) 和 [验证记录](VERIFICATION.md)。

## 本地验证

在仓库根目录运行无需登录或联网的测试：

```sh
node --test tests/*.test.mjs
```

测试覆盖授权流程、动态客户端注册、状态校验、plan 范围门控，以及 Responses API 请求和 SSE 流解析。

## 目录结构

- [`bundle/`](bundle/) — 可安装的 DeepSeek Harness 插件。
- [`tests/`](tests/) — OAuth 与请求/流解析测试。
- [`scripts/`](scripts/) — 桌面 Harness 探测及端到端辅助脚本。
- [`research/`](research/) — SIWC、Codex wire protocol 与 Harness 适配器契约研究资料。
- [`VERIFICATION.md`](VERIFICATION.md) — 已记录的桌面应用验证结果。

## 许可证

插件使用 MIT 许可证，见 [`bundle/LICENSE`](bundle/LICENSE)。
