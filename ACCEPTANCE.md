# ACCEPTANCE — dsh-chatgpt-plan-plugin

- 验收日期：2026-10-30（Asia/Shanghai）
- Profile：`web`（`<DSH_HOME>/profiles/web`）
- 插件：`@local/dsh-chatgpt-plan` 0.1.0
- 安装方式：`plugin_manager` `install_bundle`，target 为项目绝对目录（本地 `link:`）
- 结论：**FAIL / 尚未整体验收通过**
  - 核心安装、登录、模型目录、DSH 文本/多轮/工具/文件任务、取消、重启恢复、退出撤销均有实测证据；
  - 但“退出后再次登录复用 issued client ID”实测 **FAIL**；live 重新授权页面报错/超时 **BLOCKED**；真实 token 刷新 **NOT_RUN**；流中断/限额/权限的 UI 展示仅用夹具验证；当前会话日志含一次 browser-session secret 泄漏（见第 10 节）。
  - 因此不能把“已安装”“已登录”“出现文字”“退出 0”当作整体 PASS。

> **2026-10-31（v0.2.0）**：在另一台机器（DSH `0.2.1-rc.5`、profile `web`）重新安装并加载成功；“退出后重新连接复用 issued client ID”已实现并有离线测试（会话 tombstone + reconnect intent），但该机器上的真实登录/推理/刷新/撤销 **未复测**。第 11 节中 live 重授权、真实刷新、UI 失败展示与日志卫生的结论仍然有效。新证据见第 14 节。

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
2. **退出后重登不复用注册**：v0.1.0 的已知设计缺口；v0.2.0 已修复——退出时保留非秘密 registration tombstone（`clientId`/`subject`/`issuer`/`email`/`label`，不含 token），status 暴露 `reconnectable`，coordinator 支持 `reconnect` intent，Models 面板出现 `Reconnect`；callback client id 与 ID token `sub` 必须与 tombstone 一致。离线测试覆盖；真实环境复测仍 **NOT_RUN**。
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
- [install-20261031.json](./acceptance/install-20261031.json)
- [login-20261031.json](./acceptance/login-20261031.json)
- [transport-failure-20261031.json](./acceptance/transport-failure-20261031.json)
- [tools-20261031.json](./acceptance/tools-20261031.json)
- [reconnect-20261031.json](./acceptance/reconnect-20261031.json)
- [reauth-20261031.json](./acceptance/reauth-20261031.json)
- [reasoning-empty-20261031.json](./acceptance/reasoning-empty-20261031.json)
- [revoke-probe.mjs](./acceptance/revoke-probe.mjs)
- [file-baseline.sha256](./acceptance/file-baseline.sha256)
- [file-task-dir.txt](./acceptance/file-task-dir.txt)

## 14. 2026-10-31 复装与 v0.2.0 修复（另一台机器）

- 环境：Node `v24.21.0`、pnpm `12.9.1`、DSH `0.2.1-rc.5`、profile `web`。
- 插件：`@local/dsh-chatgpt-plan` `0.2.0`（`link:/home/qwei/dsh-chatgpt-plan-plugin`）。
- 兼容门禁：`peerDependencies` 由精确 `0.2.1-rc.2` 改为 `>=0.2.1-rc.2 <0.2.2`，`0.2.1-rc.5` 通过 `evaluatePluginCompatibility`。
- 安装：`plugin_manager install_bundle`，target 为项目绝对路径。
  - `stage: enable`、`changed: true`、`application: applied`、`version: 0.2.0`、`warnings: []`
  - pnpm 退出码 0；警告只说明被 `link:` 的包不会从 profile `node_modules` 解析 peer（DSH Host 运行时提供 peer）。
