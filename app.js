require("dotenv").config({ quiet: true });

const axios = require("axios");
const { createHmac, timingSafeEqual } = require("crypto");
const { basename } = require("path");
const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { FastifyAdapter } = require("@bull-board/fastify");
const fastifyCookie = require("@fastify/cookie");
const oauthPlugin = require("@fastify/oauth2");
const { Queue } = require("bullmq");

const fastify = require("fastify")({ logger: true });
const bullBoardQueues = [];

const bullBoardPath = normalizeBullBoardPath(
  process.env.BULL_BOARD_PATH || "/admin/queues"
);
const bullBoardUsername =
  process.env.BULL_BOARD_USERNAME || process.env.ADMIN_USERNAME;
const bullBoardPassword =
  process.env.BULL_BOARD_PASSWORD || process.env.ADMIN_PASSWORD;
const feishuWebhookAllowedHosts = parseList(
  process.env.FEISHU_WEBHOOK_ALLOWED_HOSTS ||
    "open.feishu.cn,open.larksuite.com"
).map((host) => host.toLowerCase());

const bullBoardAuthMode = getBullBoardAuthMode();
const jwtAuthConfig = getJwtAuthConfig(bullBoardAuthMode);
const oidcConfig = getOidcConfig(bullBoardAuthMode);

if (bullBoardAuthMode === "jwt") {
  setupJwtAuth(jwtAuthConfig);
}
if (bullBoardAuthMode === "oidc") {
  setupOidcAuth(oidcConfig);
}
setupBullBoard();

// Declare a route
fastify.post("/notify/feishu", async (request, reply) => {
  const link = getFeishuWebhookUrl(request.query.link);
  if (!link) {
    return reply.code(400).send("Invalid Feishu webhook URL.");
  }

  const { jobQueue, jobId, status, result, error, cost, startAt, payload } =
    request.body;

  let message = `# 导出完成\n队列名称：${jobQueue}\n任务编号：${jobId}\n创建时间：${new Date(
    startAt
  ).toLocaleString()}\n花费时间：${cost / 1000}s`;
  const code = result.code || 0;
  if (status === "completed" && code === 0) {
    message += `
文件名称：${basename(decodeURIComponent(result.url))}
导出状态：成功
文件链接：${result.url}
文件大小：${result.size / 1024 / 1024}MB
文件数量：${result.count}`;
  } else {
    message += `
导出状态：失败(status: ${status}, code: ${code})
错误信息：${error === "null" ? result.msg : error}`;
  }

  message += `\n用户Openid: ${payload.openid}\n\n[查看详情](http://120.53.222.157:9001/xgj-export-test/${jobQueue}/${jobId})`;

  const res = await axios.post(link, {
    msg_type: "text", // 指定消息类型
    content: {
      // 消息内容主体
      text: message,
    },
  });

  return res.data;
});

fastify.addHook("onClose", async () => {
  await Promise.all(bullBoardQueues.map((queue) => queue.close()));
});

function setupBullBoard() {
  const queueNames = parseList(process.env.BULL_BOARD_QUEUES);
  const redisConnectionOptions = getRedisConnectionOptions();
  const queueErrorLogInterval = Number(
    process.env.BULL_BOARD_QUEUE_ERROR_LOG_INTERVAL_MS || 60000
  );
  const serverAdapter = new FastifyAdapter();
  const adapters = queueNames.map((queueName) => {
    let lastQueueErrorLoggedAt = 0;
    const queue = new Queue(queueName, {
      connection: redisConnectionOptions,
    });
    queue.on("error", (err) => {
      const now = Date.now();
      if (now - lastQueueErrorLoggedAt < queueErrorLogInterval) {
        return;
      }

      lastQueueErrorLoggedAt = now;
      fastify.log.warn({ err, queue: queueName }, "Bull Board queue error");
    });
    bullBoardQueues.push(queue);
    return new BullMQAdapter(queue);
  });

  serverAdapter.setBasePath(bullBoardPath);

  createBullBoard({
    queues: adapters,
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: process.env.BULL_BOARD_TITLE || "Export Queue Admin",
      },
    },
  });

  fastify.addHook("onRequest", async (request, reply) => {
    if (!isBullBoardRequest(request)) {
      return;
    }

    if (bullBoardAuthMode === "oidc") {
      return authenticateWithOidc(request, reply, oidcConfig);
    }

    return authenticateWithJwt(request, reply, jwtAuthConfig);
  });

  fastify.register(serverAdapter.registerPlugin(), { prefix: bullBoardPath });
}

