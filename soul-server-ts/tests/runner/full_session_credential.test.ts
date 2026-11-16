/**
 * full 세션 러너 spawn 입력의 자격 증명 치환.
 *
 * 자식 env와 soulstream 계열 MCP 헤더에서 서비스 토큰 값을 세션 토큰으로
 * 바꾸고, 그 밖의 값은 건드리지 않는다. 이름이 soulstream 계열이어도 내부
 * 주소로 다시 쓰이지 않는 항목(예: sse)의 헤더는 그대로 둔다. 호스트 토큰이
 * 비면 아무것도 바꾸지 않는다(개발 환경).
 */
import { describe, expect, it } from "vitest";

import type { ResolvedMcpServer } from "../../src/mcp_config_service.js";
import {
  fullSessionCredential,
  withFullSessionCredential,
} from "../../src/runner/full_session_credential.js";
import {
  FULL_SESSION_MCP_TOKEN_PREFIX,
  verifyFullSessionMcpToken,
} from "../../src/security/restricted_mcp_auth.js";

const HOST_TOKEN = "host-service-token-0001";
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function soulstreamServers(): ResolvedMcpServer[] {
  return [
    {
      name: "soulstream",
      type: "streamable_http",
      url: "http://127.0.0.1:3105/mcp",
      headers: {
        Authorization: `Bearer ${HOST_TOKEN}`,
        "x-soulstream-agent-session-id": SESSION,
      },
    },
    {
      name: "soulstream-cogito",
      type: "streamable_http",
      url: "http://127.0.0.1:3105/mcp/cogito",
      headers: { authorization: HOST_TOKEN },
    },
    {
      name: "other-http",
      type: "streamable_http",
      url: "https://mcp.example.test/tools",
      headers: { Authorization: "fixture-secret", "x-test": "표식" },
    },
    {
      name: "local",
      type: "stdio",
      command: "node",
      args: ["probe.mjs"],
    },
  ];
}

describe("fullSessionCredential", () => {
  it("issues an ssf1 token bound to the session", () => {
    const credential = fullSessionCredential(SESSION, HOST_TOKEN);
    expect(credential).toBeDefined();
    expect(credential!.startsWith(FULL_SESSION_MCP_TOKEN_PREFIX)).toBe(true);
    expect(verifyFullSessionMcpToken(credential!, HOST_TOKEN))
      .toEqual({ ok: true, sessionId: SESSION });
    expect(credential).not.toBe(HOST_TOKEN);
  });

  it("returns undefined when the host token is missing or blank", () => {
    expect(fullSessionCredential(SESSION, undefined)).toBeUndefined();
    expect(fullSessionCredential(SESSION, "")).toBeUndefined();
    expect(fullSessionCredential(SESSION, "   ")).toBeUndefined();
  });
});