- 加载（无需重启）：
  - profile `package.json` 依赖新增 `"@local/dsh-chatgpt-plan": "link:/home/qwei/dsh-chatgpt-plan-plugin"`，bundle 列表新增 `@local/dsh-chatgpt-plan`；
  - `plugin_manager list_plugins`：`include:openai-chatgpt-plan`，`moduleName=@local/dsh-chatgpt-plan`，`enabled=true`，`fiberPhase=active`；
  - Client `Slots.listSubTree('settings.models.footer')`：occupant `openai-chatgpt-plan-account`，order 10，active；
  - `GET http://127.0.0.1:3080/chatgpt-plan/status` → 200：
    `{"signedIn":false,"accounts":[],"reconnectable":[],"providerRegistered":false,"modelCount":0,"callbackAvailable":true,"loginPending":false}`
    `callbackAvailable=true` 表示 `/auth/callback` 注册成功。
- 离线验证（DSH `0.2.1-rc.5` peer）：`79 tests / 79 pass / 0 fail`；`npm run check` 通过。
- v0.2.0 新增离线覆盖：
  - sign-out tombstone 只保留非秘密注册身份，不包含 access/refresh/id token；
  - `status.reconnectable` 暴露账号但不含 clientId/subject；
  - 退出后 `Reconnect` 的 authorize URL 复用 issued client id、无 `agent_name_hint`、无 `id_token_hint`、带 `login_hint`；
  - reconnect callback 拒绝不同 client id、拒绝不同 `sub`；
  - 旧版纯时间戳 tombstone 不提供 reconnect；
  - 第 5 个 pending 登录被拒绝，过期 attempt 在容量判断前清理。
- 2026-10-31 追加（源码已改，Host 需重启才加载）：`status.pendingSignIns`；`start` 前清理过期 attempt；面板在 `loginPending=true` 时显示取消并禁用重复发起；`TOO_MANY_PENDING`/`LOGIN_IN_PROGRESS` 改为可操作文案。当前运行的旧代码下，可用 `POST /chatgpt-plan/cancel`（同源 `Origin` + JSON）立即清空 pending。
- **安装时未执行**：真实 ChatGPT 登录、推理、工具、真实 token 刷新、退出/撤销、live 重新授权。登录随后在 §15 完成，模型目录由该账号实时返回 8 个；推理/工具/刷新/退出与重连仍未执行。
- 脱敏证据：[acceptance/install-20261031.json](./acceptance/install-20261031.json)。

## 15. 2026-10-31 本机真实登录（web profile，DSH 0.2.1-rc.5）

- 用户在 Models 页完成 Sign in with ChatGPT；`GET /chatgpt-plan/status` 实测：
  `signedIn=true`、`planEnabled=true`、`providerRegistered=true`、`modelCount=8`、`pendingSignIns=0`、`loginPending=false`、`reconnectable=[]`、`callbackAvailable=true`。
- 账号 1 个：`acct-39f71f01da6bc3125abdc75b`；email 在证据文件中脱敏。
- 凭据：`openai-chatgpt-plan/state` + 每账号独立 grant；grant 字段齐全（含 scopes/expiresAt/generation），**未导出任何 token**。
- pending 机制实测（新代码已加载）：
  - `POST /chatgpt-plan/start {"newAccount":true}` → `pendingSignIns=1`、`loginPending=true`（URL 已丢弃，未打开授权页）；
  - `POST /chatgpt-plan/cancel` → `pendingSignIns=0`、`loginPending=false`，原账号仍 `signedIn=true`。
- `status` 中出现 `pendingSignIns` 证明 Host 已运行 v0.2.0 的 pending 清理代码。
- 仍未执行：在 GUI 选 ChatGPT Plan 模型做真实文本/工具调用、退出→Reconnect live 复用、真实 token 刷新（access 到期 2026-10-31T22:06:59+08:00）、live 重新授权。
- 证据：[acceptance/login-20261031.json](./acceptance/login-20261031.json)。

## 16. 2026-10-31 首次真实文本尝试：TRANSPORT（链路问题，非插件协议错误）

