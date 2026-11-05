# 供应商 JWT 网关适配计划

日期：2026-11-05。状态：计划。本文件不改应用代码。

配套：[可插拔计费源](2026-11-05-billing-pluggable.md)、[验收用例](2026-11-05-billing-acceptance.md)（含 TBD 共 53 条，必过 50 条）。

站点称「供应商 JWT 站」或供应商 IP 主机 `18.139.109.234`。文档不写密码、令牌、cookie 或渠道数字 ID。

## 1. 背景与目标

上号器今天有两种网关：

| `gateways.kind` | 登录 | 渠道路径 | 账单 |
| --- | --- | --- | --- |
| `newapi_admin` | 系统访问令牌 + `New-Api-User` | `/api/channel/` | 源 B，日志对账 |
| `newapi_seller` | 账号密码换短令牌，刷新 cookie | `/api/seller/channel/` | 源 A，`used_quota` 快照 |

供应商 JWT 站是第三种。2026-11-05 只读核对：QuantumNous New API 供应商分支，版本 `development-supplier-ee3071cad28e`，账号 role=5。它不是 ainow（`/api/seller/*` 在该站 404），也不是管理令牌网关。

目标：新增网关种类 `newapi_supplier`（界面名「供应商 JWT」）。复用现有登录态存储和每网关一把锁，单独写路径、能力、证书和计费源。渠道列表能导入约 601 条，区分可管理与仅可见，并且不把供应商做不到的按钮露出来。

## 2. 已核对的事实

| 点 | 结论 |
| --- | --- |
| 登录 | `POST /api/user/login`，JSON 账号密码。返回 JWT、`access_expires_at`、`session.sid`，并种 `new_api_refresh` |
| 访问令牌 | 约 900 秒。业务请求 `Authorization: Bearer`。不送 `New-Api-User` |
| 刷新 | `POST /api/user/auth/refresh`，cookie `new_api_refresh` + 头 `X-Auth-Session`。cookie 会旋转，必须存新的 |
| Origin | 刷新不带该站允许的 `Origin` 时 403，正文可见 `request origin is not allowed`（亦记为 `AUTH_ORIGIN_FORBIDDEN`）。同时带 `Referer` |
| 渠道 | `/api/channel/*`。`POST /api/channel` 不带斜杠会 307，客户端 `redirect: manual`，所以创建必须打 `/api/channel/` |
| 能力 | `GET /api/supplier/v1/profile` 给出 kinds、actions、editable_fields。没有 `/api/seller/*` |
| 规模 | 只读全量现为 604。其中 `owned=false` 601（原先那批可见渠道），`owned=true` 3。更早的 status 聚合（1→83、2→35、3→483）是 601 那批的当天快照 |
| 创建 | `{mode:"single", channel}` 可以成功。站点给名称加上 `supplier_label-` 前缀 |
| 删除 / 手动启停 | 本账号被拒，文案要求联系平台管理员。profile 里 `newapi`、`azure` 即使列出 enable/disable/delete/test，也以实机拒绝为准 |
| 测试 | 不对线上渠道调用 `GET /api/channel/test/:id`。无权限时隐藏入口 |
| `owned` | 只读全量已点清，见第 6 节。供应商自己创建的渠道是 `owned=true`；原先可见的约 601 条是 `owned=false` |
| 额度 | 抽样 `used_quota` 恒为 0。日消耗走计费源 C，见账单计划 |
| TLS | 该主机是 IP + 自签 HTTPS |
| 限流头 | 未见 `X-RateLimit-*`。刹车在我们自己的队列 |

profile 上观察到的 kind：`anthropic`、`bedrock_iam`、`bedrock_apikey`、`newapi`、`openai`、openrouter、`azure`、`vertex`。actions 随 kind 变。授权由站点「Supplier Authorization」控制，会变，每次同步重读 profile，不把矩阵写死。

`GET /api/group/` 可用。列表上的 `keyword` 不可靠，搜索走 `GET /api/channel/search`。批量、tag、multi_key、codex、update_balance 当管理残留，本种类不调用。

## 3. 网关类型

`kind = newapi_supplier`。不要塞进 `newapi_seller`，也不要要求管理员填 Access Token。

