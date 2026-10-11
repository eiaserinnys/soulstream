import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import type { PersistentSessionHistoryRow } from "../src/control_plane/repositories/persistent_session_history_query.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@soulstream/mcp-contract";

function setup() {
  const rows = new Map<string, Record<string, unknown>>();
  const accessCalls: unknown[] = [];
  const readPersistentSessionHistory = vi.fn(async () => ({ rows: [] as PersistentSessionHistoryRow[], nextCursor: null as number | null }));
  let ownerEmail: string | null = "owner@example.com";
  let denyFolder = false;
  const settings = new PersistentSessionSettingsService({
    reads: async () => ({ getSession: async (id: string) => rows.get(id) ?? null, listPersistentSessions: async () => [] }),
    access: {
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }) as never,
      requireSessionAccess: async (input: { request: unknown; sessionId: string; accessEmail?: string | null }) => {
        accessCalls.push(input);
        if (denyFolder) throw new SessionResourceAccessError("SESSION_ACCESS_DENIED", "Folder access denied", 403);
        if (input.request === SERVICE_CALLER && input.accessEmail !== "owner@example.com") {
          throw new SessionResourceAccessError("SESSION_ACCESS_DENIED", "Folder access denied", 403);
        }
      },
      requireFolderAccess: async () => undefined,
    },
    catalog: { renameSession: async () => undefined },
    commands: { router: {}, bridge: {}, timeoutMs: 1000 } as never,
    createSession: async () => ({ status: 201, body: {} }),
    presets: {
      resolveStaticForNode: (_nodeId: string, id: string) => ({ id, backend: "claude", available: true, supported_efforts: ["high"], default_effort: "high" }),
      requireAvailable: () => undefined,
    } as never,
    profiles: { listAgentProfiles: async () => ({ "agent-1": { name: "Agent One" } }) },
  } as never);
  const resolveSessionOwner = vi.fn(async (id: string) => id === "caller-session" && ownerEmail
    ? { ownerEmail, callerInfo: { email: ownerEmail } }
    : null);
  let providerCalls = 0;
  const options = {
    persistentSessionSettings: settings,
    resolveSessionOwner,
    sessions: { repositoryProvider: async () => {
      providerCalls += 1;
      return { eventReads: { readPersistentSessionHistory } };
    } },
  } as unknown as McpHostOptions;
  const call = (args: Record<string, unknown>, callerSessionId: string | null = "caller-session", principal: "internal" | "external" = "internal") =>
    executeMcpTool(options, "list_persistent_session_history" as never, args, {
      principal, callerSessionId, nodeId: "node-1",
    }) as Promise<CallToolResult>;
  return { rows, accessCalls, readPersistentSessionHistory, resolveSessionOwner, call,
    setOwnerEmail: (value: string | null) => { ownerEmail = value; },
    setDenyFolder: (value: boolean) => { denyFolder = value; },
    providerCalls: () => providerCalls };
}

const period = { since: "2026-10-05T00:00:00+09:00", until: "2026-10-06T00:00:00+09:00" };

function session(id: string, persistent = true) {
  return {
    session_id: id, session_type: "claude", node_id: "node-1", agent_id: "agent-1",
    display_name: "Persistent session", folder_id: "folder-1", model_preset: "claude-opus",
    model: "claude-opus-model", reasoning_effort: "high",
    metadata: [{ type: "persistent_session", value: { enabled: persistent } }],
  };
}