- 会话 `chatgpt测试`（`session-2d0050de-dcee-40a6-892f-9b61ff4aa49d`），模型 `gpt-6.1-sol`，reasoning `medium`，声明工具 40 个；`request/header` seq 16，三次 `assistant/attempt` seq 20/23/26，`turn/end` seq 28。
- 三次尝试各约 5.0 s 后失败，最终 `TRANSPORT` / “The ChatGPT-plan transport failed”；该版本尚未携带底层 cause。
- 同机独立复现（不经过插件、使用假 token，只测连接）：
  - curl 经本地代理 GET `https://api.openai.com/v1/models` 10 次：8 次 401，2 次 `000` + TLS `unexpected eof`（约 3.0 s），另有 2 次 >2 s；
  - Node `fetch` 同一路径 10 次：9 次 401，1 次 `TypeError: fetch failed`，cause `ECONNRESET`（3021 ms）；
  - Host 日志同期出现 `api.deepseek.com` 模型列表 5000 ms 超时。
- 另一台机器同一插件、同一账号当前正常，说明是**当前机器的代理/TLS 链路**问题，不是凭据、scope、请求体或插件协议。
- 复现命令（不含 token）：

  ```bash
  for i in $(seq 1 20); do
    curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" \
      -H 'authorization: Bearer invalid' https://api.openai.com/v1/models
  done
  ```

- 代码改进（需重启 Host 才加载）：`TRANSPORT` 消息与日志带安全 cause code；重试策略由 3 次/0.5 s 起改为 5 次/1 s 起（1 s/2 s/4 s/8 s，单次上限 15 s）。
- 结论：真实文本/工具调用仍未 **PASS**；阻断条件是本机到 `api.openai.com` 的间歇 TLS reset。切换/重启代理节点后需重测。
- 证据：[acceptance/transport-failure-20261031.json](./acceptance/transport-failure-20261031.json)。

## 17. 2026-10-31 工具调用与多轮上下文（本机 GUI，PASS）

会话 `chatgpt测试`（`session-2d0050de-dcee-40a6-892f-9b61ff4aa49d`），provider `openai-chatgpt-plan`，model `gpt-6.1-sol`。

| turn | 内容 | 结果 |
|---|---|---|
| 2 | “只回复OK，不要调用任何工具” | assistant `OK`；usage 9887/5/9892；单个 `finish: stop`；**PASS** |
| 3 | “用 bash 运行 printf tool-ok 并原样回复” | tool-call `call_ua1urnM6NtFOqPX3FZNzVgRE`，args `{"command":"printf tool-ok"}`；tool/result 同一 callId，`isError=false`，内容 `tool-ok`；随后 assistant `tool-ok`，`finish: stop`；usage 11138/20/11158；**PASS** |
| 4 | “上一条命令输出的字符串是什么？只回答它。” | assistant `tool-ok`；**PASS** |
| 5 | “先用 bash 运行 pwd，再用 read 读取 README.md 的前 3 行” | 两个独立 callId：`call_qBbqzv9JiVfD4gyoRHlQr0x6`（pwd）与 `call_UeD2qeC2Nt7A7VPVO16qZDvG`（第二个 bash 读取 README）；两次 result 都正确回填，最终答案含 cwd 与 README 前 3 行；**PASS（有偏差）** |

核对项：

- 每个 step 只有一个终态 `finish`，工具轮为 `tool-calls`，最终轮为 `stop`；
- `tool/result.toolCallId` 与 `tool-call.id` 一致，`isError=false`；
- 每轮都有 usage；
- 多轮历史与工具结果在同一会话中延续。

偏差/观察：

- turn 5 中模型把“用 read”改成了第二个 `bash` 循环读取；两个 `call_id` 独立且结果正确，属模型选择，不是序列化错误；
- turn 5 第二步 assistant message 里有一个**空 reasoning 块**（`text=""`）。不影响答案，但 UI 可能出现空思考块；已在 §20 修复；
- DSH 会话日志不持久化请求体，因此“工具结果回填”的证据是：live tool result + 正确最终答案 + 离线 serializer 测试。