设置抽屉在「New API（管理令牌）」和「供应商账号」旁增加「供应商 JWT」。保存前必须测试连接（AUTH-S-01）。管理令牌和 `New-Api-User` 输入框不渲染。

复用列（已在 `lib/db.ts` 的 `gateways` 上）：`password_cipher`、`refresh_cookie_cipher`、`session_sid_cipher`、`access_token_cipher`、`access_expires_at`、`auth_status`、`auth_error`、`owner_user_id`。密码和会话材料继续走 `lib/secret-box.ts` 的 AES-256-GCM。接口、页面、日志都不回明文（AUTH-S-02、SEC-S-01）。

建议新列，启动时 `addMissingColumns`，SQLite 与 Postgres 同一套：

| 列 | 用途 |
| --- | --- |
| `allowed_origin` | 刷新时发送的 Origin。默认取该网关站点根的 origin，用户不填 |
| `supplier_label` | profile 的标签，只用于解释创建后的名称前缀 |
| `profile_cache` | profile JSON 缓存。不得含令牌 |
| `tls_exception_host` | 允许证书例外的主机名，必须等于 `base_url` 的 host。空表示严格校验 |

本种类不读 ainow 的 `can_write` / `max_channels`。该站列表没有这些字段。上限以 profile 将来若真返回为准；没有该字段时，不要显示「已达站点上限」，也不要写死一个数。

## 4. 鉴权生命周期

落点：扩展 `lib/seller-auth.ts`，或抽出共用的会话管理，由 `newapi_supplier` 走同一套锁。`lib/gateway-adapter.ts` 按 kind 分路径。不要让 supplier 请求打到 `/api/seller/*`。

1. 测试连接和保存时 `POST /api/user/login`。验证码或 MFA 沿用现有分类，记「需要人工处理」，不当成密码错误。该站 `turnstile_check` 为 false，分类器仍保留。
2. 访问令牌剩余不足 60 秒（现有 `SELLER_RENEW_WITHIN_MS`）就先刷新。刷新串行（现有 `withGatewayLock`），成功后立刻写回旋转过的 cookie 和 sid。
3. 刷新请求带 `Origin` 和 `Referer`，值都是该网关站点自身的 origin（此主机为 `https://18.139.109.234`）。浏览器不直连供应商站，所以这个头是代理自己加的。
4. 刷新 401，或 Origin 被拒：不要循环刷刷新。按现有上限用密码再登录一次（`seller_login_attempts`，每小时 3 次，刷新不计次）。仍失败则 `auth_status=failed`，顶部黄条，停止（AUTH-S-06、AUTH-S-07、AUTH-S-08）。
5. 业务请求 401 只强制刷新一次再重试，与现在的 `sellerRequest` 相同。
6. 登录会新建会话。失败路径禁止紧循环登录。不要在刷新失败时调用 logout。

表单只有静态说明，没有 Origin 输入框。代理自己把 `Origin` 和 `Referer` 设成该网关站点根的 origin。不要提示运维把上号器前端 Origin 配进白名单。若站点仍拒绝，把站点原文给用户。

## 5. TLS

Node 的 `fetch` 拒绝自签证书。全局 `NODE_TLS_REJECT_UNAUTHORIZED=0` 不能开。

例外只绑 `tls_exception_host` 这一台主机：该网关的请求使用 `rejectUnauthorized: false` 的 dispatcher，其他网关仍严格校验。主机和 `base_url` 不一致就不套用例外。

设置页按设计只放黄字说明，不放「忽略证书」勾选。例外记在该网关的服务端字段里，由部署这个主机的人打开，界面不把它做成一颗通用开关。测试连接在例外生效后应成功（CH-S 的 TLS 预期、验收 AUTH 保存前的连接测试）。证书换成受信任证书后清空 `tls_exception_host`。

## 6. 渠道、owned、按钮

适配器路径：

| 动作 | 路径 | v1 |
| --- | --- | --- |
| 列表 | `GET /api/channel/` | 要。`page_size=20` |
| 搜索 | `GET /api/channel/search` | 本地导入之后的搜索仍走本库 |
| 详情 | `GET /api/channel/:id` | 列表缺字段时才拉 |
| 创建 | `POST /api/channel/` `{mode:"single", channel}` | 第二阶段，见下 |
| 更新 | `PUT /api/channel/` | 仅 `owned=true` 且 profile 允许的字段 |
| 删除 | `DELETE /api/channel/:id` | 不调用。API 层直接拒绝 |
| 启停 | `POST /api/channel/:id/status` | 不调用。API 层直接拒绝 |
| 测试 | `GET /api/channel/test/:id` | 默认不调用 |

