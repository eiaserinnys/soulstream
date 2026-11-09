/**
 * restricted CLI용 정제 MCP config(§5) 검증.
 *
 * Soulstream upstream 강제·중복 제거, 관리 upstream 제거, 승인 local 정규화,
 * 미승인 private/self 제거, 외부 public 유지, stdio env/headers 제거.
 */
import { describe, expect, it } from "vitest";

import type { ResolvedMcpServer } from "../../src/mcp_config_service.js";
import {
  defaultIsolationPolicyPath,
  loadIsolationPolicyFile,
} from "../../src/security/session_isolation_policy.js";
import { sanitizeRestrictedMcpServers } from "../../src/security/restricted_mcp_config.js";

const policy = loadIsolationPolicyFile(defaultIsolationPolicyPath()).policy;
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const INTERNAL_URL = "http://127.0.0.1:3105/mcp";
const RESTRICTED_TOKEN = "ssr1.11111111-1111-4111-8111-111111111111.signature";

function server(partial: Record<string, unknown>): ResolvedMcpServer {
  return partial as unknown as ResolvedMcpServer;
}

const resolvedServers: ResolvedMcpServer[] = [
  server({
    type: "streamable_http",
    name: "soulstream",
    url: "http://127.0.0.1:3105/mcp",
    headers: { Authorization: "Bearer full-secret" },
  }),
  server({
    type: "streamable_http",
    name: "soulstream-cogito",
    url: "http://127.0.0.1:3105/cogito",
    headers: { Authorization: "Bearer full-secret" },
  }),
  server({
    type: "streamable_http",
    name: "renamed-internal",
    url: "http://10.20.30.40:3105/mcp",
    headers: { Authorization: "Bearer full-secret" },
  }),
  server({
    type: "stdio",
    name: "ms-todo",
    command: "npx",
    args: ["ms-todo"],
    env: { TODO_TOKEN: "child-secret" },
    headers: { Authorization: "Bearer child-secret" },
  }),
  server({
    type: "streamable_http",
    name: "atom",
    url: "http://127.0.0.1:4200/mcp",
    headers: { Authorization: "Bearer atom-secret" },
  }),
  server({
    type: "streamable_http",
    name: "outline",
    url: "http://localhost:3103/mcp",
    headers: { Authorization: "Bearer outline-secret" },
  }),
  server({
    type: "streamable_http",
    name: "unapproved-local",
    url: "http://127.0.0.1:9999/mcp",
    headers: { Authorization: "Bearer local-secret" },
  }),
  server({
    type: "streamable_http",
    name: "atom-wrong-port",
    url: "http://127.0.0.1:4300/mcp",
  }),
  server({
    type: "streamable_http",
    name: "haniel",
    url: "http://127.0.0.1:9300/mcp",
    headers: { Authorization: "Bearer haniel-secret" },
  }),
  server({
    type: "streamable_http",
    name: "public",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer public-token" },
  }),
  server({ type: "sse", name: "public-sse", url: "https://sse.example.com/sse" }),
];

function sanitize(nodeId = "eiaserinnys") {
  return sanitizeRestrictedMcpServers({
    resolvedServers,
    authenticatedSessionId: SESSION_A,
    restrictedToken: RESTRICTED_TOKEN,
    localMcpPolicy: policy.localMcp,
    actualInternalMcpUrl: INTERNAL_URL,
    nodeId,
  });
}

