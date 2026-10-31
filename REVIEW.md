# REVIEW — dsh-chatgpt-plan-plugin

> 2026-10-30：本插件已通过 `plugin_manager` 安装到 `web` profile 并完成一轮真实验收；安装、登录、实测异常与未通过项见 [ACCEPTANCE.md](./ACCEPTANCE.md)。下文“未安装/未登录/NOT_RUN”描述的是实现阶段的历史状态。
>
> 2026-10-31：v0.2.0 在 DSH `0.2.1-rc.5` 上重新安装并加载成功；新增“退出后重新连接复用 issued client ID”，离线测试 74/74 通过。真实登录/推理/刷新在该机器上仍未复测，见 [ACCEPTANCE.md §14](./ACCEPTANCE.md)。

## 1. 范围与结论

本阶段在项目目录内完成可审查代码、离线测试、README、打包检查和 SHA256。**未安装到当前 profile，未执行真实登录，未调用真实模型，未做界面验收。**

- 静态/离线测试：见第 6 节。
- 真实登录：`NOT_RUN`
- 真实模型推理：`NOT_RUN`
- 真实刷新/撤销：`NOT_RUN`
- 安装/启停/卸载：`NOT_RUN`
- 界面验收：`NOT_RUN`

## 2. 采用的真实接口

| 能力 | 接口 | 证据 |
|---|---|---|
| LLM adapter | `ctx.llm.registerAdapter(['openai-chatgpt-plan'], adapter)` | 安装的 `dsh-llm` `LlmRuntime`，已用 `cordis_inspect_query` 核对 |
| Adapter 基类 | `LlmAdapter`，实现 `stream`、`listModels`、`resolveModel`、`providerRetryPolicy` | 同上 |
| Credential record | `ctx.credentials.readRecord/modifyRecord/deleteRecord/listRecords` | 安装的 `dsh-credentials`，已核对 |
| Authorization flow | `ctx.authorization.registerFlow/begin/cancel` | 安装的 `dsh-authorization`，已核对 |
| Host HTTP | `ctx.webServer.register({ kind, path, handler })`、`getOrigin()` | 安装的 `dsh-host-webserver`，已核对 |
| Client slot | `settings.models.footer`，`id=openai-chatgpt-plan-account` | Client `Slots.listSubTree` 实时查询 |
| Client locale | `ctx.locale.register(ns, locale, dict)` / `bind(ns)` | 安装的 `dsh-client-locale` 类型与实现 |
| Attribution | `attributionHeaders()` | 安装的 `dsh-llm`，每个 Responses/Models 请求发送真实 DSH User-Agent |

## 3. 架构决策与 TASK 的差异

### 3.1 不采用 PiAiAdapter + 私有 `current()` shim

TASK 的方案 A 计划复用 `@deepseek-ai/dsh-llm-pi-ai` 的 `PiAiAdapter`，并通过覆盖私有 `current()` 注入 `openai` alias。实现时改为直接实现 `LlmAdapter` 并调用公开 Responses API：

- 避免版本敏感的私有 shim；
- 可以把请求字段白名单、工具 `additional_tools` 形态、call ID/原始参数保留、唯一终态做成可单测的显式逻辑；
- 不依赖 pi-ai 的 `isChatGPTSignIn` 内部判断，也不会误用通用 OpenAI 参数。

代价：需要自己维护 Responses 消息/SSE 转换。已用 serializer/SSE/adapter 测试固定。

### 3.2 每账号独立 grant，而不是单 record map

TASK 建议一个 `openai-chatgpt-plan/accounts` record 存所有账号。实现改为：

- `openai-chatgpt-plan/state`：仅索引/hostId/activeAccountId/epoch，不含 token；
- `openai-chatgpt-plan/<recordId>`：每账号一个 grant，含该账号 token；
- Authorization flow 的 key 就是该账号 grant key，`session.commit()` 只写这一条 record。

