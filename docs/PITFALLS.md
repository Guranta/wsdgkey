# 开发踩坑

改规则前先看设计侧的记录：[design/PITFALLS.md](design/PITFALLS.md)。那边是产品取舍；这里是实现和部署时真正会咬人的地方。每条都写症状、原因、处理和代码位置。

## 1. 浏览器不能直连 New API

- **症状**：在浏览器里给网关发 `fetch`，失败，控制台是 CORS；或者内容安全策略把请求拦下。
- **原因**：网关不会给这个控制台的源加 CORS 头。本站的 CSP 是 `connect-src 'self'`，浏览器也只允许打到自己的源。
- **处理**：页面只调本站 `/api/...`。上游请求在服务端发，带 `Authorization` 和 `New-Api-User`。
- **位置**：`lib/upstream.ts` 的 `callGateway`；`lib/security-headers.ts`；`next.config.ts` 的 `headers()`。

## 2. 管理接口要系统访问令牌，不是 sk-

- **症状**：设置里填了 `sk-` 密钥后，拉渠道或账单返回 401。中继鉴权的文案是 Invalid token（`i18n.MsgTokenInvalid`）；面板鉴权的文案是 `Unauthorized, invalid access token`。
- **原因**：`/api/channel` 和 `/api/log/stat` 走的是面板鉴权，要的是系统访问令牌。`sk-` 是给 `/v1` 用的用户密钥。v1.0.0-rc.45 起，旧的单个令牌接口没有了（路由里是 `/api/user/access_tokens`，外加 `DELETE /api/user/access_tokens/legacy`），令牌按 scope 授权，没声明的路由直接拒绝。令牌前缀是 `nap_`。本应用每次都额外送 `New-Api-User`（数字用户 ID）。这一版的上游文档写明该头不再参与鉴权；更旧的网关缺这个头、或头不是数字 ID，仍会 401。
- **处理**：在网关的安全设置里新建访问令牌，不要用渠道密钥。本应用实际打到的路由需要这些 scope：
  - `channel:read`：`GET /api/channel/`、`GET /api/channel/:id`
  - `channel:sensitive_write`：`POST /api/channel/`（创建）、`POST /api/channel/:id/codex/refresh`；更新里改了密钥、Base URL 或覆盖项时，处理器还会再查这个权限
  - `channel:write`：`PUT /api/channel/`
  - `channel:operate`：`GET /api/channel/test/:id`、`POST /api/channel/:id/status`
  - `log:read`：`GET /api/log/stat`
  - 创建或改绑 Task Plugin（类型 61）时，网关还要 `task_plugin.bind`
- **位置**：`lib/upstream.ts` 的 `authHeaders`。上游对照是 v1.0.0-rc.45 的 `router/channel-router.go`、`middleware/access_token_routes.go`（`GET /api/log/stat` → `log:read`）。

## 3. 渠道测试写 type=2 日志，但不改 used_quota

- **症状**：账是平的，一测渠道就出现差额；基线一天比一天低。
- **原因**：v1.0.0-rc.45 里成功的渠道测试调用 `RecordConsumeLog`，类型是 `LogTypeConsume = 2`，`TokenName` 为 `Model test`。这条路径不更新渠道的 `used_quota`。`/api/log/stat?type=2` 却把测试额度算进去。基线若用「累计 − 今日日志」且不扣测试，会把基线压低。
- **处理**：算基线和对账前，从今日日志里减去 `token_name=Model test` 和 `token_name=模型测试` 两笔（旧构建用中文名）。扣掉的部分记在「测试消耗」，不进供应商合计。两笔是相加，不是取一个。升级网关后要重新确认测试是否仍只写日志、不改 `used_quota`。
- **位置**：`lib/billing-math.ts` 的 `todayExcludingTests`；`lib/upstream.ts` 的 `testLogQuota`；`lib/billing-service.ts` 的 `pullChannelBaseline`。

## 4. 启用和禁用不能放进 PUT