按钮（本种类）：

- 行内、批量、抽屉三处都没有「测试」。无权限时给「站点未开放」，不要点下去再 403，也不要自动重试测试（CH-S-07）。保存后、启用后的自动测试在本种类关掉。
- 「删除」「手动禁用」「启用」隐藏，且本站 API 拒绝，避免只藏按钮（CH-S-05、CH-S-06）。
- 「修改」只在 `owned=true` 且该 kind 的 `editable_fields` 允许时出现。
- `owned=false`：只读。名称旁灰 pill「不可管」，操作列是「只读」，复选框禁用。原因用站点能表达的那句（不可管 / 联系管理员），不要只剩一个灰色图标。
- profile 日后若开放某动作，入口跟着 profile **和** `owned=true` 一起出现（CH-S-08）。删除、手动启停、测试是否会因为 `owned=true` 而放开，仍然**未验证**（没有再做写操作复测）。在那之前，这三项对 `owned=true` 也继续隐藏，API 层照样拒绝。
- 列表只读展示 `other_info.status_reason`（欠费、已封禁、密钥重复等）以及 `customer_billing` 的 source、state、汇率（CH-S-09）。`used_quota` 恒为 0，详情不得把它当成今日消耗（CH-S-10）。
- 导入登记的是供应商列表 id。`supplier_publication.customer_channels` 里的客户侧 id 不另建行。日志行上的 channel 可能是客户侧 id，统计口径见账单计划，适配器不要把两种 id 加总。

上游 id 已见到超过 1e12，仍在 JS 安全整数内。解析后若 `Number` 往返不一致，该行算失败，不入库。

创建表单对齐库存 New API 的字段布局，按 `editable_fields` 裁剪。测试按钮不放。名称可能被站点改成带 `supplier_label-` 的前缀，保存后的提示说明这一点，客户端不要自己再加一遍前缀。

创建放到第二阶段。只读结果已经说明：供应商自己创建的渠道得到 `owned=true`。形态试验只打我们自己的测试网关。供应商 JWT 站上线前不再为探形状而创建渠道。

### owned 验证结果

状态：**已验证**。只读全量点清，计数如下。

| 项 | 结果 |
| --- | --- |
| 列表总数 | 604 |
| `owned=false` | 601。预先存在的可见渠道，仅可见 |
| `owned=true` | 3。只有残留探针，名称都是 `xiaolou-01-wsdgkey-probe-should-fail` |
| `owned` 缺失 | 0 |
| 创建是否得到 `owned=true` | 已证实。这 3 条探针就是供应商账号创建的，创建得到 `owned=true` |

删除、手动禁用、测试会不会因为 `owned=true` 而放开，不在本表里。那件事没有做写操作复测，记在第 13 节仍开放的第 1 条。按钮规则仍是第 6 节：这三项继续隐藏。

### 导入默认（已决）

已决。打开导入时默认勾上全部。导入必须带上 `owned`，清单分成「可管理」（`owned=true`）和「仅可见」（`owned=false`）。摘要写成「导入 n（可管 a · 仅可见 b）· 跳过 · 失败」。

- **默认勾选全部渠道**，包括 `owned=false` 的仅可见行，进入列表和 `customer_billing` 计费。当前是 604 条，其中 601 条仅可见。用户可以取消勾选；取消的行不入库、不进账单。
- **管理动作（编辑等）只对 `owned=true`。** 现在只有那 3 条探针。`owned=false` 无测试、无启停、无编辑。取消勾选不改变这条：即便某条仅可见被导入，也不能编辑。
- 站点管理员清掉探针之后，**可管渠道为 0 是预期**，直到供应商新建渠道。可管数为 0 时仍然导入全部仅可见行，不要改成「没有可管行就不要导入」。列表和导入摘要要有空态「暂无可管理渠道」，这不是错误。

导入成功的 toast 或弹窗注脚必须有文案「计费从导入后第一个 0:00 快照起算」，避免把导入当天看成 `$0`。

