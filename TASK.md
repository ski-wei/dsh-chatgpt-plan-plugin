# DSH ChatGPT Plan Provider：实施任务书

- 版本：v1（只读发现阶段产出）
- 日期：2026-10-29（Asia/Shanghai）
- 对应发现报告：[DISCOVERY.md](./DISCOVERY.md)
- 当前阶段：**只读检查完成，未实现、未安装、未登录、未推理**
- 目标读者：后续实施会话 / Creator mode 会话 / 代码评审者

---

## 1. 目标

开发一个可安装的 DSH bundle，让用户通过 **Sign in with ChatGPT** 授权，并在其符合条件的 ChatGPT 计划下，使用 GPT 模型作为 DSH 原生模型提供方。

必须满足：

1. 新增 provider 路由 `openai-chatgpt-plan`，**不覆盖** `openai` 或 `openai-codex`。
2. 登录使用 OpenAI 当前 **OSS 动态注册 + Responses API** 路径，不使用旧 Codex token / client / `backend-api`。
3. 登录复用 callback 返回的 **issued client ID**；重新登录不重新注册。
4. 用官方 JWKS 验证 ID token（issuer / audience / exp / nonce / sub）。
5. 支持多账号隔离；同一记录内按账号保存 token，active account 可切换。
6. 刷新串行化；rotation 后写回；失败按官方错误码分类。
7. 退出尝试远端撤销，再删本地。
8. 模型目录来自账号的 `GET /v1/models`，不是写死 catalog。
9. 通过 DSH 公开扩展点注册：`ctx.llm.registerAdapter`、`ctx.credentials`、`ctx.webServer`、Client slot `settings.models.footer`。
10. 不在 Config / Settings / 日志 / 状态 JSON 中输出秘密。

---

## 2. 非目标

- 不修改 DSH 全局安装目录中的 `dsh-llm-pi-ai/lib/index.js`。
- 不编辑现有 profile 的 `package.json` / `cordis.patch.yml` / 凭据文件（本阶段）。
- 不把旧 `openai-codex` 登录缓存导入新 provider。
- 不把 ChatGPT 计划 token 当作普通 OpenAI API key 长期保存（access token 仅作为请求凭据，刷新由插件负责）。
- 不实现 Codex app-server / 任务委派路线；本插件只提供 DSH 主模型。
- MVP 不做托管多租户/远程服务端；仅本机 loopback Web。
- 不实现通用 OAuth UI / Remote 命名空间；MVP 用 Host HTTP + Models footer。

---

## 3. 已确定的架构决策

| ID | 决策 | 理由 |
|---|---|---|
| D1 | 新 route `openai-chatgpt-plan` | 唯一、不冲突；`registerAdapter` 对重复 route 全有或全无 |
| D2 | 复用 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter` | 复用 message/tool/image/replay/attribution 转换，减少协议偏差 |
| D3 | 内部 pi-ai provider/模型 `provider` 仍为 `"openai"` | 触发 pi-ai 的 `isChatGPTSignIn`，自动省略计划路由不支持字段 |
| D4 | 子类 shim 在 `PiAiAdapter.current()` 快照中挂 `openai` alias | `Models` 按 `model.provider` 查找 provider；这是复用 `PiAiAdapter` 的最小改动点 |
| D5 | 一个 credential record `openai-chatgpt-plan/accounts` | `modifyRecord` 提供跨进程锁；payload 内多账号隔离 |
| D6 | Host HTTP 路由 + Models footer | 通用 authorization seam 没有现成 Web UI；不新增 Remote 构建面 |
| D7 | 回调使用 DSH 现有 loopback HTTP `/auth/callback` | DSH Web 已是 `http://127.0.0.1:3080`，WSL→Windows 可达性已被 GUI 证明；官方只允许 port 变化 |
| D8 | `jose` 做 ID token 验签 | 官方示例使用 `jose`；DSH 依赖树已有 6.2.13 |
| D9 | 不注册 `ctx.authorization` flow（MVP） | 多账号/重新授权需要动态 key；没有 UI 消费；避免制造“已注册但不可用”的假象 |
| D10 | 先做无登录 adapter spike，再做 OAuth | 先排除 tools/alias 两个最高风险 |

> D3/D4 是版本敏感设计。若 `dsh-llm-pi-ai` 升级后 `current()` 或 provider 查找变化，退回“自写 LlmAdapter + 直接调用 pi-ai `openaiProvider().stream`”的方案 B（见 DISCOVERY 7.2）。

---

## 4. 里程碑与任务

### M0 — Adapter/alias spike（不登录、不发真实请求）

**目标**：证明 `PiAiAdapter` 可以被新 route 复用，且请求体满足 ChatGPT 计划限制。

任务：

- [ ] 创建 workspace bundle 骨架（package.json、cordis.patch.yml、index.js）。
- [ ] 构造合成 `ResolvedPiAiProviderProfile`：
  - `provider: "openai-chatgpt-plan"`
  - `piProvider`: `{ ...openaiProvider(), id: "openai-chatgpt-plan", getModels: () => models }`
  - 模型：从 `OPENAI_MODELS` 克隆，`provider: "openai"`，`baseUrl: "https://api.openai.com/v1"`。
