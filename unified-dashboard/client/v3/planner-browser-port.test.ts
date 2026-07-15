import { describe, expect, it, vi } from "vitest";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { BrowserPlannerMutationPort } from "./planner-browser-port";

describe("BrowserPlannerMutationPort.createRunbook", () => {
  it("uses the PR-A browser contract and extracts the created runbook id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      snapshot: { runbook: { id: "rb-created" } },
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const port = new BrowserPlannerMutationPort(
      {} as PageApiClient,
      fetchMock as typeof globalThis.fetch,
    );

    await expect(port.createRunbook({
      title: "새 업무",
      folderId: "folder-project",
    })).resolves.toEqual({ runbookId: "rb-created" });

    expect(fetchMock).toHaveBeenCalledWith("/api/runbooks", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ title: "새 업무", folder_id: "folder-project" }),
    }));
  });
});

describe("BrowserPlannerMutationPort default fetch binding", () => {
  it("calls the default fetch with a window-compatible this (no Illegal invocation)", async () => {
    // 브라우저 fetch는 this가 window/undefined가 아니면 Illegal invocation을 던진다.
    // 클래스 필드에 unbound fetch를 저장하면 this가 인스턴스가 되어 재현된다 — 회귀 방지.
    const originalFetch = globalThis.fetch;
    function strictFetch(this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(new Response(JSON.stringify({
        snapshot: { runbook: { id: "rb-bound" } },
      }), { status: 201, headers: { "Content-Type": "application/json" } }));
    }
    globalThis.fetch = strictFetch as unknown as typeof globalThis.fetch;
    try {
      const port = new BrowserPlannerMutationPort({} as PageApiClient);
      await expect(port.createRunbook({ title: "바인딩 검증", folderId: "folder-x" }))
        .resolves.toEqual({ runbookId: "rb-bound" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
