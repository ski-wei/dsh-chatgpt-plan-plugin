# ACCEPTANCE — dsh-chatgpt-plan-plugin

- 验收日期：2026-10-30（Asia/Shanghai）
- Profile：`web`（`<DSH_HOME>/profiles/web`）
- 插件：`@local/dsh-chatgpt-plan` 0.1.0
- 安装方式：`plugin_manager` `install_bundle`，target 为项目绝对目录（本地 `link:`）
- 结论：**FAIL / 尚未整体验收通过**
  - 核心安装、登录、模型目录、DSH 文本/多轮/工具/文件任务、取消、重启恢复、退出撤销均有实测证据；
  - 但“退出后再次登录复用 issued client ID”实测 **FAIL**；live 重新授权页面报错/超时 **BLOCKED**；真实 token 刷新 **NOT_RUN**；流中断/限额/权限的 UI 展示仅用夹具验证；当前会话日志含一次 browser-session secret 泄漏（见第 10 节）。
  - 因此不能把“已安装”“已登录”“出现文字”“退出 0”当作整体 PASS。

## 1. 安装与版本

| 项 | 结果 |
|---|---|
| `plugin_manager install_bundle` application | **applied** |
| warnings | `[]` |
| packageResult.exitCode | `0` |
| pnpm | `12.4.1`（由 Node corepack 生成 shim） |
| registry | `https://registry.npmmirror.com/` |
| profile dependency | `@local/dsh-chatgpt-plan`: `link:<project-clone>` |
| profile bundle list | 原有 base/web/OpenViking/experimental 全部保留；新增 `@local/dsh-chatgpt-plan` |
| loaded plugin row | `include:openai-chatgpt-plan`，`enabled=true`，`fiberPhase=active` |
| Client slot | `settings.models.footer` occupant `openai-chatgpt-plan-account`，order 10，active |
| 初始 reviewed artifact SHA256SUMS | `e528910a49b9e8857d4d028679d321d0f8ba4dab6296d228e11a0df1e08af288`（42 files） |
| 验收修复后最终 SHA256SUMS | 见 `SHA256SUMS.txt.sha256`（`ACCEPTANCE.md` 与 `acceptance/` 已加入清单） |
| 运行文件精确 SHA-256 | [acceptance/runtime-hashes.json](./acceptance/runtime-hashes.json) |

> 安装后验收发现 Sign out 的真实缺陷：Credential 存储的严格 JSON 校验拒绝含 `undefined` 的 grant payload，导致 `TypeError`。已修复为 JSON-safe payload，并把测试用 Credential store 收紧为拒绝 `undefined`；随后重启 Host。当前运行代码是修复后的代码，版本号仍为 0.1.0；最终 hash 与安装时 reviewed hash 不同，必须按最终 `SHA256SUMS` 复核。

## 2. 账号与模型目录（本次有效授权）

`GET /chatgpt-plan/status`（脱敏）在重新登录后返回：

```json
{"signedIn":true,"activeAccountId":"acct-c5a880657bd2d8255b6d4738","accounts":[{"id":"acct-c5a880657bd2d8255b6d4738","label":"q***@gmail.com","email":"q***@gmail.com","planEnabled":true,"reauthRequired":false,"expiresAt":1793299314994}],"providerRegistered":true,"modelCount":8,"callbackAvailable":true,"loginPending":false}
```

- 实际 scopes 包含 `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`；`planEnabled=true`。
- 真实 `GET https://api.openai.com/v1/models` 返回 8 个可用 slug：`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6.1-terra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`。
- 未在 ACCEPTANCE 中保存账号 email 原文、access/refresh/id token、issued client ID 原文或授权 URL。

证据：[raw-provider.json](./acceptance/raw-provider.json)

## 3. 真实短文本请求（response.completed）

使用当前有效账号凭据直接调用公开 Responses 入口，作为 provider 契约实测：

| 项 | 值 |
|---|---|
| model | `gpt-5.6-luna` |
| response/request correlation id | `resp_094249c4f1ec0c49016ae381a0e1f8819985eb3a42f5ca522e` |
| HTTP 状态 | 200 |
| 终态 | `response.completed` |
| 文本 | `OK` |
| usage | input 10, output 5, total 15；cached 0；reasoning 0 |
| header `x-request-id` | 未返回；使用 provider response id 作为脱敏 correlation id |