- [ ] 子类 `ChatGptPlanAdapter extends PiAiAdapter`，覆盖 `current()`，在快照的 `models` 中注册 id 为 `"openai"` 的 alias。
- [ ] 用 mock access token（非 `sk-` 开头）和 mock global `fetch` 捕获请求体。
- [ ] 断言：`store === false`、`stream === true`、无 `max_output_tokens`、无 `temperature`、无 `prompt_cache_retention`、`tools` 形态被记录。
- [ ] 断言：system prompt 对 reasoning 模型是 developer 角色；确认非 reasoning 模型不会进入 MVP 目录。
- [ ] 断言：DSH `listProviders()` 只多出 `openai-chatgpt-plan`；`openai`/`openai-codex` 未被替换。
- [ ] 用一个最小 function tool 分别捕获新模型（`gpt-5.4`，compat 走 `additional_tools`）和旧模型（`gpt-5`，顶层扁平 `tools`）的请求体，记录实际形态；M0 只做 mock 捕获，服务端是否接受留到 M6 live 验证。

**退出标准**：

- mock 请求体满足已知限制（除 tools 待定）。
- `listModels` 能返回至少一个模型。
- 若 live 验证发现旧模型的扁平 `tools` 被拒：记录 `error.param`，把该模型过滤掉；优先在 alias provider 外包一层 `fetch`，把顶层 `tools` 改写为 `additional_tools` input item（`{type:"additional_tools", role:"developer", tools:[...]}`）；若改写不足以覆盖 tool call/output 语义，再走方案 B 自写 adapter。

**状态**：`NOT_RUN`（需要写代码；本阶段禁止）。

---

### M1 — OAuth 协调器（Host）

**目标**：完成官方 OSS 注册/登录/重新登录/回调/兑换/ID token 验证。

任务：

- [ ] `lib/oauth.js`：
  - 生成 `state` / `nonce` / PKCE verifier + S256 challenge。
  - 构造 authorize URL：
    - 新账号：`client_id=dynamic_agent_client`、`agent_name_hint=<app name>`、`ext_agent_host_id=<hostId>`。
    - 重新登录：`client_id=<saved clientId>`、无 `agent_name_hint`、`id_token_hint`、可选 `login_hint`。
    - 两者都带 `response_type=code`、`redirect_uri`、`resource`、`scope`、`state`、`nonce`、`code_challenge`、`code_challenge_method=S256`。
  - token exchange：form-urlencoded，`grant_type=authorization_code`、`client_id`、`code`、`code_verifier`、`redirect_uri`、`resource`。
  - 解析 token response：`access_token`、`refresh_token`、`id_token`、`token_type`、`expires_in`、`scope`、`earliest_refresh_at`。
- [ ] `lib/id-token.js`：
  - 拉取 `https://auth.openai.com/.well-known/openid-configuration`，缓存 issuer/jwks_uri/revocation_endpoint。
  - `jose.createRemoteJWKSet` + `jwtVerify`：
    - issuer 精确匹配；
    - audience = issued client ID；
    - `requiredClaims: ["sub","exp","iat"]`；
    - `clockTolerance` 5s；
    - 手动校验 `nonce`；
    - 校验 `sub` 非空；`sid` 若存在必须为非空字符串。
  - 重新登录时 `sub` 必须与所选账号一致。
- [ ] 事务管理：
  - 内存 Map：`state -> { verifier, nonce, accountId, isNew, expectedClientId, redirectUri, createdAt }`。
  - TTL 10 分钟；一次性消费；最多 4 个 pending；定时清理。
  - callback `error=access_denied`：校验 state 后取消。
- [ ] 新注册 callback：
  - 必须带 `client_id`；不得为 `dynamic_agent_client`；保存。
  - 缺失 → 失败，不进入 token exchange。
- [ ] 重新登录 callback：
  - 可省略 `client_id` → 用保存值；
  - 若给出不同值 → 拒绝。
- [ ] scopes：
  - 必须含 `chatgpt.tokens.use.direct` 才 `planEnabled=true`；
  - 否则保留登录、`planEnabled=false`、不注册模型路由。

**退出标准**：

- 单测覆盖 authorize URL 的新/旧账号参数矩阵。
- 单测覆盖 callback 错误、state mismatch、client ID 缺失/不一致、nonce 不匹配、issuer/audience/exp 错误。
- 单测覆盖 identity_only 分支。
- 不发出真实网络请求（mock fetch / 本地 JWKS）。

**状态**：`NOT_RUN`。

---

### M2 — 账号记录与串行刷新

**目标**：多账号隔离、host ID 持久化、刷新/撤销。

任务：