function setupJwtAuth(config) {
  fastify.register(fastifyCookie);

  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body)));
      } catch (err) {
        done(err);
      }
    }
  );

  fastify.get(config.loginPath, async (request, reply) => {
    if (getJwtSession(request, config)) {
      return reply.redirect(bullBoardPath);
    }

    return reply
      .type("text/html; charset=utf-8")
      .send(renderJwtLoginPage(config));
  });

  fastify.post(config.loginPath, async (request, reply) => {
    const credentials = getLoginCredentials(request.body);
    if (!areJwtCredentialsValid(credentials, config)) {
      return reply
        .code(401)
        .type("text/html; charset=utf-8")
        .send(
          renderJwtLoginPage(config, {
            error: true,
            username: credentials?.username,
          })
        );
    }

    setJwtSessionCookie(reply, config);
    return reply.redirect(bullBoardPath);
  });

  fastify.get(config.logoutPath, async (_request, reply) => {
    clearJwtSessionCookie(reply, config);
    return reply.redirect(config.loginPath);
  });
}

function setupOidcAuth(config) {
  fastify.register(fastifyCookie, {
    secret: config.sessionSecret,
    parseOptions: {
      httpOnly: true,
      sameSite: config.cookieSameSite,
      secure: config.cookieSecure,
    },
  });

  fastify.register(oauthPlugin, {
    name: "bullBoardOidc",
    scope: config.scopes,
    credentials: {
      client: {
        id: config.clientId,
        secret: config.clientSecret,
      },
    },
    startRedirectPath: config.loginPath,
    callbackUri: (request) => getOidcCallbackUrl(request, config),
    discovery: { issuer: config.issuer },
    cookie: {
      path: bullBoardPath,
      httpOnly: true,
      sameSite: config.cookieSameSite,
      secure: config.cookieSecure,
    },
    redirectStateCookieName: `${config.sessionCookieName}.state`,
    verifierCookieName: `${config.sessionCookieName}.verifier`,
    userAgent: "exporthook-to-feishu/1.0.0",
  });

  fastify.get(config.callbackPath, async function (request, reply) {
    let tokenResponse;
    let userinfo;

    try {
      tokenResponse =
        await this.bullBoardOidc.getAccessTokenFromAuthorizationCodeFlow(
          request,
          reply
        );
      userinfo = await this.bullBoardOidc.userinfo(tokenResponse.token);
    } catch (err) {
      request.log.warn({ err }, "OIDC login failed");
      clearOidcFlowCookies(reply, config);
      return reply.code(401).send("OIDC login failed.");
    }

    if (!isOidcUserAllowed(userinfo, config)) {
      request.log.warn(
        {
          sub: userinfo.sub,
          email: getClaim(userinfo, config.emailClaim),
        },
        "OIDC user is not allowed"
      );
      clearOidcFlowCookies(reply, config);
      return reply.code(403).send("OIDC user is not allowed.");
    }

    clearOidcFlowCookies(reply, config);
    setOidcSessionCookie(reply, userinfo, config);
    return reply.redirect(bullBoardPath);
  });

  fastify.get(config.logoutPath, async (_request, reply) => {
    clearOidcSessionCookie(reply, config);
    return reply.redirect(config.loginPath);
  });
}

function authenticateWithJwt(request, reply, config) {
  if (isJwtAuthRoute(request, config)) {
    return;
  }

  const session = getJwtSession(request, config);
  if (session) {
    request.jwtSession = session;
    return;
  }

  if (shouldRedirectToJwtLogin(request)) {
    return reply.redirect(config.loginPath);
  }

  return reply.code(401).send("Authentication required.");
}

function authenticateWithOidc(request, reply, config) {
  if (isOidcAuthRoute(request, config)) {
    return;
  }

  const session = getOidcSession(request, config);
  if (session) {
    request.oidcSession = session;
    return;
  }

  if (shouldRedirectToOidcLogin(request)) {
    return reply.redirect(config.loginPath);
  }

  return reply.code(401).send("Authentication required.");
}