- **症状**：更新渠道时带上 `status`，网关返回 `Invalid parameters`，开关没生效。
- **原因**：rc.45 的 `UpdateChannel` 看到请求体里有 `status` 字段就直接拒绝。状态有单独的接口。
- **处理**：启用和禁用用 `POST /api/channel/:id/status`，body 是 `{ "status": 1 }` 或 `{ "status": 2 }`。更新用的 PUT 不要包含 `status`。批量也是对每条渠道各 POST 一次，然后汇总成功、失败、以及启用后再次被自动禁用的条数。代码里的 `setUpstreamStatusBatch` 没有被控制台调用。
- **位置**：`lib/upstream.ts` 的 `setUpstreamStatus`；`lib/channel-service.ts` 的 `changeStatus`；`lib/channel-payload.ts` 里更新体不含 status。

## 5. 账单和渠道列表只有本应用创建的渠道

- **症状**：在 New API 后台手工建的渠道，这里的列表、账单、对账都没有。有人会以为同步坏了。
- **原因**：这是范围，不是漏同步。没有创建人的上游 ID 不会插入；`created_here = 0` 的行在列表走完后删除。查询一律 `created_here = 1`。供应商再被 `creator_user_id` 滤掉。我们创建之后又在网关上被删掉的，会留在库里并标「网关上找不到」。
- **处理**：要统计的渠道必须从本控制台添加。手工渠道不会补进账单。
- **位置**：`lib/channel-service.ts` 的 `rememberChannel`、`finishGatewayList`、列表里的 `c.created_here = 1`；`lib/billing-service.ts`、`lib/recon-service.ts` 同样过滤。

## 6. 限流、429 和 Retry-After

- **症状**：渠道一多，同步变慢，或者界面上出现「网关繁忙」；短时间连点测试或登录会被 429。
- **原因**：上游队列默认每个网关每分钟 60 次、每个 lane 每分钟 5 次、并发 3，窗口 60 秒（`app_settings`，范围分别是 1–10000、1–1000、1–50）。429 和 5xx 会重试：有 `Retry-After` 就遵守，上限 10 分钟；没有则 1 秒起翻倍，上限 60 秒。任务默认只等到 45 秒（创建和更新 90 秒），单次 HTTP 20 秒。列表每次 tick 只翻一页，每页 20 条，tick 是 15 秒；整表重扫间隔默认 5 分钟。连续失败后轮询从 5 分钟加倍，上限 6 小时。登录是另一套：同一 IP、同一用户名，15 分钟内 5 次失败后 429，并带 `Retry-After`。
- **处理**：在设置里改三个限速之前，先确认网关自己的限额。不要用批量测试去撞这条队列（产品已经去掉批量测试）。登录 429 等 `Retry-After`，不要换个无痕窗口以为 IP 限制会消失。
- **位置**：`lib/rate-queue.ts`；`lib/billing-math.ts` 的 `retryDelayMs`、`pollDelayMs`；`lib/settings.ts`；`lib/upstream.ts` 的 20 秒中止；`lib/jobs.ts`；`lib/login-guard.ts`。

## 7. 退出登录必须作废服务端会话

- **症状**：退出后，旧 Cookie 仍能调接口。这是曾经的严重缺陷。
- **原因**：只清浏览器 Cookie 不够，服务端还承认那次登录。
- **处理**：表 `sessions` 是权威。退出给该行写 `revoked_at`。停用、改密、重置密码、退出全部设备会把 `users.credential_version` 加一，并撤销该用户全部会话。Cookie 里的版本对不上就是 401。
- **位置**：`app/api/auth/logout/route.ts`；`lib/session-store.ts`；`lib/session-access.ts`；`lib/users.ts` 的 `setUserDisabled`、`changeOwnPassword`、`resetPassword`。

## 8. /api/locale 要认 zh 和 zh-Hans；html lang 曾被预渲染钉死

