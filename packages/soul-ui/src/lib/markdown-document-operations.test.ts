import { describe, expect, it, vi } from "vitest";

import { renameMarkdownDocument } from "./markdown-document-operations";

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
