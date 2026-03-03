/**
 * SessionCache 테스트
 *
 * 세션별 이벤트를 JSONL 파일로 캐시하는 모듈 테스트.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile } from "fs/promises";
import { join } from "path";
import { SessionCache } from "./session-cache.js";

const TEST_CACHE_DIR = join(import.meta.dirname, "../.test-cache/sessions");

describe("SessionCache", () => {
  let cache: SessionCache;

  beforeEach(async () => {
    // 테스트 디렉토리 생성
    await mkdir(TEST_CACHE_DIR, { recursive: true });
    cache = new SessionCache({ cacheDir: TEST_CACHE_DIR });
  });

  afterEach(async () => {
    // 테스트 디렉토리 정리
    await rm(TEST_CACHE_DIR, { recursive: true, force: true });
  });

  describe("appendEvent", () => {
    it("이벤트를 JSONL 파일에 추가해야 한다", async () => {
      const sessionId = "test-session-123";
      const event = { type: "text_start", card_id: "card-1" };

      await cache.appendEvent(sessionId, 1, event);

      // 파일 직접 읽어서 확인
      const filePath = join(TEST_CACHE_DIR, `${sessionId}.jsonl`);
      const content = await readFile(filePath, "utf-8");
      const record = JSON.parse(content.trim());

      expect(record.id).toBe(1);
      expect(record.event).toEqual(event);
    });

    it("여러 이벤트를 순서대로 추가해야 한다", async () => {
      const sessionId = "test-session-multi";

      await cache.appendEvent(sessionId, 1, { type: "text_start" });
      await cache.appendEvent(sessionId, 2, { type: "text_delta", text: "Hello" });
      await cache.appendEvent(sessionId, 3, { type: "text_end" });

      const events = await cache.readEvents(sessionId);
      expect(events).toHaveLength(3);
      expect(events[0].id).toBe(1);
      expect(events[1].id).toBe(2);
      expect(events[2].id).toBe(3);
    });

    it("디렉토리가 없으면 자동으로 생성해야 한다", async () => {
      // 디렉토리 삭제
      await rm(TEST_CACHE_DIR, { recursive: true, force: true });

      const sessionId = "new-session";
      await cache.appendEvent(sessionId, 1, { type: "init" });

      const events = await cache.readEvents(sessionId);
      expect(events).toHaveLength(1);
    });
  });

  describe("readEvents", () => {
    it("존재하지 않는 세션은 빈 배열을 반환해야 한다", async () => {
      const events = await cache.readEvents("non-existent-session");
      expect(events).toEqual([]);
    });

    it("afterId 이후의 이벤트만 반환해야 한다", async () => {
      const sessionId = "test-session-filter";

      await cache.appendEvent(sessionId, 1, { type: "event1" });
      await cache.appendEvent(sessionId, 2, { type: "event2" });
      await cache.appendEvent(sessionId, 3, { type: "event3" });
      await cache.appendEvent(sessionId, 4, { type: "event4" });

      const events = await cache.readEvents(sessionId, 2);

      expect(events).toHaveLength(2);
      expect(events[0].id).toBe(3);
      expect(events[1].id).toBe(4);
    });

    it("afterId가 없으면 모든 이벤트를 반환해야 한다", async () => {
      const sessionId = "test-session-all";

      await cache.appendEvent(sessionId, 1, { type: "event1" });
      await cache.appendEvent(sessionId, 2, { type: "event2" });

      const events = await cache.readEvents(sessionId);
      expect(events).toHaveLength(2);
    });
  });

  describe("getLastEventId", () => {
    it("존재하지 않는 세션은 0을 반환해야 한다", async () => {
      const lastId = await cache.getLastEventId("non-existent");
      expect(lastId).toBe(0);
    });

    it("마지막 이벤트 ID를 반환해야 한다", async () => {
      const sessionId = "test-session-last";

      await cache.appendEvent(sessionId, 5, { type: "event1" });
      await cache.appendEvent(sessionId, 10, { type: "event2" });
      await cache.appendEvent(sessionId, 15, { type: "event3" });

      const lastId = await cache.getLastEventId(sessionId);
      expect(lastId).toBe(15);
    });
  });

  describe("deleteSession", () => {
    it("세션 캐시 파일을 삭제해야 한다", async () => {
      const sessionId = "test-session-delete";

      await cache.appendEvent(sessionId, 1, { type: "event1" });

      // 삭제 전 확인
      let events = await cache.readEvents(sessionId);
      expect(events).toHaveLength(1);

      // 삭제
      await cache.deleteSession(sessionId);

      // 삭제 후 확인
      events = await cache.readEvents(sessionId);
      expect(events).toHaveLength(0);
    });

    it("존재하지 않는 세션 삭제는 오류 없이 처리해야 한다", async () => {
      // 오류 없이 완료되어야 함
      await cache.deleteSession("non-existent");
    });
  });

  describe("path security", () => {
    it("경로 탈출 시도를 방지해야 한다", async () => {
      const maliciousId = "../../../etc/passwd";

      await cache.appendEvent(maliciousId, 1, { type: "test" });

      // 파일이 캐시 디렉토리 내에 생성되었는지 확인
      const events = await cache.readEvents(maliciousId);
      expect(events).toHaveLength(1);

      // 실제 경로가 캐시 디렉토리 내인지 확인 (sanitized)
      const sanitizedId = maliciousId.replace(/[^\w.\-]/g, "_");
      const filePath = join(TEST_CACHE_DIR, `${sanitizedId}.jsonl`);
      const content = await readFile(filePath, "utf-8");
      expect(content).toBeTruthy();
    });
  });
});