- **症状**：请求体是 `{ "locale": "zh" }` 或 `zh-Hans` 时 400；或者浏览器是英文，查看源代码里 `<html lang>` 仍是 `zh-CN`。
- **原因**：只比较完整字符串 `zh-CN` 会漏掉主语言标签。根布局若在构建时预渲染，`getLocale()` 拿不到这次请求的 `Accept-Language`，lang 就被写成默认的 `zh-CN`。
- **处理**：`canonicalLocale` 看主语言：`zh*` → `zh-CN`，`en*` → `en`，下划线会先换成连字符。其他值 400。根布局 `await connection()`，按请求计算 lang：`en` 写成 `en-US`，其余 `zh-CN`。Cookie 名是 `locale`，不是设计稿里的 `shq-lang`（那个键只写在 localStorage）。
- **位置**：`lib/locale.ts`；`app/api/locale/route.ts`；`app/layout.tsx`；`components/locale-toggle.tsx`。

## 9. Next 16 里 Date.now() 会让预渲染报错

- **症状**：构建日志里是 blocking-prerender，栈在 `Date.now` 或 iron-session 解 Cookie。
- **原因**：Next 16 开了 `cacheComponents`。预渲染阶段读时钟会被判定为动态，直接失败。会话库解封时会读时钟。
- **处理**：在读会话或算 locale 之前 `await connection()`，把这段推迟到请求期。不要为了躲开这个错误去缓存 `Date.now()` 的结果。
- **位置**：`lib/session.ts` 的 `getSession`；`app/layout.tsx`；`proxy.ts` 里同样先 `connection()`；`next.config.ts` 的 `cacheComponents: true`。

## 10. 第一次上线死在 TS18048

- **症状**：`docker build` 在 `channel-drawer.tsx` 失败，`TS18048: 'form.other' is possibly 'undefined'`。本机 `next dev` 往往不报。
- **原因**：`ChannelFormValues.other` 是可选的。开发服务器不跑完整类型检查，生产构建会。
- **处理**：用到 `other` 时先兜住，例如讯飞默认版本那一行的 `form.other ?? ""`。发布前在干净环境跑 `docker compose build` 或 `npm run build`，不要只看 dev server。
- **位置**：`lib/channel-payload.ts` 的 `other?: string`；`components/channel-drawer.tsx`（类型 18 的默认值）。

## 11. 容器是 UTC，账单不能用本地时区

- **症状**：账单日界跟着机器时区跑。容器里是 UTC 时，上海时间 0 点会被当成早上 8 点，06:00 的截止也是错的。
- **原因**：`Date` 的本地方法用的是进程时区。镜像没有把 `TZ` 设成上海。
- **处理**：日界、下一班 0 点、日志窗口全部走 `Asia/Shanghai` 的 `Intl.DateTimeFormat`。调度器每 15 秒看一次这个时钟，和容器时区无关。日志窗口结束于次日 0 点减 1 秒。
- **位置**：`lib/shanghai.ts`；`lib/jobs.ts` 的 `startJobs`。

## 12. 部署进空目录，并修掉压缩包里的文件属主

- **症状**：新版本已经起来，浏览器仍是旧页面；或者解包之后文件属主是一个不存在的 uid，接下来的构建或运行读不了。
- **原因**：往旧目录上解包，过期的 `.next` 页面和旧的 standalone 文件会留下来。`tar` 默认保留包内的 uid。容器进程是 uid 1001，数据目录要由入口脚本 `chown` 给 `nextjs`。
- **处理**：每次解到新的空目录，`tar -xzf … --no-same-owner`。数据只放在卷的 `/data`，不要放在镜像层。回滚时连同 `app.db`、`token.key`、`session.secret` 一起换回去。
- **位置**：`Dockerfile`（`adduser -u 1001`，`VOLUME /data`）；`docker-entrypoint.sh`；`docker-compose.yml`。

## 13. 部署前看磁盘

- **症状**：构建或解包中途失败，`df` 显示使用率已经到 90% 以上。这台机器曾经到过 92%。
- **原因**：`docker compose build` 会留下多层镜像；旧的发布目录和解包临时文件占着系统盘。SQLite 写不进满盘。
- **处理**：`df -h` 之后再构建。不用的镜像用 `docker image prune` 清掉之前，先确认当前容器还指着要留的那一层。备份不要和构建抢同一块快满的盘。
- **位置**：操作步骤，不在应用代码里。部署顺序见 [../README.md](../README.md)。

## 14. 测试网关是另一套 New API，版本要钉死