- [ ] `lib/accounts.js`：
  - record key：`credentialKey("openai-chatgpt-plan", "accounts")`。
  - payload `version: 1`，`hostId`、`activeAccountId`、`accounts` map（见 DISCOVERY 8.1）。
  - `accountId = "acct-" + sha256(issuer + "\0" + subject + "\0" + clientId).slice(0,24)`。
  - `ensureHostId()`：首次生成 UUIDv4；写入 record；失败则中止登录。
  - `readAccounts()`：校验版本；迁移旧版本；损坏时返回诊断，不覆盖。
  - `upsertAccount()`：只有 ID token 验证通过后调用；原子写。
  - `setActive()` / `removeAccount()`：只改目标账号。
- [ ] `refreshAccount(accountId, reason)`：
  - 在 `ctx.credentials.modifyRecord(key, async current => ...)` 内执行；
  - 读取当前记录；若 access 未过期且 reason 非强制，直接返回；
  - `AbortSignal.timeout(30_000)`；
  - POST refresh form（`grant_type=refresh_token`、saved `client_id`、`refresh_token`、`resource`，无 `scope`）；
  - 旋转 refresh、更新 access/expiry/scopes；
  - 失败分类：
    - 网络/5xx/timeout：保留；
    - `invalid_grant` / `invalid_refresh_token` / `token_expired` / `refresh_token_expired` / `refresh_token_invalidated` / `refresh_token_reused`：清 access/refresh，`reauthRequired=true`；
    - `invalid_client`：配置错误，不循环。
  - 进程内 single-flight：`Map<accountId, Promise>`；跨进程依赖 `modifyRecord`。
- [ ] `signOut(accountId)`：
  - 从 discovery 取 `revocation_endpoint`；
  - POST form `token=<refresh_token>`、`token_type_hint=refresh_token`、`client_id`；
  - 200 成功；网络/5xx 最多 3 次退避；
  - 无论远端结果，删除本地账号；返回 `remoteRevoked` boolean；
  - 删除最后一个账号后 dispose adapter registration。
- [ ] 记录写入后必须 `ctx.credentials` 事件/内存缓存失效，确保下一次请求读到新 token。

**退出标准**：

- 账号 A/B 同时存在时，刷新 A 不改 B。
- 同一账号 10 个并发请求只触发 1 次 refresh 网络调用。
- 模拟双进程：第二个 `modifyRecord` 看到已刷新 token 后不再刷新（用两个 store 实例/文件锁模拟）。
- 刷新失败只清目标账号。
- 签出只删目标账号；远端失败仍删本地并报告。

**状态**：`NOT_RUN`。

---

### M3 — 模型目录与 adapter 接线

**目标**：账号级模型目录、adapter 注册/注销、token 解析。

任务：

- [ ] `lib/catalog.js`：
  - `GET {baseURL}/models`，Bearer access；
  - 解析 `body.models` 数组（官方）或 `body.data` 数组（兼容）；
  - 过滤 `visibility === "list"`；
  - **MVP 只暴露 `OPENAI_MODELS` 中同时满足 `reasoning === true && compat.supportsMidConvoSystemMessages === true && compat.supportsAdditionalTools === true` 的模型**；这既避开非 reasoning 的 `role:"system"`，也确保工具走 `additional_tools` 而不是顶层扁平 `tools` / `tool_search`。`gpt-5.4+` / `gpt-6.*` 满足；`gpt-5` / `o3` 等旧模型先隐藏。未知 slug 默认隐藏（Config `allowUnknownModels=false`），直到验证其 compat 行为；
  - `id = slug`，`name = display_name ?? slug`；
  - 元数据合并 `OPENAI_MODELS`：`contextWindow`、`maxTokens`、`input`、`reasoning`；
  - 未知模型用 Config 默认（`defaultContextWindow`、`defaultMaxTokens`、`defaultInput`），不要默认声明 image；
  - 缓存 per account 5 分钟；登录/切换/刷新/强制时失效。
- [ ] `lib/provider.js`：
  - 构造 `models`：克隆 pi-ai model，`provider: "openai"`、`baseUrl` 精确、`api: "openai-responses"`、`compat.supportsDeveloperRole = true`。
  - route provider：`{ ...openaiProvider(), id: "openai-chatgpt-plan", name: displayName, getModels: () => models }`。
  - alias provider：`{ ...openaiProvider(), id: "openai", name: "OpenAI (ChatGPT plan)", getModels: () => models }`。
  - `ChatGptPlanAdapter extends PiAiAdapter`：
    - 覆盖 `current()` 挂 alias；
    - 覆盖 `listModels()` 先 `refreshCatalog()` 再 `super.listModels()`；
    - 覆盖 `resolveModel()` 未知模型时刷新一次。
  - `ResolvedPiAiProviderProfile`：
    - `provider`、`displayName`、`piProvider`；
    - `retryPolicy`：normal，maxRetries 2，重试码不含 `QUOTA`/`AUTH`；
    - `streamIdleTimeoutMs`、`maxRequestImageBytes`、`requestImagePixelBudget`、`requestImageMaxBytes`；
    - `modelErrors: new Map()`、`configuredMaxTokens: new Map()`、`catalogError: undefined`。
- [ ] `resolveApiKey`：
  - 读 active account；`planEnabled` 为 false → 抛 `MISSING_CREDENTIAL`/`AUTH`；
  - 过期前 3 分钟刷新；
  - 返回 access token；
  - 绝不把 token 写日志。