describe("withFullSessionCredential", () => {
  it("replaces the service token value in every child env key", () => {
    const base = {
      sessionId: SESSION,
      childProcessEnv: {
        PATH: "/usr/bin",
        AUTH_BEARER_TOKEN: HOST_TOKEN,
        PORTABLE_LOCAL_MCP_AUTHORIZATION: HOST_TOKEN,
        SOULSTREAM_SERVICE_AUTHORIZATION: `Bearer ${HOST_TOKEN}`,
        DATABASE_URL: "postgres://host-db",
        EMPTY_VALUE: undefined,
      },
    };

    const credential = fullSessionCredential(SESSION, HOST_TOKEN)!;
    const result = withFullSessionCredential(base, { hostBearerToken: HOST_TOKEN });
    const env = result.childProcessEnv!;

    expect(env.AUTH_BEARER_TOKEN).toBe(credential);
    expect(env.PORTABLE_LOCAL_MCP_AUTHORIZATION).toBe(credential);
    expect(env.SOULSTREAM_SERVICE_AUTHORIZATION).toBe(`Bearer ${credential}`);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DATABASE_URL).toBe("postgres://host-db");
    expect(env.EMPTY_VALUE).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(HOST_TOKEN);
  });

  it("adds AUTH_BEARER_TOKEN when the base env did not have one", () => {
    const credential = fullSessionCredential(SESSION, HOST_TOKEN)!;
    const result = withFullSessionCredential(
      { sessionId: SESSION, childProcessEnv: { PATH: "/usr/bin" } },
      { hostBearerToken: HOST_TOKEN },
    );
    expect(result.childProcessEnv).toEqual({
      PATH: "/usr/bin",
      AUTH_BEARER_TOKEN: credential,
    });
  });

  it("leaves the input env untouched", () => {
    const env = { AUTH_BEARER_TOKEN: HOST_TOKEN, PATH: "/usr/bin" };
    const base = { sessionId: SESSION, childProcessEnv: env };
    withFullSessionCredential(base, { hostBearerToken: HOST_TOKEN });
    expect(env).toEqual({ AUTH_BEARER_TOKEN: HOST_TOKEN, PATH: "/usr/bin" });
    expect(base.childProcessEnv).toBe(env);
  });

  it("returns the same input when the host token is absent", () => {
    const base = { sessionId: SESSION, childProcessEnv: { AUTH_BEARER_TOKEN: HOST_TOKEN } };
    expect(withFullSessionCredential(base, { hostBearerToken: undefined })).toBe(base);
    expect(withFullSessionCredential(base, { hostBearerToken: "  " })).toBe(base);
    expect(base.childProcessEnv.AUTH_BEARER_TOKEN).toBe(HOST_TOKEN);
  });

  it("uses buildChildProcessEnv only when the spawn input has no env", () => {
    const buildChildProcessEnv = () => ({
      AUTH_BEARER_TOKEN: HOST_TOKEN,
      PATH: "/from-builder",
    });
    const credential = fullSessionCredential(SESSION, HOST_TOKEN)!;

    const built = withFullSessionCredential(
      { sessionId: SESSION },
      { hostBearerToken: HOST_TOKEN, buildChildProcessEnv },
    );
    expect(built.childProcessEnv).toEqual({
      AUTH_BEARER_TOKEN: credential,
      PATH: "/from-builder",
    });

    const direct = withFullSessionCredential(
      { sessionId: SESSION, childProcessEnv: { PATH: "/from-input" } },
      { hostBearerToken: HOST_TOKEN, buildChildProcessEnv },
    );
    expect(direct.childProcessEnv).toEqual({
      PATH: "/from-input",
      AUTH_BEARER_TOKEN: credential,
    });
  });

  it("replaces soulstream MCP authorization headers and leaves other servers alone", () => {
    const servers = soulstreamServers();
    const credential = fullSessionCredential(SESSION, HOST_TOKEN)!;
    const result = withFullSessionCredential(
      { sessionId: SESSION, resolvedMcpServers: servers },
      { hostBearerToken: HOST_TOKEN },
    );
    const replaced = result.resolvedMcpServers!;

    const soulstream = replaced[0]!;
    expect(soulstream.type).toBe("streamable_http");
    if (soulstream.type !== "streamable_http") return;
    expect(soulstream.headers).toEqual({
      Authorization: `Bearer ${credential}`,
      "x-soulstream-agent-session-id": SESSION,
    });

    const cogito = replaced[1]!;
    expect(cogito.type).toBe("streamable_http");
    if (cogito.type !== "streamable_http") return;
    // 같은 키의 다른 표기(lowercase)를 남기지 않고 하나만 둔다.
    expect(cogito.headers).toEqual({ Authorization: `Bearer ${credential}` });

    expect(replaced[2]).toEqual(servers[2]);
    expect(replaced[3]).toEqual(servers[3]);
  });

  it("keeps soulstream-named servers whose URL is not rewritten to the internal MCP", () => {
    // sse는 Claude가 URL을 그대로 두고 Codex는 아예 보내지 않는다. 다른 곳을
    // 가리킬 수 있으므로 이름만 보고 헤더를 바꾸지 않는다.
    const servers: ResolvedMcpServer[] = [
      {
        name: "soulstream",
        type: "sse",
        url: "https://external.example.test/sse",
        headers: { Authorization: `Bearer ${HOST_TOKEN}`, "x-test": "표식" },
      },
      {
        name: "soulstream-cogito",
        type: "streamable_http",
        url: "http://127.0.0.1:3105/mcp/cogito",
        headers: { Authorization: `Bearer ${HOST_TOKEN}` },
      },
    ];
    const credential = fullSessionCredential(SESSION, HOST_TOKEN)!;
    const result = withFullSessionCredential(
      { sessionId: SESSION, resolvedMcpServers: servers },
      { hostBearerToken: HOST_TOKEN },
    );
    const replaced = result.resolvedMcpServers!;

    expect(replaced[0]).toBe(servers[0]);
    expect(replaced[1]).not.toBe(servers[1]);
    if (replaced[1]!.type !== "streamable_http") return;
    expect(replaced[1]!.headers).toEqual({ Authorization: `Bearer ${credential}` });
  });

  it("does not touch MCP servers when there are none", () => {
    const result = withFullSessionCredential(
      { sessionId: SESSION, childProcessEnv: {} },
      { hostBearerToken: HOST_TOKEN },
    );
    expect(result.resolvedMcpServers).toBeUndefined();
  });

  it("leaves the input server objects untouched", () => {
    const servers = soulstreamServers();
    const before = JSON.stringify(servers);
    withFullSessionCredential(
      { sessionId: SESSION, resolvedMcpServers: servers },
      { hostBearerToken: HOST_TOKEN },
    );
    expect(JSON.stringify(servers)).toBe(before);
    expect(servers[0]).toBeTypeOf("object");
    if (servers[0]!.type !== "streamable_http") return;
    expect(servers[0]!.headers?.Authorization).toBe(`Bearer ${HOST_TOKEN}`);
  });

  it("is idempotent and keeps each session bound to its own token", () => {
    const credential = fullSessionCredential(SESSION, HOST_TOKEN)!;
    const once = withFullSessionCredential(
      { sessionId: SESSION, childProcessEnv: { AUTH_BEARER_TOKEN: HOST_TOKEN } },
      { hostBearerToken: HOST_TOKEN },
    );
    const twice = withFullSessionCredential(once, { hostBearerToken: HOST_TOKEN });
    expect(twice.childProcessEnv?.AUTH_BEARER_TOKEN).toBe(credential);

    const other = fullSessionCredential(OTHER, HOST_TOKEN)!;
    expect(other).not.toBe(credential);
    expect(verifyFullSessionMcpToken(other, HOST_TOKEN))
      .toEqual({ ok: true, sessionId: OTHER });
    expect(verifyFullSessionMcpToken(credential, HOST_TOKEN))
      .toEqual({ ok: true, sessionId: SESSION });
  });
});