同时 DSH 会话 `d0aa7185-0592-442a-b898-1e26f4cab613` 的 request header 为 `provider=openai-chatgpt-plan, model=gpt-6.1-sol`，assistant message 完成并记录 usage。证据：[dsh-session-summary.json](./acceptance/dsh-session-summary.json)

## 4. DSH 集成：文本、多轮、工具、文件、取消

会话标题“gpt配置”，session id `d0aa7185-0592-442a-b898-1e26f4cab613`，模型 `gpt-6.1-sol`。

| 验证 | 实测 | 结果 |
|---|---|---|
| 单轮短文本 | 用户“请只回复 OK…” → assistant `OK`；usage 14283/5/14288 | **PASS** |
| 两轮上下文 | 用户“我刚才让你回复的单词是什么？” → assistant `OK`；usage 15163/5/15168 | **PASS** |
| 工具调用/结果 | `bash` call id `call_59348d1440a34639ba0f44c5c533b316`，`printf tool-ok`；tool result `tool-ok`，isError=false；最终 assistant `tool-ok` | **PASS（一次重试）** |
| 文件任务 | 在 `.acceptance-tmp/run-20261030-0125/note.txt` 写入 `acceptance-ok`；`write` result Created file | **PASS** |
| 文件未越界 | 42 个基线文件 `sha256sum -c` 全 OK；除临时文件外无新增/改动 | **PASS** |
| 取消 | 长文本生成中点停止；assistant message `interrupted=true`，`turn/end reason=aborted/user` | **PASS** |

工具说明：第一次 `bash` 调用由模型生成了错误的 `workdir` 字符串（含 `LINT_SANITY=1 true #`），实际结果为 `Error: spawn bash ENOENT`；模型第二次用正确 `workdir` 成功。该失败来自模型参数，不是插件序列化；原始 tool call 参数与 call ID 均保留在证据中。

基线说明：`acceptance/file-baseline.sha256` 是文件任务当时的 42 文件快照，当时 `sha256sum -c` 全 OK。之后为修复 Sign out 的 JSON-safe 缺陷修改了源码，因此该基线不再用于验证“当前源码未变”；当前源码完整性以最终 `SHA256SUMS.txt` / `acceptance/runtime-hashes.json` 为准。

## 5. 失败路径（模拟夹具，不是实测限额）

通过真实 adapter 代码 + mock SSE/HTTP 运行，未真实诱发限额/权限/网络异常：

| 夹具 | 终态 |
|---|---|
| SSE 在 terminal 前结束 | `STREAM_CLOSED`，恰好 1 个 finish |
| 429 `subscription_sharing_usage_limit_exceeded` | `QUOTA` |
| 403 `subscription_sharing_user_not_eligible` | `QUOTA` |
| 401 `subscription_sharing_invalid_user` | `AUTH` |
| 文本 delta 后流中断 | `STREAM_CLOSED` |

证据：[simulated-failures.json](./acceptance/simulated-failures.json)。这些只证明 adapter 终态/错误码，**不证明 DSH UI 的限额/权限提示**；UI 展示为 **NOT_RUN**。

## 6. 重启与凭据恢复

- 用户在验收中重启 DSH Host（修复 Sign out 后再次重启加载新代码）。
- 重启后 `GET /chatgpt-plan/status` 仍为 `signedIn=true`，active account `acct-a2bbcccd13506b2bbdba1ce8` 恢复，`providerRegistered=true`；模型目录缓存初始为 0，重新读取后为 8。
- 重启后加载的 row 仍为 `include:openai-chatgpt-plan` active，slot occupant 仍 active。
- **凭据恢复：PASS**。
- **真实 token 刷新：NOT_RUN**。验收时 access token 仍在有效期内（expiresAt 1793299314994），没有触发真实 refresh；因此不能把“重启后仍可用”当作刷新已验证。

## 7. 退出、远端撤销与再次登录

