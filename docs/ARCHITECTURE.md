# 架构

行为以当前代码为准。设计侧的取舍见 [design/PITFALLS.md](design/PITFALLS.md)，和实现对不上时以这里描述的代码为准。

## 目录

```
app/
  layout.tsx                 根布局：locale、html lang、图标
  (auth)/login/              登录页
  (console)/                 登录后的壳
    channels/                上 key
    billing/                 账单
    recon/                   对账（/reconcile 由 proxy 转过来）
    admin/users/             用户管理
    settings/                设置
    connections/             重定向到 /channels
    usage/                   重定向到 /billing
  api/                       本站接口。浏览器只调这里
components/                  页面视图。渠道抽屉在 channel-drawer.tsx
lib/                         服务端：库、会话、上游代理、账单、对账
i18n/request.ts              next-intl 入口
messages/zh-CN.json          中文
messages/en.json             英文
public/                      logo-mark.svg、PNG、ICO
vendor/new-api/v1.0.0-rc.45/ 钉住的上游类型表和提交体对照
docs/                        本文、踩坑、设计稿、验收清单
proxy.ts                     鉴权、locale、安全响应头（Next 16 的 proxy，不是 middleware.ts）
instrumentation.ts           进程启动后跑后台任务
docker-compose.yml           127.0.0.1:3000，卷 /data
Dockerfile                   多阶段构建，uid 1001
```

`output: "standalone"`。容器里跑的是构建产物 `server.js`，不是 `next dev`。

## 角色和权限

两种角色：`admin`、`supplier`。没有公开注册。`proxy.ts` 对 `/register` 和 `/api/auth/register` 直接拒绝。

管理员只在 `lib/db.ts` 的 `seedAdmin` 里创建：`ADMIN_USERNAME` 还不存在、密码至少 8 位且不含空白时插入一条 `role = 'admin'`。`createSupplier` 永远写 `supplier`。用户管理页不能把供应商改成管理员。

范围在服务端收紧，不靠隐藏按钮：

| 谁 | 渠道 | 账单 / 对账 | 用户与网关 |
| --- | --- | --- | --- |
| 供应商 | `channels.creator_user_id` 等于自己，且 `created_here = 1` | 同样只含自己的渠道 | 「设置」只能改自己的密码。`/api/gateways`、`/api/settings`、`/api/admin` 返回 403 |
| 管理员 | 本应用创建的全部渠道 | 全部 `created_here = 1` 的渠道 | 用户、网关、限速、按月锁定对账、重绑 |

直接在 New API 里建的渠道不会入库。列表同步调用 `rememberChannel` 时不带创建人，未知的上游 ID 被丢掉；同步走完一圈后删除 `created_here = 0` 的行（`lib/channel-service.ts` 的 `finishGatewayList`）。所以渠道列表、账单、对账里都没有它们。

单条操作再查一次 `ownedRow`：不是本人、也不是管理员，返回 404。重绑只允许管理员（`lib/rebind.ts`）。

## 五个导航

侧栏顺序在 `components/shell.tsx`。文案来自 `messages/zh-CN.json` 的 `nav`。「总览」（`/billing`，原「账单」）在最上面，顶部带渠道 KPI 卡与拉取队列（数据来自 `/api/channels` 的 stats），不含剩余额度。

| 导航 | 路径 | 谁能看见 | 本站接口 | 打到 New API 的接口 |
| --- | --- | --- | --- | --- |
| 总览 | `/billing` | 所有人 | `GET /api/billing`、`GET /api/channels`（只取 stats） | 调度器拉基线时：`GET /api/channel/:id`，`GET /api/log/stat?type=2` |
| 上 key（渠道） | `/channels` | 所有人 | `/api/channels`、`/api/channels/:id`、`/api/channels/:id/test`、`/api/channels/status`、`/api/channels/:id/rebind`、`/api/channels/:id/codex/refresh`、`/api/channels/key-check`、`/api/channels/gateway-meta`（转发网关的 `/api/group/` 与 `/api/pricing`，供抽屉勾选分组、搜索填入模型） | 见下方渠道一节 |
| 对账 | `/recon` | 所有人，数据按角色过滤 | `GET/POST /api/recon`，导出 `/api/recon/export`，模板 `/api/recon/template` | 每个渠道的 `GET /api/log/stat?type=2&channel=`；另读一次不带 `channel` 的网关合计，用来判断「整个网关都没有日志」 |
| 用户管理 | `/admin/users` | 仅管理员（侧栏过滤；`/admin` 与 `/users` 在 proxy 里对供应商返回 403） | `/api/admin/users` | 不调用 New API |
| 设置 | `/settings` | 所有人。网关和限速只渲染给管理员 | `/api/gateways`、`/api/settings`、`/api/me/password` | 保存网关时不连上游。之后的同步才用保存的令牌 |