describe("sanitizeRestrictedMcpServers", () => {
  it("forces exactly one soulstream upstream with the restricted credential", () => {
    const { sanitizedServers } = sanitize();
    const soulstream = sanitizedServers.filter((entry) => entry.name === "soulstream");
    expect(soulstream).toHaveLength(1);
    expect(sanitizedServers[0]).toEqual({
      type: "streamable_http",
      name: "soulstream",
      url: INTERNAL_URL,
      headers: {
        Authorization: `Bearer ${RESTRICTED_TOKEN}`,
        "x-soulstream-agent-session-id": SESSION_A,
      },
    });
    expect(sanitizedServers.map((entry) => entry.name)).not.toContain("soulstream-cogito");
    expect(sanitizedServers.map((entry) => entry.name)).not.toContain("renamed-internal");
    expect(JSON.stringify(sanitizedServers)).not.toContain("full-secret");
  });

  it("drops management upstreams", () => {
    const names = sanitize().sanitizedServers.map((entry) => entry.name);
    expect(names).not.toContain("haniel");
    expect(JSON.stringify(sanitize().sanitizedServers)).not.toContain("haniel-secret");
  });

  it("keeps stdio servers but strips env and headers", () => {
    const stdio = sanitize().sanitizedServers.find((entry) => entry.name === "ms-todo");
    expect(stdio).toEqual({
      type: "stdio",
      name: "ms-todo",
      command: "npx",
      args: ["ms-todo"],
    });
  });

  it("normalizes approved local servers to canonical 127.0.0.1 ports", () => {
    const { sanitizedServers, approvedLocalMcp } = sanitize();
    expect(sanitizedServers.find((entry) => entry.name === "atom")?.url)
      .toBe("http://127.0.0.1:4200/mcp");
    expect(sanitizedServers.find((entry) => entry.name === "outline")?.url)
      .toBe("http://127.0.0.1:3103/mcp");
    expect(approvedLocalMcp).toEqual([
      { serverId: "atom", hostPort: 4200 },
      { serverId: "outline", hostPort: 3103 },
    ]);
  });

  it("drops unapproved private and self endpoints", () => {
    const names = sanitize().sanitizedServers.map((entry) => entry.name);
    expect(names).not.toContain("unapproved-local");
    expect(names).not.toContain("atom-wrong-port");
    expect(JSON.stringify(sanitize().sanitizedServers)).not.toContain("local-secret");
  });

  it("keeps public external servers with their existing authentication", () => {
    const { sanitizedServers } = sanitize();
    expect(sanitizedServers.find((entry) => entry.name === "public")).toEqual(
      resolvedServers.find((entry) => entry.name === "public"),
    );
    expect(sanitizedServers.find((entry) => entry.name === "public-sse")).toBeDefined();
  });

  it("applies only the approvals of the given node", () => {
    const wsl = sanitize("eias-linegames-wsl");
    expect(wsl.sanitizedServers.map((entry) => entry.name)).not.toContain("atom");
    expect(wsl.sanitizedServers.map((entry) => entry.name)).toContain("outline");
    expect(wsl.approvedLocalMcp).toEqual([{ serverId: "outline", hostPort: 3103 }]);
  });

  it("does not turn an external endpoint with a matching name and port into a local one", () => {
    const externalServers: ResolvedMcpServer[] = [
      server({
        type: "streamable_http",
        name: "atom",
        url: "https://mcp.example.com:4200/mcp",
        headers: { Authorization: "Bearer external-atom-token" },
      }),
      server({
        type: "streamable_http",
        name: "outline",
        url: "https://mcp.example.com:3103/mcp",
        headers: { Authorization: "Bearer external-outline-token" },
      }),
    ];
    const { sanitizedServers, approvedLocalMcp } = sanitizeRestrictedMcpServers({
      resolvedServers: externalServers,
      authenticatedSessionId: SESSION_A,
      restrictedToken: RESTRICTED_TOKEN,
      localMcpPolicy: policy.localMcp,
      actualInternalMcpUrl: INTERNAL_URL,
      nodeId: "eiaserinnys",
    });

    expect(sanitizedServers.find((entry) => entry.name === "atom")).toEqual(externalServers[0]);
    expect(sanitizedServers.find((entry) => entry.name === "outline")).toEqual(externalServers[1]);
    expect(approvedLocalMcp).toEqual([]);
  });
});
