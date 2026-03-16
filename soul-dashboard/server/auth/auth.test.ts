/**
 * Google OAuth 인증 모듈 단위 테스트
 *
 * 인증 활성(GOOGLE_CLIENT_ID 설정) / 비활성 양쪽 시나리오를 검증한다.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import express, { type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { createServer, type Server } from "http";
import { generateToken, verifyToken } from "./jwt.js";
import { isAuthEnabled, requireAuth } from "./middleware.js";
import { createAuthRouter, AUTH_COOKIE_NAME } from "./routes.js";

// ── 테스트 헬퍼 ──

function createTestApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/auth", createAuthRouter());

  // 보호된 엔드포인트 (requireAuth 테스트용)
  app.get("/api/protected", requireAuth, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return app;
}

function startServer(app: ReturnType<typeof express>): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://localhost:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ── JWT 유틸 테스트 ──

describe("jwt.ts", () => {
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-key-for-unit-tests";
  });

  afterEach(() => {
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
  });

  it("generateToken → verifyToken 라운드트립이 성공한다", () => {
    const payload = { email: "test@example.com", name: "Test User" };
    const token = generateToken(payload);

    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const decoded = verifyToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded?.email).toBe(payload.email);
    expect(decoded?.name).toBe(payload.name);
  });

  it("verifyToken — 잘못된 토큰이면 null 반환", () => {
    const result = verifyToken("invalid.token.here");
    expect(result).toBeNull();
  });

  it("verifyToken — 빈 문자열이면 null 반환", () => {
    const result = verifyToken("");
    expect(result).toBeNull();
  });

  it("verifyToken — 다른 secret으로 서명된 토큰이면 null 반환", () => {
    // secret-A로 토큰 생성
    process.env.JWT_SECRET = "secret-a";
    const tokenFromA = generateToken({ email: "x@x.com", name: "X" });

    // secret-B로 검증 — 실패해야 함
    process.env.JWT_SECRET = "secret-b";
    const result = verifyToken(tokenFromA);
    expect(result).toBeNull();
  });

  it("JWT_SECRET 미설정 시 generateToken이 에러를 낸다", () => {
    delete process.env.JWT_SECRET;
    expect(() => generateToken({ email: "a@a.com", name: "A" })).toThrow(
      "JWT_SECRET environment variable is not set"
    );
  });
});

// ── AUTH_COOKIE_NAME 상수 테스트 ──

describe("AUTH_COOKIE_NAME", () => {
  it("routes.ts에서 export되고 'soul_dashboard_auth' 값을 가진다", () => {
    expect(AUTH_COOKIE_NAME).toBe("soul_dashboard_auth");
  });
});

// ── 인증 비활성 시나리오 (GOOGLE_CLIENT_ID 미설정) ──

describe("Auth disabled (GOOGLE_CLIENT_ID 미설정)", () => {
  let server: Server;
  let baseUrl: string;
  const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

  beforeAll(async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.JWT_SECRET = "test-secret";

    const app = createTestApp();
    ({ server, baseUrl } = await startServer(app));
  });

  afterAll(async () => {
    await stopServer(server);
    if (ORIGINAL_CLIENT_ID === undefined) {
      delete process.env.GOOGLE_CLIENT_ID;
    } else {
      process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
    }
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
  });

  it("isAuthEnabled() === false", () => {
    expect(isAuthEnabled()).toBe(false);
  });

  it("GET /api/auth/config → authEnabled: false", async () => {
    const res = await fetch(`${baseUrl}/api/auth/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authEnabled).toBe(false);
    expect(typeof body.devModeEnabled).toBe("boolean");
  });

  it("GET /api/protected — 인증 없이 접근 가능 (requireAuth 바이패스)", async () => {
    const res = await fetch(`${baseUrl}/api/protected`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("GET /api/auth/status → authenticated: false (토큰 없음)", async () => {
    const res = await fetch(`${baseUrl}/api/auth/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });

  it("GET /api/auth/google → 503 (OAuth 미설정)", async () => {
    const res = await fetch(`${baseUrl}/api/auth/google`, {
      redirect: "manual",
    });
    expect(res.status).toBe(503);
  });

  it("POST /api/auth/dev-login — devModeEnabled 시 JWT 발급", async () => {
    // NODE_ENV가 'production'이 아니면 dev-login 활성
    const isDevMode = process.env.NODE_ENV !== "production";
    const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com", name: "Dev User" }),
    });

    if (isDevMode) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.user.email).toBe("dev@example.com");

      // 쿠키에 JWT가 설정되어야 함
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain(AUTH_COOKIE_NAME);
    } else {
      expect(res.status).toBe(403);
    }
  });

  it("POST /api/auth/logout → 쿠키 삭제", async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

// ── 인증 활성 시나리오 (GOOGLE_CLIENT_ID 설정) ──

describe("Auth enabled (GOOGLE_CLIENT_ID 설정)", () => {
  let server: Server;
  let baseUrl: string;
  const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = "mock-client-id";
    process.env.JWT_SECRET = "test-secret-enabled";

    const app = createTestApp();
    ({ server, baseUrl } = await startServer(app));
  });

  afterAll(async () => {
    await stopServer(server);
    if (ORIGINAL_CLIENT_ID === undefined) {
      delete process.env.GOOGLE_CLIENT_ID;
    } else {
      process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
    }
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
  });

  it("isAuthEnabled() === true", () => {
    expect(isAuthEnabled()).toBe(true);
  });

  it("GET /api/auth/config → authEnabled: true", async () => {
    const res = await fetch(`${baseUrl}/api/auth/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authEnabled).toBe(true);
  });

  it("GET /api/protected — 토큰 없으면 401", async () => {
    const res = await fetch(`${baseUrl}/api/protected`);
    expect(res.status).toBe(401);
  });

  it("GET /api/protected — 유효한 JWT 쿠키가 있으면 200", async () => {
    const token = generateToken({ email: "user@example.com", name: "User" });

    const res = await fetch(`${baseUrl}/api/protected`, {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("GET /api/protected — 유효한 Bearer 헤더가 있으면 200", async () => {
    const token = generateToken({ email: "user@example.com", name: "User" });

    const res = await fetch(`${baseUrl}/api/protected`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("GET /api/protected — 잘못된 토큰이면 401", async () => {
    const res = await fetch(`${baseUrl}/api/protected`, {
      headers: { Authorization: "Bearer invalid.jwt.token" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/status — 유효한 토큰이면 authenticated: true", async () => {
    const token = generateToken({ email: "user@example.com", name: "User" });

    const res = await fetch(`${baseUrl}/api/auth/status`, {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.email).toBe("user@example.com");
  });

  it("GET /api/auth/status — 토큰 없으면 authenticated: false", async () => {
    const res = await fetch(`${baseUrl}/api/auth/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
  });

  it("POST /api/auth/logout → 쿠키 삭제 응답", async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(AUTH_COOKIE_NAME);
  });
});

// ── devModeEnabled 로직 테스트 ──

describe("devModeEnabled 로직", () => {
  let server: Server;
  let baseUrl: string;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
  const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

  afterAll(async () => {
    await stopServer(server);
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    if (ORIGINAL_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  });

  beforeAll(async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.JWT_SECRET = "test-secret-devmode";
    process.env.NODE_ENV = "test"; // 'production'이 아닌 환경

    const app = createTestApp();
    ({ server, baseUrl } = await startServer(app));
  });

  it("NODE_ENV !== 'production'이면 devModeEnabled: true", async () => {
    const res = await fetch(`${baseUrl}/api/auth/config`);
    const body = await res.json();
    expect(body.devModeEnabled).toBe(true);
  });

  it("devModeEnabled 환경에서 dev-login이 동작한다", async () => {
    const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@test.com" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("이메일 없이 dev-login 요청하면 400", async () => {
    const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "No Email" }),
    });
    expect(res.status).toBe(400);
  });

  it("잘못된 이메일 형식으로 dev-login 요청하면 400", async () => {
    const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Production 환경 보안 게이트 테스트 ──

describe("Production 환경 보안 게이트", () => {
  let server: Server;
  let baseUrl: string;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
  const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

  beforeAll(async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    process.env.JWT_SECRET = "test-secret-production";
    process.env.NODE_ENV = "production"; // production 환경 시뮬레이션

    const app = createTestApp();
    ({ server, baseUrl } = await startServer(app));
  });

  afterAll(async () => {
    await stopServer(server);
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    if (ORIGINAL_CLIENT_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  });

  it("NODE_ENV=production이면 devModeEnabled: false", async () => {
    const res = await fetch(`${baseUrl}/api/auth/config`);
    const body = await res.json();
    expect(body.devModeEnabled).toBe(false);
  });

  it("NODE_ENV=production이면 dev-login이 403을 반환한다", async () => {
    const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "hacker@example.com", name: "Hacker" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("non-production");
  });
});
