import { describe, expect, it } from "vitest";
import {
  classifyInternalLink,
  internalLinkPath,
  type InternalLinkTarget,
} from "./internal-link";

const INTERNAL_ORIGINS = ["https://soulstream.eiaserinnys.me"];

const classificationCases: Array<[string, InternalLinkTarget | null]> = [
  [
    "https://soulstream.eiaserinnys.me/api/markdown-documents/15fb44b0-bd32-46b7-a051-e8e2bd718be8",
    { kind: "document", documentId: "15fb44b0-bd32-46b7-a051-e8e2bd718be8" },
  ],
  [
    "/api/markdown-documents/15fb44b0-bd32-46b7-a051-e8e2bd718be8",
    { kind: "document", documentId: "15fb44b0-bd32-46b7-a051-e8e2bd718be8" },
  ],
  [
    "https://soulstream.eiaserinnys.me/?session=892c0435-7e36-453a-98e3-6adf54c26535",
    { kind: "session", sessionId: "892c0435-7e36-453a-98e3-6adf54c26535" },
  ],
  [
    "/?session=892c0435-7e36-453a-98e3-6adf54c26535&event=6",
    { kind: "session", sessionId: "892c0435-7e36-453a-98e3-6adf54c26535", eventId: "6" },
  ],
  [
    "/?session=892c0435-7e36-453a-98e3-6adf54c26535&event=abc",
    { kind: "session", sessionId: "892c0435-7e36-453a-98e3-6adf54c26535" },
  ],
  [
    "https://SoulStream.eiaserinnys.me/?card=2cd85ec5-acc6-44eb-8248-ca01dfda3d49",
    { kind: "card", cardId: "2cd85ec5-acc6-44eb-8248-ca01dfda3d49" },
  ],
  ["/?document=15fb44b0-bd32-46b7-a051-e8e2bd718be8", { kind: "document", documentId: "15fb44b0-bd32-46b7-a051-e8e2bd718be8" }],
  ["/?folder=claude", { kind: "folder", folderId: "claude" }],
  ["/?folder=page-runbook:3d36b10b-441d-42e5-b6ea-1887eea8ef53", { kind: "folder", folderId: "page-runbook:3d36b10b-441d-42e5-b6ea-1887eea8ef53" }],
  ["/?page=abc123", { kind: "page", pageId: "abc123" }],
  [
    "/api/attachments/asset-1/content?context_type=session&context_id=session-1",
    { kind: "attachment_asset", attachmentId: "asset-1", context: { type: "session", id: "session-1" } },
  ],
  [
    "https://soulstream.eiaserinnys.me/api/attachments/asset-2/content?context_type=owner",
    { kind: "attachment_asset", attachmentId: "asset-2", context: { type: "owner" } },
  ],
  [
    "/api/attachments/asset-3/content",
    { kind: "attachment_asset", attachmentId: "asset-3", context: null },
  ],
  [
    "/?attachment=asset-4&context_type=board_item&context_id=item-1",
    { kind: "attachment_asset", attachmentId: "asset-4", context: { type: "board_item", id: "item-1" } },
  ],
  [
    "/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fa%20b%2Fshot.PNG",
    { kind: "attachment", nodeId: "eiaserinnys", path: "/home/eias/a b/shot.PNG", isImage: true },
  ],
  [
    "/api/attachments/files?nodeId=eiaserinnys&path=%2Ftmp%2Fnote.md",
    { kind: "attachment", nodeId: "eiaserinnys", path: "/tmp/note.md", isImage: false },
  ],
  ["/api/attachments/files?nodeId=eiaserinnys", null],
  ["/api/attachments/worker/asset-1/content", null],
  ["/api/attachments/asset-1/content?download=true", null],
  ["/api/attachments/asset-1%2Fother/content", null],
  ["/api/attachments/asset-1/content?context_type=session", null],
  ["/api/attachments/asset-1/content?context_type=unknown&context_id=one", null],
  ["/api/attachments/asset-1/content?context_type=owner&context_id=one", null],
  ["/?attachment=bad%20id", null],
  ["https://example.com/api/attachments/asset-1/content", null],
  ["https://soulstream.eiaserinnys.me/browser/", null],
  ["/dialogues", null],
  ["/persistent/abc", null],
  ["/api/health", null],
  ["/", null],
  ["/?session=", null],
  ["/api/markdown-documents/", null],
  ["/api/markdown-documents/a/b", null],
  ["https://github.com/eiaserinnys/soulstream/pull/1", null],
  ["https://pages.eiaserinnys.me/d/x", null],
  ["https://soulstream.eiaserinnys.me.evil.example/?card=1", null],
  ["https://evil.example@soulstream.eiaserinnys.me/?card=1", null],
  ["//evil.example/?card=1", null],
  ["javascript:alert(1)", null],
  ["", null],
];