## 7. 导入策略

复用「导入已有渠道」的语义（`lib/channel-service.ts` 的 `importSellerChannels`）：只写本地行，不 PUT、不 POST、不改状态。自动禁用保持 status 3。重复导入按 `(gateway_id, upstream_id)` 跳过，不重置基线、不改 `imported_at`。

和 ainow 导入的差别：

- 按本种类的列表路径拉，不走 `/api/seller/channel/`。
- 写入 `channels.owned` 和 `supplier_kind`。`origin=imported`，`created_here=1`，`create_baseline` 保持 NULL。禁止调用 `snapshotCreateBaseline(used_quota)`：该站累计额度恒为 0，写进去会变成假基线。
- 页大小 20（满足验收 page_size≤100）。按返回的 total 翻页，不要沿用 seller 导入 `page<=50` 的硬顶当业务上限。604 条约 31 页，50 页碰巧够，站点再涨就会截断。
- 本网关并发默认 2，每分钟不超过 60。这落在验收「并发 ≤3、≤60/min」里，并和设计稿写死的「并发 2」一致。
- 进度：已处理 n / 总数。完成后三格汇总，失败带站点原文。进行中的结果要能在结束后看到。
- 默认导入全部，含那 3 条探针，以便可见和计费完整。探针仍是仅有的 `owned=true`，管理动作只对它们开放到第 6 节允许的程度（编辑在 kind 允许时；删除、启停、测试继续隐藏）。不要按名称把探针排除出账单。

列表展示仍服务端分页 20。不要一次把全部行画进 DOM。

## 8. 运维债：探针渠道

形状试验时创建了三条渠道，名称都是 `xiaolou-01-wsdgkey-probe-should-fail`。它们是目前仅有的 `owned=true`。供应商不能删除，也不能手动禁用。上线前请**站点管理员**删除。上号器不提供删除按钮，也不要再探测创建。

删掉之后，可管渠道为 0 是预期，直到供应商新建。导入默认不变：全部入库做列表和计费，管理动作只认 `owned=true`。

识别这三条时，名称只要包含 `wsdgkey-probe-should-fail` 即算探针。站点会给新建名称加 `supplier_label-` 前缀，现名已经是 `xiaolou-01-wsdgkey-probe-should-fail`，不要只拿不带前缀的短名做精确相等。导入默认仍是全部入库，不因这个名字把它们排除出列表或计费。

以后的探针默认只读。创建形态的试验只在我们自己的测试网关做。验收不依赖这三条，也不去调用它们。

## 9. 表结构影响（网关侧）

只加列，不改旧 kind 的行。

`gateways`：第 3 节的四列。`kind` 已是 TEXT，写入 `newapi_supplier` 即可。

`channels`：

| 列 | 用途 |
| --- | --- |
| `owned` | `NULL` 未核对，`0` 仅可见，`1` 可管理 |
| `supplier_kind` | profile 的 kind 名，如 `openai` |

账单快照表放在计费计划里，列表同步不写快照。渠道行上可以缓存最近一次见到的 `customer_billing` 状态供列表 pill 使用，权威读数以快照表为准。

现有 `importSellerChannels`、`gatewayApi` 的 `kind === "newapi_seller"` 分支不要顺便改行为。本种类走新分支。

## 10. 工作拆分

| 序号 | 内容 | 量级 | 依赖 |
| --- | --- | --- | --- |
| G1 | kind、设置表单、密文字段复用、i18n 中英 | M | — |
| G2 | 登录 / 刷新 / Origin / Referer / 限频 | M | G1 |
| G3 | 单主机 TLS 例外 | S | G1 |
| G4 | `/api/channel` 适配器 + profile | M | G2 |
| G5 | owned 拆分、隐藏测试/删除/启停、API 层拒绝 | M | G4 |
| G6 | 导入全部、可管理只认 owned=true、进度、并发 2 | M | G4、G5 |
| G7 | 用假上游做的测试，不对供应商站写 | M | G2–G6 |
| G8 | 创建表单（无测试按钮） | M | G5，且第 6 节的 owned 验证已填 |

G6 可以和计费计划的源 C 并行，但源 C 要等 G4 能读出 `customer_billing`。不要在 G8 之前对供应商站创建渠道。

## 11. 上线顺序与回滚

