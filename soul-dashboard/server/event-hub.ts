/**
 * Event Hub - 대시보드 클라이언트 브로드캐스트 (1:N)
 *
 * Soul에서 수신한 이벤트를 연결된 대시보드 SSE 클라이언트들에게
 * 브로드캐스트합니다. 세션별로 리스너를 관리합니다.
 */

import type { Response } from "express";
import type { SoulSSEEvent } from "../shared/types.js";

interface SSEClient {
  id: string;
  res: Response;
  sessionKey: string;
  lastEventId: number;
}

/**
 * 대시보드 SSE 클라이언트 브로드캐스트 허브.
 *
 * 사용 패턴:
 * 1. 대시보드 클라이언트가 SSE 연결 → addClient()
 * 2. SoulClient가 이벤트 수신 → broadcast()
 * 3. EventHub가 해당 세션의 모든 클라이언트에게 이벤트 전송
 * 4. 클라이언트 연결 종료 → removeClient()
 */
/** 세션 별칭: 새 세션 이벤트를 원래 세션으로 포워딩하기 위한 매핑 */
interface SessionAlias {
  targetKey: string;
  eventIdOffset: number;
  /** 생성 시각 (TTL 만료 판정용) */
  createdAt: number;
}

/** MEDIUM-4: alias TTL (1시간) */
const ALIAS_TTL_MS = 60 * 60 * 1000;

export class EventHub {
  /** sessionKey → SSEClient[] */
  private readonly clients = new Map<string, SSEClient[]>();
  /** clientId → SSEClient (모든 클라이언트 조회용) */
  private readonly allClients = new Map<string, SSEClient>();
  /** 세션 별칭: sourceKey → { targetKey, eventIdOffset } */
  private readonly sessionAliases = new Map<string, SessionAlias>();
  private clientIdCounter = 0;

  /**
   * SSE 클라이언트를 세션에 등록합니다.
   *
   * @param sessionKey - "clientId:requestId" 형식의 세션 키
   * @param res - Express Response 객체 (SSE 스트림용)
   * @param lastEventId - 클라이언트가 마지막으로 수신한 이벤트 ID
   * @returns 클라이언트 ID (해제 시 사용)
   */
  addClient(
    sessionKey: string,
    res: Response,
    lastEventId?: number,
  ): string {
    const clientId = `dash-${++this.clientIdCounter}`;

    // SSE 헤더 설정
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // 초기 연결 확인 이벤트
    res.write(
      `event: connected\ndata: ${JSON.stringify({ clientId, sessionKey })}\n\n`,
    );

    const client: SSEClient = {
      id: clientId,
      res,
      sessionKey,
      lastEventId: lastEventId ?? 0,
    };

    // 세션별 클라이언트 목록에 추가
    if (!this.clients.has(sessionKey)) {
      this.clients.set(sessionKey, []);
    }
    this.clients.get(sessionKey)!.push(client);
    this.allClients.set(clientId, client);

    // 연결 종료 시 자동 정리
    res.on("close", () => {
      this.removeClient(clientId);
    });

    return clientId;
  }

  /**
   * SSE 클라이언트를 해제합니다.
   */
  removeClient(clientId: string): void {
    const client = this.allClients.get(clientId);
    if (!client) return;

    // 세션별 목록에서 제거
    const sessionClients = this.clients.get(client.sessionKey);
    if (sessionClients) {
      const idx = sessionClients.findIndex((c) => c.id === clientId);
      if (idx !== -1) {
        sessionClients.splice(idx, 1);
      }
      // 빈 세션 정리
      if (sessionClients.length === 0) {
        this.clients.delete(client.sessionKey);
      }
    }

    this.allClients.delete(clientId);

    // Response 종료
    if (!client.res.writableEnded) {
      client.res.end();
    }
  }