原因：Authorization 的 `session.commit(record)` 是整条 record 覆盖写；如果所有账号共用一个 record，登录提交会覆盖并发刷新的 rotation。独立 grant 让登录提交天然原子且只影响目标账号；刷新仍由 `modifyRecord` 跨进程串行化。

### 3.3 动态 flow key

新登录在知道 account id 之前先分配 `pending-<random>` record id，并在该 key 上注册 attempt 专用 flow；重新登录使用账号已有 record key。这样 `session.commit` 永远只写目标 grant。flow 在 attempt 结束后 dispose。

### 3.4 退出/竞争防护

- 刷新只在账号 record 仍存在且 generation 匹配时写回；退出会先标记 signing-out 并递增 generation。
- 重新登录在提交前再次读取账号，若账号已被退出或 generation 改变，报 `ACCOUNT_CHANGED`，不写回。
- 退出期间的旧刷新无法复活账号；账号切换只改 state 索引，不碰 token。
- 新登录在验证/ID token 校验通过前只准备 pending 索引，不改变 active 账号；失败删除 pending。

### 3.5 退出后重连（v0.2.0）

v0.1.0 在 sign-out 时删除整条 account grant，重新“添加账号”必然走新的动态注册，违反“复用 issued client ID”。v0.2.0 在 state 的 tombstone 中保留 `clientId`/`subject`/`issuer`/`email`/`label`（**绝不含 token**），status 只暴露 `id/label/email/signedOutAt`，coordinator 增加 `reconnect` intent：

- authorize URL 用保存的 `clientId` + `login_hint`，不带 `agent_name_hint`、不带 `id_token_hint`（退出后没有可用的 ID token）；
- callback client id 与 ID token `sub` 必须与 tombstone 匹配；account id 仍由同一 `(issuer, subject, clientId)` 计算，因此登录后还是同一账号；
- reconnect 使用确定性 record id，第二次并发尝试会被 flow 注册拒绝；
- 旧版纯时间戳 tombstone 仍用于阻止陈旧 record 复现，但不会出现在 `reconnectable`。

## 4. 安全审查

- 状态 JSON 只包含 `accounts` 的 `id/label/email/planEnabled/reauthRequired/expiresAt`、`reconnectable` 的 `id/label/email/signedOutAt`，以及计数字段；不含 access/refresh/id token、clientId、subject、授权 URL、state、code。
- 回调 HTML 只显示固定文案/错误码，不反射 query。
- 日志只记录阶段、错误码、状态码；不记录 Authorization、code、token、clientId、subject、完整 authorize URL。
- 所有 POST 校验精确 `Origin` 和 JSON content type；回调只接受 pending state；state 一次性消费；最多 4 个 pending；start 限流。
- 回调路径固定 `/auth/callback`；冲突时禁用登录，不静默换路径。
- 只允许 loopback HTTP origin（`http://127.0.0.1:<port>`）。
- ID token 使用 Node `crypto` 验签（RS/ES），拒绝 `none`/HS；校验 issuer/aud/exp/iat/nbf/nonce/sub/sid。
- 不读写 Codex/Hermes/Pi 缓存；不伪装其 User-Agent。LLM/Models 请求使用 DSH 真实 attribution。
- 图片/文件输入、未验证模型工具等不可用能力明确报错，不静默降级。

## 5. 已知限制/未决