function getJwtAuthConfig(authMode) {
  if (authMode !== "jwt") {
    return {
      enabled: false,
    };
  }

  const secret =
    process.env.BULL_BOARD_JWT_SECRET ||
    process.env.JWT_SECRET ||
    process.env.COOKIE_SECRET;

  if (!bullBoardUsername || !bullBoardPassword) {
    throw new Error(
      "BULL_BOARD_AUTH=jwt requires BULL_BOARD_USERNAME and BULL_BOARD_PASSWORD."
    );
  }

  if (!secret) {
    throw new Error(
      "BULL_BOARD_AUTH=jwt requires BULL_BOARD_JWT_SECRET or COOKIE_SECRET."
    );
  }

  if (secret.length < 32) {
    throw new Error("BULL_BOARD_JWT_SECRET must be at least 32 characters.");
  }

  return {
    enabled: true,
    username: bullBoardUsername,
    password: bullBoardPassword,
    secret,
    loginPath: normalizePath(
      process.env.BULL_BOARD_LOGIN_PATH || `${bullBoardPath}/login`
    ),
    logoutPath: normalizePath(
      process.env.BULL_BOARD_LOGOUT_PATH || `${bullBoardPath}/logout`
    ),
    cookieName: process.env.BULL_BOARD_JWT_COOKIE_NAME || "bull_board_jwt",
    cookieSecure: parseCookieSecure(
      process.env.BULL_BOARD_JWT_COOKIE_SECURE ||
        process.env.BULL_BOARD_COOKIE_SECURE
    ),
    cookieSameSite:
      process.env.BULL_BOARD_JWT_COOKIE_SAME_SITE ||
      process.env.BULL_BOARD_COOKIE_SAME_SITE ||
      "lax",
    sessionMaxAgeSeconds: parsePositiveInteger(
      process.env.BULL_BOARD_JWT_MAX_AGE_SECONDS,
      604800
    ),
  };
}

function getOidcConfig(authMode) {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const allowedEmails = parseList(process.env.OIDC_ALLOWED_EMAILS).map((email) =>
    email.toLowerCase()
  );
  const allowedDomains = parseList(process.env.OIDC_ALLOWED_DOMAINS).map(
    (domain) => domain.toLowerCase()
  );
  const allowAllUsers = parseBoolean(process.env.OIDC_ALLOW_ALL_USERS, false);
  const sessionSecret =
    process.env.OIDC_SESSION_SECRET || process.env.COOKIE_SECRET;
  const configuredValues = [
    issuer,
    clientId,
    clientSecret,
    process.env.OIDC_SESSION_SECRET,
  ];
  const hasAnyConfig = configuredValues.some(Boolean);
  const hasRequiredConfig = Boolean(
    issuer && clientId && clientSecret && sessionSecret
  );

  if (authMode !== "oidc") {
    return {
      enabled: false,
    };
  }

  if (hasAnyConfig && !hasRequiredConfig) {
    throw new Error(
      "OIDC is partially configured. Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_SESSION_SECRET."
    );
  }

  if (!hasRequiredConfig) {
    throw new Error(
      "BULL_BOARD_AUTH=oidc requires OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_SESSION_SECRET."
    );
  }

  if (hasRequiredConfig && sessionSecret.length < 32) {
    throw new Error("OIDC_SESSION_SECRET must be at least 32 characters.");
  }

  if (
    hasRequiredConfig &&
    !allowAllUsers &&
    !allowedEmails.length &&
    !allowedDomains.length
  ) {
    throw new Error(
      "OIDC requires OIDC_ALLOWED_EMAILS, OIDC_ALLOWED_DOMAINS, or OIDC_ALLOW_ALL_USERS=true."
    );
  }

  if (
    hasRequiredConfig &&
    process.env.NODE_ENV === "production" &&
    !process.env.OIDC_BASE_URL &&
    !process.env.OIDC_CALLBACK_URL
  ) {
    throw new Error("OIDC_BASE_URL or OIDC_CALLBACK_URL is required in production.");
  }

  return {
    enabled: hasRequiredConfig,
    issuer,
    clientId,
    clientSecret,
    sessionSecret,
    baseUrl: process.env.OIDC_BASE_URL,
    callbackUrl: process.env.OIDC_CALLBACK_URL,
    callbackPath: normalizePath(
      process.env.OIDC_CALLBACK_PATH || `${bullBoardPath}/callback`
    ),
    loginPath: normalizePath(
      process.env.OIDC_LOGIN_PATH || `${bullBoardPath}/login`
    ),
    logoutPath: normalizePath(
      process.env.OIDC_LOGOUT_PATH || `${bullBoardPath}/logout`
    ),
    scopes: parseList(process.env.OIDC_SCOPES || "openid,profile,email"),
    allowedEmails,
    allowedDomains,
    allowAllUsers,
    requireEmailVerified: parseBoolean(
      process.env.OIDC_REQUIRE_EMAIL_VERIFIED,
      true
    ),
    emailClaim: process.env.OIDC_EMAIL_CLAIM || "email",
    nameClaim: process.env.OIDC_NAME_CLAIM || "name",
    sessionCookieName:
      process.env.OIDC_SESSION_COOKIE_NAME || "bull_board_oidc_session",
    sessionMaxAgeSeconds: parsePositiveInteger(
      process.env.OIDC_SESSION_MAX_AGE_SECONDS,
      604800
    ),
    cookieSecure: parseCookieSecure(process.env.OIDC_COOKIE_SECURE),
    cookieSameSite: process.env.OIDC_COOKIE_SAME_SITE || "lax",
  };
}

