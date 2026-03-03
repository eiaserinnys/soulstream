/**
 * Soul Dashboard Server - 엔트리포인트
 *
 * Soul Server의 API를 프록시하는 BFF(Backend For Frontend) 서버.
 * 파일 직접 읽기 없이 Soul Server API만 호출합니다.
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
import { createActionsRouter } from "./routes/actions.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Configuration ===

const PORT = parseInt(process.env.DASHBOARD_PORT ?? "3109", 10);
const SOUL_BASE_URL =
  process.env.SOUL_BASE_URL ?? "http://localhost:3105";
const AUTH_TOKEN = process.env.CLAUDE_SERVICE_TOKEN ?? "";
const DASHBOARD_AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN ?? "";
const ALLOWED_ORIGINS =
  process.env.DASHBOARD_ALLOWED_ORIGINS?.split(",") ?? [
    `http://localhost:${PORT}`,
    "http://localhost:5173", // Vite dev server
  ];

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
    version: "0.3.0", // Phase 3: Proxy-based architecture
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

// Routes - 프록시 라우터 사용
app.use(
  "/api/sessions",
  createSessionsProxyRouter({
    soulBaseUrl: SOUL_BASE_URL,
    authToken: AUTH_TOKEN,
  }),
);

// Actions 라우터 (POST /sessions, POST /sessions/:id/intervene)
// 이 라우터는 여전히 Soul Server에 직접 요청합니다 (SSE 응답 처리)
app.use(
  "/api/sessions",
  createActionsRouter({
    soulBaseUrl: SOUL_BASE_URL,
    authToken: AUTH_TOKEN,
    // EventHub, SessionStore, SoulClient는 더 이상 필요하지 않음
    // 프록시 아키텍처에서는 Soul Server가 모든 이벤트를 관리
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

// === Start Server ===

const server = app.listen(PORT, () => {
  console.log(`[dashboard] Soul Dashboard server started on port ${PORT}`);
  console.log(`[dashboard] Soul server: ${SOUL_BASE_URL}`);
  console.log("[dashboard] Architecture: Proxy-based (Phase 3)");
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
