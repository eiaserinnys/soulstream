import { describe, expect, it, vi } from "vitest";

import {
  InMemoryNodeRegistry,
  createLiveDbCatalogRepository,
  type LivePostgresSql,
} from "../src/index.js";

describe("live DB SSE replay snapshots", () => {
  it("loads session snapshots from DB with Python session response wire keys", async () => {
    const registry = new InMemoryNodeRegistry();
    registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      agents: [
        {
          id: "agent-a",
          name: "Agent A",
          backend: "codex",
          portrait_url: "/agent-a.png",
        },
      ],
    });
    const harness = createSqlHarness((text) => {
      if (text.includes("session_count")) return [{ count: 1 }];
      if (text.includes("session_get_all")) {
        return [
          {
            session_id: "sess-1",
            status: "running",
            prompt: "hello",
            created_at: new Date("2026-07-09T00:00:00.000Z"),
            updated_at: new Date("2026-07-09T00:01:00.000Z"),
            session_type: "codex",
            last_message: { text: "last" },
            client_id: "client-1",
            metadata: {
              caller_info: {
                source: "slack",
                display_name: "서소영",
                avatar_url: "/avatar.png",
              },
            },
            display_name: "Display",
            node_id: "node-a",
            folder_id: "folder-1",
            last_event_id: 7,
            last_read_event_id: 5,
            caller_session_id: "caller-1",
            agent_id: "agent-a",
          },
        ];
      }
      if (text.includes("FROM session_page_bindings")) {
        return [{
          session_id: "sess-1",
          page_state: "manual_repair",
          legacy_state: "pending",
        }];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({
      sql: harness.sql,
      registry,
    });

    await expect(repository.loadSessionSnapshot()).resolves.toEqual({
      sessions: [
        {
          agentSessionId: "sess-1",
          status: "running",
          reviewRequired: false,
          reviewState: "not_required",
          bindingWarnings: [
            {
              code: "PAGE_BINDING_MANUAL_REPAIR",
              message: "The session was created, but its page block could not be converted automatically. Manual repair is required.",
            },
            {
              code: "LEGACY_PROJECTION_PENDING",
              message: "The session was created. Its legacy folder projection is pending and will retry automatically.",
            },
          ],
          prompt: "hello",
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:01:00.000Z",
          sessionType: "codex",
          lastMessage: { text: "last" },
          clientId: "client-1",
          metadata: {
            caller_info: {
              source: "slack",
              display_name: "서소영",
              avatar_url: "/avatar.png",
            },
          },
          displayName: "Display",
          nodeId: "node-a",
          folderId: "folder-1",
          lastEventId: 7,
          lastReadEventId: 5,
          callerSessionId: "caller-1",
          agentId: "agent-a",
          agentName: "Agent A",
          agentPortraitUrl: "/api/nodes/node-a/agents/agent-a/portrait",
          backend: "codex",
          userName: "서소영",
          userPortraitUrl: "/avatar.png",
        },
      ],
      total: 1,
    });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT session_count(?::jsonb) AS count",
      "SELECT * FROM session_get_all(?::jsonb, ?, ?)",
      "SELECT session_id, page_state, legacy_state FROM session_page_bindings WHERE session_id = ANY(?::text[])",
    ]);
  });

  it("loads restricted feed-only session snapshots from the first allowed folder", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("FROM folders")) {
        return [
          { id: "root", parent_folder_id: null },
          { id: "child", parent_folder_id: "root" },
        ];
      }
      if (text.includes("session_count")) return [{ count: 0 }];
      if (text.includes("session_get_all")) return [];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.loadSessionSnapshot({
        access: { restricted: true, allowedFolderIds: ["root"] },
        feedOnly: true,
      }),
    ).resolves.toEqual({ sessions: [], total: 0 });

    const filterValues = harness.calls
      .filter((call) => call.text.includes("session_"))
      .map((call) => (call.values[0] as { jsonValue: unknown }).jsonValue);
    expect(filterValues).toEqual([
      { folder_id: "root", feed_only: true },
      { folder_id: "root", feed_only: true },
    ]);
  });

  it("returns an empty restricted session snapshot when no allowed folder exists", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("FROM folders")) return [{ id: "root", parent_folder_id: null }];
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(
      repository.loadSessionSnapshot({
        access: { restricted: true, allowedFolderIds: ["missing"] },
      }),
    ).resolves.toEqual({ sessions: [], total: 0 });
    expect(harness.normalizedCalls()).toEqual([
      "SELECT id, parent_folder_id, settings FROM folders",
    ]);
  });

  it("loads task snapshots with linked session serialization", async () => {
    const harness = createSqlHarness((text) => {
      if (text.includes("COUNT(*)::int")) return [{ count: 1 }];
      if (text.includes("FROM task_items") && !text.includes("COUNT")) {
        return [
          {
            id: "task-1",
            parent_id: null,
            position_key: 1,
            title: "Task",
            description: "Desc",
            acceptance_criteria: "Done",
            verification_owner: "agent",
            status: "open",
            linked_session_id: "sess-linked",
            linked_node_id: "node-a",
            active_for_session_id: null,
            created_from_session_id: null,
            created_from_event_id: null,
            navigation_session_id: null,
            navigation_node_id: null,
            navigation_event_id: null,
            archived: false,
            pinned: true,
            version: 3,
            created_at: new Date("2026-07-09T00:00:00.000Z"),
            updated_at: new Date("2026-07-09T00:02:00.000Z"),
          },
        ];
      }
      if (text.includes("FROM sessions")) {
        return [
          {
            session_id: "sess-linked",
            status: "completed",
            prompt: "linked",
            created_at: new Date("2026-07-09T00:00:00.000Z"),
            updated_at: new Date("2026-07-09T00:02:00.000Z"),
            session_type: "claude",
            last_message: null,
            client_id: null,
            metadata: {},
            display_name: "Linked",
            node_id: "node-a",
            folder_id: null,
            last_event_id: 4,
            last_read_event_id: 4,
            caller_session_id: null,
            agent_id: null,
          },
        ];
      }
      return [];
    });
    const repository = createLiveDbCatalogRepository({ sql: harness.sql });

    await expect(repository.loadTaskSnapshot()).resolves.toMatchObject({
      total: 1,
      tasks: [
        {
          id: "task-1",
          parentId: null,
          positionKey: 1,
          title: "Task",
          linkedSessionId: "sess-linked",
          linkedSession: {
            agentSessionId: "sess-linked",
            displayName: "Linked",
            lastEventId: 4,
          },
          pinned: true,
          version: 3,
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:02:00.000Z",
        },
      ],
    });
  });
});

function createSqlHarness(
  rowsFor: (text: string, values: unknown[]) => readonly Record<string, unknown>[] = () => [],
) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return rowsFor(text, values);
  });
  const sql = Object.assign(query, {
    json: vi.fn((value: unknown) => ({ jsonValue: value })),
  }) as unknown as LivePostgresSql;

  return {
    sql,
    calls,
    normalizedCalls: () =>
      calls.map((call) => call.text.replace(/\s+/g, " ").trim()),
  };
}
