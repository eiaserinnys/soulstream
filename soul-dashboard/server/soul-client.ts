/**
 * Soul SSE Client - Soul 서버의 SSE 스트림을 구독하는 클라이언트
 *
 * Soul 서버의 세션 SSE 엔드포인트(GET /events/{agentSessionId}/stream)에
 * 연결하여 이벤트를 수신하고, EventHub를 통해 대시보드 클라이언트에 중계합니다.
 *
 * Last-Event-ID 기반 재연결을 지원합니다.
 */

import { EventSource } from "eventsource";
import type { SoulSSEEvent, SSEEventType } from "../shared/types.js";

export interface SoulClientOptions {
  /** Soul 서버 기본 URL (기본값: http://localhost:3105) */
  soulBaseUrl: string;
  /** 인증 토큰 */
  authToken?: string;
  /** 재연결 대기 시간 (ms) (기본값: 3000) */
  reconnectInterval?: number;
  /** 최대 재연결 대기 시간 (ms) (기본값: 30000) */
  maxReconnectInterval?: number;
}

export type SoulEventHandler = (
  agentSessionId: string,
  eventId: number,
  event: SoulSSEEvent,
) => void;

interface StreamSubscription {
  eventSource: EventSource;
  agentSessionId: string;
  lastEventId: number;
  reconnectAttempts: number;
  closed: boolean;
}

/**
 * Soul SSE 구독 클라이언트.
 *
 * 세션별 SSE 스트림(GET /events/{agentSessionId}/stream)에 연결하여
 * 이벤트를 수신합니다.
 * 연결이 끊어지면 Last-Event-ID를 사용하여 지수 백오프로 재연결합니다.
 */
export class SoulClient {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly reconnectInterval: number;
  private readonly maxReconnectInterval: number;
  private readonly subscriptions = new Map<string, StreamSubscription>();
  private readonly eventHandlers: SoulEventHandler[] = [];
  private readonly errorHandlers: Array<
    (agentSessionId: string, error: Error) => void
  > = [];
  private readonly reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(options: SoulClientOptions) {
    this.baseUrl = options.soulBaseUrl.replace(/\/$/, "");
    this.authToken = options.authToken ?? "";
    this.reconnectInterval = options.reconnectInterval ?? 3000;
    this.maxReconnectInterval = options.maxReconnectInterval ?? 30000;
  }

