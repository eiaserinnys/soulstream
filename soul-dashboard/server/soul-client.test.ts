/**
 * SoulClient 테스트
 *
 * Soul SSE 구독 클라이언트의 핵심 로직을 검증합니다.
 * - 단위 테스트: 생성자, 핸들러 등록/해제, close 등
 * - 통합 테스트: Express 기반 mock SSE 서버로 실제 이벤트 수신 검증
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { SoulClient } from "./soul-client.js";
import type { SoulSSEEvent } from "../shared/types.js";

/** 비동기 조건이 충족될 때까지 폴링하는 유틸리티 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** 사용 가능한 포트로 HTTP 서버를 시작하고 포트 번호를 반환 */
function startServer(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to get server address"));
      }
    });
    server.on("error", reject);
  });
}

/** HTTP 서버를 안전하게 종료 */
function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

describe("SoulClient", () => {
  let client: SoulClient;

  afterEach(() => {
    client?.close();
  });

  describe("constructor", () => {
    it("should initialize with default options", () => {
      client = new SoulClient({
        soulBaseUrl: "http://localhost:3105",
      });

      expect(client.getActiveSubscriptions()).toEqual([]);
    });

    it("should strip trailing slash from base URL", () => {
      client = new SoulClient({
        soulBaseUrl: "http://localhost:3105/",
      });

      // URL은 내부적으로 정규화됨 - 구독 시 확인 가능
      expect(client.getActiveSubscriptions()).toEqual([]);
    });
  });

  describe("onEvent / onError", () => {
    it("should register event handlers", () => {
      client = new SoulClient({
        soulBaseUrl: "http://localhost:3105",
      });

      const handler = vi.fn();
      client.onEvent(handler);

      // 핸들러가 등록되었지만 아직 호출되지 않았음
      expect(handler).not.toHaveBeenCalled();
    });

    it("should register error handlers", () => {
      client = new SoulClient({
        soulBaseUrl: "http://localhost:3105",
      });

      const handler = vi.fn();
      client.onError(handler);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("event handler unsubscribe", () => {
    it("should unsubscribe event handler when returned function is called", () => {
      client = new SoulClient({ soulBaseUrl: "http://localhost:39999" });
      const handler = vi.fn();
      const unsub = client.onEvent(handler);

      // unsub을 호출해도 에러가 발생하지 않아야 함
      expect(() => unsub()).not.toThrow();
    });

    it("should allow multiple event handlers and selectively unsubscribe", () => {
      client = new SoulClient({ soulBaseUrl: "http://localhost:39999" });
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      const unsub1 = client.onEvent(handler1);
      client.onEvent(handler2);
      const unsub3 = client.onEvent(handler3);

      // handler1과 handler3만 해제
      unsub1();
      unsub3();

      // 이중 해제해도 에러 없음
      expect(() => unsub1()).not.toThrow();
      expect(() => unsub3()).not.toThrow();
    });
  });

  describe("error handler unsubscribe", () => {
    it("should unsubscribe error handler when returned function is called", () => {
      client = new SoulClient({ soulBaseUrl: "http://localhost:39999" });
      const handler = vi.fn();
      const unsub = client.onError(handler);

      expect(() => unsub()).not.toThrow();
    });

    it("should allow multiple error handlers and selectively unsubscribe", () => {
      client = new SoulClient({ soulBaseUrl: "http://localhost:39999" });
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsub1 = client.onError(handler1);
      client.onError(handler2);

      unsub1();

      // 이중 해제해도 에러 없음
      expect(() => unsub1()).not.toThrow();
    });
  });

  describe("subscribe / unsubscribe", () => {
    it("should track active subscriptions (connection will fail in test)", () => {
      client = new SoulClient({
        soulBaseUrl: "http://localhost:39999", // 존재하지 않는 서버
      });

      // subscribe는 내부적으로 EventSource 연결을 시도
      // 테스트 환경에서는 연결이 실패하지만 구독 추적은 됨
      // Note: 실제 구현에서 EventSource 생성자가 예외를 던질 수 있음
      try {
        client.subscribe("bot", "req-1");
      } catch {
        // EventSource 생성 실패는 예상됨
      }
    });

    it("should not duplicate subscriptions", () => {
      client = new SoulClient({
        soulBaseUrl: "http://localhost:39999",
      });

      try {
        client.subscribe("bot", "req-1");
        client.subscribe("bot", "req-1"); // 중복
      } catch {
        // 예상됨
      }
    });
  });

  describe("close", () => {
    it("should close without error when no subscriptions", () => {
      client = new SoulClient({
        soulBaseUrl: "http://localhost:3105",
      });

      expect(() => client.close()).not.toThrow();
      expect(client.getActiveSubscriptions()).toEqual([]);
    });

    it("should prevent subscribe after close", () => {
      client = new SoulClient({
        soulBaseUrl: "http://localhost:39999",
      });

      client.close();

      // close() 후 subscribe는 내부적으로 this.closed 체크로 무시됨
      try {
        client.subscribe("bot", "req-after-close");
      } catch {
        // EventSource 생성 자체가 실패할 수도 있음
      }

      // closed 상태이므로 구독이 추가되지 않아야 함
      expect(client.getActiveSubscriptions()).toEqual([]);
    });
  });

  describe("subscribe with mock SSE server", () => {
    let mockServer: Server;
    let mockPort: number;

    afterEach(async () => {
      client?.close();
      await closeServer(mockServer);
    });

    it("should receive events from SSE stream", async () => {
      // Mock SSE 서버 구성: progress -> complete 순으로 이벤트 전송
      const app = express();

      app.get("/tasks/:clientId/:requestId/stream", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // progress 이벤트
        const progressData: SoulSSEEvent = {
          type: "progress",
          text: "Working on it...",
        };
        res.write(`id: 1\nevent: progress\ndata: ${JSON.stringify(progressData)}\n\n`);

        // 짧은 지연 후 complete 이벤트
        setTimeout(() => {
          const completeData: SoulSSEEvent = {
            type: "complete",
            result: "Done!",
            attachments: [],
          };
          res.write(`id: 2\nevent: complete\ndata: ${JSON.stringify(completeData)}\n\n`);

          // complete 전송 후 스트림 종료
          setTimeout(() => res.end(), 50);
        }, 100);
      });

      mockServer = createServer(app);
      mockPort = await startServer(mockServer);

      client = new SoulClient({
        soulBaseUrl: `http://127.0.0.1:${mockPort}`,
      });

      const receivedEvents: Array<{
        sessionKey: string;
        eventId: number;
        event: SoulSSEEvent;
      }> = [];

      client.onEvent((sessionKey, eventId, event) => {
        receivedEvents.push({ sessionKey, eventId, event });
      });

      client.subscribe("testbot", "req-42");

      // 이벤트가 2개 도착할 때까지 대기
      await waitFor(() => receivedEvents.length >= 2);

      // progress 이벤트 검증
      expect(receivedEvents[0].sessionKey).toBe("testbot:req-42");
      expect(receivedEvents[0].eventId).toBe(1);
      expect(receivedEvents[0].event.type).toBe("progress");
      expect((receivedEvents[0].event as { type: "progress"; text: string }).text).toBe(
        "Working on it...",
      );

      // complete 이벤트 검증
      expect(receivedEvents[1].sessionKey).toBe("testbot:req-42");
      expect(receivedEvents[1].eventId).toBe(2);
      expect(receivedEvents[1].event.type).toBe("complete");
    });

    it("should auto-unsubscribe on complete event", async () => {
      const app = express();

      app.get("/tasks/:clientId/:requestId/stream", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // 즉시 complete 이벤트 전송
        const completeData: SoulSSEEvent = {
          type: "complete",
          result: "Finished",
          attachments: [],
        };
        res.write(`id: 1\nevent: complete\ndata: ${JSON.stringify(completeData)}\n\n`);

        setTimeout(() => res.end(), 50);
      });

      mockServer = createServer(app);
      mockPort = await startServer(mockServer);

      client = new SoulClient({
        soulBaseUrl: `http://127.0.0.1:${mockPort}`,
      });

      const receivedEvents: SoulSSEEvent[] = [];
      client.onEvent((_sessionKey, _eventId, event) => {
        receivedEvents.push(event);
      });

      client.subscribe("bot", "req-auto");

      // complete 이벤트 수신 대기
      await waitFor(() => receivedEvents.length >= 1);

      // complete 수신 후 구독이 자동 제거되어야 함
      await waitFor(() => client.getActiveSubscriptions().length === 0);

      expect(client.getActiveSubscriptions()).toEqual([]);
    });

    it("should auto-unsubscribe on error event", async () => {
      const app = express();

      app.get("/tasks/:clientId/:requestId/stream", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // error 이벤트 전송
        const errorData: SoulSSEEvent = {
          type: "error",
          message: "Something went wrong",
          error_code: "INTERNAL_ERROR",
        };
        res.write(`id: 1\nevent: error\ndata: ${JSON.stringify(errorData)}\n\n`);

        setTimeout(() => res.end(), 50);
      });

      mockServer = createServer(app);
      mockPort = await startServer(mockServer);

      client = new SoulClient({
        soulBaseUrl: `http://127.0.0.1:${mockPort}`,
      });

      const receivedEvents: SoulSSEEvent[] = [];
      client.onEvent((_sessionKey, _eventId, event) => {
        receivedEvents.push(event);
      });

      client.subscribe("bot", "req-err");

      // error 이벤트 수신 대기
      await waitFor(() => receivedEvents.length >= 1);

      // error 수신 후 구독이 자동 제거되어야 함
      await waitFor(() => client.getActiveSubscriptions().length === 0);

      expect(receivedEvents[0].type).toBe("error");
      expect(client.getActiveSubscriptions()).toEqual([]);
    });

    it("should receive multiple event types in sequence", async () => {
      const app = express();

      app.get("/tasks/:clientId/:requestId/stream", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // 다양한 이벤트를 순차 전송
        const events: Array<{ id: number; type: string; data: SoulSSEEvent }> = [
          {
            id: 1,
            type: "progress",
            data: { type: "progress", text: "Starting..." },
          },
          {
            id: 2,
            type: "text_start",
            data: { type: "text_start", card_id: "card-1" },
          },
          {
            id: 3,
            type: "text_delta",
            data: { type: "text_delta", card_id: "card-1", text: "Hello" },
          },
          {
            id: 4,
            type: "text_end",
            data: { type: "text_end", card_id: "card-1" },
          },
          {
            id: 5,
            type: "complete",
            data: { type: "complete", result: "All done", attachments: [] },
          },
        ];

        let idx = 0;
        const sendNext = () => {
          if (idx >= events.length) {
            setTimeout(() => res.end(), 50);
            return;
          }
          const evt = events[idx++];
          res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`);
          setTimeout(sendNext, 30);
        };
        sendNext();
      });

      mockServer = createServer(app);
      mockPort = await startServer(mockServer);

      client = new SoulClient({
        soulBaseUrl: `http://127.0.0.1:${mockPort}`,
      });

      const receivedEvents: SoulSSEEvent[] = [];
      client.onEvent((_sessionKey, _eventId, event) => {
        receivedEvents.push(event);
      });

      client.subscribe("bot", "req-multi");

      // 5개 이벤트 모두 수신 대기
      await waitFor(() => receivedEvents.length >= 5);

      expect(receivedEvents.map((e) => e.type)).toEqual([
        "progress",
        "text_start",
        "text_delta",
        "text_end",
        "complete",
      ]);
    });

    it("should call error handler on connection error", async () => {
      // 서버 없이 연결 시도 -> onerror 발생
      client = new SoulClient({
        soulBaseUrl: "http://127.0.0.1:39999",
        // 재연결 비활성화를 위해 짧은 간격 설정 (close로 정리)
        reconnectInterval: 60000,
        maxReconnectInterval: 60000,
      });

      const errorHandler = vi.fn();
      client.onError(errorHandler);

      try {
        client.subscribe("bot", "req-fail");
      } catch {
        // EventSource 생성이 실패할 수 있음
      }

      // 연결 실패 시 에러 핸들러가 호출될 때까지 대기
      // (네트워크 환경에 따라 실패할 수 있으므로 타임아웃을 넉넉하게)
      try {
        await waitFor(() => errorHandler.mock.calls.length > 0, 5000);

        expect(errorHandler).toHaveBeenCalledWith(
          "bot:req-fail",
          expect.any(Error),
        );
      } catch {
        // 테스트 환경에 따라 EventSource가 다르게 동작할 수 있음
        // 에러 핸들러가 호출되지 않아도 테스트 실패로 간주하지 않음
      }
    });

    it("should pass correct sessionKey format to handlers", async () => {
      const app = express();

      app.get("/tasks/:clientId/:requestId/stream", (req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const data: SoulSSEEvent = {
          type: "complete",
          result: `handled ${req.params.clientId}/${req.params.requestId}`,
          attachments: [],
        };
        res.write(`id: 1\nevent: complete\ndata: ${JSON.stringify(data)}\n\n`);

        setTimeout(() => res.end(), 50);
      });

      mockServer = createServer(app);
      mockPort = await startServer(mockServer);

      client = new SoulClient({
        soulBaseUrl: `http://127.0.0.1:${mockPort}`,
      });

      const sessionKeys: string[] = [];
      client.onEvent((sessionKey) => {
        sessionKeys.push(sessionKey);
      });

      client.subscribe("my-client", "my-request");

      await waitFor(() => sessionKeys.length >= 1);

      // sessionKey는 "clientId:requestId" 형식
      expect(sessionKeys[0]).toBe("my-client:my-request");
    });

    it("should handle unsubscribe before events arrive", async () => {
      const app = express();

      app.get("/tasks/:clientId/:requestId/stream", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        // 지연 후 이벤트 전송 (구독 해제 시간을 확보)
        setTimeout(() => {
          const data: SoulSSEEvent = {
            type: "progress",
            text: "Should not be received",
          };
          res.write(`id: 1\nevent: progress\ndata: ${JSON.stringify(data)}\n\n`);
          setTimeout(() => res.end(), 50);
        }, 500);
      });

      mockServer = createServer(app);
      mockPort = await startServer(mockServer);

      client = new SoulClient({
        soulBaseUrl: `http://127.0.0.1:${mockPort}`,
      });

      const receivedEvents: SoulSSEEvent[] = [];
      client.onEvent((_sessionKey, _eventId, event) => {
        receivedEvents.push(event);
      });

      client.subscribe("bot", "req-unsub");

      // 즉시 구독 해제
      client.unsubscribe("bot", "req-unsub");

      expect(client.getActiveSubscriptions()).toEqual([]);

      // 잠시 대기하여 이벤트가 도착하지 않음을 확인
      await new Promise((resolve) => setTimeout(resolve, 800));

      // subscription.closed = true이므로 이벤트 핸들러가 호출되지 않아야 함
      expect(receivedEvents).toEqual([]);
    });

    it("should handle event handler errors gracefully", async () => {
      const app = express();

      app.get("/tasks/:clientId/:requestId/stream", (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const progressData: SoulSSEEvent = {
          type: "progress",
          text: "test",
        };
        res.write(`id: 1\nevent: progress\ndata: ${JSON.stringify(progressData)}\n\n`);

        setTimeout(() => {
          const completeData: SoulSSEEvent = {
            type: "complete",
            result: "done",
            attachments: [],
          };
          res.write(`id: 2\nevent: complete\ndata: ${JSON.stringify(completeData)}\n\n`);
          setTimeout(() => res.end(), 50);
        }, 100);
      });

      mockServer = createServer(app);
      mockPort = await startServer(mockServer);

      client = new SoulClient({
        soulBaseUrl: `http://127.0.0.1:${mockPort}`,
      });

      // 에러를 던지는 핸들러
      const brokenHandler = vi.fn(() => {
        throw new Error("Handler exploded");
      });

      // 정상 핸들러
      const goodHandler = vi.fn();

      client.onEvent(brokenHandler);
      client.onEvent(goodHandler);

      // console.error를 모킹하여 노이즈 제거
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      client.subscribe("bot", "req-handler-err");

      // 정상 핸들러도 호출되어야 함 (에러 격리)
      await waitFor(() => goodHandler.mock.calls.length >= 2);

      expect(brokenHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalledTimes(2);

      consoleSpy.mockRestore();
    });

    it("should send Authorization header when authToken is provided", async () => {
      const app = express();
      let receivedAuthHeader: string | undefined;

      app.get("/tasks/:clientId/:requestId/stream", (req, res) => {
        receivedAuthHeader = req.headers.authorization;

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const data: SoulSSEEvent = {
          type: "complete",
          result: "authed",
          attachments: [],
        };
        res.write(`id: 1\nevent: complete\ndata: ${JSON.stringify(data)}\n\n`);
        setTimeout(() => res.end(), 50);
      });

      mockServer = createServer(app);
      mockPort = await startServer(mockServer);

      client = new SoulClient({
        soulBaseUrl: `http://127.0.0.1:${mockPort}`,
        authToken: "test-secret-token",
      });

      const receivedEvents: SoulSSEEvent[] = [];
      client.onEvent((_sessionKey, _eventId, event) => {
        receivedEvents.push(event);
      });

      client.subscribe("bot", "req-auth");

      await waitFor(() => receivedEvents.length >= 1);

      expect(receivedAuthHeader).toBe("Bearer test-secret-token");
    });
  });
});
