import { describe, expect, it, vi } from "vitest";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import { BrowserPlannerMutationPort } from "./planner-browser-port";

describe("BrowserPlannerMutationPort.createTaskIdentity", () => {
  it("uses one server call and requires the page and runbook aliases to match", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "task-uuid",
      pageId: "task-uuid",
      runbookId: "task-uuid",
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    const port = new BrowserPlannerMutationPort(
      {} as PageApiClient,
      fetchMock as typeof globalThis.fetch,
    );

    await expect(port.createTaskIdentity({
      title: "새 업무",
      description: "업무 설명",
      folderId: "folder-project",
      initialContext: {
        guidance: "검증 근거를 남긴다.",
        atomReferences: [{
          instance: "atom",
          nodeId: "node-soulstream",
          nodeTitle: "soulstream",
          depth: 4,
          titlesOnly: true,
        }],
      },
    })).resolves.toEqual({ id: "task-uuid" });

    expect(fetchMock).toHaveBeenCalledWith("/api/runbooks", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({
        title: "새 업무",
        description: "업무 설명",
        folder_id: "folder-project",
        initial_context: {
          guidance: "검증 근거를 남긴다.",
          atom_references: [{
            instance: "atom",
            node_id: "node-soulstream",
            node_title: "soulstream",
            depth: 4,
            titles_only: true,
          }],
        },
      }),
    }));
  });

  it("rejects a response that represents two identities", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "page-id",
      pageId: "page-id",
      runbookId: "runbook-id",
    }), { status: 201, headers: { "Content-Type": "application/json" } }));
    const port = new BrowserPlannerMutationPort(
      {} as PageApiClient,
      fetchMock as typeof globalThis.fetch,
    );

    await expect(port.createTaskIdentity({
      title: "분리된 업무",
      description: "",
      folderId: "folder-project",
    })).rejects.toThrow("업무 생성 응답의 ID가 일치하지 않습니다");
  });

  it("preserves the status of an expired write response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      detail: "Dashboard user is required",
    }), { status: 401, headers: { "Content-Type": "application/json" } }));
    const port = new BrowserPlannerMutationPort(
      {} as PageApiClient,
      fetchMock as typeof globalThis.fetch,
    );

    await expect(port.createTaskIdentity({
      title: "만료된 업무",
      description: "",
      folderId: "folder-project",
    })).rejects.toMatchObject({
      message: "Dashboard user is required",
      status: 401,
    });
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
        id: "task-bound",
        pageId: "task-bound",
        runbookId: "task-bound",
      }), { status: 201, headers: { "Content-Type": "application/json" } }));
    }
    globalThis.fetch = strictFetch as unknown as typeof globalThis.fetch;
    try {
      const port = new BrowserPlannerMutationPort({} as PageApiClient);
      await expect(port.createTaskIdentity({
        title: "바인딩 검증",
        description: "",
        folderId: "folder-x",
      })).resolves.toEqual({ id: "task-bound" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