上游请求都走 `lib/upstream.ts` 的 `callGateway`。请求头是 `Authorization: Bearer <系统访问令牌>` 和 `New-Api-User: <数字用户 ID>`。

## 网关限流队列

`lib/rate-queue.ts` 的 `UpstreamQueue`，限额存在 `app_settings`，由 `lib/settings.ts` 的 `rateLimits` 写入队列。

| 参数 | 默认 | 允许范围 | 含义 |
| --- | --- | --- | --- |
| `gateway_rpm` | 60 | 1–10000 | 每个网关每 60 秒的请求数 |
| `channel_rpm` | 5 | 1–1000 | 每个 lane 每 60 秒的请求数。单渠道 lane 是 `channel:<id>`，列表是 `list`，写入是 `mutate` |
| `concurrency` | 3 | 1–50 | 同时在飞的上游请求数 |

窗口 60 秒。排不上就等，不把 429 直接扔给用户。单次任务默认超时 45 秒；创建和更新渠道是 90 秒。单次 HTTP 在 20 秒后中止。

上游返回 429 或 5xx 时记为可重试，并读取 `Retry-After`。`retryDelayMs`：有 `Retry-After` 就用它，上限 10 分钟；没有则从 1 秒起指数退避（1s、2s、4s…），上限 60 秒。超过任务截止时间仍可重试，则失败为 `upstreamBusy`。3xx 不跟随，直接失败。

列表同步另有一层：`SYNC_INTERVAL_MS`（默认 5 分钟，最小 30 秒）决定何时从头再翻页。每次 15 秒 tick 只拉**一个**网关的**一页**（`page_size=20`）。连续失败时 `pollDelayMs` 把下次轮询从 5 分钟加倍，上限 6 小时；第一次失败仍是 5 分钟。

登录是另一套限制，见文末鉴权。

## 渠道

添加和编辑对齐 New API v1.0.0-rc.45（`vendor/new-api/v1.0.0-rc.45`，类型表 52 条，id 0 和被注释掉的 6、9、10、11、12、13、21 不在下拉里）。四个标签在 `CHANNEL_DRAWER_TABS`：

| id | 中文 |
| --- | --- |
| `connection` | 连接与模型 |
| `routing` | 路由与映射 |
| `request` | 请求与响应 |
| `other` | 其他设置 |

字段和校验见 [channel-types.md](channel-types.md)。一次最多 50 条密钥。Codex（57）不能批量。

| 动作 | 行为 | 上游 |
| --- | --- | --- |
| 添加 | `POST /api/channel/`。创建后把 `created_here` 置 1，记下 `used_quota` 快照，写入 `channel_bindings`，然后自动测试 | `lib/channel-service.ts` `createChannels` |
| 单条测试 | 冷却默认 10 分钟（`test_cooldown_min`，0–1440）。模型用请求里的值，否则渠道的 `test_model`，否则 `cheapestModel`（按名称里的 nano / flash / mini 等挑，不是询价） | `GET /api/channel/test/:id?model=` |
| 启用 / 禁用 | 必须走状态接口。更新渠道的 PUT **不带** `status` | `POST /api/channel/:id/status`，body `{ status: 1 \| 2 }` |
| 批量启用 / 禁用 | 对选中的每条渠道各调一次上面的状态接口，返回 `{ ok, fail, redisabled, redisabledItems, failedItems, tests }`。没有调用上游的 `/api/channel/status/batch` | `changeStatus` |
| 保存后、启用后自动测试 | `ignoreCooldown: true`，来源分别是 `auto-save`、`auto-enable`。测试仍会写下 `last_test_at`，所以冷却从这次自动测试重新算。启用后若上游把状态变成 3（自动禁用），记入 `redisabled` | 同单条测试 |
| 重绑 | 仅管理员。本地渠道记录不变，换成同一网关上另一个 New API 渠道 ID。`channel_bindings` 保留历史；`(gateway_id, newapi_channel_id)` 在 `unbound_at IS NULL` 时唯一。目标不存在，或该 ID 已有有效绑定，拒绝并写明占用者 | `lib/rebind.ts` |

