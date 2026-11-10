import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  persistentSessionSettingsTools,
  sessionMessageTools,
  sessionTools,
  type CallToolResult,
} from "@soulstream/mcp-contract";

import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";

type Row = Record<string, unknown>;

function makeRow(overrides: Row): Row {
  return {
    session_id: "11111111-1111-4111-8111-111111111111",
    display_name: "PAS",
    node_id: "eiaserinnys",
    folder_id: "folder-1",
    agent_id: "seosoyoung-pas",
    session_type: "claude",
    model_preset: "claude-opus",
    model: "claude-opus-model",
    reasoning_effort: "high",
    status: "completed",
    metadata: [],
    created_at: new Date("2026-10-01T00:00:00.000Z"),
    updated_at: new Date("2026-11-09T10:00:00.000Z"),
    ...overrides,
  };
}

const SEOSOYOUNG_PAS = makeRow({
  session_id: "20e4dae9-8a2b-4c3d-8e4f-556677889900",
  display_name: "서소영 영구 세션",
  agent_id: "seosoyoung-pas",
  folder_id: "folder-1",
  status: "completed",
  updated_at: new Date("2026-11-09T10:00:00.000Z"),
});
const WORK_PAS = makeRow({
  session_id: "aaaa1111-2222-4333-8444-555566667777",
  display_name: "workbench · 작업대 개밥먹기",
  agent_id: "work-pas",
  folder_id: "folder-2",
  model_preset: "gemini-4-argon",
  status: "running",
  updated_at: new Date("2026-11-09T12:00:00.000Z"),
});
const HIDDEN_FOLDER_PAS = makeRow({
  session_id: "bbbb1111-2222-4333-8444-555566667777",
  display_name: "숨김 폴더 PAS",
  agent_id: "seosoyoung-pas",
  folder_id: "folder-hidden",
  status: "completed",
  updated_at: new Date("2026-11-09T11:00:00.000Z"),
});

function setup() {
  const folderAccessCalls: Array<{ request: unknown; folderId: string | null; accessEmail?: string | null }> = [];
  const service = new PersistentSessionSettingsService({
    reads: async () => ({
      getSession: async () => null,
      listPersistentSessions: async () => [SEOSOYOUNG_PAS, WORK_PAS, HIDDEN_FOLDER_PAS],
    }),
    access: {
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }) as never,
      requireSessionAccess: async () => undefined,
      requireFolderAccess: async (input: { request: unknown; folderId: string | null; accessEmail?: string | null }) => {
        folderAccessCalls.push(input);
        if (input.folderId === "folder-hidden") {
          throw new SessionResourceAccessError("SESSION_ACCESS_DENIED", "Folder access denied", 403);
        }
      },
    },
    catalog: { renameSession: async () => undefined },
    commands: {} as never,
    createSession: async () => ({ status: 201, body: {} }),
    presets: {} as never,
    profiles: {
      listAgentProfiles: async () => ({
        "seosoyoung-pas": { name: "서소영 (PAS)" },
        "work-pas": { name: "키키 (PAS)" },
      }),
    },
  } as never);
  const resolveSessionOwner = vi.fn(async (id: string) => id === "caller-session"
    ? { ownerEmail: "owner@example.com", callerInfo: {} }
    : null);
  const options = { persistentSessionSettings: service, resolveSessionOwner } as unknown as McpHostOptions;
  const call = (args: Record<string, unknown>) =>
    executeMcpTool(options, "list_persistent_sessions" as never, args, {
      principal: "internal", callerSessionId: "caller-session", nodeId: "node-1",
    }) as Promise<CallToolResult>;
  return { folderAccessCalls, resolveSessionOwner, options, call };
}

function sessionIds(result: CallToolResult): string[] {
  return (result.structuredContent!.sessions as Array<{ session_id: string }>).map((session) => session.session_id);
}

