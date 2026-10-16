import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AttachmentDescriptor,
  AttachmentReadContext,
  SessionEventAttachmentResponse,
  SessionEventAttachmentView,
} from "@soulstream/wire-schema/attachments";
import {
  attachmentContentUrl,
  contextualLegacyUrl,
  loadChatAttachments,
  projectChatAttachmentItems,
} from "./chat-attachment-model";

const sessionContext: AttachmentReadContext = { type: "session", id: "session-a" };

function descriptor(overrides: Partial<AttachmentDescriptor> = {}): AttachmentDescriptor {
  return {
    attachment_id: "asset-a",
    name: "화면.png",
    mime_type: "image/png",
    byte_size: 12,
    checksum_sha256: null,
    width: 2,
    height: 3,
    preview_kind: "image",
    preview_mime_type: "image/png",
    ...overrides,
  };
}

function assetView(
  attachmentId: string,
  context: AttachmentReadContext,
  overrides: Partial<AttachmentDescriptor> = {},
): SessionEventAttachmentView {
  return {
    kind: "asset",
    descriptor: descriptor({ attachment_id: attachmentId, ...overrides }),
    read_context: context as Extract<AttachmentReadContext, { type: "session" }>,
    legacy_sources: [],
  };
}

describe("chat attachment model", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads a session event projection with same-origin credentials and no token query", async () => {
    const responseBody: SessionEventAttachmentResponse = { event_id: 42, items: [] };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => responseBody }) as Response);
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(loadChatAttachments({ sessionId: "session / one", eventId: 42, signal }))
      .resolves.toBe(responseBody);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session%20%2F%20one/events/42/attachments",
      { credentials: "same-origin", signal },
    );
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("token");
  });

  it("uses the same event URL for live and history reads", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ event_id: 42, items: [] }) }) as Response);
    vi.stubGlobal("fetch", fetchMock);

    await loadChatAttachments({ sessionId: "session-a", eventId: 42 });
    await loadChatAttachments({ sessionId: "session-a", eventId: 42 });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/sessions/session-a/events/42/attachments",
      "/api/sessions/session-a/events/42/attachments",
    ]);
  });

  it("builds asset and legacy URLs with the supplied read context", () => {
    expect(attachmentContentUrl("asset/a", sessionContext)).toBe(
      "/api/attachments/asset%2Fa/content?context_type=session&context_id=session-a",
    );
    expect(attachmentContentUrl("asset-a", sessionContext, true)).toContain("download=true");
    expect(contextualLegacyUrl("node / one", "/incoming/a b.png", sessionContext, true)).toBe(
      "/api/attachments/files?nodeId=node%20%2F%20one&path=%2Fincoming%2Fa%20b.png&context_type=session&context_id=session-a&download=true",
    );
  });

  it("projects mixed attachment views in source order with explicit availability", () => {
    const items = projectChatAttachmentItems({
      event_id: 42,
      items: [
        assetView("asset-a", sessionContext),
        {
          kind: "legacy",
          node_id: "node-a",
          path: "/incoming/note.txt",
          name: "note.txt",
          mime_type: null,
          byte_size: null,
          availability: "unresolved",
          read_context: sessionContext as Extract<AttachmentReadContext, { type: "session" }>,
        },
        {
          kind: "legacy",
          node_id: "node-a",
          path: "/incoming/gone.png",
          name: "gone.png",
          mime_type: null,
          byte_size: null,
          availability: "missing",
          read_context: sessionContext as Extract<AttachmentReadContext, { type: "session" }>,
        },
        {
          kind: "unavailable",
          attachment_id: "asset-unavailable",
          name: null,
          availability: "unavailable",
          read_context: sessionContext as Extract<AttachmentReadContext, { type: "session" }>,
        },
        {
          kind: "unavailable_legacy",
          path: "/incoming/no-node.txt",
          name: "no-node.txt",
          availability: "unavailable",
          read_context: sessionContext as Extract<AttachmentReadContext, { type: "session" }>,
        },
      ],
    });

    expect(items.map((item) => item.availability)).toEqual([
      "ready", "unresolved", "missing", "unavailable", "unavailable",
    ]);
    expect(items.map((item) => item.key)).toEqual([
      "asset:asset-a",
      'legacy:["node-a","/incoming/note.txt"]',
      'legacy:["node-a","/incoming/gone.png"]',
      "asset:asset-unavailable",
      'legacy-unavailable:"/incoming/no-node.txt"',
    ]);
    expect(items[0]).toMatchObject({
      previewKind: "image",
      previewUrl: "/api/attachments/asset-a/content?context_type=session&context_id=session-a",
      originalUrl: "/api/attachments/asset-a/content?context_type=session&context_id=session-a&download=true",
      source: { kind: "asset", attachmentId: "asset-a", context: sessionContext },
    });
    expect(items[1]?.originalUrl).toContain("context_id=session-a");
    expect(items[2]?.originalUrl).toBeNull();
    expect(items[3]).toMatchObject({ name: null, mimeType: null, byteSize: null, originalUrl: null });
    expect(items[4]?.originalUrl).toBeNull();
  });
});
