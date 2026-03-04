/**
 * parseSSEBuffer 유닛 테스트
 *
 * SSE 버퍼 파싱의 정확성을 검증합니다.
 * 특히 reader.read()의 chunk 경계에서 이벤트가 분할될 때의 동작을 중점 테스트합니다.
 */

import { describe, it, expect } from "vitest";
import { parseSSEBuffer } from "./events-cached.js";

/** SSE 이벤트 문자열을 생성하는 헬퍼 */
function sseEvent(id: number, type: string, data: object): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("parseSSEBuffer", () => {
  describe("기본 파싱", () => {
    it("단일 완전한 이벤트를 파싱", () => {
      const buffer = sseEvent(1, "text_start", { type: "text_start" });
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].id).toBe(1);
      expect(result.parsed[0].type).toBe("text_start");
      expect(result.parsed[0].data).toBe('{"type":"text_start"}');
      expect(result.remaining).toBe("");
    });

    it("여러 완전한 이벤트를 순서대로 파싱", () => {
      const buffer =
        sseEvent(1, "text_start", { type: "text_start" }) +
        sseEvent(2, "text_delta", { type: "text_delta", text: "Hello" }) +
        sseEvent(3, "text_end", { type: "text_end" });

      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(3);
      expect(result.parsed[0].id).toBe(1);
      expect(result.parsed[1].id).toBe(2);
      expect(result.parsed[2].id).toBe(3);
      expect(result.remaining).toBe("");
    });

    it("id가 없는 이벤트도 파싱 (예: history_sync)", () => {
      const buffer = `event: history_sync\ndata: {"type":"history_sync","last_event_id":5}\n\n`;
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].id).toBeUndefined();
      expect(result.parsed[0].type).toBe("history_sync");
    });

    it("빈 버퍼에서 빈 결과 반환", () => {
      const result = parseSSEBuffer("");
      expect(result.parsed).toHaveLength(0);
      expect(result.remaining).toBe("");
    });
  });

  describe("불완전 이벤트 → remaining 처리", () => {
    it("줄바꿈 없이 끝나는 버퍼: 마지막 줄이 remaining으로", () => {
      const buffer = "id: 1\nevent: text_start\ndata: {\"type\":\"text_st";
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(0);
      expect(result.remaining).toContain("id: 1");
      expect(result.remaining).toContain("event: text_start");
      expect(result.remaining).toContain("data: {\"type\":\"text_st");
    });

    it("완전 이벤트 + 불완전 이벤트: 완전한 것만 파싱하고 나머지는 remaining", () => {
      const buffer =
        sseEvent(1, "text_start", { type: "text_start" }) +
        "id: 2\nevent: text_delta\ndata: {\"type\":\"text_del";

      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].id).toBe(1);
      expect(result.remaining).toContain("id: 2");
    });
  });

  describe("chunk 경계 시뮬레이션 — 증분 파싱", () => {
    /**
     * reader.read()가 반환하는 chunk를 시뮬레이션.
     * 각 chunk를 순서대로 parseSSEBuffer에 전달하고,
     * remaining을 다음 호출에 누적합니다.
     */
    function simulateChunkedParsing(chunks: string[]) {
      let buffer = "";
      const allEvents: Array<{
        id?: number;
        type?: string;
        data?: string;
      }> = [];

      for (const chunk of chunks) {
        buffer += chunk;
        const result = parseSSEBuffer(buffer);
        buffer = result.remaining;

        for (const event of result.parsed) {
          allEvents.push({
            id: event.id,
            type: event.type,
            data: event.data,
          });
        }
      }

      return { events: allEvents, remaining: buffer };
    }

    it("이벤트 전체가 하나의 chunk에 포함되면 정상 파싱", () => {
      const fullEvent = sseEvent(1, "text_start", { type: "text_start" });
      const result = simulateChunkedParsing([fullEvent]);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe(1);
      expect(result.events[0].type).toBe("text_start");
    });

    it("chunk 경계가 data 중간에 위치: 다음 chunk에서 복원", () => {
      const chunks = [
        "id: 1\nevent: text_start\ndata: {\"type\":\"text_st",
        "art\"}\n\n",
      ];
      const result = simulateChunkedParsing(chunks);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe(1);
      expect(result.events[0].type).toBe("text_start");
      expect(result.events[0].data).toBe('{"type":"text_start"}');
    });

    it("[BUG] chunk 경계가 id: 뒤 \\n에 위치: id가 소실됨", () => {
      // Chunk 1: "id: 1\n"  — id: 다음에 \n으로 끝남
      // Chunk 2: "event: text_start\ndata: {...}\n\n"
      //
      // 기대 동작: 하나의 이벤트 {id: 1, type: "text_start", data: "..."}
      // 실제 동작: 두 개의 이벤트 — {id: 1} (불완전) + {type: "text_start", data: "..."} (id 없음)
      const chunks = [
        "id: 1\n",
        'event: text_start\ndata: {"type":"text_start"}\n\n',
      ];
      const result = simulateChunkedParsing(chunks);

      // 이벤트가 정확히 1개여야 하고, id, type, data가 모두 있어야 함
      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe(1);
      expect(result.events[0].type).toBe("text_start");
      expect(result.events[0].data).toBe('{"type":"text_start"}');
    });

    it("[BUG] chunk 경계가 event: 뒤 \\n에 위치: type이 소실됨", () => {
      const chunks = [
        "id: 1\nevent: text_start\n",
        'data: {"type":"text_start"}\n\n',
      ];
      const result = simulateChunkedParsing(chunks);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe(1);
      expect(result.events[0].type).toBe("text_start");
      expect(result.events[0].data).toBe('{"type":"text_start"}');
    });

    it("[BUG] chunk 경계가 data: 뒤 \\n에 위치 (\\n\\n 직전): 다음 chunk의 \\n과 합쳐져야 함", () => {
      const chunks = [
        'id: 1\nevent: text_start\ndata: {"type":"text_start"}\n',
        "\n",
      ];
      const result = simulateChunkedParsing(chunks);

      expect(result.events).toHaveLength(1);
      expect(result.events[0].id).toBe(1);
      expect(result.events[0].type).toBe("text_start");
      expect(result.events[0].data).toBe('{"type":"text_start"}');
    });

    it("[BUG] 여러 이벤트에서 chunk 경계 발생: 모든 이벤트의 id가 보존되어야 함", () => {
      // 실제 sse-starlette가 492개 이벤트를 빠르게 전송할 때의 시나리오
      // TCP 버퍼링으로 인해 이벤트가 임의 지점에서 분할됨
      const chunks = [
        // 이벤트 1 완전
        sseEvent(1, "user_message", { type: "user_message", text: "hello" }),
        // 이벤트 2: id 뒤에서 분할
        "id: 2\n",
        'event: thinking\ndata: {"type":"thinking"}\n\n',
        // 이벤트 3 완전
        sseEvent(3, "progress", { type: "progress", text: "Processing..." }),
        // 이벤트 4: event 뒤에서 분할
        "id: 4\nevent: text_start\n",
        'data: {"type":"text_start"}\n\n',
        // 이벤트 5: data 뒤에서 분할 (\n\n 직전)
        'id: 5\nevent: text_delta\ndata: {"type":"text_delta","text":"Hi"}\n',
        "\n",
      ];

      const result = simulateChunkedParsing(chunks);

      // 5개 이벤트 모두 파싱되어야 함
      expect(result.events).toHaveLength(5);

      // 모든 이벤트에 id가 있어야 함
      for (let i = 0; i < 5; i++) {
        expect(result.events[i].id).toBe(i + 1);
      }

      // 타입도 올바른지 확인
      expect(result.events[0].type).toBe("user_message");
      expect(result.events[1].type).toBe("thinking");
      expect(result.events[2].type).toBe("progress");
      expect(result.events[3].type).toBe("text_start");
      expect(result.events[4].type).toBe("text_delta");
    });

    it("[BUG] 이전 이벤트와 다음 이벤트의 id가 하나의 chunk에서 분할", () => {
      // 이전 이벤트의 끝과 다음 이벤트의 id가 같은 chunk에 있지만
      // 다음 이벤트가 \n으로 끝남
      const chunks = [
        'id: 1\nevent: text_start\ndata: {"type":"text_start"}\n\nid: 2\n',
        'event: text_delta\ndata: {"type":"text_delta"}\n\n',
      ];
      const result = simulateChunkedParsing(chunks);

      expect(result.events).toHaveLength(2);
      expect(result.events[0].id).toBe(1);
      expect(result.events[1].id).toBe(2);
    });
  });

  describe("SSE 스펙 edge cases", () => {
    it("여러 data: 줄은 \\n으로 연결", () => {
      const buffer =
        "id: 1\nevent: message\ndata: line1\ndata: line2\ndata: line3\n\n";
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].data).toBe("line1\nline2\nline3");
    });

    it("data: 뒤에 값이 없으면 빈 문자열", () => {
      const buffer = "id: 1\nevent: ping\ndata:\n\n";
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].data).toBe("");
    });

    it("숫자가 아닌 id는 무시 (id는 undefined)", () => {
      const buffer = 'id: abc\nevent: test\ndata: {}\n\n';
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].id).toBeUndefined();
      expect(result.parsed[0].type).toBe("test");
    });

    it("코멘트 줄(: keep-alive)은 필드로 파싱되지 않지만 raw에 포함", () => {
      const buffer = ": keep-alive\n\n";
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].id).toBeUndefined();
      expect(result.parsed[0].type).toBeUndefined();
      expect(result.parsed[0].data).toBeUndefined();
      expect(result.parsed[0].raw).toContain(": keep-alive");
    });

    it("연속 빈 줄(\\n\\n\\n\\n)은 빈 블록으로 스킵", () => {
      const buffer =
        sseEvent(1, "event1", { type: "event1" }) +
        "\n\n" + // 추가 빈 블록
        sseEvent(2, "event2", { type: "event2" });
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(2);
      expect(result.parsed[0].id).toBe(1);
      expect(result.parsed[1].id).toBe(2);
    });

    it("retry: 필드는 무시 (파싱하지 않지만 에러 없음)", () => {
      const buffer = 'id: 1\nevent: test\nretry: 5000\ndata: {}\n\n';
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].id).toBe(1);
      expect(result.parsed[0].data).toBe("{}");
    });
  });

  describe("캐시 가능 여부 — id 존재 검증", () => {
    it("정상적으로 파싱된 이벤트는 id가 존재하여 캐시 가능", () => {
      const buffer = sseEvent(42, "tool_start", {
        type: "tool_start",
        name: "Read",
      });
      const result = parseSSEBuffer(buffer);

      expect(result.parsed).toHaveLength(1);
      expect(result.parsed[0].id).toBeDefined();
      expect(result.parsed[0].id).toBe(42);
      // 캐시 조건: event.id !== undefined && event.data
      expect(result.parsed[0].data).toBeDefined();
    });

    it("492개 이벤트를 다양한 chunk 크기로 분할해도 모든 id가 보존되어야 함", () => {
      // 실제 세션과 유사한 대량 이벤트 시뮬레이션
      const eventCount = 50;
      const fullStream = Array.from({ length: eventCount }, (_, i) =>
        sseEvent(i + 1, `event_${i + 1}`, {
          type: `event_${i + 1}`,
          data: "x".repeat(100),
        }),
      ).join("");

      // 랜덤 chunk 크기로 분할 (시드를 고정하여 재현 가능)
      const chunkSizes = [73, 150, 31, 200, 88, 42, 300, 17, 99, 250];
      const chunks: string[] = [];
      let pos = 0;
      let sizeIdx = 0;
      while (pos < fullStream.length) {
        const size = chunkSizes[sizeIdx % chunkSizes.length];
        chunks.push(fullStream.slice(pos, pos + size));
        pos += size;
        sizeIdx++;
      }

      // 증분 파싱
      let buffer = "";
      const allEvents: Array<{ id?: number; type?: string }> = [];
      for (const chunk of chunks) {
        buffer += chunk;
        const result = parseSSEBuffer(buffer);
        buffer = result.remaining;
        for (const event of result.parsed) {
          allEvents.push({ id: event.id, type: event.type });
        }
      }

      // 모든 이벤트가 파싱되어야 함
      expect(allEvents).toHaveLength(eventCount);

      // 모든 이벤트에 id가 있어야 함 (캐시 가능)
      const eventsWithId = allEvents.filter((e) => e.id !== undefined);
      expect(eventsWithId).toHaveLength(eventCount);

      // id가 순서대로 있어야 함
      for (let i = 0; i < eventCount; i++) {
        expect(allEvents[i].id).toBe(i + 1);
      }
    });
  });
});