仍未验证：退出→Reconnect live、真实 token 刷新、live 重新授权、限额/权限 UI。
证据：[acceptance/tools-20261031.json](./acceptance/tools-20261031.json)。

## 18. 2026-10-31 退出 → Reconnect live（本机，PASS）

用户重启 DSH 后，在 Models 面板手动退出 ChatGPT 账号，再使用 `Reconnect` 重新登录。

- 退出前账号：`acct-39f71f01da6bc3125abdc75b`，grant record `openai-chatgpt-plan/pending-eea07ed36975e57c`。
- 重连后账号：**同一个** `acct-39f71f01da6bc3125abdc75b`；grant record 变为 `openai-chatgpt-plan/reconnect-17aa42ca0e57e990`。
- account id 由 `sha256(issuer + subject + issued clientId)` 派生，ID 不变即 issued client id 未变；`reconnect-*` record id 只有 reconnect intent 会分配，新注册会使用 `pending-*`。
- 重连后：`planEnabled=true`、`reauthRequired=false`、`generation=1`（新 grant）、scopes 含 `chatgpt.tokens.use.direct`、access 到期 2026-10-31T22:30:09+08:00。
- state：`accounts=[acct-39f71f01da6bc3125abdc75b]`、`tombstones=[]`、`activeAccountId` 指向同一账号；**tombstone 在重连成功后清除**。
- `/chatgpt-plan/status`：`signedIn=true`、`providerRegistered=true`、`modelCount=8`、`pendingSignIns=0`、`reconnectable=[]`。
- 未捕获：sign-out 返回的 `remoteRevoked` 值（面板操作，未从日志读取）；未读取或导出任何 token。
- 结论：**退出 → Reconnect 复用 issued client ID：PASS（live）**。
- 证据：[acceptance/reconnect-20261031.json](./acceptance/reconnect-20261031.json)。

## 19. 2026-10-31 Sign in again live（本机，PASS）

用户在同一已登录账号上执行 `Sign in again`（不是 Sign out）。

- 授权 URL 形状（解析后立即取消，URL 不落盘）：
  `method=reauth`、`client_id` 非 `dynamic_agent_client`、无 `agent_name_hint`、无 `ext_agent_host_id`、带 `id_token_hint` 与 `login_hint`、PKCE `S256`、redirect 精确、scope 含 `chatgpt.tokens.use.direct`。
- 重授权前后对比：

  | 项 | 前 | 后 |
  |---|---|---|
  | account id | `acct-39f71f01da6bc3125abdc75b` | 同 |
  | grant record | `openai-chatgpt-plan/reconnect-17aa42ca0e57e990` | **同**（未新建 `pending-*`） |
  | clientId hash | `3ead95b1387325c9` | 同 |
  | generation | 1 | **2** |
  | addedAt | 2026-10-31T21:30:09+08:00 | **不变** |
  | lastRefreshAt | 2026-10-31T21:30:09+08:00 | 2026-10-31T21:41:27+08:00 |
  | expiresAt | 2026-10-31T22:30:09+08:00 | 2026-10-31T22:41:27+08:00 |

- state：单账号、无 tombstone、active 不变；status `signedIn=true`、`providerRegistered=true`、`modelCount=8`、`pendingSignIns=0`、`reconnectable=[]`。
- 结论：**已登录账号的 live 重新授权 PASS**；issued client ID 复用、ID token 验证通过、同一 grant 原子覆盖。
- 证据：[acceptance/reauth-20261031.json](./acceptance/reauth-20261031.json)。

## 20. 空 reasoning 块修复（离线 + live PASS）

