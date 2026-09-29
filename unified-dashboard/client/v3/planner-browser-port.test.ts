import { describe, expect, it, vi } from "vitest";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { BrowserPlannerMutationPort } from "./planner-browser-port";

describe("BrowserPlannerMutationPort folder creation", () => {
  it("creates a checklist enabled folder and returns its distinct page identity", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => new Response(JSON.stringify({
      folder: { id: "folder-a", projectPageId: "page-a" },
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const port = new BrowserPlannerMutationPort({} as PageApiClient, fetchMock as typeof fetch);

    await expect(port.createFolderIdentity({
      title: "새 업무", description: "업무 설명", folderId: "parent-a",
    })).resolves.toEqual({ id: "folder-a", pageId: "page-a" });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/folders");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "새 업무", description: "업무 설명", parentFolderId: "parent-a",
      checklistEnabled: true, idempotencyKey: expect.any(String),
    });
  });

  it("rejects a response without the folder page identity", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ folder: { id: "folder-a" } }), {
      status: 201, headers: { "Content-Type": "application/json" },
    }));
    const port = new BrowserPlannerMutationPort({} as PageApiClient, fetchMock as typeof fetch);
    await expect(port.createFolderIdentity({ title: "새 업무", description: "", folderId: "parent-a" }))
      .rejects.toThrow("폴더 또는 페이지 ID");
  });

  it("preserves an authentication failure status", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ detail: "Dashboard user is required" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    }));
    const port = new BrowserPlannerMutationPort({} as PageApiClient, fetchMock as typeof fetch);
    await expect(port.createFolderIdentity({ title: "새 업무", description: "", folderId: "parent-a" }))
      .rejects.toMatchObject({ message: "Dashboard user is required", status: 401 });
  });
});
