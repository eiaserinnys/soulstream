/**
 * Soul Dashboard Server - 엔트리포인트
 *
 * Soul Server의 API를 프록시하는 BFF(Backend For Frontend) 서버.
 * 파일 직접 읽기 없이 Soul Server API만 호출합니다.
 * Phase 5: 세션 이벤트를 로컬 캐시하여 서버 재시작 시에도 빠르게 제공합니다.
 *
 * 포트: 3109 (supervisor 포트 체계: 3101-3108 다음)
 * Soul: http://localhost:3105
 */

import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import { createSessionsProxyRouter } from "./routes/sessions-proxy.js";
import { createEventsCachedRouter } from "./routes/events-cached.js";
import { createActionsRouter } from "./routes/actions.js";
import { createLlmProxyRouter } from "./routes/llm-proxy.js";
import { SessionCache } from "./session-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Configuration ===

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3109", 10);
const SOUL_BASE_URL =
  process.env.SOUL_BASE_URL ?? "http://localhost:3105";
const AUTH_TOKEN = process.env.CLAUDE_SERVICE_TOKEN ?? "";
const DASHBOARD_AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN ?? "";
const SERENDIPITY_URL = process.env.SERENDIPITY_URL ?? "";
const ALLOWED_ORIGINS =
  process.env.DASHBOARD_ALLOWED_ORIGINS?.split(",") ?? [
    `http://localhost:${PORT}`,
    "http://localhost:5173", // Vite dev server
  ];

// 세션 이벤트 캐시 디렉토리
const CACHE_DIR =
  process.env.DASHBOARD_CACHE_DIR ??
  path.resolve(__dirname, "../.local/sessions");
const sessionCache = new SessionCache({ cacheDir: CACHE_DIR });
const BYPASS_CACHE = process.env.DASHBOARD_BYPASS_CACHE === "true";

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
    version: "0.5.0", // Phase 5: Cached events
  });
});

// Config (클라이언트에 설정 전달)
app.get("/api/config", (_req, res) => {
  res.json({
    authRequired: !!DASHBOARD_AUTH_TOKEN,
    serendipityAvailable: !!SERENDIPITY_URL,
  });
});

// === Auth Middleware (POST 엔드포인트 보호) ===
// DASHBOARD_AUTH_TOKEN이 설정된 경우에만 인증을 요구합니다.
// GET 요청(세션 조회, SSE 구독)은 인증 없이 허용됩니다.

if (DASHBOARD_AUTH_TOKEN) {
  const requireAuth: express.RequestHandler = (req, res, next) => {
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
  };

  app.use("/api/sessions", (req, res, next) => {
    // GET 요청은 인증 불필요 (세션 조회, SSE 구독)
    if (req.method === "GET") {
      next();
      return;
    }
    requireAuth(req, res, next);
  });

  // LLM proxy — 모든 요청에 인증 필수
  app.use("/api/llm", requireAuth);

  console.log("[dashboard] Auth enabled for POST endpoints");
}

// Routes - 프록시 라우터 사용
app.use(
  "/api/sessions",
  createSessionsProxyRouter({
    soulBaseUrl: SOUL_BASE_URL,
    authToken: AUTH_TOKEN,
  }),
);

// Events 캐시 라우터 (/:id/events 엔드포인트)
// 캐시 + 라이브 통합: 캐시된 이벤트 먼저 전송 후 Soul 서버에서 새 이벤트 수신
app.use(
  "/api/sessions",
  createEventsCachedRouter({
    soulBaseUrl: SOUL_BASE_URL,
    sessionCache,
    authToken: AUTH_TOKEN,
    bypassCache: BYPASS_CACHE,
  }),
);

// Actions 라우터 (POST /sessions, POST /sessions/:id/intervene)
// 이 라우터는 여전히 Soul Server에 직접 요청합니다 (SSE 응답 처리)
app.use(
  "/api/sessions",
  createActionsRouter({
    soulBaseUrl: SOUL_BASE_URL,
    authToken: AUTH_TOKEN,
  }),
);

// LLM Proxy 라우터 (POST /api/llm/completions → Soul Server /llm/completions)
app.use(
  "/api/llm",
  createLlmProxyRouter({
    soulBaseUrl: SOUL_BASE_URL,
    authToken: AUTH_TOKEN,
  }),
);

// Dashboard config/portrait 프록시 (Soul Server → 클라이언트)
app.get("/api/dashboard/config", async (_req, res) => {
  try {
    const headers: Record<string, string> = {};
    if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
    const upstream = await fetch(`${SOUL_BASE_URL}/api/dashboard/config`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: { message: `Upstream ${upstream.status}` } });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error("[dashboard] Failed to proxy /api/dashboard/config:", err);
    res.status(502).json({ error: { message: "Failed to reach soul server" } });
  }
});

app.get("/api/dashboard/portrait/:role", async (req, res) => {
  try {
    const { role } = req.params;
    const headers: Record<string, string> = {};
    if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
    const upstream = await fetch(
      `${SOUL_BASE_URL}/api/dashboard/portrait/${encodeURIComponent(role)}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!upstream.ok) {
      res.status(upstream.status).end();
      return;
    }
    // Forward content-type and cache headers
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    const cc = upstream.headers.get("cache-control");
    if (cc) res.setHeader("Cache-Control", cc);
    // Stream the body
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error("[dashboard] Failed to proxy portrait:", err);
    res.status(502).end();
  }
});

// === Static File Serving ===

// dist/client/ 는 vite build 결과물이 위치하는 디렉토리.
// server/ → soul-dashboard/ → dist/client/
const clientDistDir = path.resolve(__dirname, "../dist/client");

app.use(express.static(clientDistDir));

// SPA fallback: API가 아닌 모든 GET 요청에 index.html 반환
app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(clientDistDir, "index.html"));
});

// === Start Server ===

const server = app.listen(PORT, () => {
  console.log(`[dashboard] Soul Dashboard server started on port ${PORT}`);
  console.log(`[dashboard] Soul server: ${SOUL_BASE_URL}`);
  console.log(`[dashboard] Cache dir: ${CACHE_DIR}`);
  console.log("[dashboard] Architecture: Cached events (Phase 5)");
  if (BYPASS_CACHE) {
    console.log("[dashboard] ⚠️ Cache bypass enabled (DASHBOARD_BYPASS_CACHE=true)");
  }
});

// === Graceful Shutdown ===

function shutdown() {
  console.log("[dashboard] Shutting down...");

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

export { app, server };
