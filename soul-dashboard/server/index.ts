/**
 * Soul Dashboard Server - 엔트리포인트
 *
 * Soul SSE를 구독하고 대시보드 클라이언트에 이벤트를 중계하는 서버.
 *
 * 포트: 3109 (supervisor 포트 체계: 3101-3108 다음)
 * Soul: http://localhost:3105
 */

import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { SoulClient } from "./soul-client.js";
import { SessionStore } from "./session-store.js";
import { EventHub } from "./event-hub.js";
import { createSessionsRouter } from "./routes/sessions.js";
import { createEventsRouter } from "./routes/events.js";
import { createActionsRouter } from "./routes/actions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Configuration ===

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3109", 10);
const SOUL_BASE_URL =
  process.env.SOUL_BASE_URL ?? "http://localhost:3105";
const AUTH_TOKEN = process.env.CLAUDE_SERVICE_TOKEN ?? "";
const EVENTS_BASE_DIR =
  process.env.EVENTS_BASE_DIR ??
  "D:/soyoung_root/seosoyoung_runtime/data/events";
const KEEPALIVE_INTERVAL_MS = 15_000;
const DASHBOARD_AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN ?? "";
const ALLOWED_ORIGINS =
  process.env.DASHBOARD_ALLOWED_ORIGINS?.split(",") ?? [
    `http://localhost:${PORT}`,
    "http://localhost:5173", // Vite dev server
  ];

// === Initialize Components ===

const sessionStore = new SessionStore({
  baseDir: EVENTS_BASE_DIR,
});

const eventHub = new EventHub();

const soulClient = new SoulClient({
  soulBaseUrl: SOUL_BASE_URL,
  authToken: AUTH_TOKEN,
  reconnectInterval: 3000,
  maxReconnectInterval: 30000,
});

// Soul 이벤트 → EventHub 브로드캐스트 + JSONL 저장
// Resume 세션의 경우 alias를 통해 원래 세션으로 포워딩
soulClient.onEvent((sessionKey, eventId, event) => {
  const alias = eventHub.resolveAlias(sessionKey);

  if (alias) {
    // Resume 세션: 원래 세션으로 포워딩 (eventId에 offset 적용)
    const resolvedId = eventId + alias.eventIdOffset;
    eventHub.broadcast(alias.targetKey, resolvedId, event);

    const sepIdx = alias.targetKey.indexOf(":");
    if (sepIdx !== -1) {
      const clientId = alias.targetKey.slice(0, sepIdx);
      const requestId = alias.targetKey.slice(sepIdx + 1);
      sessionStore
        .appendEvent(clientId, requestId, resolvedId, event)
        .catch((err) =>
          console.warn(`[dashboard] Failed to persist forwarded event for ${alias.targetKey}:`, err),
        );
    }

    // 완료/에러 시 alias 정리
    if (event.type === "complete" || event.type === "error" || event.type === "result") {
      eventHub.removeAlias(sessionKey);
    }
    return;
  }

  // 일반 세션: 기존 동작
  eventHub.broadcast(sessionKey, eventId, event);

  const sepIdx = sessionKey.indexOf(":");
  if (sepIdx !== -1) {
    const clientId = sessionKey.slice(0, sepIdx);
    const requestId = sessionKey.slice(sepIdx + 1);
    sessionStore
      .appendEvent(clientId, requestId, eventId, event)
      .catch((err) =>
        console.warn(`[dashboard] Failed to persist event for ${sessionKey}:`, err),
      );
  }
});

soulClient.onError((sessionKey, error) => {
  console.warn(
    `[dashboard] Soul SSE error for ${sessionKey}:`,
    error.message,
  );
});

// === Express App ===

const app = express();

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

// Health check (내부 경로 정보 노출하지 않음)
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "soul-dashboard",
    version: "0.1.0",
    connectedClients: eventHub.getTotalClientCount(),
    activeSubscriptions: soulClient.getActiveSubscriptions().length,
  });
});

// Stats (운영 모니터링용)
app.get("/api/stats", (_req, res) => {
  res.json({
    clients: eventHub.getStats(),
    totalClients: eventHub.getTotalClientCount(),
    soulSubscriptions: soulClient.getActiveSubscriptions(),
  });
});

// Config (클라이언트에 인증 설정 전달)
app.get("/api/config", (_req, res) => {
  res.json({
    authRequired: !!DASHBOARD_AUTH_TOKEN,
  });
});

// === Auth Middleware (POST 엔드포인트 보호) ===
// DASHBOARD_AUTH_TOKEN이 설정된 경우에만 인증을 요구합니다.
// GET 요청(세션 조회, SSE 구독)은 인증 없이 허용됩니다.

if (DASHBOARD_AUTH_TOKEN) {
  app.use("/api/sessions", (req, res, next) => {
    // GET 요청은 인증 불필요 (세션 조회, SSE 구독)
    if (req.method === "GET") {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${DASHBOARD_AUTH_TOKEN}`) {
      res.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Valid Bearer token required",
        },
      });
      return;
    }
    next();
  });
  console.log("[dashboard] Auth enabled for POST endpoints");
}

// Routes
app.use("/api/sessions", createSessionsRouter(sessionStore));
app.use(
  "/api/sessions",
  createEventsRouter({ sessionStore, eventHub, soulClient }),
);
app.use(
  "/api/sessions",
  createActionsRouter({
    soulBaseUrl: SOUL_BASE_URL,
    authToken: AUTH_TOKEN,
    eventHub,
    sessionStore,
    soulClient,
  }),
);

// === Static File Serving ===

// dist/client/ 는 vite build 결과물이 위치하는 디렉토리.
// server/ → soul-dashboard/ → dist/client/
const clientDistDir = path.resolve(__dirname, "../dist/client");

app.use(express.static(clientDistDir));

// SPA fallback: API가 아닌 모든 GET 요청에 index.html 반환
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(clientDistDir, "index.html"));
});

// === Keepalive Timer ===

const keepaliveTimer = setInterval(() => {
  eventHub.sendKeepalive();
}, KEEPALIVE_INTERVAL_MS);

// === Start Server ===

const server = app.listen(PORT, () => {
  console.log(`[dashboard] Soul Dashboard server started on port ${PORT}`);
  console.log(`[dashboard] Soul server: ${SOUL_BASE_URL}`);
  console.log(`[dashboard] Events directory: ${EVENTS_BASE_DIR}`);
});

// === Graceful Shutdown ===

function shutdown() {
  console.log("[dashboard] Shutting down...");

  clearInterval(keepaliveTimer);
  soulClient.close();
  eventHub.closeAll();

  server.close(() => {
    console.log("[dashboard] Server closed");
    process.exit(0);
  });

  // 5초 후 강제 종료
  setTimeout(() => {
    console.error("[dashboard] Forced shutdown after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { app, server, sessionStore, eventHub, soulClient };