- **症状**：测试环境的渠道测试不写日志、或状态接口的参数变了，账单公式突然对不上。测试渠道出现在线上默认分组里，开始接真实流量。
- **原因**：计费和测试日志的行为跟着网关版本走。`default` 分组会被正常请求选中。
- **处理**：测试用单独的 New API，镜像版本和线上一致（当前对照是 v1.0.0-rc.45）。不用登录就能看版本：`GET /api/status` 的 `data.version`，这条路由在鉴权之外。不要把测试渠道放进线上网关的 `default` 分组。
- **位置**：`docs/channel-types.md` 头部的版本号；上游 `router/api-router.go` 的 `GET /api/status`。

## 15. 10 分钟冷却是按渠道算的，不是按人

- **症状**：两个人先后点同一条渠道的测试，第二个人立刻看到冷却，或者看到的是对方刚刚那次的结果。
- **原因**：冷却看的是行上的 `last_test_at`，默认 10 分钟。自动测试（保存后、启用后）跳过冷却，但会把 `last_test_at` 更新掉，下一次手工测试从那里再算。
- **处理**：测试数据的名称用 `qa-` 前缀，测完删掉。不要在共享渠道上并行点测试。冷却分钟数在 `app_settings.test_cooldown_min`（0–1440）。设置页目前没有这个输入框，但 `PUT /api/settings` 接受 `testCooldownMin`。
- **位置**：`lib/channel-service.ts` 的 `testChannel`；`lib/settings.ts` 的 `testCooldownMs`。

## 16. 测试机上的代理会把域名解析到 198.18.0.1

- **症状**：验收脚本报告「HTTP 没有跳转到 HTTPS」。直接在笔记本上访问却是正常的。
- **原因**：QA 机器的代理把域名解析成了 `198.18.0.1`（假 IP 网段），请求没有到真实服务器，于是看不到 nginx 的跳转。
- **处理**：对生产做检查时用 `curl --resolve <域名>:443:<SERVER_IP>`，把 `<SERVER_IP>` 换成这台机器的地址。不要把真实 IP 写进仓库。
- **位置**：部署环境，不是应用代码。

## 17. nginx 和应用各送一遍安全头

- **症状**：响应里 `X-Content-Type-Options` 和 `Referrer-Policy` 出现两次。
- **原因**：`lib/security-headers.ts` 对每个响应设置 `nosniff` 和 `strict-origin-when-cross-origin`。宿主机 nginx 通常也设了同样的头。
- **处理**：不用改。重复的同值头没有行为差异。应用还送了 CSP 和 `Permissions-Policy`，nginx 不必再复制一份，除非有意收紧。
- **位置**：`lib/security-headers.ts`；`proxy.ts` 的 `applySecurityHeaders`；`next.config.ts`。

## 18. 登录页用的不是 /icon.svg

- **症状**：验收去打开 `/icon.svg`，和登录页标签上的图标不一致，或者 404。
- **原因**：全站 metadata 指向 `/logo-mark.svg`、`/favicon.ico`、`/icon-32.png`、`/icon-512.png` 和 `/apple-touch-icon.png`。仓库里的 `app/icon.svg` 是另一条文件路由，不是登录页在用的那张。
- **处理**：对图标时看 `app/layout.tsx` 的 `metadata.icons`，以及 `public/logo-mark.svg`。
- **位置**：`app/layout.tsx`。

## 19. 相对路径的数据库不会进卷

- **症状**：换一次容器，用户和渠道都没了。卷上的 `app.db` 只有大约 1 KB，文件头不是 `SQLite format 3`。
- **原因**：`DATABASE_URL=file:./data/app.db` 在工作目录 `/app` 下会写成 `/app/data/app.db`，那是容器层，不在 `/data` 卷上。更早的构建还会把构建期的 `DATABASE_URL` 编进包里。
- **处理**：Compose 和镜像都把 `DATABASE_URL` 设成 `file:/data/app.db`。生产且检测到 `/.dockerenv` 时，落在 `/app` 下的路径会改写到 `/data/app.db`。读环境变量用 `process.env[name]`，避免被打进包。入口脚本在打开库之前，会把遗留在 `/app/data/app.db` 的真库拷进卷（连同 `-wal` / `-shm`，以及还不存在的 `token.key`、`session.secret`）。不是 SQLite 的占位文件会改名为 `app.db.not-sqlite`。
- **位置**：`lib/paths.ts`；`docker-entrypoint.sh`；`lib/adopt-legacy-db.ts`；`docker-compose.yml`。

