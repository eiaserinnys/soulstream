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
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import passport from "passport";
import { createSessionsProxyRouter } from "./routes/sessions-proxy.js";
import { createCatalogProxyRouter } from "./routes/catalog-proxy.js";
import { createEventsCachedRouter } from "./routes/events-cached.js";
import { createActionsRouter } from "./routes/actions.js";
import { createLlmProxyRouter } from "./routes/llm-proxy.js";
import { createCogitoRouter } from "./cogito.js";
import { SessionCache } from "./session-cache.js";
import { configurePassport } from "./auth/passport.js";
import { createAuthRouter } from "./auth/routes.js";
import { isAuthEnabled, requireAuth } from "./auth/middleware.js";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Configuration ===

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3109", 10);
const SOUL_BASE_URL =
  process.env.SOUL_BASE_URL ?? "http://localhost:3105";
const SOULSTREAM_BASE_URL =
  process.env.SOULSTREAM_BASE_URL ?? "http://localhost:4105";
const AUTH_TOKEN = process.env.CLAUDE_SERVICE_TOKEN ?? "";
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

// === 시작 시 인증 설정 검증 ===

// GOOGLE_CLIENT_ID는 있지만 CLIENT_SECRET이 없으면 즉시 에러
if (process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_CLIENT_SECRET) {
  throw new Error(
    "[dashboard] GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set"
  );
}

// Google OAuth 활성화 시에만 JWT_SECRET 필수
if (isAuthEnabled() && !process.env.JWT_SECRET) {
  throw new Error(
    "[dashboard] JWT_SECRET is required when Google OAuth is enabled"
  );
}

// === Express App ===

const app: Express = express();

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

// Passport 초기화 (Google OAuth Strategy 등록)
configurePassport();
app.use(passport.initialize());

// Health check (내부 경로 정보 노출하지 않음)
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "soul-dashboard",
    version: _pkg.version,
  });
});

// Cogito /reflect 엔드포인트 (자기 기술 프로토콜)
app.use(createCogitoRouter());

// Auth 라우트 (공개 엔드포인트 — 인증 미들웨어 적용 전에 등록)
app.use("/api/auth", createAuthRouter());

// Config (클라이언트에 설정 전달 — soul-server의 /api/config/settings와 호환)
app.get("/api/config/settings", (_req, res) => {
  res.json({
    serendipityAvailable: !!SERENDIPITY_URL,
    categories: [],
  });
});

// === 보호 대상 라우트 ===
// GOOGLE_CLIENT_ID 미설정 시 requireAuth는 next()를 즉시 호출하여 통과

app.use("/api/sessions", requireAuth);
app.use("/api/catalog", requireAuth);
app.use("/api/llm", requireAuth);
app.use("/api/nodes", requireAuth);
app.use('/api/debug', requireAuth)

app.get('/api/debug/memory', (_, res) => {
  const m = process.memoryUsage()
  const mb = (v: number) => Math.round(v / 1024 / 1024 * 10) / 10
  res.json({
    heapUsed: mb(m.heapUsed),
    heapTotal: mb(m.heapTotal),
    rss: mb(m.rss),
    external: mb(m.external),
    timestamp: new Date().toISOString()
  })
})

app.post('/api/debug/gc', (_, res) => {
  if (typeof (global as any).gc === 'function') {
    ;(global as any).gc()
    const m = process.memoryUsage()
    const mb = (v: number) => Math.round(v / 1024 / 1024 * 10) / 10
    res.json({ gc: true, heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), rss: mb(m.rss) })
  } else {
    res.status(400).json({ error: 'GC not exposed. Start Node with --expose-gc flag.' })
  }
})

// Routes - 프록시 라우터 사용
app.use(
  "/api/sessions",
  createSessionsProxyRouter({
    soulBaseUrl: SOUL_BASE_URL,
    authToken: AUTH_TOKEN,
  }),
);

// Catalog 프록시 라우터
app.use(
  "/api/catalog",
  createCatalogProxyRouter({
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

// Nodes 프록시 → soulstream-server /api/nodes (orchestrator-dashboard 전용)
app.get("/api/nodes/:nodeId/agents", async (req, res) => {
  const { nodeId } = req.params;
  try {
    const headers: Record<string, string> = {};
    if (AUTH_TOKEN) headers["Authorization"] = `Bearer ${AUTH_TOKEN}`;
    const upstream = await fetch(
      `${SOULSTREAM_BASE_URL}/api/nodes/${encodeURIComponent(nodeId)}/agents`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[dashboard] Failed to proxy /api/nodes agents:", err);
    res.status(502).json({ error: { message: "Failed to reach soulstream server" } });
  }
});

// Cogito Search 프록시 → soul-server /cogito/search
app.get("/api/cogito/search", async (req, res) => {
  const q = req.query.q as string | undefined;
  if (!q) {
    res.status(400).json({ detail: "q parameter required" });
    return;
  }
  const topK = req.query.top_k as string | undefined;
  const params = new URLSearchParams({ q, ...(topK ? { top_k: topK } : {}) });
  try {
    const response = await fetch(`${SOUL_BASE_URL}/cogito/search?${params}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch {
    res.status(502).json({ detail: "soul-server unavailable" });
  }
});

// Status 프록시 (Soul Server is_draining 상태 조회 — 인증 불필요 공개 엔드포인트)
app.get("/api/status", async (_req, res) => {
  try {
    const response = await fetch(`${SOUL_BASE_URL}/status`, {
      signal: AbortSignal.timeout(5_000),
    });
    const data = await response.json();
    res.json(data);
  } catch {
    // soul-server가 종료 중이거나 응답 없음 — draining 상태로 간주
    res.status(502).json({ is_draining: true, error: "soul-server unavailable" });
  }
});

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
  res.sendFile("index.html", { root: clientDistDir });
});

// === Start Server ===

const server = app.listen(PORT, () => {
  console.log(`[dashboard] Soul Dashboard server started on port ${PORT}`);
  console.log(`[dashboard] Soul server: ${SOUL_BASE_URL}`);
  console.log(`[dashboard] Cache dir: ${CACHE_DIR}`);
  console.log("[dashboard] Architecture: Cached events (Phase 5)");
  if (isAuthEnabled()) {
    console.log("[dashboard] Auth enabled (Google OAuth + JWT)");
  }
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
