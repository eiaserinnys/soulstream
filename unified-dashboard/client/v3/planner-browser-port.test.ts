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
