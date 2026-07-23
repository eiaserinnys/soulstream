import { describe, expect, it, vi } from "vitest";

import {
  deleteMarkdownDocument,
  renameMarkdownDocument,
  updateMarkdownDocument,
} from "./markdown-document-operations";

describe("renameMarkdownDocument", () => {
  it("uses the existing versioned markdown PUT contract", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "doc-1",
      title: "새 이름",
      body: "",
      version: 4,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(renameMarkdownDocument({
      documentId: "doc-1",
      title: "새 이름",
      expectedVersion: 3,
    }, fetchMock as typeof globalThis.fetch)).resolves.toMatchObject({
      title: "새 이름",
      version: 4,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/markdown-documents/doc-1",
      expect.objectContaining({
        method: "PUT",
        credentials: "same-origin",
        body: JSON.stringify({ title: "새 이름", expectedVersion: 3 }),
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/markdown-documents/doc-1",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports version conflicts without hiding the failed rename", async () => {
    const fetchMock = vi.fn(async () => new Response("conflict", { status: 409 }));

    await expect(renameMarkdownDocument({
      documentId: "doc-1",
      title: "새 이름",
      expectedVersion: 3,
    }, fetchMock as typeof globalThis.fetch)).rejects.toThrow("다른 곳에서 변경");
  });
});

describe("updateMarkdownDocument", () => {
  it("confirms title and body through a server reread before reporting success", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "doc-1", title: "결정", body: "# 수정", version: 3,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "doc-1", title: "결정", body: "# 수정", version: 3,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(updateMarkdownDocument({
      documentId: "doc-1",
      title: "결정",
      body: "# 수정",
      expectedVersion: 2,
    }, fetchMock as typeof globalThis.fetch)).resolves.toMatchObject({
      title: "결정",
      body: "# 수정",
      version: 3,
    });
    expect(fetchMock.mock.calls.map(([, init]) => init?.method ?? "GET"))
      .toEqual(["PUT", "GET"]);
  });

  it("rejects a save that the server reread does not confirm", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "doc-1", title: "결정", body: "# 수정", version: 3,
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "doc-1", title: "결정", body: "# 이전", version: 2,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(updateMarkdownDocument({
      documentId: "doc-1",
      title: "결정",
      body: "# 수정",
      expectedVersion: 2,
    }, fetchMock as typeof globalThis.fetch)).rejects.toThrow("서버 재조회");
  });
});

describe("deleteMarkdownDocument", () => {
  it("reuses the existing DELETE route and reports server failures", async () => {
    const success = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(deleteMarkdownDocument("doc/1", success)).resolves.toBeUndefined();
    expect(success).toHaveBeenCalledWith(
      "/api/markdown-documents/doc%2F1",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );

    const failure = vi.fn(async () => new Response(null, { status: 503 }));
    await expect(deleteMarkdownDocument("doc-1", failure))
      .rejects.toThrow("마크다운 문서를 삭제하지 못했습니다 (503)");
  });
});