function getBullBoardAuthMode() {
  const authMode = (process.env.BULL_BOARD_AUTH || "").toLowerCase();
  const resolvedMode =
    authMode || (hasOidcEnvironmentConfig() ? "oidc" : "jwt");

  if (resolvedMode === "basic") {
    return "jwt";
  }

  if (!["jwt", "oidc"].includes(resolvedMode)) {
    throw new Error("BULL_BOARD_AUTH must be jwt, basic, or oidc.");
  }

  return resolvedMode;
}

function hasOidcEnvironmentConfig() {
  return [
    process.env.OIDC_ISSUER,
    process.env.OIDC_CLIENT_ID,
    process.env.OIDC_CLIENT_SECRET,
    process.env.OIDC_SESSION_SECRET,
  ].some(Boolean);
}

function getOidcCallbackUrl(request, config) {
  if (config.callbackUrl) {
    return config.callbackUrl;
  }

  if (config.baseUrl) {
    return `${config.baseUrl.replace(/\/+$/, "")}${config.callbackPath}`;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("OIDC_BASE_URL or OIDC_CALLBACK_URL is required in production.");
  }

  return `${getRequestOrigin(request)}${config.callbackPath}`;
}

function getRequestOrigin(request) {
  const forwardedProto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeaderValue(request.headers["x-forwarded-host"]);
  const protocol = forwardedProto || request.protocol || "http";
  const host = forwardedHost || request.headers.host;

  return `${protocol}://${host}`;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }

  if (typeof value === "string") {
    return value.split(",")[0].trim();
  }

  return undefined;
}

function parseCookieSecure(value) {
  const normalizedValue = (value || "auto").toLowerCase();

  if (normalizedValue === "true") {
    return true;
  }

  if (normalizedValue === "false") {
    return false;
  }

  return "auto";
}

