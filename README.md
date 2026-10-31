# @local/dsh-chatgpt-plan

[中文](#中文说明) | [English summary](#english-summary)

一个独立 DSH bundle，新增模型路由 `openai-chatgpt-plan`：用户通过 **Sign in with ChatGPT** 授权，把符合条件的 ChatGPT 计划作为 **DSH 原生模型提供方**。DSH 继续拥有 agent loop、工具声明与执行、权限/审批、会话日志、压缩与记忆；本插件只提供模型适配器、账号授权和模型目录。

> 实现阶段状态（历史）：代码、离线测试、打包检查在项目目录内完成，未安装、未登录、未推理。
>
> **2026-10-30 安装验收**：已通过 `plugin_manager` 安装到 `web` profile，并完成真实登录、模型目录、DSH 文本/多轮/工具/文件任务、取消、重启恢复和退出撤销实测。整体结论为 **FAIL/未通过**（退出后重登未复用 issued client ID、live 重授权超时、真实 token 刷新 NOT_RUN、当前会话日志含一次 browser-session secret 泄漏）。详见 [ACCEPTANCE.md](./ACCEPTANCE.md)，不要以“已安装/已登录/出现文字”替代验收。
>
> **2026-10-31 本机复装（v0.2.0）**：在 DSH `0.2.1-rc.5` 的 `web` profile 上用本地 `link:` 重新安装，`application=applied`、`warnings=[]`；row `include:openai-chatgpt-plan` active、`settings.models.footer` occupant active、`/chatgpt-plan/status` 返回 200。本版修复“退出后重新连接复用 issued client ID”；随后在本机完成真实登录，账号 `planEnabled=true`、`providerRegistered=true`、实时模型目录 8 个。真实文本、单工具调用、多轮上下文与多工具序列已在本机实测通过（`gpt-6.1-sol`）；期间一次 `TRANSPORT` 已定位为本机到 `api.openai.com` 的间歇 TLS reset，并已改进诊断与重试。退出→Reconnect 与已登录账号的 Sign in again 均已在本机实测通过；真实 token 刷新仍未执行，见 [ACCEPTANCE.md §14–19](./ACCEPTANCE.md)。

## 与 `dsh-subagent-codex` 的区别

`@deepseek-ai/dsh-subagent-codex` 是 **subagent provider**：每次委派启动真正的 Codex app-server，由 Codex 自己的 agent loop 和工具执行，DSH 父会话只收到最终答案。它使用 Codex 原生认证和 `CODEX_HOME`，不是模型路由。

本插件是 **LLM provider**：

- 注册 `ctx.llm.registerAdapter(['openai-chatgpt-plan'], adapter)`，模型出现在 DSH 模型选择器；
- 模型返回文本/推理流和工具调用，工具由 **DSH** 执行并把结果回填；
- 多轮历史、工具调用/结果、usage、取消都进入 DSH 会话；
- 使用 DSH Authorization/Credentials 和 OpenAI 开源客户端动态注册，不读取 Codex/Hermes/Pi 的登录缓存；
- 不启动 Codex 进程，不把完整 agent 委派伪装成模型适配。

两者可以共存，但凭据和执行路径隔离，不互相 fallback。

## 安装（从 GitHub/本地 clone）

前置条件：

- Node.js `>= 22`；
- DSH `>=0.2.1-rc.2 <0.2.2`（`0.2.1-rc.5` 已复核；其他 minor/大版本需先复核并重新测试）；
- Web profile（登录入口在 Models 页；headless 没有登录 UI）；
- `pnpm` 可用（DSH `plugin_manager` 调用它；没有时可 `corepack enable pnpm`）。

```bash
git clone <your-private-repo-url> dsh-chatgpt-plan-plugin
cd dsh-chatgpt-plan-plugin
```

在 DSH Creator mode 使用 `plugin_manager` 的 `install_bundle`，target 指向 clone 目录的**绝对路径**：

```text
plugin_manager install_bundle
  target: <absolute-clone-path>/dsh-chatgpt-plan-plugin
```

安装结果以管理器的 `application` / `warnings` 为准；本项目已验证本地目录 `link:` 安装。刷新页面后，Models 页尾部出现 **ChatGPT Plan** 面板；在目标机器上重新完成 ChatGPT 登录，**不要复制其他机器的 `.dsh/.credentials.yaml`**。

本机（2026-10-31，DSH `0.2.1-rc.5`、profile `web`）实测：

```text
plugin_manager install_bundle
  target: /home/qwei/dsh-chatgpt-plan-plugin
→ stage: enable, changed: true, application: applied
→ version: 0.2.0, warnings: []
```

安装后无需重启即加载：profile 依赖为 `link:/home/qwei/dsh-chatgpt-plan-plugin`，bundle 列表新增 `@local/dsh-chatgpt-plan`，row `include:openai-chatgpt-plan` 为 `active`，`settings.models.footer` occupant `openai-chatgpt-plan-account`（order 10）为 `active`，`GET /chatgpt-plan/status` 返回 200。pnpm 会提示被 `link:` 的包无法从目标 `node_modules` 解析 peer；DSH Host 在运行时提供这些 peer，本项目测试与加载均正常。

> 测试命令会自动探测已安装的 DSH（`npm root -g`、`which dsh`、Node 前缀）；探测失败时用 `DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh npm run test:deps` 指定。

卸载：`plugin_manager` 的 `remove_bundle` 或禁用 `openai-chatgpt-plan`。删除 credential record 前先尝试在面板中退出登录。

> 如果 clone 路径变化，profile 里的 `link:` 会失效，需要重新安装。希望避免绝对路径时，可把 `npm pack` 生成的 tarball 放到 release，再验证 tarball 安装；本仓库尚未实测 git/tarball target。

## 配置

`cordis.patch.yml` 只放非秘密字段。所有字段都有默认值，且未知字段会被拒绝。

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否启用 Host 插件 |
| `displayName` | `ChatGPT Plan` | 模型选择器显示名 |
| `agentNameHint` | `DeepSeek Harness` | 新动态注册时发送的真实应用名；不会伪装成 Codex/Pi |
| `allowUnknownModels` | `false` | 是否暴露未验证的模型 slug；即使允许也不发送工具 |
| `catalogTtlMs` | `300000` | 账号模型目录缓存 |
| `requestTimeoutMs` | `120000` | 单次 Responses 请求总超时 |
| `streamIdleTimeoutMs` | `120000` | SSE 空闲超时 |
| `defaultContextWindow` | `272000` | 未知模型/默认上下文 |
| `defaultMaxTokens` | `128000` | 未知模型/默认输出上限 |

端点、scope、resource、回调路径和动态 client id 都是固定常量，不能通过配置改变；这是为了避免静默切换计费/授权路径。

## 授权与账号

- 新账号：`client_id=dynamic_agent_client` + `agent_name_hint` + 稳定 `ext_agent_host_id`（`urn:uuid:<UUIDv4>`），PKCE S256、一次性 `state`/`nonce`。
- 回调：必须返回 issued `client_id`（且不能是 `dynamic_agent_client`），用该值兑换 code。
- 重新登录/重新授权：复用已保存的 issued `client_id`，省略 `agent_name_hint`，带 `id_token_hint`（可带 `login_hint`）；回调若给出不同 client id 必须拒绝。
- 退出后重新连接（v0.2.0）：sign-out 只保留非秘密 registration tombstone（`clientId`/`subject`/`issuer`/`email`/`label`，**不含任何 token**），status 暴露 `reconnectable`；`Reconnect` 复用该 issued `client_id`，不带 `agent_name_hint`，ID token `sub` 与 client id 必须和 tombstone 一致。退出后已无 ID token，因此 reconnect URL 不带 `id_token_hint`，授权页可能要求重新登录。`Add account` 仍走新注册。
- ID token：通过 discovery + JWKS 验签，校验 issuer、audience=issued client id、exp/iat、nonce、sub；`sid` 若存在必须为非空字符串。重新授权还要求 `sub` 与选中账号一致。
- scopes：以 token 响应的实际 `scope` 为准；只有包含 `chatgpt.tokens.use.direct` 才启用计划路由，否则保留身份登录但 `planEnabled=false`。
- 多账号：每个账号独立 grant record；账号索引只保存元数据。active account 可切换。
- 刷新：在 credential record 的 `modifyRecord` 跨进程写锁内执行，旋转 refresh token；进程内 single-flight；网络/5xx 保留 token，`invalid_grant` 等标记 reauth；`invalid_client` 不循环。
- 退出：先在锁内标记 signing-out 并捕获 token，尝试 discovery 的 revocation endpoint，随后删除本地 grant；远端失败仍删除本地并返回 `remoteRevoked:false`。旧刷新任务只能更新仍存在且 generation 匹配的账号，不能复活已退出账号。
- 新登录验证成功前不会覆盖原有效账号；重新授权在 ID token 验证通过且 `sub` 匹配后才原子提交所属账号 record。
- 未完成的登录尝试最多同时 4 个，每个最多保留 10 分钟；status 返回 `pendingSignIns` 与 `loginPending`。面板在 `loginPending=true` 时显示 `Cancel sign-in` 并禁用再次发起（刷新页面后仍然可见）；过期 attempt 会在下一次 `start` 前被清理。若面板状态异常，可直接 `POST /chatgpt-plan/cancel`（需同源 `Origin` + JSON）。

Host HTTP 路由（仅 loopback HTTP；启动时校验 `webServer.getOrigin()`）：

| 路由 | 方法 | 说明 |
|---|---|---|
| `/chatgpt-plan/start` | POST JSON | `{newAccount:true}` 或 `{accountId}`，返回 `{url}` |
| `/chatgpt-plan/status` | GET | 脱敏状态，无 token/clientId/subject；含 `accounts`、`reconnectable`、`pendingSignIns` |
| `/chatgpt-plan/signout` | POST JSON | `{accountId}`，撤销并删除 |
| `/chatgpt-plan/select` | POST JSON | 切换 active account |
| `/chatgpt-plan/cancel` | POST JSON | 取消进行中的登录 |
| `/auth/callback` | GET | 官方固定回调；冲突时禁用登录，不改路径 |

所有 POST 校验精确同源 `Origin` 和 `application/json`；回调页不反射 `code`/`state`/token。

## 请求与模型

- 模型目录来自同一账号凭据的 `GET https://api.openai.com/v1/models`，不是硬编码目录；按 `visibility === "list"` 过滤。
- 默认只准入已验证的 reasoning + `additional_tools` 模型：`gpt-5.4*`、`gpt-5.5*`、`gpt-5.6*`、`gpt-6*`。未知 slug 默认隐藏。
- 推理走公开 `POST https://api.openai.com/v1/responses`，请求体严格白名单：`model`、`input`、`stream:true`、`store:false`，可选 `reasoning.effort`。
- 不发送 `tools` 顶层字段、`max_output_tokens`、`temperature`、`top_p`、`stop`、`previous_response_id`、`prompt_cache_*`、`service_tier`、`metadata` 等计划路线不接受/未验证的字段。工具统一放在 `additional_tools` input item 中。
- `maxTokens` / `temperature` / `stop` 会被省略并记录一次诊断；这表示“不生效”，不是“改成另一种计费路径”。
- 工具保留 DSH 原始 `call_id` 和原始 JSON 参数；工具结果以 `function_call_output` 回到同一 call id。工具执行、权限和审批全部在 DSH。
- 文字流、推理摘要流、工具参数分片、usage、取消、流内错误都映射为 DSH `StreamChunk`；每个流只有一个终态 `finish`。
- 图片/文件输入当前明确报 `UNSUPPORTED_CONTENT`，不做静默丢弃；未知模型带工具报 `UNSUPPORTED_CAPABILITY`。
- 不发送通用 OpenAI API 的字段，也不使用 Codex/Hermes/Pi 的登录缓存或身份。

## 错误

常见错误码：`AUTH_REJECTED`、`PLAN_INELIGIBLE`、`PLAN_DISABLED`、`REAUTH_REQUIRED`、`MISSING_CREDENTIAL`、`QUOTA`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`INVALID_REQUEST`、`UNSUPPORTED_CAPABILITY`、`UNSUPPORTED_CONTENT`、`MALFORMED_RESPONSE`、`STREAM_CLOSED`、`EMPTY_RESPONSE`、`ABORTED`。（`AUTH` 仍识别，仅为旧记录兼容。）官方 `subscription_sharing_*` 诊断保留在消息/日志中，不循环重登。

错误展示分两处：

- **聊天错误行（DSH 所有）**：显示 `message` 和 `code`。`QUOTA` 由 DSH 本地化成“额度已用尽”；`AUTH` 会被 DSH 显示成“API key is invalid”，因此本插件改用 `AUTH_REJECTED`，让插件自己的“凭据被拒绝，请重新登录”显示出来。`PLAN_INELIGIBLE` 不再复用 `QUOTA`，避免把“不符合资格”误报成额度问题。其余错误的消息都带下一步动作（重新登录/检查代理/稍后重试）。
- **Models 面板（插件所有）**：`/chatgpt-plan/status` 返回 `lastRequestError`（code/message/status/providerCode/retryAfterMs/at），面板按 `en`/`zh` 显示“最近一次请求失败”横幅，给出额度、资格、权限、限流、网络、超时等分类文案，并显示 `code · HTTP status · retry Ns`；成功请求、重新登录或切换账号后自动清除，也可手动忽略。

## 故障排查

- **`TRANSPORT (ECONNRESET)` / `TRANSPORT (EPROTO)` / TLS `unexpected eof`**：本机到 `api.openai.com` 的连接被网络或本地代理重置，不是账号、权限或请求体错误。先单独测链路：

  ```bash
  for i in $(seq 1 20); do
    curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" \
      -H 'authorization: Bearer invalid' https://api.openai.com/v1/models
  done
  ```

 正常应稳定返回 `401`；出现 `000` / `unexpected eof` / 明显超时就切换、重启或检查代理节点。适配器按约 1s/2s/4s/8s 重试（最多 5 次），仍失败才返回 `TRANSPORT`；括号内是安全的原因码（如 `ECONNRESET`），不含 token/URL。
- **`TOO_MANY_PENDING` / `LOGIN_IN_PROGRESS`**：未完成登录尝试占满名额；在面板点 `Cancel sign-in`，或 `POST /chatgpt-plan/cancel`（同源 `Origin` + JSON）。过期 attempt 会在下一次 `start` 前清理。

## 离线测试与打包检查

```bash
# 仅测试：把已安装 DSH 的 peer 包链接到项目 node_modules
# 自动探测（npm root -g / which dsh / Node 前缀）；也可显式指定：
# DSH_INSTALL_ROOT=/path/to/@deepseek-ai/dsh npm run test:deps
npm run test:deps

npm test       # node --test test/*.test.mjs
npm run check  # npm pack --dry-run --json + 必需文件检查
```

测试不访问网络、不登录、不调用模型；使用内存 credential store、生成的 RSA/JWKS、mock OAuth/SSE。本次离线结果（DSH `0.2.1-rc.5`）：**83 tests / 83 pass / 0 fail**。`node_modules/@deepseek-ai/dsh-{llm,credentials}` 只是测试链接，不进入 pack；安装后由 DSH peer 提供；`.gitignore` 已排除 `node_modules/`。

覆盖：authorize URL 新/旧账号矩阵、回调 client id 校验、ID token 各失败分支、注册复用、退出后 reconnect 复用 issued client id、多账号隔离、刷新 single-flight/双 store 竞争、账号切换、退出竞争、旧刷新不复活、SSE 分片、工具参数分片、usage、唯一终态、空 reasoning 块、错误分类与 lastRequestError 脱敏、状态脱敏、回调路径冲突、非 loopback 禁用。

## 本次真实验收状态

2026-10-30 已在另一台机器的 `web` profile 实测：安装、ChatGPT 登录、plan scope、8 个真实模型目录、DSH 单轮文本、两轮上下文、工具调用/结果、项目临时目录文件任务、取消、重启凭据恢复、退出与远端撤销。

2026-10-31 在当前机器（DSH `0.2.1-rc.5`、profile `web`）重新安装并加载：`application=applied`、`warnings=[]`、row active、footer slot active、`/chatgpt-plan/status` 200。该版本（v0.2.0）实现“退出后重新连接复用 issued client ID”。随后在本机完成真实登录：`planEnabled=true`、`providerRegistered=true`、实时模型目录 8 个、`pendingSignIns=0`；并实测 start→cancel 的 pending 计数与清理。

已通过/已修复：

- **本机真实文本/工具/多轮：PASS**（2026-10-31，`gpt-6.1-sol`：`OK`、`printf tool-ok`、两轮上下文、多工具序列；见 ACCEPTANCE §17）；期间一次 `TRANSPORT` 由本机链路 reset 引起，已加重试与原因码；
- **退出后重新连接复用 issued client ID**：sign-out tombstone 保留 `clientId`/`subject`/`issuer`/`email`/`label`（无 token），`status.reconnectable` + `Reconnect` 复用注册；callback client id 与 ID token `sub` 必须匹配。**离线 + 本机 live 退出→Reconnect PASS**：重连后 account id 不变、grant 记录为 `reconnect-*`、tombstone 清除（见 ACCEPTANCE §18）。
- **pending 登录占满名额**：过期 attempt 在容量判断前清理，`status.pendingSignIns` 可见，面板在 pending 时显示取消并禁止重复发起。本机 start→cancel 实测通过。
- **空 reasoning 块**：reasoning 的 block-start 延迟到有文本；空 summary 不再生成空块；只有空 reasoning 的响应按 `EMPTY_RESPONSE` 处理。4 个新离线用例，重启后 live 复测 PASS（reasoningTokens=8，text 块 index=1，无空 reasoning 块）。
- **错误 UI 分类与本地化**：聊天错误行改用 `AUTH_REJECTED`/`PLAN_INELIGIBLE` 等语义正确的码和可操作文案；`/chatgpt-plan/status.lastRequestError` + Models 面板中英双语“最近一次请求失败”横幅（额度/资格/权限/限流/网络/超时），成功或重新登录后清除。83/83 离线测试；live 复测需重启。

仍不通过/不完整：

- **live 重新授权（Sign in again）：PASS**（2026-10-31：同一 account id/grant/clientId，generation 1→2，addedAt 不变，lastRefreshAt/expiresAt 更新；见 ACCEPTANCE §19）；
- **真实 token 刷新：NOT_RUN**（Sign in again 后 access 到期 2026-10-31T22:41:27+08:00）；
- **限额/权限/网络错误的 UI 展示：已实现并离线验证**（聊天错误码/文案分类 + Models 面板双语横幅）；真实 429/403/断网触发的 UI 复测仍 **NOT_RUN**；
- **当前验收会话日志秘密卫生：FAIL**（2026-10-30 一次 browser-session secret 泄漏；不在仓库文件中，详见 ACCEPTANCE）。

完整证据、当前已知问题与回退步骤见 [ACCEPTANCE.md](./ACCEPTANCE.md)。在上表修复前，不建议作为生产级插件发布或公开宣传。

## 文件

```text
index.js              Host 插件：账号、catalog、adapter、flow、路由接线
client.js             Models footer 账号面板
lib/                  OAuth、ID token、accounts、catalog、serializer、SSE、adapter、coordinator、web routes
locale/{en,zh}.json   展示元数据
icon.svg              原创可分发图标
cordis.patch.yml      bundle 插入行
test/                 离线测试
scripts/check.mjs     打包检查
scripts/link-test-deps.mjs 测试用 DSH peer 链接
REVIEW.md             评审记录
ACCEPTANCE.md         安装/真实环境验收记录（私有仓库保留）
acceptance/           脱敏后的验收证据（不含 token）
.gitignore            排除 node_modules、缓存和临时目录
```

## English summary

A native DSH model provider for eligible ChatGPT plan accounts. It registers the `openai-chatgpt-plan` LLM route, performs OpenAI's current open-source Sign in with ChatGPT flow (stable host id, PKCE, state/nonce, issued client id reuse, JWKS ID-token verification, real scope checks), stores per-account grants through DSH Credentials, serializes only the Responses API fields this route documents (tools in `additional_tools`), and streams text, tool calls, results, usage, cancellation, and exactly one terminal event back into DSH. DSH keeps the agent loop, tools, approvals, sessions, and memory. It does not spawn Codex, does not use Codex/Hermes/Pi login caches, and does not pretend to be those products. Version 0.2.0 reuses the issued client ID after sign-out through a non-secret registration tombstone, adds a `Reconnect` action to the Models footer, and bounds stale sign-in attempts with a visible pending count and cancellation. Installation, login, real model calls, tools, file tasks, cancellation, restart recovery, and sign-out were exercised on DSH 0.2.1-rc.2; the 2026-10-30 acceptance remains **FAIL** for live re-authorization, real token refresh, UI failure display, and one session-log secret-hygiene finding. The 2026-10-31 reinstall on DSH 0.2.1-rc.5 applied and loaded; a real sign-in then succeeded on that machine with `planEnabled=true`, 8 live models, and `providerRegistered=true`. One real text request was first blocked by intermittent TLS resets between that machine and api.openai.com (the same account works on another machine); after the link recovered, real text, a single bash tool call with call-id round-trip, two-turn context, and a multi-tool sequence all passed with the live provider. Transport cause reporting and retry were then improved. A manual sign-out followed by Reconnect reused the same issued client id (same account id, reconnect-* grant), and a live Sign in again reused the same grant with generation 1→2. Token refresh remains NOT_RUN there. See [ACCEPTANCE.md](./ACCEPTANCE.md).
