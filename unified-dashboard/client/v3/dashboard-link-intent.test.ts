import { describe, expect, it } from "vitest";
import { consumeDashboardLinkIntent, readDashboardLinkIntent } from "./dashboard-link-intent";

const ORIGINS = ["https://soulstream.eiaserinnys.me"];

describe("dashboard link intent", () => {
  it.each([
    ["session", "/", "?keep=1&session=session-1&event=7", "#return", { kind: "session", sessionId: "session-1", eventId: "7" }],
    ["card", "/", "?keep=1&card=card-1", "#return", { kind: "card", cardId: "card-1" }],
    ["document query", "/", "?document=doc-1", "", { kind: "document", documentId: "doc-1" }],
    ["document API path", "/api/markdown-documents/doc-1", "", "", { kind: "document", documentId: "doc-1" }],
    ["folder", "/", "?folder=folder-1", "", { kind: "folder", folderId: "folder-1" }],
    ["page", "/", "?page=page-1", "", { kind: "page", pageId: "page-1" }],
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

  it("uses the existing search-contract cleanup for the legacy feed hash", () => {
    const intent = readDashboardLinkIntent({ pathname: "/", search: "?keep=1", hash: "#/feed/session-1?event=7" }, ORIGINS)!;
    expect(consumeDashboardLinkIntent(`https://soulstream.eiaserinnys.me${intent.identity}`, intent))
      .toBe("/?keep=1");
  });

  it("returns no intent for unrelated paths and query keys", () => {
    expect(readDashboardLinkIntent({ pathname: "/components", search: "?keep=1", hash: "#sample" }, ORIGINS)).toBeNull();
  });
});