### 7.1 退出与远端撤销

- 用户首次在面板操作 Sign out 失败/找不到按钮；随后 Host 路由 `POST /chatgpt-plan/signout` 返回 `SIGNOUT_FAILED TypeError`。
- 根因：`signOut` 的 grant payload 带 `accessToken: undefined` / `refreshToken: undefined`，严格 Credential store 的 JSON 校验拒绝 `undefined`。修复为 JSON-safe payload，测试用 store 同步收紧。
- 重启后再次调用同一路由：`remoteRevoked=true`；status 变为 `signedIn=false`；account grant 删除；state 留 tombstone。
- 后台探针持有旧 refresh token，在本地 grant 删除后调用 token endpoint：返回 `invalid_grant`，**确认远端撤销**。
- 结果：**服务端退出 + 远端撤销 PASS**；**修复后的 UI 按钮复测 NOT_RUN**（首次 UI 失败，之后通过同一 Host 路由完成）。

证据：[credential-after-signout.json](./acceptance/credential-after-signout.json)

### 7.2 退出后再次登录复用注册

- 退出前 account：`acct-a2bbcccd13506b2bbdba1ce8`，issued client ID hash `0a908cb7c3bc23d8`。
- 退出后通过面板“Continue with ChatGPT”重新登录：account `acct-c5a880657bd2d8255b6d4738`，client ID hash `b227b7c8def949c4`。
- **结论：FAIL**。退出时 account grant 被删除，重新“添加账号”走新动态注册，issued client ID 没有复用。当前实现只在“已登录账号点击 Sign in again”路径复用；退出后的重新连接没有保留注册元数据/提供 reconnect 入口。

### 7.3 已登录账号重新授权的 URL 复用

对当前 `acct-c5a880657bd2d8255b6d4738` 发起 `Sign in again`（未完成授权），解析返回的授权 URL（不显示 URL 原文）：

```json
{"method":"reauth","clientIdIsDynamic":false,"clientIdHash":"b227b7c8def949c4","agentNameHintPresent":false,"hostIdPresent":false,"idTokenHintPresent":true,"loginHintPresent":true,"pkce":"S256"}
```

- **issued client ID 在 authorize URL 中复用：PASS（静态/URL）**；无 `agent_name_hint`，带 `id_token_hint`/`login_hint`，PKCE S256。
- 用户实际打开授权页时报错/超时；attempt 保持 pending，随后通过 `/chatgpt-plan/cancel` 取消，原账号未受影响。
- **live 重新授权：BLOCKED**，错误为“网页登录页面显示出错了。超时”。未完成 token exchange/ID token 复验，不能标记 PASS。

## 8. 其他模型/插件/凭据

- profile 原有 OpenViking bundle 仍 `enabled=true`；未修改 OpenViking/Docker 部署。
- profile 原有 `DEEPSEEK_API_KEY` 引用仍在；`client-connection/browser-session` 仍在。
- 退出前后 browser-session hash `0672e0758c318482`、DeepSeek ref hash `ecc8c344f0be3822` 未变；**其他登录不受影响：PASS**。
- 原有模型：`llm-deepseek` 等 row 仍 active；未替换 `openai`/`openai-codex`。

## 9. OpenViking 隔离

- 对 `viking://` 搜索 `gpt配置`、`tool-ok`、`acceptance-ok`、`acct-c5a880657bd2d8255b6d4738`、`d0aa7185`、`run-20261030-0125`：**无匹配**。
- 测试文件写入项目内 `.acceptance-tmp/`，未写入 OpenViking 生产资源；**测试数据未混入知识库：PASS（当前检索结果）**。
- 未修改 OpenViking 容器、配置或数据目录。

## 10. 日志/证据秘密检查

