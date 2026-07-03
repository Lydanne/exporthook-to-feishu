# exporthook-to-feishu 使用指南

这个服务做两件事：

- 接收导出任务回调，并转发通知到飞书机器人。
- 提供 BullMQ 队列管理页，基于 bull-board，支持 Basic Auth 或 OIDC 登录。

## 安装与启动

```bash
pnpm install --frozen-lockfile
pnpm start
```

默认监听 `PORT=8001`。首次部署前建议从 `.env.example` 复制一份 `.env`，并替换所有密钥类配置。

## 必填安全配置

通知接口必须配置访问 token：

```env
FEISHU_NOTIFY_TOKEN=replace-with-random-token
```

`FEISHU_NOTIFY_TOKEN` 至少 16 个字符。请求 `/notify/feishu` 时可任选一种方式传入：

```http
x-notify-token: <FEISHU_NOTIFY_TOKEN>
Authorization: Bearer <FEISHU_NOTIFY_TOKEN>
?token=<FEISHU_NOTIFY_TOKEN>
```

飞书 webhook 域名默认只允许：

```env
FEISHU_WEBHOOK_ALLOWED_HOSTS=open.feishu.cn,open.larksuite.com
```

## 通知接口

接口：

```http
POST /notify/feishu?link=open.feishu.cn/open-apis/bot/v2/hook/<token>
```

服务会把 `link` 转成 HTTPS URL，并只允许发送到 `FEISHU_WEBHOOK_ALLOWED_HOSTS` 中的域名。

请求体需要包含当前代码使用的字段：

```json
{
  "jobQueue": "export-jobs",
  "jobId": "123",
  "status": "completed",
  "result": {
    "code": 0,
    "url": "https://example.com/file.xlsx",
    "size": 1024,
    "count": 1
  },
  "error": "null",
  "cost": 1000,
  "startAt": 1783070000000,
  "payload": {
    "openid": "ou_xxx"
  }
}
```

## Bull Board 管理页

默认地址：

```text
/admin/queues
```

配置队列名和 Redis：

```env
BULL_BOARD_PATH=/admin/queues
BULL_BOARD_QUEUES=export-jobs
REDIS_URL=redis://127.0.0.1:6379/0
```

`BULL_BOARD_PATH` 不能配置为 `/`，必须使用独立子路径，避免管理页接口绕过鉴权。

多个队列用逗号分隔：

```env
BULL_BOARD_QUEUES=export-jobs,mail-jobs,report-jobs
```

## Basic Auth 模式

适合内网或临时部署：

```env
BULL_BOARD_AUTH=basic
BULL_BOARD_USERNAME=admin
BULL_BOARD_PASSWORD=replace-with-strong-password
```

访问 `/admin/queues` 时浏览器会弹出账号密码登录框。

## OIDC 模式

启用 OIDC 后，`BULL_BOARD_USERNAME` 和 `BULL_BOARD_PASSWORD` 会被忽略。
如果使用 Basic Auth，保持 `.env.example` 中的 OIDC 变量为注释状态即可。

```env
BULL_BOARD_AUTH=oidc
OIDC_ISSUER=https://id.example.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_SESSION_SECRET=replace-with-at-least-32-random-characters
OIDC_BASE_URL=https://your-service.example.com
OIDC_ALLOWED_EMAILS=admin@example.com
```

OIDC 回调地址默认为：

```text
<OIDC_BASE_URL>/admin/queues/callback
```

需要在身份提供商里配置这个 callback URL。

生产环境必须配置 `OIDC_BASE_URL` 或 `OIDC_CALLBACK_URL`，不要依赖请求头推导回调地址。

### OIDC 用户授权

默认不允许 issuer 下所有用户直接登录，必须配置至少一种授权方式：

```env
OIDC_ALLOWED_EMAILS=admin@example.com,ops@example.com
```

或：

```env
OIDC_ALLOWED_DOMAINS=example.com
```

如果确实要允许该 OIDC issuer 下所有用户登录，需要显式配置：

```env
OIDC_ALLOW_ALL_USERS=true
```

默认要求邮箱已验证：

```env
OIDC_REQUIRE_EMAIL_VERIFIED=true
```

如身份提供商不返回 `email_verified`，可以关闭：

```env
OIDC_REQUIRE_EMAIL_VERIFIED=false
```

## 常用环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务监听端口，默认 `8001` |
| `FEISHU_NOTIFY_TOKEN` | 通知接口访问 token，至少 16 字符 |
| `FEISHU_WEBHOOK_ALLOWED_HOSTS` | 允许转发的飞书 webhook 域名 |
| `BULL_BOARD_AUTH` | 管理页认证模式：`basic` 或 `oidc` |
| `BULL_BOARD_PATH` | 管理页路径，不能是 `/` |
| `BULL_BOARD_QUEUES` | BullMQ 队列名，逗号分隔 |
| `REDIS_URL` | Redis 连接串 |
| `OIDC_ISSUER` | OIDC issuer URL |
| `OIDC_CLIENT_ID` | OIDC client id |
| `OIDC_CLIENT_SECRET` | OIDC client secret |
| `OIDC_SESSION_SECRET` | Cookie 签名密钥，至少 32 字符 |
| `OIDC_BASE_URL` | 服务外部访问地址 |
| `OIDC_CALLBACK_URL` | 显式 OIDC callback URL，可覆盖 `OIDC_BASE_URL` |
| `OIDC_ALLOWED_EMAILS` | 允许登录的邮箱白名单 |
| `OIDC_ALLOWED_DOMAINS` | 允许登录的邮箱域名白名单 |

## 部署前检查

```bash
node --check app.js
pnpm install --frozen-lockfile
pnpm audit --prod
pnpm outdated --format json
```

确认：

- `.env` 没有提交到 Git。
- `FEISHU_NOTIFY_TOKEN` 已设置且足够长。
- `BULL_BOARD_PATH` 不是 `/`。
- OIDC 模式下已配置用户白名单或显式 `OIDC_ALLOW_ALL_USERS=true`。
- 生产环境 OIDC 已配置 `OIDC_BASE_URL` 或 `OIDC_CALLBACK_URL`。
