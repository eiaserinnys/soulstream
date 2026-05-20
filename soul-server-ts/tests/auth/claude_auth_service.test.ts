import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import {
  ANTHROPIC_PROFILE_URL,
  ANTHROPIC_USAGE_URL,
  ClaudeAuthService,
  FileClaudeAuthTokenStore,
  type ClaudeAuthHttpGet,
} from "../../src/auth/claude_auth.js";
import { CLAUDE_OAUTH_TOKEN_ENV } from "../../src/engine/claude_options.js";

const silentLogger = pino({ level: "silent" });
const VALID_TOKEN = "sk-ant-oat01-valid_token";

async function withTempStore<T>(fn: (tokenPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "soul-ts-claude-auth-"));
  try {
    return await fn(join(dir, "claude-auth.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeService(
  tokenPath: string | undefined,
  httpGet?: ClaudeAuthHttpGet,
): ClaudeAuthService {
  return new ClaudeAuthService(
    {
      store: new FileClaudeAuthTokenStore(tokenPath),
      httpGet,
    },
    silentLogger,
  );
}

describe("ClaudeAuthService token storage", () => {
  it("storage path가 없으면 status는 secret 없이 missing-config error를 싣는다", () => {
    const svc = makeService(undefined);

    expect(svc.status("r1", "claude_auth_status")).toEqual({
      type: "claude_auth_status",
      requestId: "r1",
      has_token: false,
      configured: false,
      error: "CLAUDE_AUTH_TOKEN_PATH is not configured",
    });
  });

  it("set/status/delete는 temp config 파일만 사용하고 secret을 status에 노출하지 않는다", async () => {
    await withTempStore(async (tokenPath) => {
      const svc = makeService(tokenPath);

      const result = svc.setToken(
        {
          type: "claude_auth_set_token",
          token: `  ${VALID_TOKEN}  `,
          refresh_token: "refresh-secret",
          expires_in: 60,
          scope: "user:profile user:inference",
        },
        "r2",
        "claude_auth_set_token",
      );

      expect(result).toEqual({
        response: {
          type: "claude_auth_set_token",
          requestId: "r2",
          success: true,
        },
      });

      const status = svc.status("r3", "claude_auth_status");
      expect(status).toMatchObject({
        type: "claude_auth_status",
        requestId: "r3",
        has_token: true,
        configured: true,
        has_refresh_token: true,
        scopes: ["user:profile", "user:inference"],
      });
      expect(JSON.stringify(status)).not.toContain(VALID_TOKEN);
      expect(JSON.stringify(status)).not.toContain("refresh-secret");

      const raw = await readFile(tokenPath, "utf-8");
      expect(raw).toContain(VALID_TOKEN);
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);

      expect(svc.deleteToken("r4", "claude_auth_delete_token")).toEqual({
        type: "claude_auth_delete_token",
        requestId: "r4",
        success: true,
      });
      expect(svc.deleteToken("r5", "claude_auth_delete_token")).toEqual({
        type: "claude_auth_delete_token",
        requestId: "r5",
        success: true,
      });
    });
  });

  it.each([
    ["", "token is required"],
    ["   ", "token is required"],
    ["not-an-oauth-token", "invalid token format"],
  ])("token %j 설정은 결정된 error이고 파일을 만들지 않는다", async (token, error) => {
    await withTempStore(async (tokenPath) => {
      const svc = makeService(tokenPath);

      expect(
        svc.setToken(
          { type: "claude_auth_set_token", token },
          "r-bad",
          "claude_auth_set_token",
        ),
      ).toEqual({ error });

      expect(svc.status("r-status", "claude_auth_status")).toMatchObject({
        has_token: false,
        configured: true,
      });
    });
  });

  it("buildProcessEnv는 상속된 Python env token을 제거하고 TS store token만 주입한다", async () => {
    await withTempStore(async (tokenPath) => {
      const svc = makeService(tokenPath);
      const inherited = {
        KEEP_ME: "1",
        [CLAUDE_OAUTH_TOKEN_ENV]: "sk-ant-oat01-python_env_token",
      };

      expect(svc.buildProcessEnv(inherited)).toEqual({ KEEP_ME: "1" });

      svc.setToken(
        { type: "claude_auth_set_token", token: VALID_TOKEN },
        "r-set",
        "claude_auth_set_token",
      );

      expect(svc.buildProcessEnv(inherited)).toEqual({
        KEEP_ME: "1",
        [CLAUDE_OAUTH_TOKEN_ENV]: VALID_TOKEN,
      });
    });
  });
});

describe("ClaudeAuthService profile/usage API", () => {
  it("usage/profile은 토큰이 없으면 no token 실패 응답", async () => {
    await withTempStore(async (tokenPath) => {
      const svc = makeService(tokenPath);

      await expect(svc.fetchUsage("u1", "claude_auth_get_usage")).resolves.toEqual({
        type: "claude_auth_get_usage",
        requestId: "u1",
        success: false,
        error: "no token",
      });
      await expect(svc.fetchProfile("p1", "claude_auth_get_profile")).resolves.toEqual({
        type: "claude_auth_get_profile",
        requestId: "p1",
        success: false,
        error: "no token",
      });
    });
  });

  it("profile/usage HTTP 호출은 mock으로만 수행하고 Anthropic OAuth header를 붙인다", async () => {
    await withTempStore(async (tokenPath) => {
      const httpGet = vi.fn<ClaudeAuthHttpGet>(async (url) => ({
        status: 200,
        text: async () => "",
        json: async () =>
          url === ANTHROPIC_PROFILE_URL
            ? { account: { email: "agent@example.com" } }
            : { five_hour: null },
      }));
      const svc = makeService(tokenPath, httpGet);
      svc.setToken(
        { type: "claude_auth_set_token", token: VALID_TOKEN },
        "r-set",
        "claude_auth_set_token",
      );

      await expect(svc.fetchUsage("u2", "claude_auth_get_usage")).resolves.toEqual({
        type: "claude_auth_get_usage",
        requestId: "u2",
        success: true,
        data: { five_hour: null },
      });
      await expect(svc.fetchProfile("p2", "claude_auth_get_profile")).resolves.toEqual({
        type: "claude_auth_get_profile",
        requestId: "p2",
        success: true,
        data: { account: { email: "agent@example.com" } },
      });

      expect(httpGet).toHaveBeenNthCalledWith(1, ANTHROPIC_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
      expect(httpGet).toHaveBeenNthCalledWith(2, ANTHROPIC_PROFILE_URL, {
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
    });
  });

  it("unauthorized profile response는 success=false error 본문으로 고정한다", async () => {
    await withTempStore(async (tokenPath) => {
      const svc = makeService(tokenPath, async () => ({
        status: 401,
        text: async () => "unauthorized",
        json: async () => ({}),
      }));
      svc.setToken(
        { type: "claude_auth_set_token", token: VALID_TOKEN },
        "r-set",
        "claude_auth_set_token",
      );

      await expect(svc.fetchProfile("p401", "claude_auth_get_profile")).resolves.toEqual({
        type: "claude_auth_get_profile",
        requestId: "p401",
        success: false,
        error: "unauthorized",
      });
    });
  });

  it("network/profile API failure도 success=false로 반환한다", async () => {
    await withTempStore(async (tokenPath) => {
      const svc = makeService(tokenPath, async () => {
        throw new Error("network down");
      });
      svc.setToken(
        { type: "claude_auth_set_token", token: VALID_TOKEN },
        "r-set",
        "claude_auth_set_token",
      );

      await expect(svc.fetchProfile("p-net", "claude_auth_get_profile")).resolves.toEqual({
        type: "claude_auth_get_profile",
        requestId: "p-net",
        success: false,
        error: "network down",
      });
    });
  });

  it("set_token은 Python WS 정본처럼 profile fetch를 하지 않아 rollback 대상이 없다", async () => {
    await withTempStore(async (tokenPath) => {
      const httpGet = vi.fn<ClaudeAuthHttpGet>();
      const svc = makeService(tokenPath, httpGet);

      expect(
        svc.setToken(
          { type: "claude_auth_set_token", token: VALID_TOKEN },
          "r-set",
          "claude_auth_set_token",
        ),
      ).toMatchObject({ response: { success: true } });
      expect(httpGet).not.toHaveBeenCalled();
      expect(svc.status("r-status", "claude_auth_status")).toMatchObject({
        has_token: true,
      });
    });
  });
});
