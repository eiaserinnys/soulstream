/**
 * SessionStore 테스트
 *
 * JSONL 파일 읽기 전용 기능을 검증합니다.
 * 플랫 파일 구조: {baseDir}/{agentSessionId}.jsonl
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SessionStore } from "./session-store.js";

const TEST_DIR = join(tmpdir(), "soul-dashboard-test-" + Date.now());

/** 플랫 구조로 JSONL 파일 생성 */
function createTestJsonl(
  agentSessionId: string,
  events: Array<{ id: number; event: Record<string, unknown> }>,
): void {
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(TEST_DIR, `${agentSessionId}.jsonl`), lines, "utf-8");
}

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    store = new SessionStore({ baseDir: TEST_DIR });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("listSessions", () => {
    it("should return empty array when no sessions exist", async () => {
      const sessions = await store.listSessions();
      expect(sessions).toEqual([]);
    });

    it("should return empty array when baseDir does not exist", async () => {
      const missingStore = new SessionStore({
        baseDir: join(TEST_DIR, "nonexistent"),
      });
      const sessions = await missingStore.listSessions();
      expect(sessions).toEqual([]);
    });

    it("should list sessions from JSONL files (flat structure)", async () => {
      createTestJsonl("sess-001", [
        { id: 1, event: { type: "progress", text: "Starting..." } },
        { id: 2, event: { type: "complete", result: "Done" } },
      ]);
      createTestJsonl("sess-002", [
        { id: 1, event: { type: "progress", text: "Working..." } },
      ]);

      const sessions = await store.listSessions();
      expect(sessions).toHaveLength(2);

      const sess1 = sessions.find((s) => s.agentSessionId === "sess-001");
      const sess2 = sessions.find((s) => s.agentSessionId === "sess-002");

      expect(sess1).toBeDefined();
      expect(sess1!.eventCount).toBe(2);
      expect(sess1!.lastEventType).toBe("complete");
      expect(sess1!.status).toBe("completed");

      expect(sess2).toBeDefined();
      expect(sess2!.eventCount).toBe(1);
      expect(sess2!.lastEventType).toBe("progress");
      expect(sess2!.status).toBe("running");
    });

    it("should extract prompt from first user_message", async () => {
      createTestJsonl("sess-prompt", [
        {
          id: 1,
          event: {
            type: "user_message",
            text: "대사 작업 스킬을 로드해줘",
            user: "dashboard",
          },
        },
        { id: 2, event: { type: "complete", result: "Done" } },
      ]);

      const sessions = await store.listSessions();
      const session = sessions.find(
        (s) => s.agentSessionId === "sess-prompt",
      );
      expect(session!.prompt).toBe("대사 작업 스킬을 로드해줘");
    });
  });

  describe("readEvents", () => {
    it("should return empty array for nonexistent session", async () => {
      const events = await store.readEvents("nonexistent-session");
      expect(events).toEqual([]);
    });

    it("should read all events from JSONL file", async () => {
      createTestJsonl("sess-001", [
        { id: 1, event: { type: "progress", text: "Step 1" } },
        { id: 2, event: { type: "text_start", card_id: "abc12345" } },
        {
          id: 3,
          event: {
            type: "text_delta",
            card_id: "abc12345",
            text: "Hello",
          },
        },
        { id: 4, event: { type: "text_end", card_id: "abc12345" } },
        { id: 5, event: { type: "complete", result: "Done" } },
      ]);

      const events = await store.readEvents("sess-001");
      expect(events).toHaveLength(5);
      expect(events[0].id).toBe(1);
      expect(events[0].event.type).toBe("progress");
      expect(events[4].id).toBe(5);
      expect(events[4].event.type).toBe("complete");
    });

    it("should skip corrupted lines", async () => {
      const content = [
        JSON.stringify({ id: 1, event: { type: "progress", text: "OK" } }),
        "THIS IS NOT VALID JSON",
        JSON.stringify({
          id: 2,
          event: { type: "complete", result: "Done" },
        }),
      ].join("\n");
      writeFileSync(
        join(TEST_DIR, "sess-corrupt.jsonl"),
        content,
        "utf-8",
      );

      const events = await store.readEvents("sess-corrupt");
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe(1);
      expect(events[1].id).toBe(2);
    });
  });

  describe("readEventsSince", () => {
    it("should return events after given ID", async () => {
      createTestJsonl("sess-001", [
        { id: 1, event: { type: "progress", text: "Step 1" } },
        { id: 2, event: { type: "progress", text: "Step 2" } },
        { id: 3, event: { type: "progress", text: "Step 3" } },
        { id: 4, event: { type: "complete", result: "Done" } },
      ]);

      const events = await store.readEventsSince("sess-001", 2);
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe(3);
      expect(events[1].id).toBe(4);
    });

    it("should return all events when afterId is 0", async () => {
      createTestJsonl("sess-001", [
        { id: 1, event: { type: "progress", text: "Step 1" } },
        { id: 2, event: { type: "complete", result: "Done" } },
      ]);

      const events = await store.readEventsSince("sess-001", 0);
      expect(events).toHaveLength(2);
    });

    it("should return empty when afterId is beyond last event", async () => {
      createTestJsonl("sess-001", [
        { id: 1, event: { type: "progress", text: "Step 1" } },
      ]);

      const events = await store.readEventsSince("sess-001", 100);
      expect(events).toEqual([]);
    });
  });

  describe("inferStatus", () => {
    it("should infer 'completed' for complete event", () => {
      expect(store.inferStatus("complete")).toBe("completed");
    });

    it("should infer 'completed' for result event", () => {
      expect(store.inferStatus("result")).toBe("completed");
    });

    it("should infer 'error' for error event", () => {
      expect(store.inferStatus("error")).toBe("error");
    });

    it("should infer 'running' for progress event", () => {
      expect(store.inferStatus("progress")).toBe("running");
    });

    it("should infer 'running' for text_delta event", () => {
      expect(store.inferStatus("text_delta")).toBe("running");
    });

    it("should infer 'unknown' for undefined", () => {
      expect(store.inferStatus(undefined)).toBe("unknown");
    });
  });

  describe("sessionPath", () => {
    it("should produce flat path from agentSessionId", () => {
      const path = store.sessionPath("sess-abc-123");
      expect(path).toBe(join(TEST_DIR, "sess-abc-123.jsonl"));
    });

    it("should sanitize path components to prevent traversal", () => {
      const path = store.sessionPath("../etc/passwd");
      // "/" is replaced with "_" so traversal is prevented
      // Result: ".._etc_passwd.jsonl" — stays in baseDir
      expect(path).toBe(join(TEST_DIR, ".._etc_passwd.jsonl"));
    });
  });
});