搜索可以一次贴多个渠道 ID（逗号、空格或换行），服务端一条 `IN`，最多 `CHANNEL_ID_SEARCH_CAP` = 2000。

状态：1 运行中，2 手动禁用，3 自动禁用。自动禁用展示 `other_info.status_reason` 和时间。上游列表里找不到、但本应用创建过的渠道标成「网关上找不到」（`upstream_missing = 1`），历史账单保留。

## 账单

日界是 Asia/Shanghai 的 00:00。`lib/jobs.ts` 每 **15 秒** 跑一次 `tick`，用 `lib/shanghai.ts` 的 `Intl` 时区 `Asia/Shanghai`，不读容器本地时区。容器是 UTC 也不影响日界。

`ensureBillingRun`：

- 当天的 `baseline_day` 对应账单日是前一天。
- 没有运行记录就插入 `collecting`。
- 还没有基线的 `created_here = 1` 渠道会再拉。已在拉取中的跳过。失败不写基线，下一轮 15 秒继续，所以中断后可以接着拉。
- 全部渠道都有基线，**或者** 上海时间的小时 ≥ 6，就把账单标成 `published`。也就是拉完即发布，最晚 06:00。未拉到的不挡住发布。
- 发布之后某一条又拉成功，`writeRow` 就地更新已发布的那一行（`backfill_at`）。

基线公式在 `lib/billing-math.ts`：

```
today  = GET /api/log/stat?type=2 的 quota
         − token_name「Model test」的 quota
         − token_name「模型测试」的 quota
baseline = used_quota − today
```

rc.45 里成功的渠道测试会写 type=2 消费日志（`LogTypeConsume = 2`，`TokenName` 为 `Model test`），`RecordConsumeLog` **不改**渠道 `used_quota`。不减测试日志的话，基线会被压低，第二天对不上。

今日日志读不到时，只有拉取时刻落在日界后 15 分钟内（`NEAR_MIDNIGHT_MS`）才用累计值当作基线；再晚就记失败，不猜。

创建时 `snapshotCreateBaseline` 把当时的 `used_quota` 写成 `source = 'create'`。首日消耗 = 次日 0 点基线 − 这个快照。创建日当天的快照不会被当成「昨日 0 点」，该渠道不进前一日账单。

缺基线时行的 `kind` 是 `unsynced` 或 `no-baseline`，界面是「未同步」，金额不是 0，也不进合计。跨过日界仍缺中间基线时合成一行：2 天标签 `span2`（「两日合计」），更多天是 `spanN`（「n日合计」），不拆开。

美元：账单和渠道列表用 `QUOTA_PER_DOLLAR = 500000`（`lib/format.ts` 的 `formatUsd`）。对账用设置里的 `quota_per_unit`，默认也是 500000，范围 1–1000000000。改设置不会改变账单页上的美元，因为那边写死了 500000。

## 对账

账单写出一行后 `syncReconChannel` 跑对账，可以重复写。比较的是**这个渠道**的 `/api/log/stat?type=2`（同样先去掉两种测试日志）。日志窗口的结束时间是次日 0 点减 1 秒，因为上游把 `created_at <= end` 当成闭区间（`logWindow`）。

`upstream_missing = 1` 的渠道在对账里是「网关上找不到」。日志读不到是「未同步」，不是 0。整个网关的日志合计为 0、我方又大于 0 时，记为日志缺失（`missing_logs` / `purged`），不记成金额异常。

默认规则（`app_settings`，可改）：

- 容差 `recon_tolerance_pct` 默认 1%。比较的是 `(我方 − 日志) / max(|我方|, |日志|)`。
- 昨日基线 + 昨日消耗 与 今日基线 相差超过 0.5 个额度单位，记 `self`。基线下降记 `reset`。
- 已禁用（状态 2 或 3）仍在涨，记 `disabled_growth`。
- 启用中且消耗接近 0，连续天数达到 `recon_zero_days`（默认 3），记 `zero_streak`。
- 两日合计只比合并后的总量。

供应商可以确认或填备注提出异议；管理员处理异议。管理员可以按月锁定（`recon_periods`）。锁定后原记录不能改，调整走 `recon_adjustments` 追加。可以导出 CSV。`recon_manual_entries` 和 2% 的手工容差已经留在库和设置里，没有写入路径，供应商上传 CSV 还没做。模板下载在 `/api/recon/template`。

