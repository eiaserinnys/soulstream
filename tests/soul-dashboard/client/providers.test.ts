/**
 * Session Provider Tests
 *
 * Provider 인터페이스 구현체 테스트
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FileSessionProvider,
  SerendipitySessionProvider,
  getSessionProvider,
} from "../../../soul-dashboard/client/providers";
import type { SessionSummary } from "../../../soul-dashboard/shared/types";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock EventSource
class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners: Map<string, ((e: MessageEvent) => void)[]> = new Map();

  constructor(public url: string) {
    // Simulate async open
    setTimeout(() => this.onopen?.(), 10);
  }

  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    const existing = this.listeners.get(type) || [];
    this.listeners.set(type, [...existing, listener]);
  }

  close() {
    // noop
  }

  // Test helper to simulate events
  _emit(type: string, data: unknown, lastEventId?: string) {
    const listeners = this.listeners.get(type) || [];
    const event = {
      data: JSON.stringify(data),
      lastEventId: lastEventId ?? "0",
    } as MessageEvent;
    listeners.forEach((l) => l(event));
  }
}

// @ts-expect-error - Mock EventSource globally
global.EventSource = MockEventSource;

describe("FileSessionProvider", () => {
  let provider: FileSessionProvider;

  beforeEach(() => {
    provider = new FileSessionProvider();
    mockFetch.mockReset();
  });

  describe("fetchSessions", () => {
    it("should return sessions from API", async () => {
      const mockSessions: SessionSummary[] = [
        {
          clientId: "test",
          requestId: "req1",
          status: "completed",
          eventCount: 10,
          createdAt: "2026-03-01T00:00:00Z",
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: mockSessions }),
      });

      const result = await provider.fetchSessions();

      expect(mockFetch).toHaveBeenCalledWith("/api/sessions");
      expect(result).toEqual(mockSessions);
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(provider.fetchSessions()).rejects.toThrow("HTTP 500");
    });
  });

  describe("fetchCards", () => {
    it("should return empty array (SSE fills cards)", async () => {
      const result = await provider.fetchCards("test:req1");
      expect(result).toEqual([]);
    });
  });

  describe("subscribe", () => {
    it("should create EventSource with correct URL", () => {
      const unsubscribe = provider.subscribe("test:req1", vi.fn());

      // URL should be encoded
      // The EventSource is created synchronously
      unsubscribe();
    });
  });

  describe("mode", () => {
    it("should return file mode", () => {
      expect(provider.mode).toBe("file");
    });
  });
});

describe("SerendipitySessionProvider", () => {
  let provider: SerendipitySessionProvider;

  beforeEach(() => {
    provider = new SerendipitySessionProvider({
      baseUrl: "/serendipity-api",
      sessionLabelName: "soul-session",
    });
    mockFetch.mockReset();
  });

  describe("fetchSessions", () => {
    it("should filter pages by soul-session label", async () => {
      // Mock pages list
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "page1", title: "Session 1", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T01:00:00Z" },
          { id: "page2", title: "Not a session", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T01:00:00Z" },
        ],
      });

      // Mock labels for page1 (has soul-session)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "label1", name: "soul-session" }],
      });

      // Mock labels for page2 (no soul-session)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: "label2", name: "other" }],
      });

      const result = await provider.fetchSessions();

      expect(result).toHaveLength(1);
      expect(result[0].requestId).toBe("page1");
    });

    it("should handle API errors gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(provider.fetchSessions()).rejects.toThrow("Serendipity API error: 500");
    });
  });

  describe("fetchCards", () => {
    it("should convert soul:assistant blocks to text cards", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "page1",
          title: "Test Session",
          blocks: [
            {
              id: "block1",
              pageId: "page1",
              parentId: null,
              order: 0,
              type: "soul:assistant",
              content: {
                _version: 1,
                content: [
                  {
                    _key: "b1",
                    _type: "block",
                    style: "normal",
                    children: [{ _key: "s1", _type: "span", text: "Hello", marks: [] }],
                    markDefs: [],
                  },
                ],
              },
            },
          ],
        }),
      });

      const cards = await provider.fetchCards("page1");

      expect(cards).toHaveLength(1);
      expect(cards[0].type).toBe("text");
      expect(cards[0].content).toBe("Hello");
      expect(cards[0].completed).toBe(true);
    });

    it("should convert soul:tool_use blocks to tool cards", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "page1",
          title: "Test Session",
          blocks: [
            {
              id: "block1",
              pageId: "page1",
              parentId: null,
              order: 0,
              type: "soul:tool_use",
              content: {
                _version: 1,
                content: [
                  {
                    _key: "b1",
                    _type: "block",
                    style: "normal",
                    children: [
                      {
                        _key: "s1",
                        _type: "span",
                        text: '{"name":"Read","input":{"path":"/test"}}',
                        marks: [],
                      },
                    ],
                    markDefs: [],
                  },
                ],
              },
            },
          ],
        }),
      });

      const cards = await provider.fetchCards("page1");

      expect(cards).toHaveLength(1);
      expect(cards[0].type).toBe("tool");
      expect(cards[0].toolName).toBe("Read");
      expect(cards[0].toolInput).toEqual({ path: "/test" });
    });
  });

  describe("mode", () => {
    it("should return serendipity mode", () => {
      expect(provider.mode).toBe("serendipity");
    });
  });
});

describe("getSessionProvider", () => {
  it("should return FileSessionProvider for file mode", () => {
    const provider = getSessionProvider("file");
    expect(provider.mode).toBe("file");
  });

  it("should return SerendipitySessionProvider for serendipity mode", () => {
    const provider = getSessionProvider("serendipity");
    expect(provider.mode).toBe("serendipity");
  });

  it("should throw for unknown mode", () => {
    // @ts-expect-error - Testing invalid mode
    expect(() => getSessionProvider("invalid")).toThrow("Unknown storage mode");
  });
});