1. 真实计划路线是否接受 `additional_tools` 与 `reasoning.effort`：**BLOCKED（需 live 验证）**。
2. 真实 `/v1/models` 返回的 `visibility`/slug 与静态白名单的匹配：**NOT_RUN**。
3. `gpt-5.4*` / `gpt-5.5*` / `gpt-5.6*` / `gpt-6*` 的 contextWindow/maxTokens 是静态默认；真实值可能不同。
4. 非 reasoning 模型、图片/文件输入未暴露；如需要，需新增序列化能力并 live 验证。
5. WSL2→Windows 浏览器回调 127.0.0.1:3080：**NOT_RUN**；当前 GUI 可达是正面信号，不等于回调已验证。
6. `auth.openai.com` discovery/JWKS 端点、动态注册参数和 scopes 均按 2026-10-29 官方文档实现；官方变更后需重新核对。
7. 插件 dispose 会取消 flow/attempts、释放 adapter registration 和 routes；真实进程卸载/重载未验收。
8. 本会话 `web_fetch` 官方文档时环境把 `developers.openai.com` 解析到非公网地址，无法重新抓取；OAuth/Responses 契约以 2026-10-29 的 DISCOVERY.md 和本机 pi-ai 1.4.0 源码交叉核对。live 前必须在可联网环境重抓官方文档。
9. 本机首次真实文本请求（`gpt-6.1-sol`）连续 `TRANSPORT`；同机复现为到 `api.openai.com` 的间歇 TLS `unexpected eof` / `ECONNRESET`，另一台机器正常。已给 `TRANSPORT` 加安全 cause code，并把重试改为 5 次/1 s 起；需重启 Host 生效。

## 6. 离线测试结果

本次运行（DSH `0.2.1-rc.5` peer）：**83 tests / 83 pass / 0 fail / 0 skipped**（`node --test test/*.test.mjs`，约 0.9 s）。打包检查：**24 个 packed 文件，必需运行文件齐全，未包含 node_modules / 临时目录**。

运行：

```bash
npm test
npm run check
```

计划覆盖（实际结果见本次交付的运行记录）：

- authorize URL 新/旧账号参数矩阵、PKCE；
- 回调 missing client id、client id mismatch、state unknown/replay、access_denied；
- ID token 有效/签名/issuer/audience/exp/nonce/sub/sid/alg；
- 注册复用 issued client id；
- 退出后 reconnect 复用 issued client id、client id/sub 不匹配拒绝、旧时间戳 tombstone 不可重连；
- 多账号隔离、切换、退出；
- 刷新 10 并发 1 次网络；两个 store 共享文件 1 次网络；
- invalid_grant/retryable/invalid_client 分类；
- 退出与刷新/重新登录竞争，旧任务不复活；
- 模型目录过滤/缓存/401 刷新重试；
- SSE 分片、工具参数分片、call ID/原始参数、usage、唯一终态、取消、流内错误；
- 状态脱敏、Origin/JSON/回调冲突/非 loopback；
- 静态 manifest/patch/locale/icon/secret scan；
- `npm pack --dry-run` 文件清单。

## 7. 文件 SHA256

见 `SHA256SUMS.txt`。它包含运行文件、测试、脚本、文档、manifest、lockfile、locale 和图标；不包含 `node_modules` / `.inspect-codex` / `.npm-cache` / `SHA256SUMS.txt` 自身。`SHA256SUMS.txt` 的顶层校验值见 `SHA256SUMS.txt.sha256`。

`node_modules/@deepseek-ai/dsh-{llm,credentials}` 只是测试链接，不进入 pack；安装后由 DSH peer 依赖提供。

## 8. 结论

代码路径与 DSH 公开扩展点对齐；离线行为可复核。v0.2.0 在 DSH `0.2.1-rc.5` 上完成安装并 live 加载，退出后 reconnect 复用注册已离线验证。本机真实登录、文本、单工具调用、多轮上下文、多工具序列、退出→Reconnect 与 live Sign in again 已通过；真实 token 刷新与界面失败展示仍为 `NOT_RUN`；空 reasoning 块已修复并离线 + live 验证；`additional_tools` 已在 live 工具调用中工作，但仍需真实 token 刷新复测。

## 9. 安装验收

见 [ACCEPTANCE.md](./ACCEPTANCE.md)。2026-10-30 的 live 验收结论为 **FAIL/未整体通过**：live 重新授权超时、真实 token 刷新 NOT_RUN，且当前会话日志含一次 browser-session secret 泄漏。2026-10-31 在 DSH `0.2.1-rc.5` 上复装为 **applied**，并修复“退出后重新登录未复用 issued client ID”；该项在本机仅离线验证，真实环境复测仍 **NOT_RUN**。
