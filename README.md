# 万事大吉

供应商往 New API 网关里添加渠道的控制台（上号器），外加管理员的账单和对账。品牌名中英文都是「万事大吉」。线上版本见仓库根目录的 `VERSION`（当前发布 `1076446d935b6705869c1599e1a3adc1496b3eae`，站点 `https://new.886668.shop`）。

程序不写死任何上游地址。网关令牌加密后入库，接口只回掩码。仓库里没有真实密钥、数据库或服务器地址。

更细的行为说明在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，开发时踩过的坑在 [docs/PITFALLS.md](docs/PITFALLS.md)。渠道抽屉的 52 种类型见 [docs/channel-types.md](docs/channel-types.md)。设计稿在 [docs/design/](docs/design/README.md)，验收清单在 [docs/testing/ACCEPTANCE-CHECKLIST.md](docs/testing/ACCEPTANCE-CHECKLIST.md)。

## 它做什么

- 管理员在「设置」里登记一个或多个 New API 网关（站点根地址、系统访问令牌、数字管理员用户 ID）。
- 供应商往这些网关里添加自己的上游渠道。添加和编辑抽屉对齐 New API v1.0.0-rc.45：52 种类型、四个标签。
- 账单在每天 00:00（Asia/Shanghai）开始拉取，拉完就发布，最晚 06:00。对账按渠道和网关的 `/api/log/stat` 比对。
- 账单、渠道列表和对账只统计本应用创建的渠道。直接在 New API 里建的渠道不会出现。

## 账号

两种角色，没有公开注册（`/register` 会回到登录页）。

- **管理员**：只在首次启动、且 `ADMIN_USERNAME` 还不存在时创建。接口不能再开一个管理员，只能创建供应商。管理员看到本应用里的全部渠道，可以重绑、管用户、管网关。
- **供应商**：只能由管理员创建。只能看到自己创建的渠道。停用后不能登录。

重置密码、停用账号、修改自己的密码，都会作废该账号已有的服务端会话。

## 技术栈

- Next.js 16 App Router（`next` 16.4.2）、React 19、TypeScript
- Tailwind CSS 4
- SQLite（`node:sqlite`）。`DATABASE_URL` 以 `postgres://` 或 `postgresql://` 开头时改走 Postgres；Compose 生产配置固定为 SQLite
- next-intl（`zh-CN` / `en`）
- Docker Compose（镜像 `node:22-alpine`，进程 uid 1001）

浏览器不直连 New API。所有上游请求由服务端代理发出。

## 本地运行

```bash
cp .env.example .env
npm ci
npm run dev
```