describe("list_persistent_sessions MCP tool", () => {
  it("lists accessible persistent sessions newest activity first with the delivery fields", async () => {
    const h = setup();

    const result = await h.call({});

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      sessions: [
        {
          session_id: "aaaa1111-2222-4333-8444-555566667777",
          display_name: "workbench · 작업대 개밥먹기",
          agent_id: "work-pas",
          agent_name: "키키 (PAS)",
          node_id: "eiaserinnys",
          status: "running",
          last_activity_at: "2026-11-09T12:00:00.000Z",
          model_preset: "gemini-4-argon",
        },
        {
          session_id: "20e4dae9-8a2b-4c3d-8e4f-556677889900",
          display_name: "서소영 영구 세션",
          agent_id: "seosoyoung-pas",
          agent_name: "서소영 (PAS)",
          node_id: "eiaserinnys",
          status: "completed",
          last_activity_at: "2026-11-09T10:00:00.000Z",
          model_preset: "claude-opus",
        },
      ],
      total: 2,
    });
    expect(h.resolveSessionOwner).toHaveBeenCalledWith("caller-session");
    expect(h.folderAccessCalls).toContainEqual({
      request: SERVICE_CALLER,
      folderId: "folder-1",
      accessEmail: "owner@example.com",
    });
  });

  it("matches the query against display name, agent name, agent id and session id", async () => {
    const h = setup();

    expect(sessionIds(await h.call({ query: "서소영" }))).toEqual(["20e4dae9-8a2b-4c3d-8e4f-556677889900"]);
    expect(sessionIds(await h.call({ query: "개밥먹기" }))).toEqual(["aaaa1111-2222-4333-8444-555566667777"]);
    expect(sessionIds(await h.call({ query: "20e4dae9" }))).toEqual(["20e4dae9-8a2b-4c3d-8e4f-556677889900"]);
    expect(sessionIds(await h.call({ query: "seosoyoung-pas" }))).toEqual(["20e4dae9-8a2b-4c3d-8e4f-556677889900"]);
    // Words match independently: the agent is 「서소영 (PAS)」, the display name has no 「PAS」.
    expect(sessionIds(await h.call({ query: "서소영 PAS" }))).toEqual(["20e4dae9-8a2b-4c3d-8e4f-556677889900"]);
    expect(sessionIds(await h.call({ query: "서소영 개밥먹기" }))).toEqual([]);
  });

  it("treats a blank query as no filter", async () => {
    const h = setup();

    expect(sessionIds(await h.call({ query: "   " }))).toEqual([
      "aaaa1111-2222-4333-8444-555566667777",
      "20e4dae9-8a2b-4c3d-8e4f-556677889900",
    ]);
  });

  it("drops persistent sessions in folders the caller cannot access", async () => {
    const h = setup();

    const result = await h.call({ query: "숨김" });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ sessions: [], total: 0 });
  });

  it("rejects external callers and untrusted callers", async () => {
    const h = setup();

    const external = await (executeMcpTool(h.options, "list_persistent_sessions" as never, {}, {
      principal: "external", callerSessionId: null, nodeId: "node-1",
    }) as Promise<CallToolResult>);
    expect(external.isError).toBe(true);
    expect(external.structuredContent).toMatchObject({ error: "internal_principal_required" });

    const untrusted = await (executeMcpTool(h.options, "list_persistent_sessions" as never, {}, {
      principal: "internal", callerSessionId: null, nodeId: "node-1",
    }) as Promise<CallToolResult>);
    expect(untrusted.isError).toBe(true);
    expect(untrusted.structuredContent).toMatchObject({
      error: "A trusted Soulstream caller session is required for persistent session settings.",
    });
  });

  it("is a strict internal read-only tool and points at send_message_to_session", () => {
    const definition = persistentSessionSettingsTools.list_persistent_sessions;
    expect(definition.audience).toBe("internal");
    expect(definition.strictInputSchema).toBe(true);
    expect(definition.config.annotations?.readOnlyHint).toBe(true);

    const input = z.object(definition.config.inputSchema).strict();
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ query: "서소영" }).success).toBe(true);
    // Exact agent and node filters invited guessed ids that hid the main PAS (카드 #1150 실측).
    expect(input.safeParse({ agent_id: "seosoyoung" }).success).toBe(false);
    expect(input.safeParse({ caller_session_id: "forged" }).success).toBe(false);

    const description = definition.config.description ?? "";
    expect(description).toContain("send_message_to_session");
    expect(sessionMessageTools.send_message_to_session.config.description).toContain("list_persistent_sessions");
    expect(sessionTools.list_sessions.config.description).toContain("list_persistent_sessions");
  });
});
