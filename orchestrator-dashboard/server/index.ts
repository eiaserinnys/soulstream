/**
 * Orchestrator Dashboard Server — Google OAuth + Static + /api 프록시.
 *
 * 환경변수:
 *   ORCH_PORT                   서버 포트 (기본 3200)
 *   ORCH_GOOGLE_CLIENT_ID       Google OAuth 클라이언트 ID
 *   ORCH_GOOGLE_CLIENT_SECRET   Google OAuth 클라이언트 시크릿
 *   ORCH_GOOGLE_CALLBACK_URL    OAuth 콜백 URL
 *   ORCH_SESSION_SECRET         세션 시크릿
 *   ORCH_ALLOWED_EMAIL          허용 이메일
 *   SOUL_STREAM_URL             soul-stream 서버 URL (기본 http://localhost:5200)
 *   ORCH_DIST_DIR               빌드 결과물 경로 (기본 ./dist)
 */

import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import express from "express";
import session from "express-session";
import passport from "passport";
import { createProxyMiddleware } from "http-proxy-middleware";
import { configurePassport, ensureAuthenticated } from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 필수 환경변수 검증
const ORCH_GOOGLE_CLIENT_ID = process.env.ORCH_GOOGLE_CLIENT_ID;
const ORCH_GOOGLE_CLIENT_SECRET = process.env.ORCH_GOOGLE_CLIENT_SECRET;
const ORCH_GOOGLE_CALLBACK_URL = process.env.ORCH_GOOGLE_CALLBACK_URL;
const ORCH_SESSION_SECRET = process.env.ORCH_SESSION_SECRET;
const ORCH_ALLOWED_EMAIL = process.env.ORCH_ALLOWED_EMAIL;

if (!ORCH_GOOGLE_CLIENT_ID) throw new Error("ORCH_GOOGLE_CLIENT_ID is required");
if (!ORCH_GOOGLE_CLIENT_SECRET) throw new Error("ORCH_GOOGLE_CLIENT_SECRET is required");
if (!ORCH_GOOGLE_CALLBACK_URL) throw new Error("ORCH_GOOGLE_CALLBACK_URL is required");
if (!ORCH_SESSION_SECRET) throw new Error("ORCH_SESSION_SECRET is required");
if (!ORCH_ALLOWED_EMAIL) throw new Error("ORCH_ALLOWED_EMAIL is required");

const PORT = parseInt(process.env.ORCH_PORT ?? "3200", 10);
const SOUL_STREAM_URL = process.env.SOUL_STREAM_URL ?? "http://localhost:5200";
const DIST_DIR = process.env.ORCH_DIST_DIR ?? resolve(__dirname, "../dist");

const app = express();

// ── 세션 & Passport ────────────────────────────────────────────────────────

app.use(
  session({
    secret: ORCH_SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7일
  }),
);

app.use(passport.initialize());
app.use(passport.session());

configurePassport({
  clientId: ORCH_GOOGLE_CLIENT_ID,
  clientSecret: ORCH_GOOGLE_CLIENT_SECRET,
  callbackUrl: ORCH_GOOGLE_CALLBACK_URL,
  allowedEmail: ORCH_ALLOWED_EMAIL,
  sessionSecret: ORCH_SESSION_SECRET,
});

// ── OAuth 라우트 (인증 불필요) ────────────────────────────────────────────

app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/login?error=denied" }),
  (_req, res) => {
    res.redirect("/");
  },
);

app.get("/logout", (req, res) => {
  req.logout(() => {
    res.redirect("/login");
  });
});

// ── /login 페이지 (인증 불필요) ───────────────────────────────────────────

app.get("/login", (req, res) => {
  if (req.isAuthenticated()) {
    res.redirect("/");
    return;
  }
  const error = req.query.error;
  res.send(`
    <!DOCTYPE html>
    <html lang="ko" class="dark">
    <head>
      <meta charset="UTF-8" />
      <title>Orchestrator Login</title>
      <style>
        body { background: #0a0a0a; color: #e5e5e5; font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; text-align: center; max-width: 360px; }
        h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
        p { color: #888; font-size: 0.875rem; margin-bottom: 1.5rem; }
        a.btn { display: inline-block; background: #fff; color: #111; padding: 0.6rem 1.5rem; border-radius: 8px; text-decoration: none; font-size: 0.875rem; font-weight: 600; }
        .err { color: #f87171; font-size: 0.75rem; margin-bottom: 1rem; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Soulstream Orchestrator</h1>
        <p>접근 권한이 있는 Google 계정으로 로그인하세요.</p>
        ${error ? `<div class="err">접근 거부됨 (허용된 이메일이 아닙니다)</div>` : ""}
        <a class="btn" href="/auth/google">Google로 로그인</a>
      </div>
    </body>
    </html>
  `);
});

// ── /api 프록시 (인증 필요) ───────────────────────────────────────────────

app.use(
  "/api",
  ensureAuthenticated,
  createProxyMiddleware({
    target: SOUL_STREAM_URL,
    changeOrigin: true,
  }),
);

// ── 정적 파일 서빙 (인증 필요) ────────────────────────────────────────────

app.use(ensureAuthenticated, express.static(DIST_DIR));

// SPA 폴백 (인증 필요)
app.get("*", ensureAuthenticated, (_req, res) => {
  if (existsSync(DIST_DIR)) {
    res.sendFile("index.html", { root: DIST_DIR });
  } else {
    res.status(503).send("Dashboard not built yet. Run: pnpm build");
  }
});

// ── 시작 ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Orchestrator Dashboard server listening on http://localhost:${PORT}`);
  console.log(`  → soul-stream proxy: ${SOUL_STREAM_URL}`);
  console.log(`  → dist dir: ${DIST_DIR}`);
});
