/**
 * card #1261 B — orch 세션 삭제 조정자.
 *
 * HTTP DELETE와 MCP delete_session이 같은 판정을 쓴다:
 *   (a) 세션 없음 → 404
 *   (b) 소유 노드에 붙어 있음 → 상태와 무관하게 delete_session 명령
 *       (제한 시간 안에 지워짐 → deleted/200, 시간 초과 → accepted/202)
 *   (c) 구버전 노드가 명령을 모름("Not implemented") → 실행 중이면 409 「멈춘 뒤 지워 주십시오」,
 *       아니면 orch가 직접 삭제
 *   (d) 소유 노드가 없거나 연결되지 않음 → 실행 중이면 409 「노드 연결을 기다리는 중」,
 *       아니면 직접 삭제
 */
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_NODE_COMMAND_TIMEOUT_MS,
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
} from "../src/node/pending_commands.js";
import {
  SessionRouteNodeUnavailableError,
  SessionRouteSessionOwnerMissingError,
} from "../src/session/session_command_router.js";
import {
  SessionDeleteError,
  deleteSessionWithNode,
  sessionDeleteTransportFromRouteOptions,
  type SessionDeleteTarget,
  type SessionDeleteTransport,
} from "../src/session/session_delete.js";
import {
  InMemoryNodeRegistry,
  NodeCommandTransportHub,
  SessionCommandRouter,
  SessionCommandTransportBridge,
  loadContractFixtures,
  type NodeRegistrationPayload,
} from "../src/index.js";

type SendArgs = {
  payload: { type: string; agentSessionId: string };
  timeoutMs: number;
};

function makeTransport(params: {
  connected?: string[];
  respond?: (args: SendArgs) => Promise<Record<string, unknown>>;
} = {}) {
  const sent: SendArgs[] = [];
  const transport: SessionDeleteTransport = {
    isNodeConnected: (nodeId) => (params.connected ?? [nodeId]).includes(nodeId),
    sendDeleteCommand: vi.fn(async (payload, options) => {
      const args = { payload, timeoutMs: options.timeoutMs };
      sent.push(args);
      if (params.respond) return await params.respond(args);
      return {
        type: "delete_session_ack",
        requestId: "req-1",
        status: "ok",
        deleted: true,
      };
    }),
  };
  return { transport, sent };
}

function makeDirectDelete() {
  return vi.fn(async (_sessionId: string) => {});
}

/**
 * 노드 전송기 전체 경로(registry → router → bridge → receiveNodeMessage)를 세운다.
 * 시험이 노드 응답을 실제 제어 채널 프레임 그대로 돌려주므로, 오류 꼴은 손으로
 * 만든 문자열이 아니라 전송기의 settleFromResponse가 만드는 것이다.
 */
function makeRealDeleteTransport(params: {
  reply: (frame: Record<string, unknown>) => Record<string, unknown>;
}): { transport: SessionDeleteTransport; frames: Record<string, unknown>[] } {
  const nodeId = "node-a";
  const fixtures = loadContractFixtures();
  const registry = new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType }) => `${commandType}-${sequence}`,
  });
  const connectionId = registry.registerNode({
    ...(fixtures.fakeNodeReconnect.registration as NodeRegistrationPayload),
    node_id: nodeId,
  }).node.connectionId;
  registry.receiveNodeMessage(nodeId, {
    type: "runner_inventory",
    running_session_ids: [],
  });
  const transports = new NodeCommandTransportHub();
  const frames: Record<string, unknown>[] = [];
  transports.attach({
    nodeId,
    connectionId,
    transport: {
      send: (data) => {
        const frame = JSON.parse(data) as Record<string, unknown>;
        frames.push(frame);
        registry.receiveNodeMessage({ nodeId, connectionId }, params.reply(frame));
      },
    },
  });
  const router = new SessionCommandRouter({
    registry,
    findSessionOwnerNodeId: async () => nodeId,
  });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  return {
    transport: sessionDeleteTransportFromRouteOptions({ router, bridge }),
    frames,
  };
}

/** 옛 노드의 제어 채널 거절 프레임(control_inbox_runtime.sendError와 같은 꼴). */
function controlInventoryRejection(frame: Record<string, unknown>) {
  return {
    type: "error",
    requestId: frame.requestId,
    status: "rejected",
    code: "CONTROL_COMMAND_NOT_IN_INVENTORY",
    message:
      `Command type is not present in the control command inventory: ${String(frame.type)}`,
  };
}

const running: SessionDeleteTarget = { nodeId: "node-a", status: "running" };
const completed: SessionDeleteTarget = { nodeId: "node-a", status: "completed" };

