# DSH「Sign in with ChatGPT」原生模型提供方：只读发现报告

- 调查日期：2026-10-29（Asia/Shanghai）
- 调查范围：只读检查已安装 DSH、`dsh-llm-pi-ai`、`pi-ai`、Authorization、Credentials、Settings、Client slots、Plugin Manager、Host WebServer，以及 OpenAI 官方当前文档。
- 本阶段未安装插件、未登录、未发起推理、未读取凭据值、未修改 profile / `cordis.patch.yml` / 现有凭据。
- 文中状态：`PASS` 仅表示**本次静态检查通过**，不等于运行时验收；`NOT_RUN` 表示未执行；`BLOCKED` 表示受当前会话或外部条件阻塞；`FAIL` 表示已安装实现与目标要求不符。

> 结论先行：**可以做，但不能靠“打开 DSH 的 `openai` OAuth 开关”完成。** 应新增独立路由 `openai-chatgpt-plan`，复用 DSH 的 LLM/凭据扩展点与 pi-ai 的 Responses 传输，同时由插件补齐官方要求的 issued client ID 复用、ID token 验签、账号隔离、串行刷新、退出撤销和模型目录。当前主要未验证风险是旧 reasoning 模型的 tools 形态、OAuth live 流程与 `PiAiAdapter` shim 的稳定性。

---

## 1. 本次检查的工具限制

用户要求先使用 `cordis_inspect_list` 与定向 `cordis_inspect_query`。本次会话的 Agent 工具注册表中**没有**这两个工具，也没有 `plugin_manager` 工具：

