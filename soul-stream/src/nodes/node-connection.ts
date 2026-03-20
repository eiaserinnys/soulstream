/**
 * NodeConnection — 개별 소울 서버 노드의 WebSocket 연결 관리.
 *
 * 노드에 명령을 전송하고, 노드에서 오는 이벤트를 수신하여 구독자에게 전달한다.
 */

import type { WebSocket } from "ws";
import type { NodeRegistration, NodeInfo, NodeStatus } from "./types";
import type { SessionSummary, SessionEvent } from "../sessions/types";
import { globalEventStore } from "../sessions/event-store";

let requestIdCounter = 0;
function nextRequestId(): string {
  return `req-${++requestIdCounter}-${Date.now()}`;
}

export class NodeConnection {
  readonly nodeId: string;
  readonly host: string;
  readonly port: number;
  readonly capabilities: Record<string, unknown>;
  readonly connectedAt: number;

  private _ws: WebSocket;
  private _status: NodeStatus = "connected";
  private _sessions: Map<string, SessionSummary> = new Map();
  private _eventListeners: Map<string, Set<(event: SessionEvent) => void>> =
    new Map();
  private _pendingRequests: Map<
    string,
    { resolve: (data: unknown) => void; reject: (err: Error) => void }
  > = new Map();
  private _onClose: (() => void) | null = null;

  constructor(ws: WebSocket, registration: NodeRegistration) {
    this.nodeId = registration.node_id;
    this.host = registration.host;
    this.port = registration.port;
    this.capabilities = registration.capabilities ?? {};
    this.connectedAt = Date.now();
    this._ws = ws;

    this._setupListeners();
  }

  get status(): NodeStatus {
    return this._status;
  }

  /** 연결 종료 콜백 등록 (NodeManager가 사용). */
  set onClose(cb: (() => void) | null) {
    this._onClose = cb;
  }

  /** 노드 정보 반환. */
  toInfo(): NodeInfo {
    return {
      nodeId: this.nodeId,
      host: this.host,
      port: this.port,
      status: this._status,
      capabilities: this.capabilities,
      connectedAt: this.connectedAt,
      sessionCount: this._sessions.size,
    };
  }

  /** 세션 목록 반환. */
  getSessions(): SessionSummary[] {
    return Array.from(this._sessions.values());
  }

  /** 세션 생성 명령 전송. */
  async createSession(
    prompt: string,
    opts?: {
      profile?: string;
      allowed_tools?: string[];
      disallowed_tools?: string[];
      use_mcp?: boolean;
    }
  ): Promise<string> {
    const requestId = nextRequestId();
    const result = await this._sendCommand({
      type: "create_session",
      prompt,
      profile: opts?.profile ?? "",
      allowed_tools: opts?.allowed_tools,
      disallowed_tools: opts?.disallowed_tools,
      use_mcp: opts?.use_mcp,
      request_id: requestId,
    });
    return (result as { session_id: string }).session_id;
  }

  /** 개입 명령 전송. */
  async intervene(
    sessionId: string,
    text: string,
    user: string
  ): Promise<void> {
    this._send({
      type: "intervene",
      session_id: sessionId,
      text,
      user,
    });
  }

  /** AskUserQuestion 응답 전송. */
  async respond(
    sessionId: string,
    requestId: string,
    answers: Record<string, unknown>
  ): Promise<void> {
    this._send({
      type: "respond",
      session_id: sessionId,
      request_id: requestId,
      answers,
    });
  }

