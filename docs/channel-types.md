# 渠道类型与抽屉

类型表从 QuantumNous/new-api **v1.0.0-rc.45**（commit `6cf0d90`，2026-10-17）的前端 `CHANNEL_TYPES` 生成，写入 `lib/channel-types.generated.ts`。不要手改该文件。注释掉、未进入对象的 id（6、9、10、11、12、13、21）不在下拉里。id 0 排除。一共 **52** 种。

显示顺序是 `CHANNEL_TYPE_DISPLAY_ORDER`，其余类型接在后面（SGLang 63 在末尾）。

抽屉重新按 new-api 的四组展示，顺序和校验不变：

| id | 中文 | English |
| --- | --- | --- |
| `connection` | 连接与模型 | Connection & models |
| `routing` | 路由与映射 | Routing & mapping |
| `request` | 请求与响应 | Request & response |
| `other` | 其他设置 | Other settings |

视觉用本应用的浅色主题。字段、默认值、分组和校验跟原编辑页一致。提交体由 `lib/channel-payload.ts` 生成，并与 `vendor/new-api/v1.0.0-rc.45/payload-original.mjs` 做字节级对照。

## 标签里的字段

**连接与模型：** 名称、类型（可搜索）、新建时的状态（启用 / 手动禁用）、密钥、添加方式（单条 / 批量 / 多密钥合并）、按类型出现的附加项、API Base URL、模型、分组。

**路由与映射：** 优先级（默认 0）、权重（默认 0）、测试模型、自动禁用、模型映射 JSON。

**请求与响应：** 状态码映射、参数覆盖、请求头覆盖、强制格式化、思考转正文、透传 body、系统提示词及是否覆盖。OpenAI、Anthropic、Codex、Advanced Custom、Sub2API、New API 另有 service tier。Anthropic 另有 Claude beta query。

**其他设置：** 标签、备注（最长 255）、代理、HTTP 协议（auto / http1，默认 auto）、上游模型检查。

新建默认：类型 OpenAI（1）、分组 `default`、状态启用、自动禁用开启、`multi_key_mode=single`、`settings` 为 `{}`。创建请求带 `status`。更新用 PUT，请求体不含 `status`。启用和禁用另走 `POST /api/channel/:id/status`。

## 硬校验

空名称、空类型、空模型、空分组不能保存。密钥在新建时必填，vLLM（62）和 SGLang（63）除外，因为它们允许 `EMPTY`。编辑时留空表示不改密钥。一次最多 50 条。Codex（57）不能批量。Vertex 使用 API Key 时也不能批量。

Base URL 必填的类型：Azure 3、Custom 8、SunoAPI 36、VolcEngine 45、New API 60、Task Plugin 61、vLLM 62、SGLang 63。有值时只接受 http/https，不能带用户名、密码、查询或哈希，不能含空白。末尾 `/v1` 只是黄色警告，保存时只去掉首尾空白和末尾斜杠。

`other` 必填：Azure 3（API 版本）、Xunfei 18、Cloudflare 39（账号）、Vertex 41（区域 JSON）、Coze 49。Task Plugin 还要插件标识。

结构校验：

- AWS 33，`ak_sk` 必须是三段非空的 `AccessKey|Secret|Region`（`awsAkSk`）。`api_key` 必须是两段（`awsApiKey`）。
- Vertex 41，JSON 密钥必须能解析成对象或对象数组（`vertexJson`）。
- Codex 57，密钥必须是含非空 `access_token` 和 `account_id` 的 JSON（`codexJson`）。
- 模型映射、状态码映射、参数覆盖、请求头覆盖必须是 JSON 对象。状态码两端都要在 100–599。
- 代理若填写，须是 `http`、`https` 或 `socks5` / `socks5h`。

## 软警告

仍可保存，黄色提示：

- OpenAI（1）不以 `sk-` 开头
- Anthropic（14）不以 `sk-ant-` 开头
- Gemini（24）短于 8 个字符
- 同一次粘贴里的重复行，以及和已有密钥指纹相同的行
- Base URL 以 `/v1` 结尾

## 火山方舟（45）

默认 Base URL 是 `https://ark.cn-beijing.volces.com`（空值或 `doubao-coding-plan` 也落到这一项）。未解锁时只能选两个地址：

- `https://ark.cn-beijing.volces.com`
- `https://ark.ap-southeast.bytepluses.com`

「API Base URL」标签是隐藏点击目标。点满 10 次（`VOLCENGINE_UNLOCK_CLICKS`）后改为自由输入，并提示已解锁。

## Codex（57）

密钥是 OAuth JSON，必须含非空 `access_token` 和 `account_id`（`codexJson`）。不能批量，也不能多密钥合并。

编辑已有渠道时，「刷新凭证」只在类型 57 且已有本地 id 时出现。本站 `POST /api/channels/:id/codex/refresh` 代理上游 `POST /api/channel/:id/codex/refresh`，请求体为空对象。上游成功时返回 `account_id`、`email`、`expires_at`、`last_refresh`。演示网关只在类型为 57 时返回 `account_id=acct_demo`、`email=codex@demo.invalid`。

