import { describe, expect, it } from "vitest";

import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  SessionCommandTransportBridge,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  type NodeRegistrationPayload,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

const SNAPSHOT = {
  identity: { name: null, email: null },
  ssh: { state: "missing", key_path: "/h/.ssh/id_ed25519", public_key: null },
  projects: { state: "ready", root: "/p", repos: [] },
  clone: null,
};

type Ack = Record<string, unknown>;

function createHarness(options: {
  capable?: boolean;
  connected?: boolean;
  admin?: boolean;
  ack?: (message: Record<string, unknown>) => Ack;
  withhold?: boolean;
  timeoutMs?: number;
} = {}) {
  const registry = new InMemoryNodeRegistry({ nowMs: () => 1_700_000_000_000 });
  const transports = new NodeCommandTransportHub();
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  const sent: Array<Record<string, unknown>> = [];
  if (options.connected !== false) {
    const registration = loadContractFixtures().fakeNodeReconnect.registration as NodeRegistrationPayload;
    const connectionId = registry.registerNode({
      ...registration,
      capabilities: { ...(registration.capabilities ?? {}), ...(options.capable === false ? {} : { node_git_setup_v1: true }) },
    }).node.connectionId;
    transports.attach({
      nodeId: "fake-node",
      connectionId,
      transport: {
        send: (data) => {
          const message = JSON.parse(data) as Record<string, unknown>;
          sent.push(message);
          if (options.withhold) return;
          registry.receiveNodeMessage(
            { nodeId: "fake-node", connectionId },
            { type: message.type, success: true, data: SNAPSHOT, ...options.ack?.(message), requestId: message.requestId },
          );
        },
      },
    });
  }
  const app = createApp({
    config,
    nodeGitSetupRoutes: {
      registry,
      bridge,
      adminAccess: {
        currentEmail: () => "user@example.test",
        isAdminEmail: () => options.admin !== false,
      },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  });
  return { app, sent };
}

const base = "/api/nodes/fake-node/git";

describe("노드 Git과 저장소 설정 경로", () => {
  it("여섯 경로가 워커 명령으로 가고 200, 201, 202로 data를 그대로 돌려준다", async () => {
    const job = { clone_id: "c-1", state: "running" };
    const { app, sent } = createHarness({
      ack: (message) => message.type === "node_git_clone_start" || message.type === "node_git_clone_status"
        ? { data: job }
        : message.type === "node_git_ssh_check" ? { data: { ok: true } } : {},
    });

    const responses = [
      await app.inject({ method: "GET", url: base }),
      await app.inject({ method: "PUT", url: `${base}/identity`, payload: { name: "N", email: "n@example.com" } }),
      await app.inject({ method: "POST", url: `${base}/ssh-key` }),
      await app.inject({ method: "POST", url: `${base}/ssh-check`, payload: { host: "github.com" } }),
      await app.inject({ method: "POST", url: `${base}/clones`, payload: { url: "git@github.com:a/b.git", repo_name: "b" } }),
      await app.inject({ method: "POST", url: `${base}/clones`, payload: { url: "git@github.com:a/b.git" } }),
      await app.inject({ method: "GET", url: `${base}/clones/c-1` }),
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 201, 200, 202, 202, 200]);
    expect(responses[0]!.json()).toEqual(SNAPSHOT);
    expect(responses[3]!.json()).toEqual({ ok: true });
    expect(responses[4]!.json()).toEqual(job);
    expect(sent.map(({ type, requestId: _id, ...payload }) => [type, payload])).toEqual([
      ["node_git_status", {}],
      ["node_git_identity_set", { name: "N", email: "n@example.com" }],
      ["node_git_ssh_key_create", {}],
      ["node_git_ssh_check", { host: "github.com" }],
      ["node_git_clone_start", { url: "git@github.com:a/b.git", repo_name: "b" }],
      ["node_git_clone_start", { url: "git@github.com:a/b.git" }],
      ["node_git_clone_status", { clone_id: "c-1" }],
    ]);
    await app.close();
  });

  it("관리자가 아니면 403이고 워커에 아무것도 보내지 않는다", async () => {
    const { app, sent } = createHarness({ admin: false });
    const responses = await Promise.all([
      app.inject({ method: "GET", url: base }),
      app.inject({ method: "PUT", url: `${base}/identity`, payload: { bad: 1 } }),
      app.inject({ method: "POST", url: `${base}/ssh-key` }),
      app.inject({ method: "POST", url: `${base}/ssh-check`, payload: { host: "github.com" } }),
      app.inject({ method: "POST", url: `${base}/clones`, payload: { url: "x" } }),
      app.inject({ method: "GET", url: `${base}/clones/c-1` }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(sent).toEqual([]);
    await app.close();
  });

  it("연결되지 않은 노드는 404 node_not_connected, 능력이 없는 노드는 409 node_git_unsupported다", async () => {
    const disconnected = createHarness({ connected: false });
    const missing = await disconnected.app.inject({ method: "GET", url: base });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("node_not_connected");
    await disconnected.app.close();

    const unsupported = createHarness({ capable: false });
    const responses = await Promise.all([
      unsupported.app.inject({ method: "GET", url: base }),
      unsupported.app.inject({ method: "POST", url: `${base}/ssh-check`, payload: { host: "github.com" } }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("node_git_unsupported");
    }
    expect(unsupported.sent).toEqual([]);
    await unsupported.app.close();
  });

  it("허용 외 키, 문자열이 아닌 값, 길이 초과, 빈 본문은 워커에 보내지 않고 422다", async () => {
    const { app, sent } = createHarness();
    const bodies: Array<[string, string, unknown, string | undefined]> = [
      ["PUT", `${base}/identity`, { name: "N", email: "n@example.com", extra: 1 }, undefined],
      ["PUT", `${base}/identity`, { name: 3, email: "n@example.com" }, "name"],
      ["PUT", `${base}/identity`, { name: "N" }, "email"],
      ["PUT", `${base}/identity`, { name: "N".repeat(201), email: "n@example.com" }, "name"],
      ["POST", `${base}/ssh-check`, { host: "h".repeat(254) }, "host"],
      ["POST", `${base}/ssh-check`, undefined, undefined],
      ["POST", `${base}/clones`, { url: "u", repo_name: 5 }, "repo_name"],
      ["POST", `${base}/clones`, { url: "x".repeat(2049) }, "url"],
      ["POST", `${base}/clones`, { repo_name: "b" }, "url"],
    ];
    for (const [method, url, payload, field] of bodies) {
      const response = await app.inject({ method: method as "PUT", url, ...(payload === undefined ? {} : { payload: payload as object }) });
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
      expect(response.json()).toMatchObject({ code: "invalid_request", ...(field ? { field } : {}) });
    }
    const badId = await app.inject({ method: "GET", url: `${base}/clones/bad_id!` });
    expect(badId.statusCode).toBe(422);
    expect(sent).toEqual([]);
    await app.close();
  });

  it.each([
    ["invalid_request", 422],
    ["clone_not_found", 404],
    ["ssh_key_exists", 409],
    ["repo_exists", 409],
    ["clone_busy", 409],
    ["projects_root_unavailable", 409],
    ["git_not_installed", 409],
    ["ssh_not_installed", 409],
    ["ssh_key_create_failed", 502],
    ["node_git_failed", 502],
    ["something_new", 502],
  ])("워커 거절 %s는 HTTP %i이고 본문은 {code, message, field?}뿐이다", async (code, status) => {
    const { app } = createHarness({
      ack: () => ({
        success: false,
        data: undefined,
        error: { code, message: "WORKER-TEXT /home/secret", field: "url", detail: "WORKER-DETAIL" },
      }),
    });
    const response = await app.inject({ method: "POST", url: `${base}/clones`, payload: { url: "git@github.com:a/b.git" } });
    expect(response.statusCode).toBe(status);
    expect(response.json().code).toBe(code);
    expect(Object.keys(response.json()).sort()).toEqual(code === "invalid_request" ? ["code", "field", "message"] : ["code", "message"]);
    expect(response.body).not.toContain("WORKER-TEXT");
    expect(response.body).not.toContain("WORKER-DETAIL");
    await app.close();
  });

  it("워커가 응답하지 않으면 502 node_command_timeout이다", async () => {
    const { app } = createHarness({ withhold: true, timeoutMs: 30 });
    const response = await app.inject({ method: "GET", url: base });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("node_command_timeout");
    await app.close();
  });
});
