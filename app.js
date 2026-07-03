require("dotenv").config({ quiet: true });

const axios = require("axios");
const { timingSafeEqual } = require("crypto");
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
const notifyToken = process.env.FEISHU_NOTIFY_TOKEN || process.env.NOTIFY_TOKEN;
const feishuWebhookAllowedHosts = parseList(
  process.env.FEISHU_WEBHOOK_ALLOWED_HOSTS ||
    "open.feishu.cn,open.larksuite.com"
).map((host) => host.toLowerCase());

if (notifyToken && notifyToken.length < 16) {
  throw new Error("FEISHU_NOTIFY_TOKEN must be at least 16 characters.");
}

const oidcConfig = getOidcConfig();
const bullBoardAuthMode = getBullBoardAuthMode(oidcConfig);

if (bullBoardAuthMode === "oidc") {
  setupOidcAuth(oidcConfig);
}
setupBullBoard();

// Declare a route
fastify.post("/notify/feishu", async (request, reply) => {
  if (!isAuthorizedNotifyRequest(request)) {
    return reply.code(401).send("Authentication required.");
  }

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

    if (!bullBoardUsername || !bullBoardPassword) {
      return reply.code(503).send("Bull Board auth is not configured.");
    }

    const credentials = parseBasicAuth(request.headers.authorization);
    const isAuthorized =
      credentials &&
      safeEqual(credentials.username, bullBoardUsername) &&
      safeEqual(credentials.password, bullBoardPassword);

    if (!isAuthorized) {
      return reply
        .header("WWW-Authenticate", 'Basic realm="Bull Board"')
        .code(401)
        .send("Authentication required.");
    }
  });

  fastify.register(serverAdapter.registerPlugin(), { prefix: bullBoardPath });
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

function getOidcConfig() {
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

  if (hasAnyConfig && !hasRequiredConfig) {
    throw new Error(
      "OIDC is partially configured. Set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_SESSION_SECRET."
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
      86400
    ),
    cookieSecure: parseCookieSecure(process.env.OIDC_COOKIE_SECURE),
    cookieSameSite: process.env.OIDC_COOKIE_SAME_SITE || "lax",
  };
}

function getBullBoardAuthMode(config) {
  const authMode = (process.env.BULL_BOARD_AUTH || "").toLowerCase();
  const resolvedMode = authMode || (config.enabled ? "oidc" : "basic");

  if (!["basic", "oidc"].includes(resolvedMode)) {
    throw new Error("BULL_BOARD_AUTH must be either basic or oidc.");
  }

  if (resolvedMode === "oidc" && !config.enabled) {
    throw new Error(
      "BULL_BOARD_AUTH=oidc requires OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_SESSION_SECRET."
    );
  }

  return resolvedMode;
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

function isOidcAuthRoute(request, config) {
  const pathname = getRequestPathname(request);
  return [config.loginPath, config.callbackPath, config.logoutPath].includes(
    pathname
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

function isAuthorizedNotifyRequest(request) {
  if (!notifyToken) {
    return false;
  }

  const authorization = request.headers.authorization || "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  const requestToken =
    request.headers["x-notify-token"] || request.query.token || bearerToken;

  return (
    typeof requestToken === "string" && safeEqual(requestToken, notifyToken)
  );
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

function parseBasicAuth(authorization) {
  if (!authorization) {
    return null;
  }

  const [scheme, encoded] = authorization.split(" ");
  if (scheme !== "Basic" || !encoded) {
    return null;
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    return null;
  }

  return {
    username: decoded.slice(0, separatorIndex),
    password: decoded.slice(separatorIndex + 1),
  };
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