1. 本文件只是文档，合并后进程不变。
2. 应用代码上线前，先处理计费计划里的线上分叉（`VERSION` 的 `1076446` 与 `main` 的 `320f31c`）。
3. 先上 kind + 鉴权 + TLS + 只读列表。导入默认全部入库；管理动作只对 `owned=true`。
4. 计费源 C 按计费计划的开关打开。`owned=false` 的可见行同样进快照。
5. 创建按钮最后开，并先在自有测试网关验证。
6. 上线前请站点管理员删除三条探针。删除前它们会随「导入全部」进入可见和计费；删除后可管集合可以是空的。

回滚：禁用该网关行；清空 `tls_exception_host` 后此主机恢复严格证书校验（连不上是预期）；新列留着，旧 kind 不读它们。不删历史渠道行。

## 12. 验收对照

用例全文在 [验收用例](2026-11-05-billing-acceptance.md)。本网关直接对应 AUTH-S-01～08、CH-S-01～10、SEC-S-01～04，以及 SCALE-01。计费与对账的判定在计费计划。

## 13. 待决

### 已关闭（原待决第 1、2 条，依赖 owned 全量）

这两条曾经等数字。数字已到，关闭，按下面实现：

1. **导入默认**：导入全部，供列表和计费（含 `owned=false` 仅可见）。用户可以取消勾选。管理动作（编辑等）只对 `owned=true`。站点管理员删除探针之后，`owned=true` 可以为 0，直到供应商新建渠道。可管数为 0 时仍然导入仅可见行。
2. **owned 全量**：已验证。总数 604，`owned=false` 601，`owned=true` 3（只有探针，名称 `xiaolou-01-wsdgkey-probe-should-fail`），缺失 0。创建得到 `owned=true`，由这 3 条探针证实。

另已关闭、与本计数无关：Origin 提示与第 4 节一致，代理发送站点自身的 Origin/Referer，不要求把上号器前端 Origin 配进白名单。

### 仍开放

1. `owned=true` 是否会放开删除、手动禁用或测试。只读全量不能回答，需要另一次写操作复测。复测前维持隐藏。
2. 创建是否进入第一期。本计划放在 G8。若站点以后要求发送另一个 Origin，再加字段。

## 14. 非目标

- 本 PR 不改应用代码。
- 调研和验收都不对供应商站做新的写操作。不删除探针（删不掉）。
- 不实现 CPA，不把站点钱包余额当结算。
- 不把本站塞进 ainow 或管理令牌的种类里。

## 界面（设计）

设计 2026-11-05 的界面稿。Origin 提示和「已达站点上限」已按设计对 PR #3 的复核改过，与第 4 节、第 3 节一致。

### 1. 新增网关类型「供应商 JWT」

在设置 › 网关 › 添加网关抽屉，类型分段在现有 `New API（管理令牌）` / `供应商账号` 旁增加第三项 **「供应商 JWT」**（描边小标同「供应商账号」）。

| 字段 | 规则 |
| --- | --- |
| 名称 | 必填；默认按站点主机名自动生成（如 `jwt-18-139-…`），**用户可改**；hint「默认按站点自动生成，可修改」 |
| 站点地址 | 必填；根地址，结尾不要 `/v1`（黄字警告不拦截） |
| 账号 | 必填；供应商登录名（role=5） |
| 密码 | 必填；`type=password` + 显示切换；保存后不回显、不回传前端；仅用于换 JWT 与刷新 |
| Origin 提示 | 静态灰字：「刷新由代理带上该站点自身的 Origin 和 Referer。错误 Origin 会返回 AUTH_ORIGIN_FORBIDDEN。」无单独输入框。不要提示把上号器前端 Origin 配进白名单 |
| 自签证书 | 黄提示条：「该站若以 IP + 自签证书提供 HTTPS，拉取代理需为该主机配置证书例外，否则测试连接会失败。」不提供「忽略证书」勾选（安全；由运维/代理配置） |
| 测试连接 | **必做**后才能保存（同 §9.6.1）；成功显示「已登录 · XXms」+「JWT 约 15 分钟 · 剩余不足 60 秒自动刷新」（具体阈值以码农实现为准，设计文案写「短时 JWT + 自动刷新」） |
| 管理令牌字段 | **隐藏**（本类型不用 Access Token） |