- `acceptance/` 下证据文件：无 `sk-`、JWT 样串或真实 token；credential 文件只存 account id、client ID/subject 的截断 SHA-256。
- DSH 全部 session log 对当前 ChatGPT access/refresh/id token 的精确匹配：**未命中**。
- **FAIL**：当前验收会话 `session-3e155199-bdbd-44f0-b415-3df7b39aa8ec` 的日志包含一次 `client-connection/browser-session` 的 `secret`。原因是验收早期一个 redaction 脚本只遮蔽 token/api-key 字段，没有遮蔽通用 `secret` 字段。该值没有写入 `ACCEPTANCE.md` 或 `acceptance/` 导出，但会话日志不要导出/分享；建议轮换该 browser session（退出 DSH 浏览器登录后重新连接），并避免把该 session log 作为证据附件。  
  这不是 ChatGPT access/refresh token 泄漏，但仍是登录凭据卫生问题，故整体验收不能 PASS。

## 11. 验收矩阵

| # | 项目 | 结果 |
|---|---|---|
| 1 | 包版本/loaded row/provider/授权入口可见 | **PASS**（0.1.0；row active；slot active；用户完成登录） |
| 2 | 账号/权限状态、模型目录来自本次授权 | **PASS**（planEnabled；8 个真实 slug） |
| 3 | 短文本 `response.completed` + request ID/model/usage/终态 | **PASS**（provider probe；DSH session 完成） |
| 4 | 两轮上下文；无副作用工具调用/结果 | **PASS**（两轮 `OK`；bash `tool-ok`） |
| 5 | 项目临时目录文件任务；其他文件未改动 | **PASS** |
| 6 | 取消；流中断/限额/权限失败展示 | 取消 **PASS**；后端失败码 **SIMULATED PASS**；UI 展示 **NOT_RUN** |
| 7 | 重启凭据恢复；真正 token 刷新 | 恢复 **PASS**；真实刷新 **NOT_RUN** |
| 8 | 退出/远端撤销；再次登录复用注册；其他登录 | 退出+撤销 **PASS**（UI 修复后复核 NOT_RUN）；已登录重授权 URL 复用 **PASS**；live 重授权 **BLOCKED**；退出后重登复用 **FAIL**；其他登录 **PASS** |
| 9 | 日志/会话/证据无秘密；测试不混入知识库 | 证据/知识库 **PASS**；当前 session log **FAIL**（browser-session secret） |
| — | 整体 | **FAIL / 未通过** |

## 12. 异常与回退

1. **Sign out TypeError**：已修复 JSON-safe payload；若再次出现，检查 `accounts.signOut` 写出的 grant payload 是否含 `undefined`；测试用 `MemoryCredentials` 已收紧拒绝 `undefined`。
2. **退出后重登不复用注册**：当前为已知设计缺口。修复方向：退出时保留非秘密 registration tombstone（clientId/subject/email，不含 token），status 暴露“可重新连接”的账号，并让 coordinator 支持 `reconnect` intent；不得把 clientId 之外的 token 留在 tombstone。
3. **live 重新授权页面超时**：保留原账号；通过 `/chatgpt-plan/cancel` 清理 pending。需复现时记录浏览器可见错误与时间，不记录 URL/state/nonce/token。
4. **browser-session secret 出现在当前 session log**：不要导出该 session；轮换 browser session；后续 redaction 必须覆盖任意 `secret` 字段。
5. **回退安装**：`plugin_manager` `remove_bundle` 移除 `@local/dsh-chatgpt-plan`，或禁用 row `openai-chatgpt-plan`；确认 profile dependency/bundle 中该项移除；重启。不要删除 OpenViking、DeepSeek 或 `client-connection` 记录。账号可按面板/路由退出后删除 `openai-chatgpt-plan/*` 记录；保留 tombstone 不影响其他登录。

## 13. 证据文件

- [raw-provider.json](./acceptance/raw-provider.json)
- [dsh-session-summary.json](./acceptance/dsh-session-summary.json)
- [simulated-failures.json](./acceptance/simulated-failures.json)
- [credential-before.json](./acceptance/credential-before.json)
- [credential-after-signout.json](./acceptance/credential-after-signout.json)
- [credential-after-relogin.json](./acceptance/credential-after-relogin.json)
- [revoke-probe.mjs](./acceptance/revoke-probe.mjs)
- [file-baseline.sha256](./acceptance/file-baseline.sha256)
- [file-task-dir.txt](./acceptance/file-task-dir.txt)