describe("list_persistent_session_history MCP access", () => {
  it("uses the trusted caller by default and passes the verified owner through existing PAS access", async () => {
    const h = setup();
    h.rows.set("caller-session", session("caller-session"));
    const result = await h.call(period);

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      session_id: "caller-session", display_name: "Persistent session",
      since: "2026-10-04T15:00:00.000Z", until: "2026-10-05T15:00:00.000Z",
      time_zone: "Asia/Seoul", entries: [], returned_count: 0, next_cursor: null,
    });
    expect(h.accessCalls.at(-1)).toMatchObject({ request: SERVICE_CALLER, sessionId: "caller-session", accessEmail: "owner@example.com" });
    expect(h.readPersistentSessionHistory).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "caller-session", since: new Date("2026-10-04T15:00:00.000Z"), limit: 20, cursor: 0,
    }));
  });

  it("supports an explicitly selected PAS under the same folder policy", async () => {
    const h = setup();
    h.rows.set("other-pas", session("other-pas"));
    const result = await h.call({ ...period, session_id: "other-pas", cursor: 4, limit: 3, max_text_chars: 100 });
    expect(result.isError).not.toBe(true);
    expect(h.readPersistentSessionHistory).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "other-pas", cursor: 4, limit: 3,
    }));
    expect(h.accessCalls.at(-1)).toMatchObject({ sessionId: "other-pas", accessEmail: "owner@example.com" });
  });

  it("returns projected entries and the repository continuation without exposing stored context", async () => {
    const h = setup();
    h.rows.set("caller-session", session("caller-session"));
    h.readPersistentSessionHistory.mockResolvedValueOnce({
      rows: [{
        id: 23,
        session_id: "caller-session",
        event_type: "user_message",
        payload: {
          text: "visible 🧭",
          caller_info: { source: "browser", display_name: "Caller", email: "private@example.com" },
          attachments: ["private/path"],
          context: ["private context"],
        },
        created_at: new Date("2026-10-05T00:00:00.000Z"),
        parent_event_id: null,
        generation: 2,
      }],
      nextCursor: 23,
    });

    const result = await h.call({ ...period, limit: 7, max_text_chars: 100 });
    expect(result.structuredContent).toMatchObject({
      returned_count: 1,
      next_cursor: 23,
      entries: [{
        event_id: 23,
        kind: "human",
        text: "visible 🧭",
        source: "browser",
        attachment_count: 1,
        generation: 2,
      }],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("private@example.com");
    expect(JSON.stringify(result.structuredContent)).not.toContain("private/path");
    expect(JSON.stringify(result.structuredContent)).not.toContain("private context");
  });

  it.each([
    ["external principal", async (h: ReturnType<typeof setup>) => h.call(period, "caller-session", "external")],
    ["missing caller", async (h: ReturnType<typeof setup>) => h.call(period, null)],
    ["unverified owner", async (h: ReturnType<typeof setup>) => { h.setOwnerEmail(null); return h.call(period); }],
    ["folder denial", async (h: ReturnType<typeof setup>) => { h.rows.set("caller-session", session("caller-session")); h.setDenyFolder(true); return h.call(period); }],
    ["missing target", async (h: ReturnType<typeof setup>) => h.call({ ...period, session_id: "missing" })],
    ["non-PAS target", async (h: ReturnType<typeof setup>) => { h.rows.set("ordinary", session("ordinary", false)); return h.call({ ...period, session_id: "ordinary" }); }],
  ] as const)("does not read events for %s", async (_label, run) => {
    const h = setup();
    expect((await run(h)).isError).toBe(true);
    expect(h.readPersistentSessionHistory).not.toHaveBeenCalled();
  });

  it("rejects caller-selected identity fields before resolving the owner or reading events", async () => {
    const h = setup();
    h.rows.set("caller-session", session("caller-session"));
    expect((await h.call({ ...period, email: "owner@example.com", user_id: "user-1" })).isError).toBe(true);
    expect(h.resolveSessionOwner).not.toHaveBeenCalled();
    expect(h.providerCalls()).toBe(0);
    expect(h.readPersistentSessionHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["date-only", { since: "2026-10-05", until: "2026-10-06" }],
    ["timezone-less", { since: "2026-10-05T00:00:00", until: "2026-10-06T00:00:00" }],
    ["reversed", { since: "2026-10-06T00:00:00+09:00", until: "2026-10-05T00:00:00+09:00" }],
  ] as const)("does not read events for a %s period", async (_label, input) => {
    const h = setup();
    h.rows.set("caller-session", session("caller-session"));
    expect((await h.call(input)).isError).toBe(true);
    expect(h.readPersistentSessionHistory).not.toHaveBeenCalled();
  });
});