  /** 이벤트 핸들러 등록. 해제 함수를 반환합니다. */
  onEvent(handler: SoulEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx !== -1) this.eventHandlers.splice(idx, 1);
    };
  }

  /** 에러 핸들러 등록. 해제 함수를 반환합니다. */
  onError(
    handler: (agentSessionId: string, error: Error) => void,
  ): () => void {
    this.errorHandlers.push(handler);
    return () => {
      const idx = this.errorHandlers.indexOf(handler);
      if (idx !== -1) this.errorHandlers.splice(idx, 1);
    };
  }

  /**
   * 세션 SSE 스트림에 구독.
   *
   * @param agentSessionId - 세션 식별자
   * @param lastEventId - 마지막으로 수신한 이벤트 ID (재연결 시)
   */
  subscribe(
    agentSessionId: string,
    lastEventId?: number,
  ): void {
    // 이미 구독 중이면 무시
    if (this.subscriptions.has(agentSessionId)) {
      return;
    }

    this.connectStream(agentSessionId, lastEventId, 0);
  }

  /** 세션 구독 해제 */
  unsubscribe(agentSessionId: string): void {
    const sub = this.subscriptions.get(agentSessionId);
    if (sub) {
      sub.closed = true;
      sub.eventSource.close();
      this.subscriptions.delete(agentSessionId);
    }
  }

  /** 모든 구독 해제 및 클라이언트 종료 */
  close(): void {
    this.closed = true;

    // 대기 중인 재연결 타이머 정리
    for (const timer of this.reconnectTimers) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();

    for (const [key, sub] of this.subscriptions) {
      sub.closed = true;
      sub.eventSource.close();
      this.subscriptions.delete(key);
    }
  }

  /** 현재 구독 중인 세션 목록 */
  getActiveSubscriptions(): string[] {
    return [...this.subscriptions.keys()];
  }

  private connectStream(
    agentSessionId: string,
    lastEventId?: number,
    reconnectAttempts?: number,
  ): void {
    if (this.closed) return;

    const url = `${this.baseUrl}/events/${encodeURIComponent(agentSessionId)}/stream`;

    const extraHeaders: Record<string, string> = {};
    if (this.authToken) {
      extraHeaders["Authorization"] = `Bearer ${this.authToken}`;
    }
    if (lastEventId !== undefined) {
      extraHeaders["Last-Event-ID"] = String(lastEventId);
    }

    // eventsource v3는 커스텀 fetch를 통해 헤더를 주입
    const customFetch: typeof globalThis.fetch = (input, init) => {
      const mergedHeaders = new Headers(init?.headers);
      for (const [key, value] of Object.entries(extraHeaders)) {
        mergedHeaders.set(key, value);
      }
      return globalThis.fetch(input, { ...init, headers: mergedHeaders });
    };

    const eventSource = new EventSource(url, { fetch: customFetch });

    const subscription: StreamSubscription = {
      eventSource,
      agentSessionId,
      lastEventId: lastEventId ?? 0,
      reconnectAttempts: reconnectAttempts ?? 0,
      closed: false,
    };

    this.subscriptions.set(agentSessionId, subscription);

    // 모든 이벤트 타입에 대해 리스너 등록
    const eventTypes: SSEEventType[] = [
      "init",
      "reconnected",
      "progress",
      "memory",
      "session",
      "intervention_sent",
      "user_message",
      "debug",
      "complete",
      "error",
      "text_start",
      "text_delta",
      "text_end",
      "tool_start",
      "tool_result",
      "result",
      "context_usage",
      "compact",
      "reconnect",
    ];

    for (const eventType of eventTypes) {
      eventSource.addEventListener(eventType, (messageEvent: MessageEvent) => {
        if (subscription.closed) return;

        try {
          if (!messageEvent.data || messageEvent.data === "undefined") return;
          const data = JSON.parse(messageEvent.data) as SoulSSEEvent;
          const eventId = messageEvent.lastEventId
            ? parseInt(messageEvent.lastEventId, 10)
            : subscription.lastEventId + 1;

          subscription.lastEventId = eventId;
          // 성공적인 이벤트 수신 시 재연결 카운터 리셋
          subscription.reconnectAttempts = 0;

          // 핸들러에 전달
          for (const handler of this.eventHandlers) {
            try {
              handler(agentSessionId, eventId, data);
            } catch (handlerError) {
              console.error(
                `[SoulClient] Event handler error for ${agentSessionId}:`,
                handlerError,
              );
            }
          }

          // complete/error는 세션의 현재 턴 종료를 의미하므로 구독을 정리합니다.
          // resume 시 새 구독이 생성됩니다.
          if (data.type === "complete" || data.type === "error") {
            subscription.closed = true;
            eventSource.close();
            this.subscriptions.delete(agentSessionId);
          }
        } catch (parseError) {
          console.error(
            `[SoulClient] Failed to parse event for ${agentSessionId}:`,
            parseError,
          );
        }
      });
    }

    eventSource.onerror = (_errorEvent: Event) => {
      if (subscription.closed || this.closed) return;

      const error = new Error(`SSE connection error for ${agentSessionId}`);
      for (const handler of this.errorHandlers) {
        try {
          handler(agentSessionId, error);
        } catch {
          // ignore handler errors
        }
      }

      // 수동 재연결 (Last-Event-ID 보존)
      eventSource.close();
      this.subscriptions.delete(agentSessionId);

      if (!this.closed) {
        // 지수 백오프 + 랜덤 지터
        const attempts = subscription.reconnectAttempts;
        const delay = Math.min(
          this.reconnectInterval * Math.pow(2, attempts) +
            Math.random() * 1000,
          this.maxReconnectInterval,
        );

        const timer = setTimeout(() => {
          this.reconnectTimers.delete(timer);
          if (!this.closed && !subscription.closed) {
            console.log(
              `[SoulClient] Reconnecting to ${agentSessionId} (attempt=${attempts + 1}, lastEventId=${subscription.lastEventId})`,
            );
            this.connectStream(
              agentSessionId,
              subscription.lastEventId,
              attempts + 1,
            );
          }
        }, delay);

        this.reconnectTimers.add(timer);
      }
    };
  }
}