- [ ] 路由生命周期：
  - `syncRegistration()`：有 active + planEnabled + 至少一个模型才注册；
  - 账号/目录变化 → `registration.replace(["openai-chatgpt-plan"])`；
  - 无账号 → dispose；
  - 捕获 `DUPLICATE_ADAPTER` 并给出诊断（不应发生）。
- [ ] providerInfo：`{ id: "openai-chatgpt-plan", name: displayName }`。

**退出标准**：

- 登录前 `listProviders()` 无新路由；登录后出现；签出后消失。
- 模型目录变化后 `llm/adapters-updated` 触发，模型选择器可刷新。
- `listModels` 不因缺少目录而永久为空。
- 不注册/不触碰 `openai`、`openai-codex`。

**状态**：`NOT_RUN`。

---

### M4 — Host HTTP 路由

**目标**：登录/状态/退出入口，安全且不泄漏 token。

任务：

- [ ] `lib/web-routes.js`：
  - `ctx.inject(["webServer"], ...)`；无 webServer 时只提供模型，不提供登录 UI。
  - 检查 `webServer.host` 为 loopback、`protocol === "http:"`；否则禁用登录并报诊断。
  - 注册：
    - `POST /chatgpt-plan/start`：Origin 校验；content-type JSON；调用 `beginLogin()`；返回 `{url}`。
    - `GET /auth/callback`：state 校验；调用 `completeLogin()`；返回 HTML（无 token、无 code 反射）。
    - `GET /chatgpt-plan/status`：脱敏 JSON。
    - `POST /chatgpt-plan/signout`：Origin 校验；调用 `signOut()`；返回脱敏状态。
  - `/auth/callback` 注册失败（duplicate）→ 捕获，status 返回 `callbackAvailable:false`，登录按钮禁用。
- [ ] `start` 请求体：
  - `{ accountId?: string, newAccount?: boolean }`；
  - `newAccount` 与 `accountId` 互斥；
  - 未知 accountId → 400；
  - 已有 pending 数上限 → 429。
- [ ] 回调 HTML：
  - 成功：`Signed in. You can close this window.` + `window.close()` 尝试 + 返回 DSH 链接。
  - 失败：错误码 + 重试链接；不显示 state/code/token。
- [ ] 状态 JSON：
  - `{ signedIn, activeAccountId, accounts: [{id,label,email,planEnabled,reauthRequired,expiresAt}], providerRegistered, modelCount, callbackAvailable, lastError }`；
  - 绝不包含 token/clientId/subject/full auth URL。
- [ ] 限流：pending 上限、start 每分钟上限；callback 只接受 pending state。
- [ ] 日志：只记录阶段、状态码、error code；不记录 Authorization、code、id_token_hint、refresh token。

**退出标准**：

- 无 Origin / 跨源 POST 返回 403。
- 未知 state 返回 400。
- 状态 JSON 无敏感字段（单测扫描键名/值）。
- `/chatgpt-plan/start` 在未登录时返回授权 URL；`/auth/callback` 完成后状态变为 signedIn。
- 回调失败不写 credential record。

**状态**：`NOT_RUN`。

---

### M5 — Client footer 面板

**目标**：Models 页可见、可操作、可刷新。

任务：

- [ ] `client.js`：
  - `window.__ModuleLoader__.load({ id, factory(require) { ... } })`。
  - `inject: ["slots","locale"]`。
  - `apply(ctx)`：
    - 注册 locale 字典 `openai-chatgpt-plan`；
    - `ctx.slots.inject("settings.models.footer", () => ctx.slots.register({ name: "settings.models.footer", id: "openai-chatgpt-plan-account", order: 10 }, AccountPanel))`。
  - `AccountPanel`：
    - 挂载时 `fetch("/chatgpt-plan/status")`；
    - 未登录：说明 + `Continue with ChatGPT`；
    - 已登录：active 账号 label/email、plan 状态、expiresAt、`Add account`、`Sign out`、`Sign in again`；
    - 多账号选择器；
    - pending 时 2s 轮询；`window.focus` / popup closed 时刷新；
    - `startLogin`：同步 `window.open("about:blank")`，再 POST start，设置 popup.location；被拦截则当前页导航；
    - `signOut`：POST signout，刷新；
    - 错误显示脱敏 `lastError`。
  - 样式：只用 `--dsw-alias-*` token；不引 primitives；不写 DOM 外内容；不写 localStorage token。
- [ ] `dsh.client`：
  - `platform: "web"`；
  - `immediately: true`（或 false，按实际加载需求）；
  - `inject: ["@deepseek-ai/dsh-client-ui-settings-models", "@deepseek-ai/dsh-client-locale"]`。
- [ ] `locale/en.json`、`locale/zh.json`：`meta.title`、`meta.description`；运行文案键。
- [ ] `icon.svg`：原创或可再分发；≤256 KiB；`files` 包含。

**退出标准**：