function parsePositiveInteger(value, fallback) {
  const parsedValue = Number(value);

  return Number.isInteger(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === "true";
}

function isJwtAuthRoute(request, config) {
  const pathname = getRequestPathname(request);
  return [config.loginPath, config.logoutPath].includes(pathname);
}

function isOidcAuthRoute(request, config) {
  const pathname = getRequestPathname(request);
  return [config.loginPath, config.callbackPath, config.logoutPath].includes(
    pathname
  );
}

function shouldRedirectToJwtLogin(request) {
  const accept = request.headers.accept || "";
  const pathname = getRequestPathname(request);

  return (
    request.method === "GET" &&
    accept.includes("text/html") &&
    !pathname.startsWith(`${bullBoardPath}/api/`)
  );
}

function shouldRedirectToOidcLogin(request) {
  const accept = request.headers.accept || "";
  const pathname = getRequestPathname(request);

  return (
    request.method === "GET" &&
    accept.includes("text/html") &&
    !pathname.startsWith(`${bullBoardPath}/api/`)
  );
}

function setOidcSessionCookie(reply, userinfo, config) {
  const now = Date.now();
  const session = {
    sub: String(userinfo.sub || ""),
    email: getClaim(userinfo, config.emailClaim),
    name: getClaim(userinfo, config.nameClaim),
    iat: now,
    exp: now + config.sessionMaxAgeSeconds * 1000,
  };

  reply.setCookie(
    config.sessionCookieName,
    Buffer.from(JSON.stringify(session)).toString("base64url"),
    getOidcSessionCookieOptions(config)
  );
}

function clearOidcSessionCookie(reply, config) {
  reply.clearCookie(config.sessionCookieName, {
    path: bullBoardPath,
  });
  clearOidcFlowCookies(reply, config);
}

function clearOidcFlowCookies(reply, config) {
  reply
    .clearCookie(`${config.sessionCookieName}.state`, { path: bullBoardPath })
    .clearCookie(`${config.sessionCookieName}.verifier`, {
      path: bullBoardPath,
    });
}

function getOidcSession(request, config) {
  const signedCookie = request.cookies?.[config.sessionCookieName];
  if (!signedCookie) {
    return null;
  }

  const unsignedCookie = request.unsignCookie(signedCookie);
  if (!unsignedCookie.valid) {
    return null;
  }

  try {
    const session = JSON.parse(
      Buffer.from(unsignedCookie.value, "base64url").toString("utf8")
    );

    if (!session.sub || !session.exp || session.exp <= Date.now()) {
      return null;
    }

    return session;
  } catch (_err) {
    return null;
  }
}

function getOidcSessionCookieOptions(config) {
  return {
    path: bullBoardPath,
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    signed: true,
    maxAge: config.sessionMaxAgeSeconds,
  };
}

function getLoginCredentials(body) {
  if (!body || typeof body !== "object") {
    return null;
  }

  return {
    username: typeof body.username === "string" ? body.username : "",
    password: typeof body.password === "string" ? body.password : "",
  };
}

function areJwtCredentialsValid(credentials, config) {
  return (
    credentials &&
    safeEqual(credentials.username, config.username) &&
    safeEqual(credentials.password, config.password)
  );
}

function setJwtSessionCookie(reply, config) {
  const now = Math.floor(Date.now() / 1000);
  const token = createJwt(
    {
      sub: config.username,
      iat: now,
      exp: now + config.sessionMaxAgeSeconds,
    },
    config.secret
  );

  reply.setCookie(config.cookieName, token, getJwtSessionCookieOptions(config));
}

function clearJwtSessionCookie(reply, config) {
  reply.clearCookie(config.cookieName, {
    path: bullBoardPath,
  });
}

function getJwtSession(request, config) {
  const token = request.cookies?.[config.cookieName];
  if (!token) {
    return null;
  }

  const payload = verifyJwt(token, config.secret);
  if (!payload || payload.sub !== config.username) {
    return null;
  }

  return payload;
}

function getJwtSessionCookieOptions(config) {
  return {
    path: bullBoardPath,
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    maxAge: config.sessionMaxAgeSeconds,
  };
}

function createJwt(payload, secret) {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signJwtInput(signingInput, secret);

  return `${signingInput}.${signature}`;
}

function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = signJwtInput(signingInput, secret);
  if (!safeEqual(signature, expectedSignature)) {
    return null;
  }

  try {
    const header = JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString("utf8")
    );
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );

    if (header.alg !== "HS256" || header.typ !== "JWT") {
      return null;
    }

    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch (_err) {
    return null;
  }
}