describe("deleteSessionWithNode (card #1261)", () => {
  it("(a) 세션이 없으면 404를 내고 아무것도 지우지 않는다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport();

    const error = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: null,
      transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SessionDeleteError);
    expect((error as SessionDeleteError).code).toBe("SESSION_NOT_FOUND");
    expect((error as SessionDeleteError).statusCode).toBe(404);
    expect(direct).not.toHaveBeenCalled();
  });

  it("(b) 소유 노드에 붙은 실행 중 세션은 노드 명령으로 멈추고 지운다", async () => {
    const direct = makeDirectDelete();
    const { transport, sent } = makeTransport();

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: running,
      transport,
      deleteDirectly: direct,
    });

    expect(outcome).toBe("deleted");
    expect(direct).not.toHaveBeenCalled();
    expect(sent).toEqual([{
      payload: { type: "delete_session", agentSessionId: "sess-1" },
      timeoutMs: DEFAULT_NODE_COMMAND_TIMEOUT_MS,
    }]);
  });

  it("(b) 끝난 세션도 소유 노드에 붙어 있으면 노드 명령을 거친다", async () => {
    const direct = makeDirectDelete();
    const { transport, sent } = makeTransport();

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: completed,
      transport,
      deleteDirectly: direct,
    });

    expect(outcome).toBe("deleted");
    expect(direct).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.timeoutMs).toBe(DEFAULT_NODE_COMMAND_TIMEOUT_MS);
  });

  it("(b) 제한 시간을 넘기면 accepted로 접고 orch가 직접 지우지 않는다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport({
      respond: async ({ payload, timeoutMs }) => {
        throw new PendingNodeCommandTimeoutError({
          commandType: payload.type,
          requestId: "req-1",
          timeoutMs,
        });
      },
    });

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: running,
      transport,
      deleteDirectly: direct,
      timeoutMs: 50,
    });

    expect(outcome).toBe("accepted");
    expect(direct).not.toHaveBeenCalled();
  });

  it("(c) 구버전 노드 + 실행 중 → 409 멈춘 뒤 지워 주십시오", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport({
      respond: async ({ payload, timeoutMs }) => {
        throw new PendingNodeCommandRejectedError({
          commandType: payload.type,
          requestId: "req-1",
          message: "Not implemented in soul-server-ts: delete_session",
          response: {
            type: "error",
            requestId: "req-1",
            message: "Not implemented in soul-server-ts: delete_session",
          },
        });
      },
    });

    const error = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: running,
      transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SessionDeleteError);
    expect((error as SessionDeleteError).statusCode).toBe(409);
    expect((error as SessionDeleteError).code).toBe("SESSION_DELETE_REQUIRES_STOP");
    expect((error as SessionDeleteError).message).toContain("멈춘 뒤 지워 주십시오");
    expect(direct).not.toHaveBeenCalled();
  });

  it("(c) 구버전 노드 + 끝난 세션 → orch가 직접 지운다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport({
      respond: async ({ payload }) => {
        throw new PendingNodeCommandRejectedError({
          commandType: payload.type,
          requestId: "req-1",
          message: "Not implemented in soul-server-ts: delete_session",
        });
      },
    });

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: completed,
      transport,
      deleteDirectly: direct,
    });

    expect(outcome).toBe("deleted");
    expect(direct).toHaveBeenCalledWith("sess-1");
  });

  it("(d) 연결되지 않은 노드 + 실행 중 → 409 노드 연결을 기다리는 중", async () => {
    const direct = makeDirectDelete();
    const { transport, sent } = makeTransport({ connected: [] });

    const error = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: running,
      transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SessionDeleteError);
    expect((error as SessionDeleteError).statusCode).toBe(409);
    expect((error as SessionDeleteError).code).toBe("SESSION_DELETE_NODE_CONNECTING");
    expect((error as SessionDeleteError).message).toContain("노드 연결을 기다리는 중");
    expect(direct).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("(d) 연결되지 않은 노드 + 끝난 세션 → 직접 지운다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport({ connected: [] });

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: completed,
      transport,
      deleteDirectly: direct,
    });

    expect(outcome).toBe("deleted");
    expect(direct).toHaveBeenCalledWith("sess-1");
  });

  it("(d) 노드가 노드 라우팅에서 사라졌으면 같은 판정을 쓴다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport({
      respond: async () => {
        throw new SessionRouteNodeUnavailableError({
          agentSessionId: "sess-1",
          nodeId: "node-a",
        });
      },
    });

    const activeError = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: running,
      transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);
    expect((activeError as SessionDeleteError).statusCode).toBe(409);
    expect((activeError as SessionDeleteError).code).toBe("SESSION_DELETE_NODE_CONNECTING");

    const finishedOutcome = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: completed,
      transport,
      deleteDirectly: direct,
    });
    expect(finishedOutcome).toBe("deleted");
    expect(direct).toHaveBeenCalledWith("sess-1");
  });

  it("(d) 소유 노드가 없는 실행 중 세션도 노드 연결을 기다린다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport();

    const error = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: { nodeId: null, status: "running" },
      transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);

    expect((error as SessionDeleteError).code).toBe("SESSION_DELETE_NODE_CONNECTING");
  });

  it("(d) 소유 노드가 없는 끝난 세션은 직접 지운다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport();

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: { nodeId: null, status: "completed" },
      transport,
      deleteDirectly: direct,
    });

    expect(outcome).toBe("deleted");
    expect(direct).toHaveBeenCalledWith("sess-1");
  });

  it("초기화 중(initializing)도 실행 중으로 본다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport({ connected: [] });

    const error = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: { nodeId: "node-a", status: "initializing" },
      transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);

    expect((error as SessionDeleteError).code).toBe("SESSION_DELETE_NODE_CONNECTING");
    expect(direct).not.toHaveBeenCalled();
  });

  it("노드가 거절한 다른 오류는 409 삭제 거절로 표면화한다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport({
      respond: async ({ payload }) => {
        throw new PendingNodeCommandRejectedError({
          commandType: payload.type,
          requestId: "req-1",
          message: "task creation projections did not drain before delete deadline",
        });
      },
    });

    const error = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: running,
      transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);

    expect((error as SessionDeleteError).statusCode).toBe(409);
    expect((error as SessionDeleteError).code).toBe("SESSION_DELETE_REJECTED");
    expect((error as SessionDeleteError).message).toContain("did not drain");
    expect(direct).not.toHaveBeenCalled();
  });

  it("라우터가 소유자 없음으로 거절하면 (d)와 같이 판정한다", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeTransport({
      respond: async () => {
        throw new SessionRouteSessionOwnerMissingError("sess-1");
      },
    });

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-1",
      target: completed,
      transport,
      deleteDirectly: direct,
    });
    expect(outcome).toBe("deleted");
    expect(direct).toHaveBeenCalledWith("sess-1");
  });

  it("(c) 제어 채널 옛 노드가 CONTROL_COMMAND_NOT_IN_INVENTORY로 거절해도 끝난 세션은 직접 지운다", async () => {
    const direct = makeDirectDelete();
    const { transport, frames } = makeRealDeleteTransport({
      reply: controlInventoryRejection,
    });

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-finished",
      target: completed,
      transport,
      deleteDirectly: direct,
    });

    expect(outcome).toBe("deleted");
    expect(frames[0]).toMatchObject({
      type: "delete_session",
      agentSessionId: "sess-finished",
    });
    expect(direct).toHaveBeenCalledWith("sess-finished");
  });

  it("(c) 제어 채널 옛 노드가 CONTROL_COMMAND_NOT_IN_INVENTORY로 거절하면 활성 세션은 409", async () => {
    const direct = makeDirectDelete();
    const { transport } = makeRealDeleteTransport({
      reply: controlInventoryRejection,
    });

    const error = await deleteSessionWithNode({
      sessionId: "sess-active",
      target: running,
      transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SessionDeleteError);
    expect((error as SessionDeleteError).statusCode).toBe(409);
    expect((error as SessionDeleteError).code).toBe("SESSION_DELETE_REQUIRES_STOP");
    expect((error as SessionDeleteError).message).toContain("멈춘 뒤 지워 주십시오");
    expect(direct).not.toHaveBeenCalled();
  });

  it("(e) 노드가 deleted:false로 답하면 끝난 세션은 orch가 지우고 활성 세션은 409", async () => {
    const direct = makeDirectDelete();
    const finished = makeRealDeleteTransport({
      reply: (frame) => ({
        type: "delete_session_ack",
        requestId: frame.requestId,
        status: "ok",
        agentSessionId: frame.agentSessionId,
        deleted: false,
      }),
    });

    const outcome = await deleteSessionWithNode({
      sessionId: "sess-finished",
      target: completed,
      transport: finished.transport,
      deleteDirectly: direct,
    });
    expect(outcome).toBe("deleted");
    expect(direct).toHaveBeenCalledWith("sess-finished");

    const active = makeRealDeleteTransport({
      reply: (frame) => ({
        type: "delete_session_ack",
        requestId: frame.requestId,
        status: "ok",
        agentSessionId: frame.agentSessionId,
        deleted: false,
      }),
    });
    const error = await deleteSessionWithNode({
      sessionId: "sess-active",
      target: running,
      transport: active.transport,
      deleteDirectly: direct,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SessionDeleteError);
    expect((error as SessionDeleteError).statusCode).toBe(409);
    expect((error as SessionDeleteError).code).toBe("SESSION_DELETE_REQUIRES_STOP");
  });
});