- Models 页尾部出现面板（无 provider row 也可）。
- 未登录点击按钮打开 OpenAI 授权页。
- 登录完成 popup 关闭后，面板自动变为已登录。
- 多账号切换生效；签出后状态更新。
- 面板不导致 Models 页崩溃/空白。

**状态**：`NOT_RUN`。

---

### M6 — 验证、文档、安装（需批准）

**目标**：完成静态/单测/合同测试；live 测试单独批准；安装可回退。

任务：

- [ ] `README.md`：安装、配置、账号、限制、故障排查、卸载；明确 `maxTokens`/`temperature` 在计划路由上不生效、非 reasoning 模型暂不暴露、tools 形态限制。
- [ ] 静态检查脚本/命令。
- [ ] 单测与 mock e2e（见第 7 节）。
- [ ] live 测试（需用户明确批准）：
  - 真实登录新账号；
  - 重新登录复用 clientId；
  - 多账号；
  - 刷新（缩短有效期或 mock 时钟）；
  - 签出撤销；
  - 文本回复；
  - tool call；
  - quota/错误模拟；
  - 重启持久化。
- [ ] 安装：Creator mode `plugin_manager` `install_bundle`，target 为项目绝对目录；保存返回 `application` / `warnings`。
- [ ] 验证：`list_plugins` / `cordis_inspect_query`（Creator mode）；页面刷新；Models footer；模型选择器。
- [ ] 回滚：`remove_bundle` 或禁用；删除 credential record；不删除用户其他凭据。

**状态**：`NOT_RUN`。

---

## 5. 文件清单

```text
dsh-chatgpt-plan-plugin/
├── DISCOVERY.md                 # 本阶段发现报告（已完成）
├── TASK.md                      # 本文件（已完成）
├── README.md                    # 安装/配置/限制/故障排查
├── package.json                 # bundle + dsh.client + exports + peerDeps
├── cordis.patch.yml             # 插入 id=openai-chatgpt-plan 行
├── index.js                     # Host apply / inject / Config 导出
├── client.js                    # Models footer Client 模块
├── icon.svg                     # 插件图标
├── locale/
│   ├── en.json                  # meta + UI 文案
│   └── zh.json
├── lib/
│   ├── config.js                # Config schema（非秘密）
│   ├── constants.js             # endpoint/scope/redirect/timeout 常量
│   ├── errors.js                # OAuth/HTTP/LLM 错误分类与脱敏
│   ├── host-id.js               # UUIDv4 host ID 生成/校验
│   ├── oauth.js                 # authorize/exchange/refresh/revoke
│   ├── id-token.js              # discovery + JWKS + jose 校验
│   ├── accounts.js              # credential record、账号、刷新、签出
│   ├── catalog.js               # GET /v1/models、缓存、元数据
│   ├── provider.js              # PiAiAdapter shim + openai alias
│   ├── adapter.js               # ChatGptPlanAdapter、注册/注销
│   ├── web-routes.js            # start/callback/status/signout
│   └── log.js                   # 脱敏日志
└── test/
    ├── static.test.mjs
    ├── oauth-params.test.mjs
    ├── id-token.test.mjs
    ├── accounts.test.mjs
    ├── catalog.test.mjs
    ├── adapter.test.mjs
    ├── web-routes.test.mjs
    ├── e2e-mock.test.mjs
    └── fixtures/
        └── jwks.test.mjs        # 测试时生成 RSA/JWKS，不提交私钥
```

### 5.1 `package.json` 要点

```json
{
  "name": "@local/dsh-chatgpt-plan",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": [
    "index.js",
    "client.js",
    "lib/",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-settings-models",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-llm": "0.2.1-rc.2",
    "@deepseek-ai/dsh-llm-pi-ai": "0.2.1-rc.2",
    "@deepseek-ai/dsh-credentials": "0.2.1-rc.2",
    "@deepseek-ai/dsh-host-webserver": "0.2.1-rc.2",
    "@earendil-works/pi-ai": "1.4.0"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-host-webserver": { "optional": true }
  },
  "dependencies": {
    "jose": "^6.2.13"
  }
}
```

说明：

- `host-webserver` 设为 optional peer：headless 组合没有 Web 登录入口，但模型 provider 仍可工作；`ctx.inject(["webServer"], ...)` 不满足时不注册登录路由。
- Client 侧的 `dsh-client-ui-settings-models` / `dsh-client-locale` 只通过 `dsh.client.inject` 排序，不是 Host 运行时依赖；不要把它们写成 Host peer。

说明：

- `peerDependencies` 先按当前精确版本锁定；`install_bundle` 的兼容检查可能要求放宽/精确，以实际返回为准。
- `@earendil-works/pi-ai` 是 DSH 安装树的传递依赖；若运行时解析不到，改为 `dependencies` 并锁定 1.4.0（会产生第二份副本，需验证结构兼容）。
- `jose` 必须显式依赖；不要依赖 DSH 的传递安装。
- local directory 安装是 `link:`，`files` 不过滤链接目录；实际发布前要 `npm pack --dry-run` 检查。

### 5.2 `cordis.patch.yml`

```yaml
- insert:
    - id: openai-chatgpt-plan
      name: '@local/dsh-chatgpt-plan'
      config:
        enabled: true
```