function base64UrlEncodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwtInput(signingInput, secret) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function renderJwtLoginPage(config, options = {}) {
  const username = escapeHtml(options.username || "");
  const errorMarkup = options.error
    ? '<p class="error" role="alert">用户名或密码错误</p>'
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Export Queue Admin</title>
  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f4f6f8;
      color: #1f2933;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(100% - 32px, 360px);
      padding: 28px;
      background: #ffffff;
      border: 1px solid #d8dee4;
      border-radius: 8px;
      box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
    }

    h1 {
      margin: 0 0 24px;
      font-size: 22px;
      font-weight: 700;
      line-height: 1.2;
    }

    label {
      display: block;
      margin: 14px 0 6px;
      font-size: 14px;
      font-weight: 600;
    }

    input {
      width: 100%;
      height: 42px;
      padding: 0 12px;
      border: 1px solid #b8c1cc;
      border-radius: 6px;
      font: inherit;
      background: #ffffff;
    }

    input:focus {
      outline: 2px solid #2563eb;
      outline-offset: 2px;
      border-color: #2563eb;
    }

    button {
      width: 100%;
      height: 42px;
      margin-top: 22px;
      border: 0;
      border-radius: 6px;
      background: #2563eb;
      color: #ffffff;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    button:focus {
      outline: 2px solid #1e40af;
      outline-offset: 2px;
    }

    .error {
      margin: 0 0 14px;
      padding: 10px 12px;
      border-radius: 6px;
      background: #fff1f2;
      color: #be123c;
      font-size: 14px;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <main>
    <h1>Export Queue Admin</h1>
    ${errorMarkup}
    <form method="post" action="${escapeHtml(config.loginPath)}">
      <label for="username">用户名</label>
      <input id="username" name="username" autocomplete="username" value="${username}" required autofocus>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">登录</button>
    </form>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return entities[char];
  });
}

function isOidcUserAllowed(userinfo, config) {
  if (config.allowAllUsers) {
    return true;
  }

  const email = getClaim(userinfo, config.emailClaim);
  if (!email) {
    return false;
  }

  if (config.requireEmailVerified && userinfo.email_verified !== true) {
    return false;
  }

  const normalizedEmail = email.toLowerCase();
  const domain = normalizedEmail.split("@")[1];

  return (
    config.allowedEmails.includes(normalizedEmail) ||
    (domain && config.allowedDomains.includes(domain))
  );
}

function getClaim(userinfo, claimName) {
  const value = userinfo?.[claimName];

  return typeof value === "string" && value ? value : undefined;
}

function normalizePath(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.replace(/\/+$/, "") || "/";
}

function normalizeBullBoardPath(path) {
  const normalizedPath = normalizePath(path);
  if (normalizedPath === "/") {
    throw new Error("BULL_BOARD_PATH must not be '/'. Use a sub-path such as /admin/queues.");
  }

  return normalizedPath;
}

function parseList(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getRedisConnectionOptions() {
  const redisUrl = process.env.BULL_BOARD_REDIS_URL || process.env.REDIS_URL;
  if (!redisUrl) {
    return {
      host: process.env.REDIS_HOST || "127.0.0.1",
      port: Number(process.env.REDIS_PORT || 6379),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      db:
        process.env.REDIS_DB === undefined
          ? undefined
          : Number(process.env.REDIS_DB),
      lazyConnect: true,
    };
  }

  const parsed = new URL(redisUrl);
  const db = parsed.pathname.slice(1);
  const connection = {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    username: parsed.username
      ? decodeURIComponent(parsed.username)
      : undefined,
    password: parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined,
    db: db ? Number(db) : undefined,
    lazyConnect: true,
  };

  if (parsed.protocol === "rediss:") {
    connection.tls = {};
  }

  return connection;
}

function isBullBoardRequest(request) {
  const pathname = getRequestPathname(request);
  return pathname === bullBoardPath || pathname.startsWith(`${bullBoardPath}/`);
}

function getRequestPathname(request) {
  return new URL(request.url, "http://localhost").pathname;
}

function getFeishuWebhookUrl(link) {
  if (typeof link !== "string" || !link) {
    return null;
  }

  let parsedUrl;
  const normalizedLink = /^https?:\/\//i.test(link) ? link : `https://${link}`;

  try {
    parsedUrl = new URL(normalizedLink);
  } catch (_err) {
    return null;
  }

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    !feishuWebhookAllowedHosts.includes(parsedUrl.hostname.toLowerCase())
  ) {
    return null;
  }

  return parsedUrl.toString();
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

// Run the server!
const start = async () => {
  try {
    await fastify.listen({ port: Number(process.env.PORT || 8001) });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