  /**
   * 특정 세션의 모든 클라이언트에게 이벤트를 브로드캐스트합니다.
   *
   * @param sessionKey - 세션 키
   * @param eventId - EventStore의 단조증가 ID
   * @param event - Soul SSE 이벤트
   */
  broadcast(
    sessionKey: string,
    eventId: number,
    event: SoulSSEEvent,
  ): void {
    const sessionClients = this.clients.get(sessionKey);
    if (!sessionClients || sessionClients.length === 0) return;

    const eventType = event.type;
    const data = JSON.stringify(event);
    const sseMessage = `id: ${eventId}\nevent: ${eventType}\ndata: ${data}\n\n`;

    // 죽은 연결 수집
    const deadClients: string[] = [];

    for (const client of sessionClients) {
      try {
        if (client.res.writableEnded) {
          deadClients.push(client.id);
          continue;
        }
        client.res.write(sseMessage);
        client.lastEventId = eventId;
      } catch {
        deadClients.push(client.id);
      }
    }

    // 죽은 연결 정리
    for (const deadId of deadClients) {
      this.removeClient(deadId);
    }
  }

  /**
   * 특정 클라이언트에게 이벤트 배열을 순서대로 전송합니다 (재연결 시 미수신 이벤트 전송).
   *
   * @param clientId - 대시보드 클라이언트 ID
   * @param events - 전송할 이벤트 배열
   */
  replayEvents(
    clientId: string,
    events: Array<{ id: number; event: Record<string, unknown> }>,
  ): void {
    const client = this.allClients.get(clientId);
    if (!client || client.res.writableEnded) return;

    for (const record of events) {
      const eventType = (record.event.type as string) ?? "unknown";
      const data = JSON.stringify(record.event);
      const sseMessage = `id: ${record.id}\nevent: ${eventType}\ndata: ${data}\n\n`;

      try {
        client.res.write(sseMessage);
        client.lastEventId = record.id;
      } catch {
        this.removeClient(clientId);
        return;
      }
    }
  }

  /**
   * Keepalive 코멘트를 모든 연결된 클라이언트에게 전송합니다.
   * MEDIUM-4: 만료된 alias도 함께 정리합니다.
   */
  sendKeepalive(): void {
    // 만료된 alias 정리
    this.cleanupExpiredAliases();

    const deadClients: string[] = [];

    for (const [clientId, client] of this.allClients) {
      try {
        if (client.res.writableEnded) {
          deadClients.push(clientId);
          continue;
        }
        client.res.write(": keepalive\n\n");
      } catch {
        deadClients.push(clientId);
      }
    }

    for (const deadId of deadClients) {
      this.removeClient(deadId);
    }
  }

  /** 특정 세션의 연결된 클라이언트 수 */
  getClientCount(sessionKey: string): number {
    return this.clients.get(sessionKey)?.length ?? 0;
  }

  /** 전체 연결된 클라이언트 수 */
  getTotalClientCount(): number {
    return this.allClients.size;
  }

  /** 세션별 클라이언트 수 맵 */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const [key, clients] of this.clients) {
      stats[key] = clients.length;
    }
    return stats;
  }

  /**
   * 세션 별칭을 등록합니다.
   * sourceKey의 이벤트가 targetKey 세션으로 포워딩됩니다.
   * eventIdOffset만큼 이벤트 ID가 오프셋됩니다.
   *
   * Resume 시: 새 세션(sourceKey) → 원래 세션(targetKey)으로 이벤트를 포워딩합니다.
   */
  addAlias(sourceKey: string, targetKey: string, eventIdOffset: number): void {
    this.sessionAliases.set(sourceKey, {
      targetKey,
      eventIdOffset,
      createdAt: Date.now(),
    });
  }

  /**
   * MEDIUM-4: 만료된 alias를 정리합니다.
   * sendKeepalive() 호출 시 함께 실행되어 메모리 누수를 방지합니다.
   */
  private cleanupExpiredAliases(): void {
    const now = Date.now();
    for (const [sourceKey, alias] of this.sessionAliases) {
      if (now - alias.createdAt > ALIAS_TTL_MS) {
        this.sessionAliases.delete(sourceKey);
      }
    }
  }

  /**
   * 세션 별칭을 조회합니다.
   * 별칭이 없으면 null을 반환합니다.
   */
  resolveAlias(sessionKey: string): SessionAlias | null {
    return this.sessionAliases.get(sessionKey) ?? null;
  }

  /** 세션 별칭을 제거합니다. */
  removeAlias(sourceKey: string): void {
    this.sessionAliases.delete(sourceKey);
  }

  /**
   * 모든 SSE 클라이언트 연결을 종료합니다.
   * 서버 셧다운 시 호출합니다.
   */
  closeAll(): void {
    for (const [clientId] of this.allClients) {
      this.removeClient(clientId);
    }
    this.sessionAliases.clear();
  }
}