对照 `web/default/src/features/channels/components/drawers/channel-mutate-drawer.tsx`（QuantumNous/new-api `7c28993f`，晚于本仓库钉住的 rc.45 `6cf0d90`）：

- 火山方舟（45）：`useHiddenClickUnlock({ requiredClicks: 10 })`。未解锁只能选 `https://ark.cn-beijing.volces.com` 和 `https://ark.ap-southeast.bytepluses.com`。解锁后变成自由输入。新建时空地址或 `doubao-coding-plan` 会写成北京节点。关闭抽屉会重置点击次数。较新的抽屉在敏感字段锁定时不再累计点击；本站没有那把锁，10 次点击始终有效。
- Codex（57）：说明文案要求个人使用、不要分发凭证。刷新按钮只在编辑态出现，调用上面的 refresh 接口，成功后刷新渠道详情。
- 讯飞（18）：新建时 `other` 默认 `v2.1`。
- 请求与响应里，OpenAI（1）和 Codex（57）另有 disable store 透传。service tier 仍按本站 payload 覆盖 1、14、57、58、59、60。
- Task Plugin（61）在 rc.45 payload 里要求 Base URL 和插件标识。较新的抽屉文件里没有单独的 61 区块，本站仍按 rc.45 校验。

## 和设计稿不一致、以规格或 new-api 为准的地方

- 设计 §9.5 写「若该 ID 已被另一本地渠道绑定，橙字提示将改绑」。重新绑定会拒绝，并在错误里写出占用记录的名称和供应商。不会把绑定抢走。
- 设计 §14 的语言规则是「zh* → 中文，其余英文，localStorage `shq-lang`」。已上线的规则保持不变：已保存的 cookie / `users.locale` 优先；否则 `en*` → en，其余（含 zh*、空、未知）→ zh-CN。第一次访问不把 Accept-Language 写进 cookie。
- 设计把用户管理放在 `/users`。路由仍是 `/admin/users`。
- 设计的提供商选择是标题栏下拉。字段、默认值和按类型显隐仍跟 new-api 编辑页；下拉只是换类型的入口。
- 渠道列表的批量条没有测试、没有删除。

## 类型表

| id | 名称 | 密钥提示 |
| --- | --- | --- |
| 1 | OpenAI | |
| 14 | Anthropic | |
| 24 | Gemini | |
| 33 | AWS | `Ak\|Sk\|Region` |
| 43 | DeepSeek | |
| 3 | Azure | Base URL 与 API 版本必填 |
| 41 | Vertex AI | JSON 服务账号，或 API Key + Project ID；区域 JSON 必填 |
| 17 | Ali | |
| 45 | VolcEngine | 两个预设地址，点标签 10 次解锁 |
| 25 | Moonshot | |
| 26 | Zhipu GLM | |
| 23 | Tencent | TokenHub API Key，或旧版 `AppId\|SecretId\|SecretKey` |
| 48 | xAI | |
| 60 | New API | Base URL 必填 |
| 58 | Advanced Custom | |
| 59 | Sub2API | |
| 61 | Task Plugin | Base URL 与插件标识必填 |
| 42 | Mistral | |
| 34 | Cohere | |
| 20 | OpenRouter | |
| 4 | Ollama | |
| 62 | vLLM | 密钥或 `EMPTY`；Base URL 必填 |
| 40 | SiliconFlow | |
| 27 | Perplexity | |
| 15 | Baidu | `APIKey\|SecretKey` |
| 46 | Baidu V2 | |
| 18 | Xunfei | `APPID\|APISecret\|APIKey`；`other` 必填 |
| 31 | LingYiWanWu | |
| 35 | MiniMax | |
| 49 | Coze | `other` 必填 |
| 19 | 360 | |
| 47 | Xinference | |
| 37 | Dify | |
| 38 | Jina | |
| 39 | Cloudflare | 账号必填 |
| 8 | Custom | Base URL 必填 |
| 57 | ChatGPT Subscription (Codex) | OAuth JSON：`access_token`、`account_id`；不可批量 |
| 22 | FastGPT | `APIKey-AppId` |
| 44 | MokaAI | |
| 2 | MjProxy | |
| 5 | MjProxyPlus | |
| 36 | SunoAPI | Base URL 必填 |
| 50 | Kling | `AccessKey\|SecretKey`，或上游已是 New API 时的 ApiKey |
| 51 | Jimeng | `Access Key ID\|Secret Access Key` |
| 52 | Vidu | |
| 53 | Submodel | |
| 54 | Doubao | |
| 55 | Sora | |
| 56 | Replicate | |
| 7 | OhMyGPT | |
| 16 | Zhipu | |
| 63 | SGLang | 密钥或 `EMPTY`；Base URL 必填 |