打开 [http://127.0.0.1:47821](http://127.0.0.1:47821)。把 `.env` 里的 `DEMO_GATEWAY` 设为 `1`，或用管理员在设置页点「载入演示网关」，可以在没有真实令牌时看界面。演示数据不出本机。

```bash
npm test
npm run lint
npm run build
```

`npm test` 会先比对 `messages/zh-CN.json` 和 `messages/en.json`，缺键或空字符串会失败。发布前至少跑过 `npm run build` 或 `docker compose build`，见 [docs/PITFALLS.md](docs/PITFALLS.md)。

## 环境变量

代码里 `process.env` 读到的变量如下。示例和注释在 [.env.example](.env.example)。

| 变量 | 作用 |
| --- | --- |
| `DATABASE_URL` | 本地默认 `file:./data/app.db`。Compose 和镜像强制 `file:/data/app.db`。生产容器里落在 `/app` 下的路径会被改写到卷上的 `/data/app.db` |
| `ADMIN_USERNAME` | 首次启动创建的管理员用户名。已存在则不改密码。1–20 字符，不能含 `@` 或空白 |
| `ADMIN_PASSWORD` | 该管理员的初始密码。少于 8 位或含空白时不创建管理员 |
| `SESSION_SECRET` | 会话签名密钥，至少 32 字符。未设置时写到数据目录的 `session.secret` |
| `TOKEN_ENCRYPTION_KEY` | 网关令牌的 AES-256-GCM 口令。未设置时写到 `token.key`。更换后已存密文无法解密 |
| `COOKIE_SECURE` | 可选。不设置时，`X-Forwarded-Proto: https` 才给 Cookie 加 `Secure`。`1` 始终开启，`0` 始终关闭 |
| `DEMO_GATEWAY` | 可选。`1` 在启动时种入本地演示网关 |
| `SYNC_INTERVAL_MS` | 每个网关重新拉渠道列表的间隔，默认 `300000`，最小 `30000`。账单 tick 固定 15 秒，不受这个变量控制 |
| `NODE_ENV` | 由 Next / 容器设置。生产为 `production` 时，Docker 内才会把 SQLite 钉到 `/data/app.db` |
| `NEXT_PHASE` | Next 构建阶段为 `phase-production-build`。构建时不改写数据库路径 |
| `NEXT_RUNTIME` | 仅为 `nodejs` 时，`instrumentation.ts` 才启动后台任务 |

测试冷却、额度换算、对账容差在 `app_settings` 里，不是环境变量。默认测试冷却 10 分钟，额度换算 500000 = 1 美元，每日容差 1%。

## 部署

生产用 Docker Compose。容器内进程监听 `0.0.0.0:3000`，发布到宿主机的 `127.0.0.1:3000`。数据在命名卷 `newapi-data` 的 `/data/app.db`（Compose 会给卷名加项目前缀，用 `docker volume ls` 确认）。入口脚本把 `/data` 交给 uid **1001**（用户 `nextjs`）后，用 `su-exec` 启动 `node server.js`。

宿主机 nginx 终结 TLS，证书签给站点域名，反代到 `127.0.0.1:3000`，并把原始协议交回应用。流式响应不要缓冲：

```nginx
server {
    listen 443 ssl;
    server_name new.886668.shop;
    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

应用自己也会送 `X-Content-Type-Options` 和 `Referrer-Policy`。nginx 再送一遍只是重复，无害。

### 备份、干净部署、回滚

先看磁盘（这台机器曾经到过 92%），再备份卷，再往**空目录**解包。覆盖旧目录会留下过期的页面；解包时去掉原所有者，避免文件属主不是本机用户。

```bash
df -h

stamp=$(date +%Y%m%d%H%M)
mkdir -p "$HOME/wsdgkey-backup/$stamp"
docker run --rm \
  -v newapi-data:/data \
  -v "$HOME/wsdgkey-backup/$stamp":/backup \
  alpine sh -c 'cp -a /data/app.db /data/token.key /data/session.secret /backup/'

install=/opt/wsdgkey
rm -rf "${install}.new"
mkdir -p "${install}.new"
tar -xzf wsdgkey-release.tar.gz -C "${install}.new" --no-same-owner
cp "${install}/.env" "${install}.new/.env"   # .env 不进仓库
cd "${install}.new"
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:3000/api/health
```

健康检查失败时回滚：停掉新容器，把备份的 `app.db`、`token.key`、`session.secret` 拷回卷，再用上一份目录或镜像启动。合法的 SQLite 以 `SQLite format 3` 开头。大约 1 KB 的文件不是数据库，说明旧进程把库写进了容器层而不是卷，见 [docs/PITFALLS.md](docs/PITFALLS.md)。

启动只加列和建表，不删 `users`。已有卷可以继续用。

### 在设置里接入网关

用管理员登录，打开「设置」→「添加网关」：

1. 名称。
2. 站点根地址，例如 `https://gateway.example.com`。不要带结尾 `/v1`，保存时会剥掉。
3. New API 管理员的**数字**用户 ID（`New-Api-User`）。
4. 系统访问令牌。用网关安全设置里的访问令牌（v1.0.0-rc.45 前缀是 `nap_`），不要填渠道用的 `sk-` 密钥。至少勾选 `channel:read`、`channel:write`、`channel:sensitive_write`、`channel:operate`、`log:read`。

保存后接口只返回掩码（前 3 位 + `••••` + 后 4 位）。令牌留空表示不修改。供应商能打开「设置」改自己的密码，看不到网关表单。

测试用的 New API 要单独实例，并钉在和线上一致的版本。版本不用登录，打开 `GET /api/status` 看 `data.version`。不要把测试渠道放进线上网关的 `default` 分组。