- id 必须唯一，不能是 `openai` / `openai-codex`。
- 不要在这里写 token、host ID、账号。
- 若未来需要调整 `displayName` / 超时，只改非秘密字段。

---

## 6. 公开 API 使用清单（实施时按此调用）

| 能力 | API | 来源 |
|---|---|---|
| 注册 provider | `ctx.llm.registerAdapter(["openai-chatgpt-plan"], adapter)` | `dsh-llm` |
| 替换/注销 | `handle.replace([...])` / `handle()` | `dsh-llm` |
| Adapter 基类 | `extends LlmAdapter`，至少实现 `stream` | `dsh-llm` |
| 复用转换 | `new PiAiAdapter({ profiles, resolveApiKey, auth, ... })` | `dsh-llm-pi-ai` |
| 凭据记录 | `ctx.credentials.modifyRecord(key, mutate)` | `dsh-credentials` |
| 记录 key | `credentialKey("openai-chatgpt-plan", "accounts")` | `dsh-credentials` |
| HTTP 路由 | `ctx.webServer.register({ kind, path, handler })` | `dsh-host-webserver` |
| 本机 origin | `ctx.webServer.getOrigin()` | `dsh-host-webserver` |
| Client 槽位 | `ctx.slots.inject("settings.models.footer", () => ctx.slots.register(...))` | `ctx.slots`（Client renderer 提供；槽位类型声明来自 `dsh-client-ui-settings-models`） |
| 本地化 | `ctx.locale.register(ns, { zh, en })` / `ctx.locale.bind(ns)` | `dsh-client-locale` |
| 安装 | Creator mode `plugin_manager install_bundle` | `dsh-plugin-manager` |

**不要使用**：

- `ctx.authorization.registerFlow`（MVP 不使用；除非未来做单账号通用 UI）。
- `ctx.settings` 存 token。
- 任何 `openai-codex` / `backend-api` / 旧 Codex token。
- 直接编辑 `dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`。

---

## 7. 测试计划

### 7.1 静态检查（无需网络/账号）

| 检查 | 方法 | 通过标准 |
|---|---|---|
| JS 语法 | `node --check index.js client.js lib/*.js` | 全部 exit 0 |
| manifest | `node -e` 解析 package.json；检查 `dsh.bundle.patch`、`dsh.client.platform`、exports | 字段存在且路径存在 |
| patch YAML | YAML 解析；检查 insert id 唯一 | 可解析 |
| locale | JSON 解析；en/zh 同键 | 无缺失 |
| icon | 文件存在、格式、≤256 KiB | 通过 |
| 秘密扫描 | grep `access_token`/`refresh_token`/`id_token`/`client_secret` 在源码/配置/JSON 中 | 仅变量名/占位符，无真实值 |
| 文件清单 | `npm pack --dry-run`（若打包） | 包含所有运行文件 |

**当前状态**：`NOT_RUN`（还没有实现文件）。

### 7.2 单元测试（mock，无真实账号）

#### `oauth-params.test.mjs`

- 新账号 URL：`client_id=dynamic_agent_client`、`agent_name_hint` 存在、无 `id_token_hint`、host ID 正确、scope 集合正确、PKCE S256、state/nonce 每次不同。
- 重新登录 URL：`client_id=<saved>`、无 `agent_name_hint`、`id_token_hint` 存在、`login_hint` 可选、host ID 相同。
- redirect URI 精确为 `http://127.0.0.1:<port>/auth/callback`；不允许 `localhost`。
- URL 编码：email/`id_token_hint` 中的特殊字符被正确编码。
- callback 解析：`error=access_denied`、缺 code、state 不匹配、新注册缺 client_id、重新登录 client_id 不一致。

#### `id-token.test.mjs`

用测试时生成的 RSA 密钥和本地 JWKS：

- 有效 token：issuer/audience/nonce/exp/sub 正确 → 通过。
- 错误签名 → 拒绝。
- 错误 issuer → 拒绝。
- 错误 audience → 拒绝。
- 过期 → 拒绝。
- nonce 不匹配 → 拒绝。
- 缺 sub → 拒绝。
- `sid` 非字符串 → 拒绝。
- 重新登录 sub 与账号不一致 → 拒绝。
- discovery 缓存：第二次不重复请求；JWKS 未知 kid 时刷新（mock）。

#### `accounts.test.mjs`

- 首次 `ensureHostId`：UUIDv4；持久化；第二次复用。
- accountId 稳定：同 iss/sub/clientId 同 id；不同 clientId 不同 id。
- 多账号：A/B token 独立；切换 active 不改 token。
- `modifyRecord` 失败：不产生半写状态。
- 刷新：
  - 未过期 → 不网络；
  - 过期 → 一次网络；旋转 refresh；
  - 10 并发 → 1 次网络；
  - 网络失败 → 保留 token；
  - invalid_grant → 清 access/refresh，`reauthRequired=true`，其他账号不变；
  - invalid_client → 标记配置错误。