## 鉴权

登录是用户名加密码。没有邮箱注册。

- Cookie 名 `newapi_session`（iron-session），`httpOnly`，`SameSite=Lax`，14 天。里面只有 `sessionId` 和 `credentialVersion`。
- 是否仍有效看表 `sessions`：`revoked_at` 为空、未过期、且 Cookie 里的版本等于 `users.credential_version`。
- 退出登录：`POST /api/auth/logout` 把这一条会话的 `revoked_at` 写上，再清 Cookie。
- 停用、本人改密、管理员重置密码、退出全部设备：`credential_version` 加一，并 `revokeUserSessions`。
- `COOKIE_SECURE` 未设置时，只有 `X-Forwarded-Proto: https` 才加 `Secure`。

登录失败限流在 `lib/login-guard.ts`：同一 IP、同一用户名，15 分钟内各 5 次失败后返回 429，带 `Retry-After`。成功登录清掉该用户名的计数。IP 取 `X-Forwarded-For` 的第一段，否则 `X-Real-IP`。

## 语言

`lib/locale.ts`：

1. Cookie `locale` 或账号上的 `users.locale` 优先（`zh-CN` 或 `en`）。
2. 否则按 `Accept-Language` 的 q 值往下找。第一个 `zh*` 用 `zh-CN`，第一个 `en*` 用 `en`。`fr` 这类不支持的标签跳过，所以后面的 `en*` 仍然有效。一个都没有则 `zh-CN`。
3. 第一次打开不把浏览器语言写进 Cookie。顶栏「中 | EN」才写 Cookie，并在已登录时写入账号。

`POST /api/locale` 接受 `zh`、`zh-CN`、`zh-Hans`、`zh_CN`（主语言是 `zh` 即简体）以及 `en`、`en-US`。其他值 400。

`<html lang>` 在 `app/layout.tsx`：`en` → `en-US`，否则 `zh-CN`。布局里 `await connection()`，避免页面在构建时被预渲染死成 `zh-CN`。客户端 `LocaleSync` 会再写一次 `documentElement.lang`。

设计稿里的 localStorage 键是 `shq-lang`。代码的 Cookie 键是 `locale`；切换语言时额外把 `shq-lang` 写入 localStorage，`LocaleSync` 也会读旧的 `locale` localStorage。

## 数据表

`lib/db.ts` 的 `SCHEMA`，外加启动时补的列。SQLite 与 Postgres 共用这些语句。

| 表 | 用途 |
| --- | --- |
| `users` | 账号。`role`、`disabled`、`credential_version`、`locale` |
| `sessions` | 服务端会话。`revoked_at` 为空才有效 |
| `connections` | 旧版连接表，仍会建，当前控制台不读写 |
| `gateways` | 网关。`token_cipher`、`admin_user_id`、`demo`、`disabled` |
| `app_settings` | 限速、冷却、额度换算、容差、站点名 |
| `channels` | 本应用的渠道副本。`created_here`、`creator_user_id`、`create_baseline`、`upstream_missing`、`missing_handled`、测试与自动禁用字段 |
| `channel_bindings` | 重绑历史。一个上游 ID 同时只有一条 `unbound_at IS NULL` 的绑定 |
| `channel_baselines` | 每个渠道每个上海日的 0 点基线。`source` 有 `create`、`exact`、`near-midnight`、`bind` |
| `billing_runs` | 一次日账：`collecting` 或 `published` |
| `billing_attempts` | 每个渠道这次拉取的成败 |
| `billing_rows` | 发布后的行。`kind`、`span_days`、`label`、`test_quota`、`finding`、`log_quota`、`binding_id` |
| `channel_audits` | 创建、测试、启用、重绑等操作记录 |
| `gateway_list_seen` | 最近一轮列表同步见过的上游 ID |
| `test_runs` | 每次测试的模型、结果、延迟、测试额度 |
| `recon_rows` | 对账结果，按账期和渠道唯一 |
| `recon_gateway_days` | 网关当日日志合计，用来判断日志是不是整站都空 |
| `recon_periods` | 按月锁定 |
| `recon_adjustments` | 锁定后的追加调整 |
| `recon_manual_entries` | 留给供应商手工对账，当前没有写入 |
