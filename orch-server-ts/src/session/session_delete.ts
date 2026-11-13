import {
  DEFAULT_NODE_COMMAND_TIMEOUT_MS,
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
} from "../node/pending_commands.js";
import {
  SessionRouteNodeUnavailableError,
  SessionRouteSessionOwnerMissingError,
} from "./session_command_router.js";
import type { SessionCommandRouteOptions } from "./session_command_routes.js";

/**
 * 세션 삭제 판정 (card #1261 B).
 *
 * 화면 삭제(HTTP DELETE)와 MCP delete_session이 같은 함수를 쓴다. 소유 노드가 붙어
 * 있으면 상태와 무관하게 그 노드에 delete_session 명령을 보내고, 노드가 그 명령을
 * 모르는 옛 판이거나 연결돼 있지 않으면 활성 세션만 409로 거절한 뒤 끝난 세션은
 * orch가 직접 지운다. 실행 중인 세션을 orch가 직접 지워 러너를 고아로 만드는 길을
 * 막는 것이 목적이다.
 */
export type SessionDeleteOutcome = "deleted" | "accepted";

export type SessionDeleteTarget = {
  nodeId: string | null;
  status: string | null;
};

export type SessionDeleteTransport = {
  isNodeConnected(nodeId: string): boolean;
  sendDeleteCommand(
    payload: { type: "delete_session"; agentSessionId: string },
    options: { timeoutMs: number },
  ): Promise<Record<string, unknown>>;
};

export class SessionDeleteError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "SessionDeleteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type DeleteSessionWithNodeParams = {
  sessionId: string;
  target: SessionDeleteTarget | null;
  transport: SessionDeleteTransport;
  deleteDirectly(sessionId: string): Promise<unknown>;
  timeoutMs?: number;
};

const ACTIVE_SESSION_STATUSES = new Set(["initializing", "running"]);

export async function deleteSessionWithNode(
  params: DeleteSessionWithNodeParams,
): Promise<SessionDeleteOutcome> {
  const { sessionId, target, transport } = params;
  if (!target) {
    throw new SessionDeleteError(
      "SESSION_NOT_FOUND",
      `세션을 찾을 수 없습니다: ${sessionId}`,
      404,
    );
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_NODE_COMMAND_TIMEOUT_MS;
  if (target.nodeId && transport.isNodeConnected(target.nodeId)) {
    try {
      const response = await transport.sendDeleteCommand(
        { type: "delete_session", agentSessionId: sessionId },
        { timeoutMs },
      );
      if (response.status === "error") {
        throw new SessionDeleteError(
          "SESSION_DELETE_REJECTED",
          `세션 삭제가 노드에서 거절되었습니다: ${
            stringValue(response.message) ?? "unknown error"
          }`,
          409,
        );
      }
      if (response.deleted === false) {
        // 노드가 줄을 지우지 못했다(지연 로더가 null을 내는 불량 행 등). 활성이면
        // 화면만 지워지는 일을 막고, 아니면 예전처럼 orch가 직접 지운다.
        return await deleteFromOrch(
          sessionId,
          target,
          params.deleteDirectly,
          "node_declined",
        );
      }
      return "deleted";
    } catch (error) {
      if (error instanceof PendingNodeCommandTimeoutError) {
        // 노드가 삭제를 마저 끝내고 화면에 알린다. orch 행은 이미 사라졌을 수 있으므로
        // 직접 지우지 않는다.
        return "accepted";
      }
      if (isLegacyNodeRejection(error)) {
        return await deleteFromOrch(
          sessionId,
          target,
          params.deleteDirectly,
          "legacy_node",
        );
      }
      if (isNodeUnavailable(error)) {
        return await deleteFromOrch(
          sessionId,
          target,
          params.deleteDirectly,
          "node_unavailable",
        );
      }
      if (error instanceof SessionDeleteError) throw error;
      if (error instanceof PendingNodeCommandRejectedError) {
        throw new SessionDeleteError(
          "SESSION_DELETE_REJECTED",
          `세션 삭제가 노드에서 거절되었습니다: ${error.message}`,
          409,
        );
      }
      throw error;
    }
  }

  return await deleteFromOrch(
    sessionId,
    target,
    params.deleteDirectly,
    "node_unavailable",
  );
}

async function deleteFromOrch(
  sessionId: string,
  target: SessionDeleteTarget,
  deleteDirectly: DeleteSessionWithNodeParams["deleteDirectly"],
  activeReason: "legacy_node" | "node_declined" | "node_unavailable",
): Promise<SessionDeleteOutcome> {
  if (isActiveSessionStatus(target.status)) {
    if (activeReason !== "node_unavailable") {
      throw new SessionDeleteError(
        "SESSION_DELETE_REQUIRES_STOP",
        `실행 중인 세션은 멈춘 뒤 지워 주십시오: ${sessionId}`,
        409,
      );
    }
    throw new SessionDeleteError(
      "SESSION_DELETE_NODE_CONNECTING",
      `노드 연결을 기다리는 중입니다: ${sessionId}`,
      409,
    );
  }
  await deleteDirectly(sessionId);
  return "deleted";
}

function isActiveSessionStatus(status: string | null): boolean {
  return status !== null && ACTIVE_SESSION_STATUSES.has(status);
}

function isLegacyNodeRejection(error: unknown): boolean {
  if (!(error instanceof PendingNodeCommandRejectedError)) return false;
  // 운영 노드는 명령을 제어 채널로 먼저 받는다. 옛 노드의 제어 채널은 모르는 명령을
  // 이 code로 거절하므로(control_inbox_runtime), 「Not implemented」 응답과 같이
  // 옛 노드로 판정한다.
  if (error.response?.code === "CONTROL_COMMAND_NOT_IN_INVENTORY") return true;
  const responseMessage = stringValue(error.response?.message);
  return error.message.includes("Not implemented")
    || responseMessage?.includes("Not implemented") === true;
}

function isNodeUnavailable(error: unknown): boolean {
  return error instanceof SessionRouteNodeUnavailableError
    || error instanceof SessionRouteSessionOwnerMissingError;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 노드 명령 라우터/브릿지를 삭제 전송기로 감싼다. 응답 대기는
 * session_command_transport의 sendPendingCommand 경로를 그대로 쓴다.
 */
export function sessionDeleteTransportFromRouteOptions(
  options: Pick<SessionCommandRouteOptions, "router" | "bridge">,
): SessionDeleteTransport {
  return {
    isNodeConnected: (nodeId) => options.router.isNodeConnected(nodeId),
    sendDeleteCommand: async (payload, { timeoutMs }) => {
      const routed = await options.router.routeExistingSessionPendingCommand(
        payload,
        { timeoutMs },
      );
      return await options.bridge.sendPendingCommand(routed);
    },
  };
}