网关列表行：名称旁 `供应商 JWT` 小标；状态 pill：`已连接` / `令牌失效` / `续期失败`（续期失败出顶部黄横幅，文案结构同 §9.6.1，原因用站点原文）。

### 2. 渠道列表与操作可见性（本类型强制）

| 操作 | 供应商 JWT 网关下 |
| --- | --- |
| 行内「测试」 | **隐藏**（站点对 supplier 测渠道返回 403） |
| 抽屉「测试连接」 | **隐藏** |
| 行内 / 批量「删除」 | **隐藏**（供应商不可删） |
| 行内 / 批量「手动禁用」「启用」 | **隐藏**（供应商不可手动禁用/启用） |
| 「修改」 | 仅 `owned===true`（可管）行显示；不可管行不提供 |
| 「添加渠道」 | 只有站点返回了 `max_channels` 并且已经达到该数时，才置灰并显示「已达站点上限」。没有这个字段时，永远不出现这句文案，也不写死一个数 |
| 「导入已有渠道」 | 显示（见下） |

抽屉顶部灰说明：「此网关为供应商 JWT，部分字段与操作不可用」。字段裁剪可对齐 §9.6.2（隐藏优先级/权重/自动封禁/参数覆盖等），以码农对接的可写字段为准；设计默认先藏写不进的项。

### 3. owned / 可见可管拆分（导入与列表）

- 导入与列表必须区分：**可见**（能看见）vs **可管**（`owned===true`，可改配置）。
- 不可管行：名称旁灰 pill「不可管」；操作列仅「—」或「只读」；复选框禁用，不进入批量。
- 导入结果表增加列「权限」：可管 / 仅可见；摘要可写「导入 n（可管 a · 仅可见 b）· 跳过 · 失败」。
- 禁止在不可管行上露出启用/禁用/编辑入口（含 hover 才出现的图标）。

### 4. 导入约 601 渠道

- 按钮「导入已有渠道」可重复；已导入 ID 跳过。
- 进行中：模态或顶栏进度「已处理 n/601 · 并发 2 · 预计剩余约 x 分钟」；不可关闭导致状态丢失（可后台继续，回列表后可「查看上次导入结果」——若一期不做，至少 toast 保留汇总）。
- 完成：三格 导入 / 跳过 / 失败 + 失败原文；注脚「导入不修改渠道设置与状态；计费从导入后第一个 0:00 快照起算」。

### 5. customer_billing 相关 pills

| Pill | 条件 | 色 | 出现位置 |
| --- | --- | --- | --- |
| 客户账单 / customer_billing | 该行计费源为 C | 青软底（同「快照计费」） | 渠道名旁、账单行旁 |
| ready | `state=ready` 且非 stale | 可不打或绿点 | 余额/计费单元格旁 |
| 源不可用 | `state=unavailable` | 棕 | 账单与渠道 |
| 过期 | `stale===true` | 橙 | 账单与渠道 |
| 导入 | 经导入登记 | 灰 | 渠道名、账单行 |

金额格规则同计费源文档：异常不显示 $0。

### 6. 账单与对账（本网关）

- **日用量权威**：`customer_billing.amount_usd` 的 0:00 快照差（计费源 C）。
- **对账页**：选中本网关 → 直接账单视图（每渠道每日快照差），无「一致/异常」总览。
- **日志辅助**：若渠道级 log/stat 可用，账单/对账表可增可选列「日志辅助」（非权威）；不可用则整列隐藏或全「—」，**不**因此打异常红。
- **测试消耗行**：不显示。
- **汇率**：环图与表头标明使用的是 `customer_billing.rate` 还是 status USD rate（见计费源文档）。

### 7. 线框 / hash 建议（设计后续可补截图）

| 场景 | 建议 hash（线框） |
| --- | --- |
| 新增网关 JWT 表单 | `#admin/settings/gw-jwt` |
| 续期失败横幅 | `#admin/settings/jwt-renewfail` |
| 渠道列表（无测试/删除/禁用，含不可管） | `#admin/channels/jwt` |
| 导入进度/结果 | `#admin/channels/jwt-import` |
| 对账=账单 + 可选日志辅助列 | `#admin/recon/jwt` |

（实现前以码农计划为准；此处仅设计占位。）

