import { describe, expect, it, vi, afterEach } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { DashboardAgentConfig } from "@seosoyoung/soul-ui";

import { createDashboardSession } from "./session-create";

const queryClient = {} as QueryClient;

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createDashboardSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the existing session creation payload and focuses the optimistic session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      agentSessionId: "session-new",
      status: "running",
      nodeId: "node-a",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const addOptimisticSession = vi.fn();
    const agent: DashboardAgentConfig = {
      id: "roselin_codex",
      name: "Roselin",
      hasPortrait: true,
      portraitUrl: "/portrait",
      backend: "codex",
    };

    const result = await createDashboardSession({
      queryClient,
      addOptimisticSession,
      prompt: "세션 session-a의 기록을 조회해 맥락을 파악한 뒤, 사용자의 지시를 대기해주세요.",
      folderId: "folder-a",
      nodeId: "node-a",
      agentId: "roselin_codex",
      agent,
    });

    expect(result.agentSessionId).toBe("session-new");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "세션 session-a의 기록을 조회해 맥락을 파악한 뒤, 사용자의 지시를 대기해주세요.",
        nodeId: "node-a",
        folderId: "folder-a",
        profile: "roselin_codex",
      }),
    });
    expect(addOptimisticSession).toHaveBeenCalledWith(
      queryClient,
      "session-new",
      "세션 session-a의 기록을 조회해 맥락을 파악한 뒤, 사용자의 지시를 대기해주세요.",
      "folder-a",
      "node-a",
      "roselin_codex",
      "Roselin",
      "/portrait",
      "codex",
      null,
    );
  });

  it("surfaces server errors and does not add an optimistic session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorJson(503, {
      detail: "target node unavailable",
    })));
    const addOptimisticSession = vi.fn();

    await expect(createDashboardSession({
      queryClient,
      addOptimisticSession,
      prompt: "hello",
      folderId: "folder-a",
      nodeId: "node-a",
      agentId: "roselin_codex",
    })).rejects.toThrow("target node unavailable");

    expect(addOptimisticSession).not.toHaveBeenCalled();
  });

  it("sends explicit null folder id when the source session has no folder", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      agentSessionId: "session-new",
      status: "running",
      nodeId: "node-a",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createDashboardSession({
      queryClient,
      addOptimisticSession: vi.fn(),
      prompt: "hello",
      folderId: null,
      nodeId: "node-a",
      agentId: "roselin_codex",
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      prompt: "hello",
      folderId: null,
      nodeId: "node-a",
      profile: "roselin_codex",
    });
  });

  it("sends sourceSessionId so the server can inherit the original board container", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({
      agentSessionId: "session-new",
      status: "running",
      nodeId: "node-a",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createDashboardSession({
      queryClient,
      addOptimisticSession: vi.fn(),
      prompt: "hello",
      folderId: "folder-a",
      nodeId: "node-a",
      agentId: "roselin_codex",
      sourceSessionId: "source-session",
    });

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      prompt: "hello",
      folderId: "folder-a",
      nodeId: "node-a",
      profile: "roselin_codex",
      sourceSessionId: "source-session",
    });
  });
});