describe("classifyInternalLink", () => {
  it.each(classificationCases)("classifies %s", (href, expected) => {
    expect(classifyInternalLink(href, INTERNAL_ORIGINS)).toEqual(expected);
  });

  it("normalizes the configured origin's case and trailing slash", () => {
    expect(
      classifyInternalLink(
        "https://soulstream.eiaserinnys.me/api/markdown-documents/doc-1",
        ["https://soulstream.eiaserinnys.me/"],
      ),
    ).toEqual({ kind: "document", documentId: "doc-1" });
  });

  it("accepts relative targets when no internal origins are configured", () => {
    expect(classifyInternalLink("/?card=x1", [])).toEqual({ kind: "card", cardId: "x1" });
    expect(
      classifyInternalLink("https://soulstream.eiaserinnys.me/?card=x1", []),
    ).toBeNull();
  });

  it("uses the first valid target key in the specified priority order", () => {
    expect(
      classifyInternalLink(
        "/?page=page-1&folder=folder-1&document=document-1&card=card-1&session=session-1",
        INTERNAL_ORIGINS,
      ),
    ).toEqual({ kind: "session", sessionId: "session-1" });
    expect(
      classifyInternalLink("/?page=page-1&folder=folder-1&document=document-1&card=card-1", INTERNAL_ORIGINS),
    ).toEqual({ kind: "card", cardId: "card-1" });
    expect(
      classifyInternalLink("/?page=page-1&folder=folder-1&document=document-1", INTERNAL_ORIGINS),
    ).toEqual({ kind: "document", documentId: "document-1" });
    expect(classifyInternalLink("/?session=bad%20id&card=card-1&document=doc-1", INTERNAL_ORIGINS))
      .toEqual({ kind: "card", cardId: "card-1" });
    expect(classifyInternalLink("/?page=page-1&folder=folder-1", INTERNAL_ORIGINS))
      .toEqual({ kind: "folder", folderId: "folder-1" });
    expect(classifyInternalLink("/?attachment=asset-1&page=page-1", INTERNAL_ORIGINS))
      .toEqual({ kind: "page", pageId: "page-1" });
  });

  it("uses the first value for repeated query keys and rejects malformed encoding", () => {
    expect(classifyInternalLink("/?card=bad%20id&card=card-1", INTERNAL_ORIGINS)).toBeNull();
    expect(classifyInternalLink("/?card=card-1&card=card-2", INTERNAL_ORIGINS))
      .toEqual({ kind: "card", cardId: "card-1" });
    expect(classifyInternalLink("/?card=%E0%A4%A", INTERNAL_ORIGINS)).toBeNull();
  });

  it("decodes plus signs as spaces in query keys and values", () => {
    expect(
      classifyInternalLink(
        "/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Fmy+files%2Fnote.md",
        INTERNAL_ORIGINS,
      ),
    ).toEqual({ kind: "attachment", nodeId: "eiaserinnys", path: "/home/my files/note.md", isImage: false });
  });

  it("requires attachment node IDs and paths and classifies only the final image extension", () => {
    expect(classifyInternalLink("/api/attachments/files?nodeId=&path=%2Ftmp%2Fimage.png", INTERNAL_ORIGINS)).toBeNull();
    expect(classifyInternalLink("/api/attachments/files?nodeId=eiaserinnys&path=", INTERNAL_ORIGINS)).toBeNull();
    expect(classifyInternalLink("/api/attachments/files?nodeId=eiaserinnys&path=%2Ftmp%2Fimage.png%2Fnote", INTERNAL_ORIGINS))
      .toEqual({ kind: "attachment", nodeId: "eiaserinnys", path: "/tmp/image.png/note", isImage: false });
  });

  it("decodes and validates document path identifiers", () => {
    expect(classifyInternalLink("/api/markdown-documents/doc%3A1", INTERNAL_ORIGINS))
      .toEqual({ kind: "document", documentId: "doc:1" });
    expect(classifyInternalLink("/api/markdown-documents/%E0%A4%A", INTERNAL_ORIGINS)).toBeNull();
    expect(classifyInternalLink("/?card=-starts-with-dash", INTERNAL_ORIGINS)).toBeNull();
    expect(classifyInternalLink(`/?page=${"a".repeat(201)}`, INTERNAL_ORIGINS)).toBeNull();
  });

  it("ignores fragments when selecting a path and query", () => {
    expect(classifyInternalLink("/?card=card-1#/?session=session-2", INTERNAL_ORIGINS))
      .toEqual({ kind: "card", cardId: "card-1" });
    expect(classifyInternalLink("/?#card=card-1", INTERNAL_ORIGINS)).toBeNull();
  });
});

describe("internalLinkPath", () => {
  const pathCases: Array<[InternalLinkTarget, string | null]> = [
    [{ kind: "session", sessionId: "session:one", eventId: "6" }, "/?session=session%3Aone&event=6"],
    [{ kind: "session", sessionId: "session-1" }, "/?session=session-1"],
    [{ kind: "card", cardId: "card:one" }, "/?card=card%3Aone"],
    [{ kind: "document", documentId: "doc.one" }, "/?document=doc.one"],
    [{ kind: "folder", folderId: "folder-one" }, "/?folder=folder-one"],
    [{ kind: "page", pageId: "page_1" }, "/?page=page_1"],
    [{ kind: "attachment", nodeId: "node-1", path: "/tmp/image.png", isImage: true }, null],
    [{ kind: "attachment_asset", attachmentId: "asset:one", context: null }, "/?attachment=asset%3Aone"],
    [{ kind: "attachment_asset", attachmentId: "asset-1", context: { type: "owner" } }, "/?attachment=asset-1&context_type=owner"],
    [{ kind: "attachment_asset", attachmentId: "asset-1", context: { type: "card", id: "card one" } }, "/?attachment=asset-1&context_type=card&context_id=card%20one"],
  ];

  it.each(pathCases)("builds the canonical path for %s", (target, expected) => {
    expect(internalLinkPath(target)).toBe(expected);
  });

  it.each(pathCases.filter(([, path]) => path !== null))("round trips %s", (target) => {
    const path = internalLinkPath(target);
    expect(path).not.toBeNull();
    expect(classifyInternalLink(path!, [])).toEqual(target);
  });
});