## 20. 换加密口令等于丢掉全部网关令牌

- **症状**：改了 `TOKEN_ENCRYPTION_KEY` 或删了 `token.key` 之后，网关仍在，同步全部失败，掩码也解不出来。
- **原因**：令牌用 AES-256-GCM 加密，密钥从口令经 scrypt 派生。口令变了，旧密文不能解。`SESSION_SECRET` 换了则旧 Cookie 全部失效，但账号还在。
- **处理**：这两份材料和 `app.db` 一起备份。要轮换时，先用旧密钥把令牌解出来，再写入新密钥。未设置口令时，进程会在数据目录生成 `token.key` 和 `session.secret`，权限 `0600`。
- **位置**：`lib/secret-box.ts`；`lib/session.ts`。

## 21. 今日日志读不到时，不要把累计值当成 0 点基线

- **症状**：拉取晚了几小时，账单把「现在的累计」当成「0 点的累计」，当天消耗变成 0 或乱数。
- **原因**：今日字段来自日志，不在渠道对象上。日志超时和日志真为 0 不是一回事。
- **处理**：只有当前时刻在上海日界之后 15 分钟以内，才允许用累计值顶上（`source = near-midnight`）。再晚就记失败，界面保持「未同步」，下一轮再拉。不要把失败写成 0。
- **位置**：`lib/billing-math.ts` 的 `deriveBaseline`、`NEAR_MIDNIGHT_MS`。

## 22. 账单上的美元换算写死 500000

- **症状**：在设置或网关里改了「多少额度 = 1 美元」，账单和渠道列表的美元不动，对账却变了。
- **原因**：`formatUsd` 除的是常量 `QUOTA_PER_DOLLAR = 500000`。对账除的是每行存下来的 `quota_per_unit`（默认 500000，设置范围 1–1000000000）。网关自己的 `QuotaPerUnit` 也不会被读回来。设置页没有「额度换算」输入框，但接口接受 `quotaPerUnit`。
- **处理**：和网关对齐时，确认两边都是 500000（New API 默认 `500 * 1000`）。要改对账口径，调用 `PUT /api/settings`。账单页要跟着改，得改 `lib/format.ts` 并让它读同一份设置。
- **位置**：`lib/format.ts`；`components/recon-view.tsx` 的 `money`；`lib/settings.ts` 的 `quotaPerUnit`。

## 23. 网关返回重定向时不要当成功

- **症状**：Base URL 少了或多了斜杠，同步失败，消息是「网关返回了重定向」，而且不会重试。
- **原因**：上游 `fetch` 使用 `redirect: "manual"`。3xx 视为配置错误，不是 429。地址末尾的 `/v1` 会在保存网关时被剥掉。
- **处理**：填站点根，不要填到 `/v1`，也不要填带用户名密码或查询串的地址。云厂商元数据主机（`169.254.169.254` 等）会被拒绝；这不是完整的内网黑名单。
- **位置**：`lib/upstream.ts` 的 `requestJson`；`lib/url.ts` 的 `normalizeBaseUrl`、`isBlockedHost`。

## 24. 种子逻辑在已有管理员时仍可能再插入一位

- **症状**：库里已经有一个用户名不同的管理员，重启后又多出一个，两个都能进管理功能。
- **原因**：`seedAdmin` 只在 `ADMIN_USERNAME` 已存在时返回。唯一的例外是：库里恰好一位管理员，且用户名像旧版邮箱，这时改名而不新增。其余情况会再插入。
- **处理**：生产库只保留一位管理员。变更 `ADMIN_USERNAME` 之前先看 `users`。产品界面不能创建第二位管理员，不要靠界面来挡住这条启动路径。
- **位置**：`lib/db.ts` 的 `seedAdmin`。