- 当前会话可用的是文件、Shell、Web、OpenViking、任务/调度等工具；不存在 `cordis_inspect_list` / `cordis_inspect_query` / `plugin_manager`。
- 当前 profile 为 `web`，`package.json` 的 bundle 列表是 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@openviking/dsh-memory-plugin`。
- `dsh-web-app/cordis.patch.yml` 已挂载 Host 侧的 `cordis-inspect-providers`（`@deepseek-ai/dsh-tool-cordis/host`），所以 inspection registry 存在；但两个 Agent 工具行由 preset 的 `tool-cordis` 提供，当前会话的 preset 不是 `cordis`，所以工具注册表中没有它们。
- `tool-plugin-manager` 在 `dsh-base` 和 `standard` preset 中默认 `disabled: true`；当前会话也没有该工具。
- `cordis_inspect_*` 属于 Creator mode（`cordis` preset）的工具集，本次会话未启用 Creator mode。

因此：

| 检查方式 | 状态 | 说明 |
|---|---|---|
| `cordis_inspect_list` / `cordis_inspect_query` 运行时查询 | **BLOCKED** | 工具未注册到本会话，不能伪造“已查询” |
| 安装目录 `package.json` / README / `lib/types/**/*.d.ts` / `lib/*.js` 静态检查 | **PASS** | 本次报告的主要证据 |
| `Config.listConfigs` 返回的 `packageDir` | **BLOCKED** | 依赖 `cordis_inspect_query`；改用安装布局中的确定路径 |
| `plugin_manager` 实时安装/启停 | **BLOCKED** | 工具未注册；本阶段也不允许安装 |

**替代路径**：DSH 安装根目录固定为：

```text
/home/qwei/.local/share/fnm/node-versions/v24.22.1/installation/lib/node_modules/@deepseek-ai/dsh/
```

DSH 包位于其 `node_modules/@deepseek-ai/<pkg>/`，pi-ai 位于 `node_modules/@earendil-works/pi-ai/`。本次按此布局读取了 `dsh-llm`、`dsh-llm-pi-ai`、`dsh-authorization`、`dsh-credentials`、`dsh-credentials-local`、`dsh-settings`、`dsh-plugin-manager`、`dsh-host-webserver`、`dsh-client-ui-settings-models` 的 README/类型，以及 `pi-ai` 的 README 与实现。升级 DSH 后必须重新核对。

> 建议下一阶段在 Creator mode 会话中补跑：`cordis_inspect_list` → `Service`/`Event`/`Slots`/`Config` 定向查询，并保存返回的 `packageDir` 与 schema。本文的静态结论可作为对照，不替代运行时查询。

`cordis-plugin-development` 也没有出现在本次 `skill` 工具的技能目录中；已按安装路径读取其 `SKILL.md`、`references/host-plugin.md`、`references/practices.md`、`references/ui-plugin.md` 和 `templates/decoration/` 模板，作为插件形态与 UI 槽位的参考。

---

## 2. 精确版本与证据

### 2.1 版本

| 组件 | 版本 | 证据 |
|---|---|---|
| DSH CLI / 安装 | `0.2.1-rc.2` | `@deepseek-ai/dsh/package.json` |
| `@deepseek-ai/dsh-llm` | `0.2.1-rc.2` | 包清单 |
| `@deepseek-ai/dsh-llm-pi-ai` | `0.2.1-rc.2` | 包清单 |
| `@earendil-works/pi-ai` | `1.4.0` | 包清单 |
| `@deepseek-ai/dsh-authorization` | `0.2.1-rc.2` | 包清单 |
| `@deepseek-ai/dsh-credentials` | `0.2.1-rc.2` | 包清单 |
| `@deepseek-ai/dsh-credentials-local` | `0.2.1-rc.2` | 包清单 |
| `@deepseek-ai/dsh-host-webserver` | `0.2.1-rc.2` | 包清单 |
| `@deepseek-ai/dsh-plugin-manager` | `0.2.1-rc.2` | 包清单 |
| `@deepseek-ai/dsh-client-ui-settings-models` | `0.2.1-rc.2` | 包清单 |
| `jose`（DSH 依赖树内） | `6.2.13` | `dsh/node_modules/jose/package.json` |

`pi-ai` 不是 DSH 的直接 dependency 名称，但由 `dsh-llm-pi-ai` 使用，实际安装在 DSH 安装树的 `node_modules/@earendil-works/pi-ai`。

### 2.2 关键文件 SHA-256

| 文件 | SHA-256 |
|---|---|
| `dsh/package.json` | `bea4288aa88eb54efe829686553100a75fdf09d11c5e3bf6b329badb9a0368dd` |
| `dsh-llm-pi-ai/package.json` | `98a8b108ead233cfbc7a869cc21ba0f58cb9b0909abfb2c9f220dd5e8b94839d` |
| `dsh-llm-pi-ai/lib/index.js` | `99b5c20830a52f69641df8a18a39206079b0c725201958cce2c4a934f1d4f7cd` |
| `pi-ai/package.json` | `36df91142c18a5912eafab0f2783bb4d88cdd101c5c5e7fd9173d4387cc5cced` |
| `pi-ai/dist/providers/openai.js` | `9dc3881e858b0280e809ec04b8b17f22580fcb1871da2edf3cfbdfa3c13747b3` |
| `pi-ai/dist/providers/openai-codex.js` | `44087142be22adfd09cf1a87edbbdb74ce155b5fd34e70fa4666f3a9f8a9a680` |
| `pi-ai/dist/auth/oauth/openai-chatgpt.js` | `4cf9fc758a07ffe4ee022326404b5dcc86767ee4154945c0417c7f95eaecdcc2` |
| `pi-ai/dist/api/openai-responses.js` | `002f15414b7c7b62a32610a8a915bdf1a01eed930b8b45d7691e8a5c475fa9b5` |
| `dsh-llm/lib/types/index.d.ts` | `895a2d357b3da2d2ec18eada1271274d43169acaa6591d57bb6e84878e1b88fe` |
| `dsh-authorization/lib/types/index.d.ts` | `6b61ec848662231cb2921bbaf9a84a5aa755562db8f4b2b025f5747890085ce0` |
| `dsh-credentials/lib/types/types.d.ts` | `8d923207d8027ff4f423d377ea2f89e2273523bd01374c678c0bbb9373905c6d` |
| `dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts` | `14bbf3635bfc505c2987b31a81bfa38d5c762d86da82ce84ae4e0e1697e5cbd0` |
| `dsh-host-webserver/lib/types/index.d.ts` | `44d66c97017d07239be332ac37183f3fa79a2b49aa4628ca06ad76c112839d1b` |
| `dsh-plugin-manager/lib/types/index.d.ts` | `7bc5a8f155c45d78dd6a769074bed0665772f506057db2bddad1cfdcfeaf92a2` |

这些哈希与工作区既有的 `DSH_ChatGPT授权_只读检查证据_20261029.json` 中对应文件一致，说明本次检查的 DSH / pi-ai 文件没有发生变化。

---

## 3. 已安装 DSH 的真实扩展点

### 3.1 LLM：新增 provider 路由的公开入口

`@deepseek-ai/dsh-llm` 的 `LlmRuntime` 提供：

```ts
// dsh-llm/lib/types/index.d.ts
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle
listProviders(): LlmProviderInfo[]
listConfigurableProviders(): LlmConfigurableProvider[]
prepareCall(config: LlmCallConfig, signal?, configure?): Promise<PreparedLlmCall>
stream(options: GenerateOptions): AsyncIterable<StreamChunk>
```

关键点：

- **【现成】** `registerAdapter` 的 `providers` 是路由名数组；同一路由被第二个 adapter 注册会抛 `DUPLICATE_ADAPTER`，全有或全无。见 `dsh-llm/lib/types/index.d.ts:262` 附近。
- **【现成】** `AdapterRegistrationHandle.replace(providers)` 可以原子替换同一 adapter 的路由集，并发布 `llm/adapters-updated`；空数组在 replace 中合法，但首次注册不能为空。
- **【现成】** `LlmAdapter` 的最小抽象方法是 `stream(options)`；`providerInfo`、`providerRetryPolicy`、`listModels`、`resolveModel`、`prepareCall` 都有默认实现。见 `dsh-llm/lib/types/index.d.ts:130-197`。
- **【现成】** `LlmProviderInfo` 只有 `{id, name}`；GUI 的模型选择需要 adapter 实现 `listModels`，否则目录为空。
- **【现成】** `LlmConfigurableProvider` 提供 `provider`、`displayName`、`settingsNs`、`settingsPath`、`declared`、`defaultBaseURL`、`baseURLEnv`、`nativeAuth`、`error`。其中 `nativeAuth.oauth: boolean` 只是目录事实，**不会自动产生登录流程**。
- **【现成】** 每次模型请求都会走 `llm/stream` waterfall；provider 请求必须携带 `attributionHeaders()`。`dsh-llm-pi-ai` 已处理 attribution，见其 `requestHeaders`（`lib/index.js:1817-1823`）。

结论：**新增 `openai-chatgpt-plan` 不需要覆盖 `openai` / `openai-codex`**。只要使用唯一路由名，`registerAdapter(['openai-chatgpt-plan'], adapter)` 即可；若 `openai` 已被 `dsh-llm-pi-ai` 注册，也不会冲突。

### 3.2 Authorization：通用授权流程

`@deepseek-ai/dsh-authorization` 的真实接口：

```ts
// dsh-authorization/lib/types/index.d.ts
registerFlow(flow: AuthorizationFlow): () => void
list(): readonly AuthorizationEntry[]
describe(key: CredentialKey): AuthorizationEntry | undefined
cancel(key: CredentialKey): void
begin(request: AuthorizationRequest): Promise<AuthorizationOutcome>
```

`AuthorizationFlow`：

```ts
{
  key: CredentialKey;                 // 该流程写入的 <scope>/<id>
  label: string;
  methods: readonly [AuthorizationMethod, ...AuthorizationMethod[]];
  run(session: AuthorizationSession): Promise<void>;
}
```

`AuthorizationSession`：

```ts
{
  method: string;
  signal: AbortSignal;
  commit(record: CredentialRecord): Promise<void>;
  notify(notice: AuthorizationNotice): void;
  prompt(prompt: AuthorizationPrompt): Promise<string>;
}
```

生命周期事实：

- **【现成】** 一个 key 同一时间只允许一个 attempt；重复 `begin` 抛 `ALREADY_IN_FLIGHT`。
- **【现成】** `run()` 必须在本次 attempt 内通过 `ctx.credentials` 提交记录；否则 `begin` 抛 `NOT_COMMITTED`。`session.commit()` 是取消安全的提交入口。
- **【现成】** `notify` 只单向展示；`prompt` 支持 `text` / `secret` / `select`；回调页面/设备码通过 notice 的 `url`/`code` 表达。
- **【现成】** 流程不可恢复；页面刷新会丢 attempt；没有服务端撤销；一个 key 一个记录。
- **【现成】** 没有随 DSH 发布的通用 Web 授权 UI。`dsh-client-ui-settings-models` 的 Models 页只编辑 API key / provider 配置，不消费 `ctx.authorization` 的 flow 列表；`dsh-client-ui-settings-account` 使用的是 DeepSeek Platform 自己的 account Remote，不是通用 authorization。
- **【现成】** `settings.models.sign-in` 槽位是“账号登录方式选择”，不是第三方 provider 登录面板；`settings.models.provider-card` 是 provider 卡片扩展槽；`settings.models.footer` 是 Models 页尾部列表槽。

对本插件的含义：

- 通用 seam 适合“单账号、固定 key”的场景；**多账号、按账号复用 issued client ID 的重新授权**需要插件自己的协调器，或将每个账号注册成独立 flow key。
- 由于没有现成 UI 消费 flow，MVP 需要自己的 Host HTTP 入口 + Models footer 面板；不能只 `registerFlow` 就期待页面出现按钮。

### 3.3 Credentials：记录、锁与账号隔离

`@deepseek-ai/dsh-credentials` 的真实接口：

```ts
credentialKey(scope: string, id: string): CredentialKey
credentialKeyScope(key): string
credentialKeyId(key): string
isCredentialKeySegment(value): boolean
readRecord(key): Promise<CredentialRecord | undefined>
describeRecord(key): Promise<CredentialRecordInfo>
listRecords(): Promise<readonly CredentialRecordEntry[]>
modifyRecord(key, mutate): Promise<CredentialRecord | undefined>
deleteRecord(key): Promise<void>
resolve(ref): Promise<ResolvedCredential | undefined>
describe(ref): Promise<CredentialInfo>
set(ref, value)
unset(ref)
```

记录形状：

```ts
type CredentialRecord = ApiKeyRecord | GrantRecord;

interface ApiKeyRecord {
  kind: 'api-key';
  key?: string;
  env?: Readonly<Record<string, string>>;
}

interface GrantRecord {
  kind: 'grant';
  payload: unknown;   // owner-defined，必须可 JSON round-trip
}
```

关键点：

- **【现成】** record key 是 `<scope>/<id>`；scope/id 必须是 lowercase hyphenated identifier（`isCredentialKeySegment`）。因此 provider 路由名 `openai-chatgpt-plan` 可以作为 scope，`accounts` 可以作为 id。
- **【现成】** `modifyRecord` 是唯一写路径；mutation 看到写入瞬间的当前记录；返回 `undefined` 表示不改。
- **【现成】** `dsh-credentials-local` 的 README 明确：记录写入在**跨进程 writer lock** 下执行；文件权限为 owner-only（POSIX 拒绝其他用户可读）。
- **【现成】** grant payload 不透明，存储层不解释；适合放 access/refresh/id_token/scopes/expiry/账号映射。
- **【现成】** 凭据值是秘密；`describe`/`describeRecord` 只返回是否配置、来源、可写性，不返回值。

对本插件的含义：

- 使用一个固定 record `openai-chatgpt-plan/accounts`，payload 内保存 `hostId` + `accounts` map + `activeAccountId`。这样：
  - `modifyRecord` 的跨进程锁自然串行化同一账号/所有账号的刷新；
  - 多账号在逻辑上隔离（每条 token 独立，不混用）；
  - 不需要在 Config 中放任何秘密。
- 代价：所有账号共用一个记录，写入会重写整张 map；token 数量增加时记录变大，但仍可接受。若未来要“每账号独立文件级锁”，需要改为按账号 key + 动态 flow。

### 3.4 Settings：不是账号状态存储

`@deepseek-ai/dsh-settings` 的事实：

- **【现成】** 只把插件 Config 中 `.volatile()` 字段投影为表单；普通字段仍由 `cordis.patch.yml` / Cordis 配置编辑。
- **【现成】** 表单按 profile entry id 定位；写入带 revision，冲突拒绝。
- **【现成】** Settings 不保存秘密值；secret role 会被 redaction。
- **【现成】** `llm-pi-ai` 把 `providers` 声明为 `Volatile`，并在 `apply` 中 `ctx.settings.configure({ auto: false }, ctx.fiber)`，见 `dsh-llm-pi-ai/lib/index.js:2860-2864`；它用 `settingsNs = ctx.fiber.entry?.options.id ?? "llm-pi-ai"` 把目录条目映射到自己的 settings 命名空间。

对本插件的含义：

- **【约定】** 账号/令牌状态放 credential record，不放 Settings；Config 只放非秘密策略（显示名、超时、默认容量、是否启用）。
- **【约定】** 不调用 `ctx.settings.configure`，让 Config 仍可由 `cordis.patch.yml` 管理；本阶段不需要 Settings 表单。
- 如果未来要让 Models 页出现 provider 行，需要让 plugin Config 形状与 `dsh-client-ui-settings-models` 期望的 pi-ai profile 对齐，或使用 `settings.models.footer` / `provider-card` 扩展槽绕过通用编辑器。MVP 选择后者。

### 3.5 Client slots：可用的 Models 页扩展点

`dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts` 声明：

| Slot | kind | owner props | 用途 |
|---|---|---|---|
| `settings.models.provider-card` | keyed | `provider: ProviderDirectoryEntry`、`configured`、`keyConfigured` | 每个 provider 卡片内的扩展区；按 `settingsNs` 分发 |
| `settings.models.sign-in` | single | `{ complete, useApiKey }` | account 登录方式选择；不是 provider OAuth |
| `settings.models.footer` | list | 空 | provider 行和 Add 控件之后的尾部区域 |

关键点：

- **【现成】** `settings.models.footer` 不要求 directory row、不要求 settings namespace、不要求 provider profile 形状；适合放本插件的账号面板。
- **【现成】** `settings.models.provider-card` 要求存在 directory row（`settingsNs`），且 Models 页会尝试用通用 `ProviderEditor` 编辑该 provider；若 Config 不是 pi-ai profile 形状，会出现 “unknown namespace / advancedHint” 等不匹配。
- **【现成】** Models 页没有为 `nativeAuth.oauth` 渲染登录按钮；`keylessNativeAuth` 只是隐藏 API key 输入（`dsh-client-ui-settings-models/lib/client.js:2030` 附近）。
- **【现成】** Client 插件通过 `window.__ModuleLoader__.load({ id, factory(require) { ... } })` 注册；React 来自浏览器模块表，`ctx.slots.inject(...)` + `ctx.slots.register(...)`；模板见 `cordis-plugin-development/templates/decoration/`。

对本插件的含义：

- **【约定】** MVP 使用 `settings.models.footer` 注册账号面板；按钮调用 Host 的同源 HTTP 路由启动/完成登录，不新增 Remote 命名空间。
- **【约定】** 不在 `provider-card` 中伪装成 pi-ai profile，避免与 Models 页的通用编辑器耦合。
- **【现成】** 槽位注册是 Client 侧 effect；卸载/重载会自动移除。Client 包需要 `dsh.client.platform = "web"` 和 `./client` 导出。

### 3.6 Plugin Manager：安装入口与权限

`@deepseek-ai/dsh-plugin-manager` 的真实接口：

```ts
listPlugins(): Promise<PluginInfo[]>
listBundles(): Promise<BundleInfo[]>
setPluginEnabled(id, enabled): Promise<ChangeResult>
installBundle(spec: string, options?: InstallBundleOptions): Promise<ChangeResult>
waitForInstall(requestId): Promise<ChangeResult | null>
cancelInstall(requestId): Promise<PluginInstallCancellation>
removeBundle(name): Promise<ChangeResult>
```

事实：

- **【现成】** `install_bundle` 由 `plugin_manager` 工具或 Web 插件页调用；`spec` 可以是本地绝对目录、registry 包、git/tarball 等。
- **【现成】** 每个 action（包括 list）在非 Full access 下需要审批；工具调用需要 `danger-full-access` 或该次调用审批。
- **【现成】** 安装会改 profile 的 `package.json` / `pnpm-lock.yaml` / bundle selection；Host 代码在进程内执行，不受 workspace sandbox 限制。
- **【现成】** 本地目录安装使用 `link:`，`files` 不会过滤链接目录；需要自己确认文件齐全。
- **【现成】** 安装结果看 `application` / `warnings`，不要用日志或进程状态推断。

本阶段：**NOT_RUN**。不安装、不启停、不调用 `plugin_manager`。

### 3.7 Host WebServer：登录回调与状态入口

`@deepseek-ai/dsh-host-webserver` 的真实接口：

```ts
register(route: WebRoute): () => void
registerUpgrade(route): () => void
registerFallback(handler): () => void
get port(): number | undefined
get host(): Config['host']
get protocol(): 'http:' | 'https:'
getOrigin(): string
```

事实：

- **【现成】** 命名路由支持 `exact` / `prefix`；重复 `(kind, path)` 抛错；需在插件 effect 中注册并返回 disposer。
- **【现成】** `host` 必须是具体本地接口字面量；loopback 才能保证本机访问；非 loopback 会把无认证路由暴露到网络。
- **【现成】** `getOrigin()` 在端口绑定后返回本地客户端可访问的根 URL。
- **【现成】** Web 组合已有 SPA fallback；插件注册 exact `/auth/callback` 或 `/chatgpt-plan/*` 不会被 SPA 抢走（exact 优先）。
- **【现成】** `register` 的处理函数异常会返回 400 或销毁 socket，不会杀死进程。

对本插件的含义：

- **【约定】** 用 `ctx.webServer` 注册：
  - `POST /chatgpt-plan/start`（同源 JSON，返回授权 URL）
  - `GET /chatgpt-plan/status`（脱敏 JSON）
  - `POST /chatgpt-plan/signout`（同源 JSON，撤销 + 删除）
  - `GET /auth/callback`（OAuth 回调；exact 路由）
- **【待验证】** 官方要求回调 `scheme=http`、`host=127.0.0.1`、`path=/auth/callback`，只允许端口变化；DSH Web 当前是 `http://127.0.0.1:3080`，因此 `/auth/callback` 可用；若 DSH 被配置为 HTTPS 或非 127.0.0.1，需要另起 loopback HTTP listener 或拒绝登录。
- **【阻塞风险】** `/auth/callback` 是全局路径；若其他插件已占用，注册会抛错。需要启动时检测并给出诊断；不要改成 `/chatgpt-plan/auth/callback`（官方明确路径必须匹配）。

---

## 4. pi-ai / DSH 的 OpenAI 提供方审计

### 4.1 pi-ai 的新版 ChatGPT OAuth 确实存在

`pi-ai@1.4.0` 的 `openai` provider：

```js
// dist/providers/openai.js:7-30
createProvider({
  id: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  auth: {
    apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
    oauth: lazyOAuth({
      name: "OpenAI (ChatGPT subscription)",
      isSubscription: true,
      loginLabel: "Sign in with ChatGPT",
      load: loadOpenAIChatGPTOAuth,
    }),
  },
  models: [...OPENAI_MODELS, ...OPENAI_CLASSIFIER_MODELS],
  filterAllModels: (models, credential) =>
    credential?.type === "oauth"
      ? models.filter((model) => !isModelType(model, "classifier"))
      : models,
  api: openAIResponsesApi(),
})
```

结论：

- **【现成】** `openai` 已有新版 Sign in with ChatGPT OAuth，不是旧 Codex token；base URL 是 `https://api.openai.com/v1`，使用 Responses API。
- **【现成】** `openai-codex` 仍是 legacy，base URL 是 `https://chatgpt.com/backend-api`，使用 `openai-codex-responses`。见 `dist/providers/openai-codex.js:1-22`。
- **【约定】** 新插件不得把 `openai-codex` 的 token / client / backend-api 作为接入依据。

### 4.2 DSH 仍然排除 `openai` OAuth

`dsh-llm-pi-ai@0.2.1-rc.2`：

```js
// lib/index.js:2447-2454
const UNSERVED_OAUTH = new Set(["openai"]);
```

```js
// lib/index.js:2467-2479
function loginMethods(provider) {
  const methods = [];
  const oauth =
    provider === undefined || UNSERVED_OAUTH.has(provider.id)
      ? undefined
      : provider.auth.oauth;
  if (oauth !== undefined) methods.push({ id: "oauth", label: ... });
  ...
}
```

```js
// lib/index.js:2562-2595
function registerPiAiFlows(ctx, auth) {
  for (const providerId of catalogProviderIds()) {
    const provider = catalogProvider(providerId);
    const [first, ...rest] = loginMethods(provider);
    if (provider === undefined || first === undefined) continue;
    ...
    ctx.authorization.registerFlow({
      key: recordKeyFor(providerId), // llm-pi-ai/<providerId>
      ...
      async run(session) {
        const models = createModels(auth);
        models.setProvider(provider);
        await models.login(providerId, "oauth", {
          signal: session.signal,
          notify: ...,
          prompt: ...,
        });
      },
    });
  }
}
```

排除原因（DSH 自己的注释，`lib/index.js:2447-2453`）：

> pi-ai's Sign in with ChatGPT (`openai`) identifies the installation to OpenAI with a stable UUID that the app supplies through `LoginOptions.getDeviceId`, and it refuses to start without one. The harness keeps no installation ID meant for a third-party account sign-in, so the route signs in with an API key.

也就是说：

- **【现成】** DSH 没有为 `openai` 提供 `getDeviceId`，所以 `models.login("openai", "oauth", ...)` 会在 pi-ai 的 `agentHostId()` 处抛错。
- **【现成】** DSH 因此把 `openai` 的 OAuth 方法从 `loginMethods` 中删掉；目录里 `nativeAuth.oauth` 仍可能为 `true`（`providerDefaultsOf` 在 `lib/index.js:2801-2811` 直接看 `provider.auth.oauth !== undefined`），但**没有对应 flow**。这是目录事实与可用流程之间的不一致，不能据此认为 UI 有登录按钮。
- **【现成】** `openai-codex` 的 OAuth 没有被 `UNSERVED_OAUTH` 排除；它是 legacy，不应作为新版方案。

### 4.3 pi-ai 的新版 OAuth 具体行为

`dist/auth/oauth/openai-chatgpt.js`：

| 项目 | pi-ai 1.4.0 行为 | 证据 |
|---|---|---|
| 首次注册 `client_id` | `dynamic_agent_client` | 第 12-13 行 |
| agent name hint | 默认 `"Pi"`，可通过 `LoginOptions.agentName` 覆盖 | 第 14、207 行 |
| host ID | 必须 `getDeviceId()` 返回 UUID；格式 `urn:uuid:<uuid>` | 第 185-193 行 |
| 回调地址 | 固定 `http://127.0.0.1:1455/auth/callback`，端口不可变 | 第 19-22 行 |
| scopes | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` | 第 23-24 行 |
| 授权端点 | `https://auth.openai.com/api/accounts/authorize` | 第 16 行 |
| token 端点 | `https://auth.openai.com/api/accounts/oauth/token` | 第 17 行 |
| resource | `https://api.openai.com/v1` | 第 18 行 |
| PKCE | 每次登录新 `state` / `nonce` / verifier / S256 | 第 194-216 行 |
| 新注册 callback | 读取 callback 的 `client_id`；缺失则报错 | 第 30-50 行 |
| issued client ID 保存 | 存入 credential 的 `clientId` 字段 | `credentialFromTokenResponse` |
| 重新登录 | **每次都从 `dynamic_agent_client` 开始新注册**；不读取已保存的 `clientId` | 第 204-217 行 |
| token 兑换 | 使用 callback 返回的 issued client ID；无 client secret | 第 156-164 行 |
| refresh | 读取 credential 的 `clientId`，用它 refresh；不是 `dynamic_agent_client` | 第 172-184 行 |
| ID token 校验 | **只检查非空**；不验签、不校验 issuer/audience/nonce、不读 `sub` | 第 165-169 行 |
| 退出 | 没有撤销端点调用；只有 credential 删除 | 文件未实现 revoke |

结论：

- **【FAIL】** pi-ai/DSH 现有流程在“重新登录复用 issued client ID”上不符合官方要求。官方要求保存 callback 返回的 `client_id` 并在后续登录/兑换中复用；pi-ai 的 `loginOpenAIChatGPT` 每次都用 `dynamic_agent_client` 发起新注册。
- **【FAIL】** pi-ai 没有做官方要求的 ID token 签名/issuer/audience/expiry/nonce 校验；它只把 ID token 当存在性检查。
- **【FAIL】** DSH 的 `llm-pi-ai` 每个 provider 只有一个 credential record（`llm-pi-ai/openai`），无法在同一 provider 下隔离多个 ChatGPT 账号。
- **【PASS / 静态】** refresh 的 `clientId` 复用是正确的；refresh 本身通过 `dsh-credentials.modifyRecord` 的跨进程写锁串行化（前提是走 pi-ai 的 `Models` / DSH 的 `llm-pi-ai` 记录路径）。
- **【风险】** 固定端口 1455 与 Codex CLI / 其他 pi 进程冲突；DSH 若照搬会失败。

### 4.4 旧 `openai-codex` 与新版必须区分

| 项目 | 新版 `openai` | 旧版 `openai-codex` |
|---|---|---|
| provider id | `openai` | `openai-codex` |
| 显示名 | OpenAI | OpenAI Codex (legacy) |
| base URL | `https://api.openai.com/v1` | `https://chatgpt.com/backend-api` |
| API | `openai-responses` | `openai-codex-responses` |
| OAuth 文件 | `openai-chatgpt.js` | `openai-codex.js` |
| 用途 | ChatGPT 计划 + Responses | 旧 Codex 订阅路线 |

**不要把旧 Codex token、client ID、`backend-api` 或 `openai-codex` 的登录缓存复用到新插件。** 官方明确要求 ChatGPT 计划走 `POST https://api.openai.com/v1/responses`，不要指向 `backend-api`。

### 4.5 pi-ai 对 ChatGPT 计划请求限制的现有处理

`dist/api/openai-responses.js` 已有 ChatGPT 分支：

```js
// 261-315
const omitUnsupportedFields = isChatGPTSignIn(model, options?.apiKey);
const params = {
  model: model.id,
  input: messages,
  stream: true,
  prompt_cache_key: ...,
  prompt_cache_retention: omitUnsupportedFields ? undefined : ...,
  prompt_cache_options: omitUnsupportedFields ? undefined : ...,
  store: false,
};
if (options?.maxTokens && compat.supportsMaxOutputTokens && !omitUnsupportedFields) {
  params.max_output_tokens = Math.max(options.maxTokens, 16);
}
if (options?.temperature !== undefined && !omitUnsupportedFields) {
  params.temperature = options?.temperature;
}
...
```

`isChatGPTSignIn` 的条件（文件前部）：

```js
model.provider === "openai" &&
model.baseUrl === "https://api.openai.com/v1" &&
apiKey !== undefined &&
!apiKey.startsWith("sk-")
```

结论：

- **【现成】** 只要走 `openai` 的 transport，且 `model.provider === "openai"`、base URL 精确、token 不是 `sk-` 开头，pi-ai 会自动 `store:false`、`stream:true`，并省略 `max_output_tokens` / `temperature` / `prompt_cache_retention` 等限制字段。
- **【关键设计约束】** 新插件的 DSH 路由是 `openai-chatgpt-plan`，但内部 pi-ai `Model.provider` 必须仍是 `"openai"`，否则上述 ChatGPT 分支不触发，会发出计划路由不接受的字段。实现上需要一个**私有的 pi-ai provider alias**（见第 6 节），不能直接把 provider id 改成新路由名。
- **【约定/限制】** 因此 DSH 的 `maxTokens` 输出上限和 `temperature` 在计划路由上会被静默省略，不能作为可执行约束；插件 README/UI 必须说明，而不是假装生效。
- **【风险】** `samplingParams` 在 `buildParams` 最后 `Object.assign`；如果模型配置带 `temperature` / `top_p` 等 sampling 参数，可能绕过 `omitUnsupportedFields`。新插件不得设置这些 sampling 参数。
- **【风险】** `service_tier` 仍会被发送（第 278-280 行），官方错误表把 service-tier override 列为可能不支持；新插件不得设置。
- **【FAIL/限制】** `convertResponsesMessages` 的 `instructionRole` 在 `model.reasoning === false` 时选 `"system"`，即使 `compat.supportsDeveloperRole = true` 也不会改为 developer（`openai-responses-shared.js` 中 `instructionRole` 逻辑）。官方明确拒绝显式 `role:"system"` 的 message。因此复用 `PiAiAdapter` 时，**MVP 只能暴露 `reasoning: true` 的模型**；非 reasoning 模型需要自写转换把 system prompt 放进 `instructions` 或 developer message，不能靠一个 compat 开关解决。
- **【现成/重要】** 对 `compat.supportsMidConvoSystemMessages === true` 且 `compat.supportsAdditionalTools === true` 的模型，pi-ai 的 `getResponsesToolSupport()` 返回 `"changes"`，会把**每个工具都放进 `additional_tools` input item**（头部第一个 + 后续增量），而不是顶层扁平 `tools`。这正好符合官方计划路由的 tools 要求。`gpt-5.4` / `gpt-5.4-mini` / `gpt-5.4-pro` / `gpt-5.5` / `gpt-5.6-*` / `gpt-6-*` / `gpt-6.1-sol` 具备这两个 compat 标志；`gpt-5` / `o3` 等旧 reasoning 模型没有，仍会走顶层 `tools`。因此 MVP 的模型过滤应同时要求 `reasoning === true && compat.supportsMidConvoSystemMessages === true && compat.supportsAdditionalTools === true`，既避开 system message，又避开扁平 tools 和 `tool_search`。

---

## 5. OpenAI 官方当前契约（2026-10-29 抓取）

> 以下为官方 Markdown 页面内容摘要；URL 见第 10 节。官方文档会变，实施前需重新抓取。

### 5.1 开源客户端路径与可用性

- **【官方】** Sign in with ChatGPT 的 open-source / locally hosted 路径：用户用 ChatGPT 账号登录；符合条件的 Plus/Pro 可用其 ChatGPT 计划完成 eligible Responses 请求；开源客户端通过 `dynamic_agent_client` 动态注册，无需 client secret 或 partner API key。
- **【官方】** Quickstart 同时写明：Sign in with ChatGPT 目前对 selected commercial partners 是 limited trial；ChatGPT plan usage 对 all open-source partners 和 selected private clients 可用。不要把“本地运行”推断为所有账号都必然有资格。
- **【官方】** 商业/远程托管产品走另一条申请路径（`request-client-id`）；本插件按 OSS 路径设计，但仍需真实账号验收资格。

### 5.2 首次注册与重新登录

官方 `Registration and sign-in` 的关键要求：

| 项目 | 要求 |
|---|---|
| 首次注册 `client_id` | `dynamic_agent_client` |
| `agent_name_hint` | 真实、稳定的应用名；只在首次动态注册时发送，重新授权时省略 |
| `ext_agent_host_id` | 每个 host 稳定、唯一；`urn:uuid:<UUIDv4>` 或 JWK thumbprint / `did:key` |
| 回调 | `http://127.0.0.1:<port>/auth/callback`；scheme/host/path 不变，只有 port 可变；不要用 `localhost` |
| `scope` | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| `resource` | `https://api.openai.com/v1` |
| 每次 attempt | 新 `state`、`nonce`、PKCE verifier；先启动监听再打开浏览器 |
| 新注册 callback | 返回 `code`、`state`、issued `client_id`；`client_id` 必须保存，不能保存 `dynamic_agent_client` |
| 重新登录 | 使用已保存的 issued `client_id`；可带 `id_token_hint` / `login_hint`；省略 `agent_name_hint` |
| 回调 client_id | 重新授权 callback 可能省略 `client_id`；若给出不同的 client ID，必须拒绝，不能替换 |
| code exchange | 使用 issued/saved client ID、code、verifier、完全一致的 redirect_uri、resource；无 client secret |
| ID token | 用 JWKS 验签；校验 issuer、audience=issued client ID、exp、nonce；用 `sub` 作为账号身份 |
| scopes | 只有包含 `chatgpt.tokens.use.direct` 才能做计划推理；否则保留登录但标记计划未启用 |
| 存储 | 每个 issued client ID / 已验证身份独立记录；保存 identity、tokens、scopes、expiry、host ID、id_token |
| 刷新 | 用保存的 issued client ID（不是 `dynamic_agent_client`）+ refresh token；序列化刷新；旋转 refresh token |
| 退出 | 用 discovery 的 `revocation_endpoint` POST refresh token + client ID；网络失败可重试，最终本地清除并告知未确认远端撤销 |

### 5.3 推理契约

官方 `Models and inference`：

- 模型列表：`GET https://api.openai.com/v1/models`，Bearer access token；响应有 `models` 数组；保留 `visibility == "list"`；显示 `display_name`；请求时用 `slug`。
- 推理：`POST https://api.openai.com/v1/responses`，`Authorization: Bearer <ACCESS_TOKEN>`。
- **必须** `store: false`、`stream: true`；`input` 是数组；用 `instructions` 或 developer messages；显式 `{type:"message", role:"system"}` 会被拒绝。
- **成功判定**：必须读到 `response.completed`；`response.failed` / `response.incomplete` / 中断流分别处理。
- 用量错误可能在流开始后以 `subscription_sharing_usage_limit_exceeded` / `subscription_sharing_usage_unavailable` 到达。

官方 `Preview limitations` 的请求限制：

- 省略：`background`、`conversation`、`max_output_tokens`、`max_tool_calls`、`metadata`、`moderation`、`multi_agent`、`prompt`、`prompt_cache_retention`、`safety_identifier`、`temperature`、`top_logprobs`、`top_p`、`truncation`、`user`。
- 不发送 `previous_response_id`；每次带完整 `input`。
- **Supported tools**：Group function/custom tools in namespaces，或通过 `additional_tools` input items。
- **Unsupported tools**：image generation、file search、Code Interpreter、native computer use、hosted MCP/connectors、Responses `tool_search`；`programmatic_tool_calling` 不能放在顶层 `tools`。
- 输入：文本、图片、文件（模型支持时）；audio/video、Files upload API、transcription API 不支持。
- Codex app-server 也是 stdio + HTTP/SSE 到 Responses；不是本插件的首选路线。

### 5.4 错误与恢复

官方 `Errors and recovery` 的关键：

- 流开始前可能是 `{"detail":"..."}`，不是标准 `error` 对象；保留 HTTP status、body shape、request ID。
- 401 / 403 / 503 的直接 admission 含义不同；403 可能是区域/策略限制，不要盲目重登。
- 结构化错误码：
  - `subscription_sharing_user_not_eligible`（403）：计划不可用；不要循环 OAuth。
  - `subscription_sharing_usage_limit_exceeded`（429）：暂停计划请求，链接 ChatGPT Usage；不要推断重置时间。
  - `subscription_sharing_usage_unavailable`（503）：稍后重试。
  - `subscription_sharing_unsupported_capability`（400）：检查 `error.param`，移除不支持字段/工具/模型。
  - `subscription_sharing_route_not_supported`（403）：检查 method/endpoint。
  - `subscription_sharing_invalid_user`（401）：保留 request ID，重新登录。
- 刷新失败码：`invalid_grant`、`invalid_refresh_token`、`token_expired`、`refresh_token_expired`、`refresh_token_invalidated`、`refresh_token_reused` → 清除不可用 token，用保存的 issued client ID 重新 OAuth；`invalid_client` → 修 client 配置。

---

## 6. 与目标要求的差距

| 目标 | 已安装 DSH/pi-ai | 结论 |
|---|---|---|
| 新增 `openai-chatgpt-plan`，不覆盖 `openai`/`openai-codex` | `LlmRuntime.registerAdapter` 支持唯一 route；`DUPLICATE_ADAPTER` 保护现有 route | **可行** |
| 使用新版 ChatGPT OAuth | pi-ai `openai` 有 `openai-chatgpt.js`；DSH 排除 | **底层有，DSH 未开放** |
| 重新登录复用 issued client ID | pi-ai 每次 `dynamic_agent_client` 新注册；refresh 复用 clientId | **FAIL；需插件实现** |
| ID token 验签/issuer/audience/nonce/sub | pi-ai 只检查非空 | **FAIL；需插件实现** |
| 账号隔离 | DSH 每 provider 一个 record | **FAIL；插件用 accounts map 实现** |
| 串行刷新 | `modifyRecord` 跨进程锁；pi-ai refresh 在 store lock 内 | **PASS（契约）；需实测** |
| 退出撤销 | DSH authorization “nothing revokes”；pi-ai 无 revoke | **需插件实现** |
| host ID 稳定 | pi-ai 要求 `getDeviceId`；DSH 不提供 | **需插件实现并持久化** |
| 模型目录 | pi-ai 静态 catalog；官方要求 `/v1/models` 账号目录 | **需插件实现** |
| ChatGPT 请求限制 | pi-ai 在 `model.provider === "openai"` 时省略字段 | **可复用；需内部 alias** |
| system prompt 形态 | pi-ai 对非 reasoning 模型发 `role:"system"`；官方拒绝 | **FAIL/限制；MVP 只暴露 reasoning 模型** |
| Tools 形态 | 新 reasoning 模型的 compat 会走 additional_tools；旧模型仍扁平 | **PASS（静态，限新模型）/ BLOCKED（旧模型待实测）** |
| 无现成 UI | Models 页不消费 authorization flow | **需 Client footer + Host HTTP** |

---

## 7. 方案比较

### 7.1 方案 A：独立插件，复用 `PiAiAdapter` + 内部 `openai` alias（推荐 MVP）

思路：

1. Host 插件注册唯一 DSH route `openai-chatgpt-plan`。
2. 复用 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter`，它已经把 DSH 的 message/tool/image/replay 转换为 pi-ai 的 transcript，并还原为 DSH `StreamChunk`。
3. 给 `PiAiAdapter` 提供一个合成的 `ResolvedPiAiProviderProfile`，其 `piProvider` 的 id 是 `openai-chatgpt-plan`，`getModels()` 返回账号目录模型；每个模型的 `provider` 字段设为 `"openai"`，`baseUrl` 为 `https://api.openai.com/v1`。
4. 由于 `Models` 按 `model.provider` 查 provider，`PiAiAdapter` 的私有快照需要额外挂一个 id 为 `"openai"` 的 alias provider。用子类覆盖 `current()`，在快照构建后 `snapshot.models.setProvider(alias)`。
5. 这样 pi-ai 的 `isChatGPTSignIn` 触发，自动省略限制字段；DSH 侧路由仍是 `openai-chatgpt-plan`。

优点：

- 复用 DSH 官方 adapter 的转换、工具、图片、replay、attribution、idle watchdog；
- 代码量最小；
- 不修改 `dsh-llm-pi-ai`、不覆盖 `openai`/`openai-codex`；
- 所有账号/令牌逻辑可由插件独立控制。

缺点 / 风险：

- `PiAiAdapter.current()` 是 d.ts 中的 `private` 方法；JS 可以覆盖，但属于**版本敏感 shim**。升级 `dsh-llm-pi-ai` 需回归测试。
- `model.provider = "openai"` 与 DSH route 名不一致，是刻意为之；需要测试 `getModel`、`requireProvider`、`applyAuth` 全链路。
- 若 shim 失败，需要退回方案 B。

shim 的核心只有一处（版本敏感，务必加注释与回归测试）：

```js
class ChatGptPlanAdapter extends PiAiAdapter {
  constructor(options, openaiAlias) {
    super(options);
    this.openaiAlias = openaiAlias; // id: "openai", getModels: () => planModels
  }
  current() {
    const snapshot = super.current();
    if (snapshot.models.getProvider("openai") === undefined) {
      snapshot.models.setProvider(this.openaiAlias);
    }
    return snapshot;
  }
}
```

**推荐**：先用一个最小 spike 验证 shim（不登录，用假 token + mock fetch），再实现完整流程。

### 7.2 方案 B：独立插件，自写 `LlmAdapter` + 复用 pi-ai 的 `openai` transport

思路：

- 自己实现 `LlmAdapter`，把 DSH `GenerateOptions` 转成 pi-ai `TranscriptContext`，调用 `openaiProvider().stream(model, context, { apiKey })`；再把 pi-ai 事件转回 DSH chunks。
- 模型 `provider` 仍是 `"openai"`，base URL 精确，token 非 `sk-`，所以限制字段省略仍由 pi-ai 处理。

优点：不依赖 `PiAiAdapter` 私有方法。
缺点：需要复制/维护 DSH 的 context 转换、工具调用、图片、replay、错误映射，工作量和回归面显著更大。

**定位**：方案 A 的 fallback；或当 tools 形态必须自定义时，方案 B 可直接改请求体（但仍受官方 namespaces 限制）。

### 7.3 方案 C：直接给 `llm-pi-ai` 加 hand-declared route

做法：在 `dsh-llm-pi-ai` 的 `providers` 中声明 `openai-chatgpt-plan`，`api: openai-responses`，`baseURL: https://api.openai.com/v1`，不写 `apiKeyEnv`，由插件写 `llm-pi-ai/openai-chatgpt-plan` 的 `api-key` record（access token）。

问题：

- hand-declared route 的 `model.provider` 是 `openai-chatgpt-plan`，**不会触发** pi-ai 的 `isChatGPTSignIn`，会发送 `max_output_tokens` / `temperature` 等计划路由不支持的字段。
- hand-declared route 的 auth 是 `harnessApiKeyAuth`，只读 `credential.key`；OAuth grant 没有 `key`，需要插件持续写 api-key record，等于把 OAuth 降级成短期 API key，且 refresh 责任在插件。
- 无法注册 provider 级 OAuth flow（flow 只对 catalog provider 注册）。
- 仍然只有一个 record，账号隔离困难。

**结论：不采用**。它看似少写代码，但会踩中 ChatGPT 请求限制和认证语义。

### 7.4 方案 D：修改 DSH 上游 `dsh-llm-pi-ai`

- 给 `openai` 加 `getDeviceId`、issued client ID 复用、ID token 校验、多账号、revoke；
- 修改 `UNSERVED_OAUTH`；
- 需要源码 checkout、测试、发布；不能编辑全局安装 `lib/index.js`。

**定位**：长期上游贡献，不是本阶段。

### 7.5 选定架构

```text
DSH Web (Models footer)
  │  POST /chatgpt-plan/start
  ▼
Host: OAuth coordinator ──► browser ──► OpenAI authorize
  │                                      │
  │  GET /auth/callback ◄────────────────┘
  ▼
token exchange + JWKS/ID-token validation
  │
  ▼
ctx.credentials.modifyRecord("openai-chatgpt-plan/accounts")
  │
  ├─► register/replace DSH route "openai-chatgpt-plan"
  │
  ▼
DSH agent loop ──► LlmRuntime ──► ChatGptPlanAdapter
                                    │
                                    ├─ 读取 active account / access token
                                    ├─ 账号目录 GET /v1/models
                                    └─ PiAiAdapter + openai alias
                                          │
                                          ▼
                              POST https://api.openai.com/v1/responses
```

---

## 8. 待实现约定（插件设计契约）

以下不是 DSH 内置行为，而是本插件要实现的约定；TASK.md 会拆成任务。

### 8.1 Provider 与账号

- DSH route：`openai-chatgpt-plan`（唯一；不注册 `openai` / `openai-codex`）。
- 显示名：`ChatGPT Plan` / `ChatGPT 计划`。
- Credential record：`openai-chatgpt-plan/accounts`，`kind: "grant"`，payload：

```json
{
  "version": 1,
  "hostId": "urn:uuid:...",
  "activeAccountId": "acct-...",
  "accounts": {
    "acct-...": {
      "id": "acct-...",
      "label": "user@example.com",
      "email": "user@example.com",
      "issuer": "https://auth.openai.com",
      "subject": "<sub>",
      "clientId": "<issued client id>",
      "idToken": "<retained id token>",
      "accessToken": "<access token>",
      "refreshToken": "<refresh token>",
      "tokenType": "Bearer",
      "expiresAt": 0,
      "scopes": ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
      "planEnabled": true,
      "reauthRequired": false,
      "addedAt": 0,
      "lastRefreshAt": 0,
      "sid": null
    }
  }
}
```

- `hostId` 首次生成后持久化；`urn:uuid:<UUIDv4>`。
- `accountId = "acct-" + sha256(issuer + "\0" + subject + "\0" + clientId).slice(0, 24)`；同一注册关系稳定；不同 clientId 即使同一 `sub` 也是不同账号。
- `activeAccountId` 只指向 `accounts` 中存在的 id；切换账号不改变其他账号 token。
- 任何 token 不进入 Config、Settings、日志、状态 JSON、错误消息。

### 8.2 登录状态机

```text
idle
  -> starting (create transaction: state/nonce/PKCE, hostId, redirectUri)
  -> waiting_for_browser
  -> callback_received (validate state)
  -> exchanging_code
  -> validating_id_token
  -> storing (modifyRecord)
  -> connected | identity_only | cancelled | failed | reauth_required
```

规则：

- 每次 attempt 新 `state` / `nonce` / PKCE verifier；transaction 内存保存，10 分钟 TTL，一次性消费；最多 4 个并发。
- 先注册 callback 路由/监听，再打开浏览器。
- `error=access_denied`：校验 state 后直接取消，不兑换 code。
- 新注册：`client_id=dynamic_agent_client` + `agent_name_hint`；callback 必须返回 issued `client_id`。
- 重新登录：使用账号的 `clientId`；省略 `agent_name_hint`；带 `id_token_hint`（以及可选 `login_hint`）；callback 若返回不同 client ID，拒绝。
- 兑换：POST form `grant_type=authorization_code`、issued/saved `client_id`、`code`、`code_verifier`、完全一致的 `redirect_uri`、`resource`。
- ID token：`jose` + discovery JWKS；`issuer`、`audience=clientId`、`exp`、`nonce`、`sub`；可选 `sid`；失败不落盘。
- scopes：必须含 `chatgpt.tokens.use.direct` 才 `planEnabled=true`；否则保留身份登录但 `planEnabled=false`，不注册模型路由。
- 重新登录身份：验证后的 `sub` 必须与所选账号一致；不一致拒绝，不覆盖。
- 成功后原子写 record；只有写成功后才切换 active account / 注册路由。

### 8.3 刷新与退出

- access token 1h；在 `expiresAt - 3min` 后刷新；`earliest_refresh_at` 可参考。
- refresh：POST form `grant_type=refresh_token`、保存的 issued `client_id`、`refresh_token`、`resource`；不带 `scope`；旋转 refresh token；替换 access/refresh/expiry/scopes。
- 串行化：在 `ctx.credentials.modifyRecord("openai-chatgpt-plan/accounts", async current => ...)` 内做刷新；跨进程锁；进程内再加 single-flight Promise。
- 刷新失败分类：
  - 网络/5xx/timeout：保留 token，返回可重试错误；
  - `invalid_grant` / `invalid_refresh_token` / `token_expired` / `refresh_token_expired` / `refresh_token_invalidated` / `refresh_token_reused`：清空该账号 access/refresh，`reauthRequired=true`，保留 clientId/sub/idToken/email 供重新登录；
  - `invalid_client`：标记配置错误，不循环重试。
- 退出：discovery `revocation_endpoint`，POST form `token=<refresh_token>`、`token_type_hint=refresh_token`、`client_id`；200 视为成功；网络/5xx 可有限重试；最终删除本地账号；若远端未确认，状态返回 `remoteRevoked=false`，UI 提示。
- 删除最后一个账号：注销 adapter route（dispose handle），模型选择器移除。

### 8.4 模型目录与 adapter

- `GET {baseURL}/models`，Bearer access；解析 `models` 数组（也兼容 `data`）；过滤 `visibility === "list"`；`slug` 为 id，`display_name` 为名称。
- 缓存 per account，TTL 5 分钟；登录/切换账号/刷新 token 后失效。
- 模型元数据与准入：
  - 已知 slug 从 pi-ai `OPENAI_MODELS` 取 `contextWindow` / `maxTokens` / `input` / `reasoning` / `compat`；
  - **MVP 只准入** `reasoning === true && compat.supportsMidConvoSystemMessages === true && compat.supportsAdditionalTools === true` 的模型；这避开 `role:"system"` 与扁平 `tools`；
  - 未知 slug 默认不暴露（Config `allowUnknownModels=false`）；即使显式允许，也用 Config 默认值（如 272000 / 128000 / `["text"]`），不要过度声明 image；
  - 所有模型对象 `provider: "openai"`、`baseUrl: "https://api.openai.com/v1"`、`api: "openai-responses"`。
- `listModels` 先刷新目录再委托 `PiAiAdapter`；`resolveModel` 若模型未知也刷新一次。
- `resolveApiKey`：读取 active account；必要时刷新；返回 access token；无 active / planEnabled=false 抛 `MISSING_CREDENTIAL` 或 `AUTH`；`listModels` 对 `MISSING_CREDENTIAL` 返回空。
- `providerRetryPolicy`：normal，maxRetries 2；可重试码 `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` / `EMPTY_RESPONSE`；不要重试 `QUOTA` / `AUTH` / `INVALID_REQUEST`。
- 路由注册：有 active + planEnabled 才 `registerAdapter(["openai-chatgpt-plan"], adapter)`；账号/目录变化时 `replace`；签出时 dispose。
- 不覆盖 `openai` / `openai-codex`；内部 alias provider id `openai` 只存在于私有 pi-ai `Models` 集合，不进入 DSH registry。

### 8.5 Host HTTP 路由

| 路由 | 方法 | 作用 | 安全 |
|---|---|---|---|
| `/chatgpt-plan/start` | POST JSON | 创建 attempt，返回 `{url}` | 校验 `Origin` 等于 `webServer.getOrigin()`；只接受 `application/json`；loopback only |
| `/auth/callback` | GET | OAuth 回调；校验 state；兑换/验证/存储；返回 HTML | state/nonce/PKCE；一次性；不反射 code/token |
| `/chatgpt-plan/status` | GET | 脱敏账号状态 | 无 token；只读 |
| `/chatgpt-plan/signout` | POST JSON | 撤销 + 删除指定账号 | Origin 校验；只接受已知 accountId |

- `start` 的 JSON `{ accountId?: string, newAccount?: boolean }`；`newAccount=true` 时忽略 accountId，走新注册；否则 accountId 必须存在。
- 浏览器打开：Client 先 `window.open('about:blank')`，再 `fetch` start，拿到 `url` 后设置 popup.location；popup 被拦截时回退当前页导航。
- 回调页：成功显示简短 HTML，尝试 `window.close()`；若不能关闭，提供回到 DSH 的链接。失败显示脱敏错误码。
- 状态 JSON 不含 `accessToken` / `refreshToken` / `idToken` / `clientId` / `subject`；最多返回 label/email/planEnabled/reauthRequired/expiresAt。
- 若 `webServer` 不是 loopback HTTP 或 `/auth/callback` 已被占用：禁用登录，status 返回明确诊断；不要静默改用其他 path。

### 8.6 Client footer 面板

- 注册到 `settings.models.footer`，`id: "openai-chatgpt-plan-account"`，`order: 10`。
- 显示：
  - 未登录：说明 + “Continue with ChatGPT”按钮；
  - 已登录：active label/email、plan 状态、到期时间、`Add account`、`Sign out`、`Sign in again`（reauth）；
  - 多账号：选择器切换 active；每个账号独立状态。
- 轮询 `/chatgpt-plan/status`（打开时一次；登录 popup 关闭/聚焦时再读；pending 时 2s 一次，成功后停止）。
- 文案通过 `ctx.locale.register("openai-chatgpt-plan", { en, zh })`；样式只用 `--dsw-alias-*` token；不引入 primitives 包。
- 不把 token 写入 DOM / localStorage / sessionStorage。

### 8.7 错误映射

官方错误码要保留在诊断中，并映射到 DSH `LlmError` code：

| 官方 code / 状态 | DSH code | 行为 |
|---|---|---|
| `subscription_sharing_user_not_eligible` (403) | `QUOTA` 或专用 `NOT_ELIGIBLE` | 不重登、不重试；说明账号/workspace 不符合 |
| `subscription_sharing_usage_limit_exceeded` (429) | `QUOTA` | 暂停计划请求；链接 Usage；不推断 reset |
| `subscription_sharing_usage_unavailable` (503) | `RATE_LIMIT` | 有界退避 |
| `subscription_sharing_unsupported_capability` (400) | `INVALID_REQUEST` | 记录 `error.param`；移除不支持字段/工具；不重试 |
| `subscription_sharing_route_not_supported` (403) | `INVALID_REQUEST` | 检查 method/path |
| `subscription_sharing_invalid_user` (401) | `AUTH` | 清 token，重新登录 |
| 401/403 admission | `AUTH` | 检查 scope/区域；不要循环 |
| 5xx / timeout / transport | `SERVER` / `TIMEOUT` / `TRANSPORT` | 有界重试 |

`dsh-llm-pi-ai` 的 `classifyPiAiError` 主要按 message/status 正则分类（`lib/index.js:1447-1458`），对 `subscription_sharing_user_not_eligible` 可能落到 `AUTH`。插件需要在 adapter 外层对 terminal failure 做补充映射，或在文档/UI 中把 403 的“not eligible”与“需要重登”区分开。该映射是**待实现约定**。

---

## 9. 阻塞项与风险

| ID | 项 | 状态 | 影响 | 处理 |
|---|---|---|---|---|
| B1 | `cordis_inspect_*` 不在本会话 | **BLOCKED** | 无法做运行时 Service/Event/Slots/Config 查询 | 下一阶段 Creator mode 补跑；本文静态证据替代 |
| B2 | 未登录真实 ChatGPT 账号 | **NOT_RUN** | 无法证明资格、scopes、模型目录、推理 | 需用户明确批准的 live 阶段 |
| B3 | tools 形态（namespaces / additional_tools） | **部分 PASS（静态）/ 旧模型待实测** | `gpt-5.4+` 走 additional_tools；旧模型仍扁平，可能被拒 | M0 spike 覆盖“新模型 + 旧模型”两种 tool 请求；旧模型失败则过滤掉，或用 alias provider 的自定义 `fetch` 改写为 `additional_tools`，或走方案 B |
| B4 | `/auth/callback` 路径被占用 | **待验证** | 登录无法完成 | 启动时检测；冲突则禁用登录并提示 |
| B5 | WSL2 → Windows 浏览器回调 | **待验证** | 浏览器可能到不了 127.0.0.1:3080 | 当前 DSH GUI 已用 127.0.0.1:3080 验证可达；仍需 callback 实测 |
| B6 | `PiAiAdapter.current()` 私有 shim | **待验证** | 升级即可能失效 | 固定 0.2.1-rc.2；spike + 回归；失败走方案 B |
| B7 | `model.provider="openai"` 与 route 名不一致 | **待验证** | 若 pi-ai 未来校验 provider/model 一致性会失败 | 固定 pi-ai 1.4.0；spike |
| B8 | `/v1/models` 不含 contextWindow | **待验证** | 模型容量可能不准 | 用 pi-ai 静态 catalog + Config 默认；实测校准 |
| B9 | 403 not eligible 被归为 AUTH | **待验证** | 错误提示误导 | 外层错误映射 + UI 文案 |
| B10 | 账号/计划资格 | **NOT_RUN** | 可能登录成功但无计划调用权限 | 登录后检查 scopes；显示 identity_only |
| B11 | 依赖 `jose` / pi-ai 解析 | **待验证** | 本地安装可能缺依赖 | 声明 dependency/peer；安装后 `node --check` + import smoke |
| B12 | 真实刷新/撤销/多进程并发 | **NOT_RUN** | 串行刷新仅契约验证 | 下一阶段用 mock 时钟 + 双进程测试 |
| B13 | 非 reasoning 模型的 system message | **FAIL/限制** | 官方拒绝 `role:"system"`；pi-ai 对非 reasoning 模型发 system | MVP 只暴露 `reasoning:true` 模型；要支持非 reasoning 需自写转换 |

---

## 10. 参考来源

### 10.1 本机安装（只读）

- DSH 清单：`/home/qwei/.local/share/fnm/node-versions/v24.22.1/installation/lib/node_modules/@deepseek-ai/dsh/package.json`
- LLM 类型：`.../dsh/node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts`
- pi-ai adapter：`.../dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`
- pi-ai adapter 类型：`.../dsh-llm-pi-ai/lib/types/{index,adapter,config,auth}.d.ts`
- Authorization：`.../dsh-authorization/lib/types/index.d.ts`
- Credentials：`.../dsh-credentials/lib/types/{index,types}.d.ts`
- Credentials local：`.../dsh-credentials-local/README.md`
- Settings：`.../dsh-settings/README.md`
- Client slots：`.../dsh-client-ui-settings-models/lib/types/client/slot-contract.d.ts`
- Models UI：`.../dsh-client-ui-settings-models/lib/client.js`
- Host WebServer：`.../dsh-host-webserver/lib/types/index.d.ts`
- Plugin Manager：`.../dsh-plugin-manager/lib/types/index.d.ts`
- pi-ai OpenAI provider：`.../pi-ai/dist/providers/openai.js`
- pi-ai legacy Codex：`.../pi-ai/dist/providers/openai-codex.js`
- pi-ai ChatGPT OAuth：`.../pi-ai/dist/auth/oauth/openai-chatgpt.js`
- pi-ai Responses：`.../pi-ai/dist/api/openai-responses.js`
- Cordis 插件技能：`.../dsh-agent-preset/skills/cordis-plugin-development/{SKILL.md,references/host-plugin.md,references/practices.md,references/ui-plugin.md}`
- Web bundle / preset：`.../dsh-web-app/cordis.patch.yml`（`cordis-inspect-providers`）、`.../dsh-web-app/presets/cordis.patch.yml`（`tool-cordis`）、`.../dsh-web-app/presets/standard.patch.yml`（`tool-plugin-manager` disabled）

### 10.2 OpenAI 官方（2026-10-29 抓取）

- [Quickstart](https://developers.openai.com/siwc/quickstart)
- [ChatGPT plan usage in open-source apps](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [On your website（ID token 验签示例）](https://developers.openai.com/siwc/website)
- [Request a client ID（商业/托管路径）](https://developers.openai.com/siwc/request-client-id)
- [Responses create API reference（tools / namespace / additional_tools）](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
- [Account security notification](https://developers.openai.com/siwc/account-security-notification)

> 官方文档会更新；实施和验收时应重新抓取 `.md` 版本并在报告中记录抓取日期。

---

## 11. 本次检查状态汇总

| 检查项 | 结果 | 级别 |
|---|---|---|
| DSH 精确版本 | `0.2.1-rc.2` / pi-ai `1.4.0` | **PASS（静态）** |
| DSH 仍排除 `openai` OAuth | `UNSERVED_OAUTH = new Set(["openai"])` | **PASS（静态）** |
| `openai` 已有新版 ChatGPT OAuth | `openai-chatgpt.js` + `Sign in with ChatGPT` | **PASS（静态）** |
| 旧 `openai-codex` 与新流程区分 | backend-api + legacy | **PASS（静态）** |
| 登录复用 issued client ID | pi-ai 重新登录不复用 | **FAIL（静态）** |
| ID token 验签/非空检查 | pi-ai 仅非空 | **FAIL（静态）** |
| 账号隔离 | DSH 每 provider 单 record | **FAIL（静态）** |
| 串行刷新 | `modifyRecord` 跨进程锁契约 | **PASS（静态）/ NOT_RUN（live）** |
| 新增 `openai-chatgpt-plan` 不覆盖旧 provider | 公开 `registerAdapter` 唯一路由 | **PASS（静态）** |
| 官方 OSS 注册/推理契约 | 已抓取并核对 | **PASS（文档）** |
| `cordis_inspect_*` 运行时查询 | 工具未注册 | **BLOCKED** |
| tools 形态 | 新模型走 additional_tools；旧模型仍扁平 | **PASS（静态，限新模型）/ BLOCKED（旧模型）** |
| 真实登录/推理/刷新/撤销 | 未执行 | **NOT_RUN** |
| 插件安装/启停/卸载 | 未执行 | **NOT_RUN** |
| 真实账号计划资格 | 未执行 | **NOT_RUN** |

---

## 12. 一句话建议

**按方案 A 实现独立 `openai-chatgpt-plan` 插件：先做不登录的 adapter/alias spike，再做 OAuth 与账号记录，最后接 Models footer；M0 必须用新/旧 reasoning 模型各证实一次 tools 形态，再决定是否只暴露 `additional_tools` 兼容的模型。**