- 签出：撤销请求字段正确；远端失败仍删本地；只删目标账号。
- 记录版本迁移：v0→v1；损坏记录不覆盖。

#### `catalog.test.mjs`

- `{ models: [{ slug, display_name, visibility: "list" }, ...] }` → 过滤/映射。
- `{ data: [...] }` 兼容。
- 未知模型用默认容量/输入。
- 已知模型合并 pi-ai 元数据。
- 缓存 5 分钟；强制刷新。
- 401 → 触发刷新/reauth，不返回旧账号目录。

#### `adapter.test.mjs`

- `current()` alias：快照中存在 id `openai` 的 provider；route provider 存在。
- `listModels` 返回账号目录；无账号返回空。
- 模型对象：`provider === "openai"`、`baseUrl` 精确、`api === "openai-responses"`。
- mock fetch 请求体：
  - `store:false`、`stream:true`；
  - 无 `max_output_tokens`、`temperature`、`prompt_cache_retention`；
  - `input` 是数组；
  - system prompt 走 developer/instructions，不是 `role:"system"`；
  - `tools` 形态快照（记录，不强制断言通过）。
- `attributionHeaders()` 出现在请求头。
- 路由注册/注销：`listProviders` 不含 `openai`/`openai-codex` 的新增/替换。
- `DUPLICATE_ADAPTER` 模拟：给出诊断。

#### `web-routes.test.mjs`

- `start`：无 Origin → 403；跨源 → 403；非 JSON → 415；未知 accountId → 400；成功 → `{url}`。
- `callback`：未知 state → 400；`error=access_denied` → 取消；成功后状态变化。
- `status`：键名白名单；无 token/clientId/subject；`callbackAvailable` 正确。
- `signout`：Origin 校验；未知 accountId → 404；成功/远端失败状态。
- 路由重复注册 → 捕获，status 报 `callbackAvailable:false`。
- 非 loopback / HTTPS → 禁用登录。

#### `e2e-mock.test.mjs`

- 本地 mock：authorize 302 → callback → token endpoint → JWKS → `/v1/models` → `/v1/responses` SSE。
- 走完新账号登录 → 模型列表 → 文本回复 → tool call（按 M0 结论）。
- 重新登录：断言 authorize 的 `client_id` 是已保存值，不是 `dynamic_agent_client`。
- 多账号：两次登录 → 两个记录 → 切换 → 请求使用正确 token。
- 刷新：mock 时钟/短 expiry → 断言 refresh 一次，rotation 写回。
- 签出：断言 revoke 请求；本地删除。
- 失败：quota/403/unsupported capability → 断言错误码/诊断。

**当前状态**：`NOT_RUN`。

### 7.3 Live 测试（必须单独批准）

前置：

- 用户明确同意真实登录、真实推理、可能产生 ChatGPT 计划用量。
- 使用测试账号；不要用主账号做破坏性签出测试。
- 不在日志/报告中输出 token/code/id_token。

步骤：

1. 安装 bundle；确认 `application: applied`。
2. 打开 Models 页，看到 footer 面板。
3. 点击 Continue with ChatGPT，完成登录；确认 callback、状态、record。
4. 断言 record 中 `client_id` 不是 `dynamic_agent_client`；`id_token` 已验证（日志只记录 sub 哈希/账号 label）。
5. 重新登录同一账号：抓包/日志确认 `client_id` 复用，无 `agent_name_hint`。
6. 新账号 B：确认独立 record；切换 active；A/B token 不混用。
7. 刷新：把 access expiry 调短或 mock 时钟；确认 refresh 一次、rotation 写回。
8. 签出 B：确认 revoke 请求；本地删除；A 不受影响。
9. 文本请求：选择账号模型，收到 `response.completed`。
10. 工具请求：让模型调用一个只读 DSH 工具；确认 tool call → result → final answer。
11. 错误：模拟 429/403/unsupported capability；确认 UI/错误码。
12. 重启 DSH：账号仍在；路由仍注册；模型目录可用。
13. 卸载/禁用：路由消失；record 可按需删除；不影响 `openai`/`openai-codex`。

**当前状态**：`NOT_RUN`（需批准）。

### 7.4 验收矩阵

| AC | 内容 | 结果 |
|---|---|---|
| AC1 | 新 route 注册，不覆盖 `openai`/`openai-codex` | `NOT_RUN` |
| AC2 | 新账号登录；issued client ID 保存；ID token 验证 | `NOT_RUN` |
| AC3 | 重新登录复用 issued client ID | `NOT_RUN` |
| AC4 | 多账号隔离/切换 | `NOT_RUN` |
| AC5 | 串行刷新 + rotation | `NOT_RUN` |
| AC6 | 签出撤销 + 本地删除 | `NOT_RUN` |
| AC7 | 账号模型目录 | `NOT_RUN` |
| AC8 | 文本回复 `response.completed` | `NOT_RUN` |
| AC9 | 工具调用端到端 | `NOT_RUN` |
| AC10 | 错误码/配额处理 | `NOT_RUN` |
| AC11 | 重启持久化 | `NOT_RUN` |
| AC12 | 日志/状态无秘密 | `NOT_RUN` |

