import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerPersistenceHostRoutes } from "../src/control_plane/persistence_host_routes.js";
import type { PersistenceHostRepositories } from "../src/control_plane/persistence_host_runtime.js";

const TOKEN = "service-token";
const NODE_ID = "node-restart";

/**
 * 부팅 복구 클레임은 그 노드의 지금 연결 등록 시각 이전에 접수된 행만 잡는다.
 * 7edad0de(261119): 재등록 11초 뒤 새 프로세스가 직접 접수한 배달을 같은 부팅의
 * 복구 패스가 잡아 runner_receipt_unknown으로 닫았다. 연결이 없으면 지금처럼
 * 시각 조건 없이 클레임해 이전 프로세스의 행이 영영 남지 않게 한다.
 *
 * 저장소의 SQL 조건(queued_at < 기준 시각, 기준 시각 없음)은
 * soul-server-ts/tests/db/session_delivery_recovery_postgres.test.ts가 실 DB로
 * 검증한다. 이 파일은 PostgreSQL 파일명 계약(postgres_test_filename_contract)상
 * harness를 import할 수 없으므로, 라우트가 레지스트리 연결 시각을 클레임 인자로
 * 넘기는지(그리고 연결이 없으면 넘기지 않는지)만 본다.
 */
describe("boot recovery claim cutoff routing", () => {
  let app: ReturnType<typeof Fastify>;
  let calls: unknown[][];
  let connectedAtMs: number | undefined;

  beforeEach(() => {
    calls = [];
    connectedAtMs = undefined;
    const recovery = {
      claimQueuedAfterNodeRestart: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    };
    app = Fastify();
    registerPersistenceHostRoutes(app, {
      nodeCredentials: null,
      authBearerToken: TOKEN,
      repositoryProvider: async () =>
        ({ deliveries: { recovery } }) as unknown as PersistenceHostRepositories,
      nodeConnectedAtMs: () => connectedAtMs,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  async function claim(args: unknown[]): Promise<unknown[]> {
    const response = await app.inject({
      method: "POST",
      url: "/api/session-deliveries/host/claim_queued_after_node_restart",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { args },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    return calls[0]!;
  }

  it("passes the node's current connection time as the claim cutoff", async () => {
    connectedAtMs = 1_762_000_000_000;

    await expect(claim([NODE_ID, "boot-worker-after", 100, 15_000, false]))
      .resolves.toEqual([NODE_ID, "boot-worker-after", 100, 15_000, false, connectedAtMs]);
  });

  it("omits the cutoff when the node has no registered connection", async () => {
    await expect(claim([NODE_ID, "boot-worker-unconnected", 100, 15_000, false]))
      .resolves.toEqual([NODE_ID, "boot-worker-unconnected", 100, 15_000, false]);
  });

  it("omits the cutoff when the route has no registry lookup", async () => {
    await app.close();
    app = Fastify();
    const recovery = {
      claimQueuedAfterNodeRestart: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    };
    registerPersistenceHostRoutes(app, {
      nodeCredentials: null,
      authBearerToken: TOKEN,
      repositoryProvider: async () =>
        ({ deliveries: { recovery } }) as unknown as PersistenceHostRepositories,
    });

    await expect(claim([NODE_ID, "boot-worker-no-lookup", 100, 15_000, false]))
      .resolves.toEqual([NODE_ID, "boot-worker-no-lookup", 100, 15_000, false]);
  });
});