## 评审意见

### 设计

1. **403 测试**：测试入口必须从行内、批量、抽屉三处都拿掉，避免「点了再报错」。验收用供应商角色扫 DOM，不应出现「测试」按钮。
2. **删除 / 手动禁用**：同理隐藏；若后端仍暴露接口，前端隐藏不够——需码农在 API 层拒绝，设计只保证无入口。
3. **假「全部一致」**：本网关对账禁止一致 donut；有 log/stat 也只能做「日志辅助」列。
4. **owned===false**：导入与列表都要可见/可管拆分；不可管行无改删启停。漏做会导致供应商点编辑后大面积 403。
5. **601 导入**：无进度与限流提示时，用户会以为卡死；并发文案写死「并发 2」以免被当成故障。
6. **证书与 Origin**：表单用说明文字，不提供「忽略 TLS」勾选。代理发送站点自身的 Origin/Referer；UI 只提示 AUTH_ORIGIN_FORBIDDEN，不要求把控制台前端 Origin 配进白名单。
7. **与 ainow「供应商账号」并列**：二者都是供应商向网关，但登录态（账号密码换 JWT vs seller token）与计费源（C vs A）不同，类型名与小标必须区分，避免设置页混淆。
8. **文案**：新增字符串中英双语、遵守 §14 不截断不溢出；英文由码农写入 i18n。

### 测试

日期：2026-11-05。针对当时的 commit `7dcaafde`。第 1、2 条已在后续提交改完：owned 全量是已验证（604 / 601 / 3 / 缺失 0），导入默认勾选全部，Origin 灰字只说代理发送站点自身 Origin 和 Referer。

账单可插拔计划对假零 / 跨天 / 导入起算写得很完整，可以按此实现。下面是必须改掉的洞，以及建议补进验收断言的点。

必须改（文档与群里已定口径不一致）：

1. `owned` 与导入默认勾选已定，网关计划仍写「未验证 / 未决」。群里已确认：604 = 601 仅可见 + 3 可管（探测渠道）；总监已定「默认导入全部；管理只对 owned=true；清探测后可管为 0 正常」。请把网关计划 §6「owned 验证结果」「导入默认勾选（未决）」改成已定结论，并删掉「数字到达前不预选」。
2. Origin 文案两套说法。码农注：代理送站点自身 Origin。设计节仍写「把上号器前端 Origin 配进白名单」。评审意见和表单灰字统一成码农注，避免运维配错。

假零（通过，补 2 条断言）：

3. `state=ready` 但 `amount_usd` 为空串 / 非数字 → 按 missing，禁止当 0。
4. 开关 `supplier_billing_enabled=false` → 显示「源不可用」或等价，禁止整页 `$0`。

跨天（通过，定死 TBD）：

5. 源 C 不做两日合计、跨日失败保持缺数据、不平均、不把次日写入昨日。
6. 源 C 的跨日 TBD 已关闭：跨日仍缺数据；两日合计只保留 A/B。见账单计划第 16 节。
7. 晚于 00:15 的首张成功快照仍算 ok 并告警。实现后必须有告警用例。

导入起算（通过，补空态）：

8. 锚点快照本身不是日耗、锚点前「—」不是 `$0`、不回填、禁止 `used_quota=0` 当 create 基线。
9. 清掉 3 条探测后可管渠道可为 0：列表/导入摘要要有「暂无可管理渠道」空态，不算错误。
10. 导入成功 toast/弹窗注脚「计费从导入后第一个 0:00 快照起算」。

其他：

11. 负差不取绝对值、不进正常合计。TBD-01 确认前保持观察。
12. 辅助 log/stat 失败时账单仍正常。
13. 探针识别按名称包含 `wsdgkey-probe-should-fail`，因为站点会加 `supplier_label-` 前缀。导入全部已决，不因名字跳过这三条。
14. 线上 `1076446` 与 `320f31c` 分叉先对账再改源。

短版：假零 / 跨天 / 导入起算三块与验收一致，可实施。owned 全量与默认导入全部、Origin 文案、源 C 关闭两日合计，以及 ready+空 amount、开关关闭、无可管理空态、导入注脚、探针前缀，按上面写入正文。验收用例见 [2026-11-05-billing-acceptance.md](2026-11-05-billing-acceptance.md)。
