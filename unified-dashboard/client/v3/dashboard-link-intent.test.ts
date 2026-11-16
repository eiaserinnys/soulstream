import { describe, expect, it, vi } from "vitest";
import { consumeDashboardLinkIntent, readDashboardLinkIntent, runSessionIntentOpen } from "./dashboard-link-intent";

const ORIGINS = ["https://soulstream.eiaserinnys.me"];

describe("dashboard link intent", () => {
  it.each([
    ["session", "/", "?keep=1&session=session-1&event=7", "#return", { kind: "session", sessionId: "session-1", eventId: "7" }],
    ["card", "/", "?keep=1&card=card-1", "#return", { kind: "card", cardId: "card-1" }],
    ["document query", "/", "?document=doc-1", "", { kind: "document", documentId: "doc-1" }],
    ["document API path", "/api/markdown-documents/doc-1", "", "", { kind: "document", documentId: "doc-1" }],
    ["folder", "/", "?folder=folder-1", "", { kind: "folder", folderId: "folder-1" }],
    ["page", "/", "?page=page-1", "", { kind: "page", pageId: "page-1" }],
    ["asset attachment", "/", "?attachment=attachment-1&context_type=card&context_id=card-1", "#return", { kind: "attachment_asset", attachmentId: "attachment-1", context: { type: "card", id: "card-1" } }],
  ])("reads the %s intent through the shared classifier", (_name, pathname, search, hash, target) => {
    expect(readDashboardLinkIntent({ pathname, search, hash }, ORIGINS)).toMatchObject({
      target,
      identity: `${pathname}${search}${hash}`,
      legacy: false,
    });
  });

  it("reads the old feed hash only through the session search contract", () => {
    expect(readDashboardLinkIntent({ pathname: "/", search: "?keep=1", hash: "#/feed/session-1?event=7" }, ORIGINS))
      .toMatchObject({
        target: { kind: "session", sessionId: "session-1", eventId: "7" },
        legacy: true,
      });
  });

  it("removes only the successful intent and preserves other query values and hashes", () => {
    const intent = readDashboardLinkIntent({ pathname: "/", search: "?keep=1&card=card-1&keep=2", hash: "#return" }, ORIGINS)!;
    expect(consumeDashboardLinkIntent(`https://soulstream.eiaserinnys.me${intent.identity}`, intent))
      .toBe("/?keep=1&keep=2#return");
  });

  it("removes only session and event from a successful session intent", () => {
    const intent = readDashboardLinkIntent({ pathname: "/", search: "?keep=1&session=session-1&event=7", hash: "#return" }, ORIGINS)!;
    expect(consumeDashboardLinkIntent(`https://soulstream.eiaserinnys.me${intent.identity}`, intent))
      .toBe("/?keep=1#return");
  });

  it("removes attachment and its context from a successful attachment intent", () => {
    const intent = readDashboardLinkIntent({ pathname: "/", search: "?keep=1&attachment=attachment-1&context_type=card&context_id=card-1", hash: "#return" }, ORIGINS)!;
    expect(consumeDashboardLinkIntent(`https://soulstream.eiaserinnys.me${intent.identity}`, intent))
      .toBe("/?keep=1#return");
  });

  it("uses the existing search-contract cleanup for the legacy feed hash", () => {
    const intent = readDashboardLinkIntent({ pathname: "/", search: "?keep=1", hash: "#/feed/session-1?event=7" }, ORIGINS)!;
    expect(consumeDashboardLinkIntent(`https://soulstream.eiaserinnys.me${intent.identity}`, intent))
      .toBe("/?keep=1");
  });

  it("returns no intent for unrelated paths and query keys", () => {
    expect(readDashboardLinkIntent({ pathname: "/components", search: "?keep=1", hash: "#sample" }, ORIGINS)).toBeNull();
  });
});

describe("session intent wait", () => {
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function wait(rememberedChatTab = false) {
    return {
      inFlight: { current: true },
      pending: { current: true },
      rememberedChatTab: { current: rememberedChatTab },
    };
  }

  it("settles the wait and reports the remembered chat tab when the open succeeds", async () => {
    const refs = wait(true);
    const onOpened = vi.fn();
    runSessionIntentOpen(async () => true, refs, onOpened);
    await settle();

    expect(onOpened).toHaveBeenCalledWith(true, true);
    expect(refs.inFlight.current).toBe(false);
    expect(refs.pending.current).toBe(false);
    expect(refs.rememberedChatTab.current).toBe(false);
  });

  it("settles the wait when the open returns false", async () => {
    const refs = wait(true);
    const onOpened = vi.fn();
    runSessionIntentOpen(async () => false, refs, onOpened);
    await settle();

    expect(onOpened).toHaveBeenCalledWith(false, true);
    expect(refs.inFlight.current).toBe(false);
    expect(refs.pending.current).toBe(false);
    expect(refs.rememberedChatTab.current).toBe(false);
  });

  it("settles the wait when the open throws instead of leaving the tab presses swallowed", async () => {
    const refs = wait(true);
    const onOpened = vi.fn();
    runSessionIntentOpen(() => Promise.reject(new Error("opener failed")), refs, onOpened);
    await settle();

    // 예외는 거짓으로 끝난 것과 같다: 성공 경로를 부르지 않고 대기 표시만 푼다.
    expect(onOpened).not.toHaveBeenCalled();
    expect(refs.inFlight.current).toBe(false);
    expect(refs.pending.current).toBe(false);
    expect(refs.rememberedChatTab.current).toBe(false);
  });
});