- 根因：`response.output_item.added` 一到就发送 reasoning 的 `block-start`，即使该 reasoning item 没有任何 summary 文本；`output_item.done` 仍发送 `block-end`，于是产生 `{type:"reasoning", text:""}`。
- 修复（[lib/adapter.js](./lib/adapter.js)）：
  - reasoning 的 `block-start` 延迟到出现非空文本；
  - 空 delta 不创建、不启动 reasoning slot；
  - `finalize` 先解析 item 的 summary/content，仍为空则丢弃该 slot 并回退 blocks 计数；
  - 只有空 reasoning 的响应按 `EMPTY_RESPONSE` 处理；
  - 防御分支：若块已被宣布但文本为空，仍发送 `block-end` 以闭合协议。
- 离线验证：4 个新用例（空 reasoning + 文本、非空 delta、仅 item 文本、仅空 reasoning）；**79 tests / 79 pass / 0 fail**。
- live 复测（已重启 Host）：turn 6 “先思考再只回复 OK” → assistant 只有 `text: "OK"`；`reasoningTokens=8`；**text 块 index=1**，说明 index 0 的 reasoning 槽位仍被分配但被抑制。对比修复前：seq 36 纯文本 index=0，seq 73 空 reasoning 产生 index 0 的 `reasoning text=""` + index 1 的 tool-call。**live PASS**。
- 证据：`test/adapter.test.mjs`、[acceptance/reasoning-empty-20261031.json](./acceptance/reasoning-empty-20261031.json)；无 token/凭据写入。

## 21. 限额/权限/网络错误的 UI 展示（离线 PASS，live 触发 NOT_RUN）

目标：让额度、资格/权限、限流、网络/超时错误在 UI 上语义正确、可操作，而不是只显示泛化的英文或误导性的 “API key is invalid”。

- **聊天错误行（DSH 所有）**：
  - `subscription_sharing_user_not_eligible` 从 `QUOTA` 改为 `PLAN_INELIGIBLE`，不再被 DSH 显示成“额度已用尽”，也不触发全局额度提示；
  - 401/403/无效账号/`invalid_client` 从 `AUTH` 改为 `AUTH_REJECTED`。DSH 对 `AUTH` 会强制显示 “API key is invalid” 并丢弃插件消息，对 OAuth 凭据是误导；
  - `REAUTH_REQUIRED`、`PLAN_DISABLED`、`MISSING_CREDENTIAL`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、空响应/流中断均带下一步动作（重新登录路径、检查代理、重试或等待重置）；
  - `QUOTA` 保留：DSH 会本地化成“额度已用尽”并显示全局额度提示。
- **Models 面板（插件所有）**：
  - Host 新增 `RequestErrorStore`（[lib/request-errors.js](./lib/request-errors.js)），在适配器失败时记录白名单字段（code/message/status/providerCode/retryAfterMs/at），成功、重新登录、切换/退出账号时清除；
  - `/chatgpt-plan/status` 返回脱敏的 `lastRequestError`；
  - 客户端按 `en`/`zh` 渲染“最近一次请求失败”横幅，分类为额度/资格/凭据/重新登录/缺少 scope/限流/网络/超时/服务端/流中断/不支持，显示 `code · HTTP status · retry Ns`，可手动忽略。
- **离线验证**：适配器 401→`AUTH_REJECTED`、403 不符合资格→`PLAN_INELIGIBLE`、429 带 `Retry in 3s`、`TRANSPORT` 指引代理、失败记录与成功清除；status 对 `lastRequestError` 做字段白名单；客户端 en/zh 键一致。**83 tests / 83 pass / 0 fail**。
- **live 触发 NOT_RUN**：需要真实的 429/403 或断网才能看到聊天错误行与面板横幅；未为了测试而破坏当前网络或额度。重启 Host 加载新代码后，遇到真实错误即为 live 验证。
- 边界：Chat 错误行由 DSH 拥有；插件不能替换其本地化逻辑（除选择语义正确的错误码/消息），因此中文界面里聊天行仍可能显示英文 `message`，面板横幅是插件自己的中英文面。
