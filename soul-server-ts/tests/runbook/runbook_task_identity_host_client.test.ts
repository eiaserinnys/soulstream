import { afterEach, describe, expect, it, vi } from "vitest";

import { RunbookTaskIdentityHostClient } from "../../src/runbook/runbook_task_identity_host_client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RunbookTaskIdentityHostClient", () => {
  it("forwards initial context through the cross-node create wire", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "task-1",
      pageId: "task-1",
      runbookId: "task-1",
      snapshot: {},
      operation: {},
      pageOperation: {},
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RunbookTaskIdentityHostClient({
      orch: { baseUrl: "http://orch.local", headers: { authorization: "Bearer test" } },
      logger: { warn: vi.fn() } as never,
    });

    await client.create({
      actorKind: "user",
      actorUserId: "user@example.com",
      title: "컨텍스트 업무",
      folderId: "folder-a",
      initialContext: {
        guidance: "직접 지침",
        atomReferences: [{
          instance: "atom",
          nodeId: "node-a",
          nodeTitle: "soulstream",
          depth: 5,
          titlesOnly: true,
        }],
      },
      idempotencyKey: "create:user:context",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://orch.local/api/runbook-task-identities/host/create",
      expect.objectContaining({
        body: JSON.stringify({
          title: "컨텍스트 업무",
          folder_id: "folder-a",
          initial_context: {
            guidance: "직접 지침",
            atom_references: [{
              instance: "atom",
              node_id: "node-a",
              node_title: "soulstream",
              depth: 5,
              titles_only: true,
            }],
          },
          actor_kind: "user",
          actor_session_id: null,
          actor_user_id: "user@example.com",
          idempotency_key: "create:user:context",
        }),
      }),
    );
  });
});