  /** 세션 이벤트 구독. 해제 함수를 반환한다. */
  onSessionEvent(
    sessionId: string,
    listener: (event: SessionEvent) => void
  ): () => void {
    let listeners = this._eventListeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this._eventListeners.set(sessionId, listeners);
    }
    listeners.add(listener);

    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) {
        this._eventListeners.delete(sessionId);
      }
    };
  }

  /** WebSocket 연결 닫기. */
  close(): void {
    this._status = "disconnected";
    try {
      this._ws.close();
    } catch {
      // 이미 닫혀있을 수 있음
    }
  }

  // ─── Private ──────────────────────────────────

  private _setupListeners(): void {
    this._ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch {
        // invalid JSON — ignore
      }
    });

    this._ws.on("close", () => {
      this._status = "disconnected";
      // pending requests 거부
      for (const [, pending] of this._pendingRequests) {
        pending.reject(new Error("Node disconnected"));
      }
      this._pendingRequests.clear();
      this._onClose?.();
    });

    this._ws.on("error", () => {
      // error 이벤트는 close 이벤트 전에 발생 — close에서 처리
    });
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;
    const requestId = msg.request_id as string | undefined;

    // pending request 응답 처리
    if (requestId && this._pendingRequests.has(requestId)) {
      const pending = this._pendingRequests.get(requestId)!;
      this._pendingRequests.delete(requestId);

      if (type === "error") {
        pending.reject(new Error((msg.message as string) ?? "Unknown error"));
        return;
      }

      // session_created 응답이면 세션 목록에도 추가
      if (type === "session_created") {
        const sid = msg.session_id as string;
        if (sid) {
          this._sessions.set(sid, { sessionId: sid, status: "running" });
        }
      }

      pending.resolve(msg);
      return;
    }

    switch (type) {
      case "event": {
        const sessionId = msg.session_id as string;
        const event = msg as SessionEvent;

        globalEventStore.append(sessionId, event); // 이벤트 캐싱

        // 세션 이벤트 리스너에 전달
        const listeners = this._eventListeners.get(sessionId);
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener(event);
            } catch {
              // 리스너 에러 무시
            }
          }
        }
        break;
      }

      case "sessions_update": {
        // 세션 목록 업데이트
        const sessions = msg.sessions as SessionSummary[];
        if (Array.isArray(sessions)) {
          this._sessions.clear();
          for (const s of sessions) {
            const id =
              s.sessionId ??
              (s as Record<string, unknown>).agent_session_id ??
              "";
            if (id) {
              // sessionId를 정규화하여 저장 (upstream이 agent_session_id만 보내는 경우 대비)
              this._sessions.set(id as string, { ...s, sessionId: id as string });
            }
          }
        }
        break;
      }

      case "session_created": {
        // 새 세션 추가
        const sessionId = msg.session_id as string;
        if (sessionId) {
          const sessionData = (msg.session as Record<string, unknown>) ?? {};
          this._sessions.set(sessionId, {
            ...sessionData,
            sessionId,
            status: (sessionData.status as string) ?? "running",
          });
        }
        break;
      }

      case "session_updated": {
        // 세션 상태/메시지 갱신
        const id =
          (msg.agent_session_id as string) ??
          (msg.sessionId as string) ??
          "";
        if (id && this._sessions.has(id)) {
          const existing = this._sessions.get(id)!;
          this._sessions.set(id, {
            ...existing,
            ...(msg.status != null ? { status: msg.status as string } : {}),
            ...(msg.updated_at != null
              ? { updatedAt: msg.updated_at as string }
              : {}),
            ...(msg.last_message != null
              ? { lastMessage: msg.last_message as string }
              : {}),
          });
        }
        break;
      }

      case "session_deleted": {
        // 세션 제거
        const delId =
          (msg.agent_session_id as string) ??
          (msg.sessionId as string) ??
          "";
        if (delId) {
          this._sessions.delete(delId);
          globalEventStore.clear(delId); // 캐시 정리
        }
        break;
      }

      case "health_status": {
        // 헬스 상태 — 현재는 로깅만
        break;
      }
    }
  }

  private _send(data: Record<string, unknown>): void {
    if (this._ws.readyState === this._ws.OPEN) {
      this._ws.send(JSON.stringify(data));
    }
  }

  private _sendCommand(
    data: Record<string, unknown>,
    timeoutMs = 30000
  ): Promise<unknown> {
    const requestId = data.request_id as string;

    return new Promise((resolve, reject) => {
      this._pendingRequests.set(requestId, { resolve, reject });
      this._send(data);

      // 타임아웃
      setTimeout(() => {
        if (this._pendingRequests.has(requestId)) {
          this._pendingRequests.delete(requestId);
          reject(new Error(`Request ${requestId} timed out`));
        }
      }, timeoutMs);
    });
  }
}