---

## 8. 阻塞项与所需批准

| ID | 阻塞/依赖 | 需要谁/什么 | 当前状态 |
|---|---|---|---|
| B1 | `cordis_inspect_*` 不在本会话 | 下一阶段使用 Creator mode；补跑 Service/Event/Slots/Config 查询 | **BLOCKED** |
| B2 | `plugin_manager` 不在本会话 | Creator mode + 安装审批 | **BLOCKED** |
| B3 | 真实 ChatGPT 账号与计划资格 | 用户明确批准 live 测试 | **NOT_RUN** |
| B4 | tools 形态（namespaces/additional_tools） | M0 spike + 真实请求（需登录） | **BLOCKED/待实测** |
| B5 | `/auth/callback` 路由占用 | 启动检测；冲突则禁用登录 | **待验证** |
| B6 | WSL2→Windows 回调可达性 | 实测；当前 3080 GUI 可达是正面信号 | **待验证** |
| B7 | `PiAiAdapter.current()` 私有 shim | M0 spike + 升级回归 | **待验证** |
| B8 | `jose`/pi-ai 依赖解析 | 安装后 import smoke | **待验证** |
| B9 | 真实刷新/撤销/双进程 | live 测试 | **NOT_RUN** |
| B10 | 403 not eligible 错误映射 | 外层映射 + live 模拟 | **待验证** |

**批准边界**：

- 本阶段（已完成）：只读检查 + 两份文档；未安装、未登录、未修改 profile/凭据。
- 下一阶段（需用户明确说“开始实现”）：写代码、跑 mock 测试；仍不登录。
- 再下一阶段（需单独“允许真实登录/推理”）：live 测试。
- 安装（需 Creator mode 的 `plugin_manager` 审批）：单独执行。

---

## 9. 当前状态汇总

| 项目 | 状态 |
|---|---|
| 只读发现（版本/API/官方契约） | **PASS**（静态；`cordis_inspect_*` 除外） |
| `cordis_inspect_list/query` | **BLOCKED**（工具未注册） |
| 插件代码 | **NOT_RUN** |
| mock/单元测试 | **NOT_RUN** |
| 真实登录 | **NOT_RUN** |
| 真实推理 | **NOT_RUN** |
| 真实刷新/撤销 | **NOT_RUN** |
| 安装/启停/卸载 | **NOT_RUN** |
| 计划资格验证 | **NOT_RUN** |

---

## 10. 回滚与清理

1. Creator mode `plugin_manager` `remove_bundle` 或 `set_plugin` 禁用 `openai-chatgpt-plan`。
2. 确认 `listProviders()` 不再包含 `openai-chatgpt-plan`；`openai`/`openai-codex` 未受影响。
3. 如需清除账号：删除 credential record `openai-chatgpt-plan/accounts`（先尝试签出撤销）。
4. 不删除其他插件的 record / refs；不修改 `llm-pi-ai` 的凭据。
5. 若安装导致 profile 异常：按 Plugin Manager 返回的 `restart-required` / `failed` 诊断处理，不用手改 `package.json`。

---

## 11. 开放问题

1. **tools 形态**：ChatGPT 计划路由是否接受扁平 `tools`？官方文字要求 namespaces/additional_tools；pi-ai 当前发送扁平 function tools。M0 必须回答。
2. **`PiAiAdapter.current()` shim 的稳定性**：0.2.1-rc.2 可用；升级是否破坏？
3. **`model.provider="openai"` 与 DSH route 的分离**：pi-ai 未来是否校验一致性？
4. **`/auth/callback` 全局路径冲突**：是否需要与 DSH 上游协商一个可配置 path，或改由独立 loopback listener？
5. **多账号记录大小/锁粒度**：单 record 是否在大量账号/高频刷新下成为瓶颈？
6. **403 not eligible 的 DSH code**：是否新增 provider-specific code，还是复用 `QUOTA`？
7. **图片/文件输入**：官方支持，但 pi-ai/DSH 的 image budget 与 ChatGPT 计划路由的限制需实测；MVP 可先 text-only。
8. **模型容量元数据**：`/v1/models` 不含 contextWindow；长期是否需要补充 endpoint 或静态映射？
9. **Desktop profile**：Desktop 的 `webServer`/callback origin 与 Web 不同；是否需要单独支持？
10. **上游贡献**：若方案 A 的 shim 长期不可接受，是否把 issued client ID 复用/ID token 校验/多账号做进 `dsh-llm-pi-ai`？

---

## 12. 下一步（建议顺序）

1. 在 Creator mode 会话补跑 `cordis_inspect_*`，确认本文的静态 API 与实际 Service/Event/Slots 一致。
2. 实现 M0 spike（无登录），先回答 tools 形态与 alias 可行性。
3. M0 通过后实现 M1/M2（OAuth + accounts），用 mock 测试。
4. M3/M4/M5 接线；mock e2e。
5. 用户批准后 live 测试；最后安装与验证。

> 在 M0 的 tools 结论出来之前，不要投入完整 adapter 实现；这是当前最可能推翻架构的单点。
