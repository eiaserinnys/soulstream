import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@soulstream/mcp-contract";
import { buildPersistentSettingsMetadataEntry, readStoredPersistentSettings } from "@soulstream/wire-schema/persistent-session-settings";

const currentSettings = {
  default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
  fallback_model: null,
  show_generation_separator: true,
  show_character: true,
  show_jev_candidates: true,
  show_turn_usage: true,
  animate_character: true,
};

function setup() {
  const rows = new Map<string, Record<string, unknown>>();
  const accessCalls: unknown[] = [];
  const commandPayloads: Record<string, unknown>[] = [];
  const modelChanges: string[] = [];
  let callerEmail = "owner@example.com";
  const makeRow = (sessionId: string, persistent = true) => ({
    session_id: sessionId,
    session_type: "claude",
    node_id: "node-1",
    agent_id: "agent-1",
    display_name: "Persistent session",
    folder_id: "folder-1",
    model_preset: "claude-opus",
    model: "claude-opus-model",
    reasoning_effort: "high",
    metadata: [
      { type: "persistent_session", value: { enabled: persistent } },
      buildPersistentSettingsMetadataEntry(currentSettings),
    ],
  });
  const service = new PersistentSessionSettingsService({
    reads: async () => ({
      getSession: async (id: string) => rows.get(id) ?? null,
      listPersistentSessions: async () => [],
    }),
    access: {
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }) as never,
      requireSessionAccess: async (input: { request: unknown; sessionId: string; accessEmail?: string | null }) => {
        accessCalls.push(input);
        const accessInput = input as { request: unknown; accessEmail?: string | null };
        if (accessInput.request === SERVICE_CALLER && accessInput.accessEmail !== "owner@example.com") {
          throw new SessionResourceAccessError("SESSION_ACCESS_DENIED", "Folder access denied", 403);
        }
      },
      requireFolderAccess: async () => undefined,
    },
    catalog: { renameSession: async () => undefined },
    commands: {
      router: { routeExistingSessionPendingCommand: async (payload: Record<string, unknown>) => payload as never },
      bridge: {
        sendPendingCommand: async (payload: Record<string, unknown>) => {
          commandPayloads.push(payload);
          const row = rows.get(String(payload.agentSessionId))!;
          const previous = readStoredPersistentSettings(row.metadata)!;
          const patch = (payload.settings ?? {}) as Record<string, unknown>;
          const next = { ...previous, ...patch } as typeof currentSettings;
          row.metadata = [
            ...(row.metadata as Array<Record<string, unknown>>).filter(entry => entry.type !== "persistent_settings"),
            buildPersistentSettingsMetadataEntry(next),
          ];
          const modelChanged = (patch.default_model as { model_preset?: string } | undefined)?.model_preset
            !== undefined && (patch.default_model as { model_preset: string }).model_preset !== previous.default_model?.model_preset;
          const modelChange = modelChanged ? "next_execution_start" : "none";
          modelChanges.push(modelChange);
          return { persistent: true, modelChange };
        },
      },
      timeoutMs: 1_000,
    } as never,
    createSession: async () => ({ status: 201, body: {} }),
    presets: {
      resolveStaticForNode: (_nodeId: string, id: string) => ({
        id,
        backend: id.startsWith("claude-") ? "claude" : "codex",
        available: true,
        supported_efforts: ["high", "medium"],
        default_effort: "high",
      }),
      requireAvailable: () => undefined,
    } as never,
    profiles: { listAgentProfiles: async () => ({ "agent-1": { name: "Agent One" } }) },
  } as never);
  const resolveSessionOwner = vi.fn(async (id: string) => id === "caller-session"
    ? { ownerEmail: callerEmail, callerInfo: { email: callerEmail } }
    : null);
  const options = { persistentSessionSettings: service, resolveSessionOwner } as unknown as McpHostOptions;
  const call = (args: Record<string, unknown>, callerSessionId: string | null = "caller-session") =>
    executeMcpTool(options, "update_persistent_session_settings" as never, args, {
      principal: "internal", callerSessionId, nodeId: "node-1",
    }) as Promise<CallToolResult>;
  return { rows, accessCalls, commandPayloads, modelChanges, makeRow, service, resolveSessionOwner, call,
    setCallerEmail: (email: string) => { callerEmail = email; } };
}

describe("update_persistent_session_settings MCP tool", () => {
  it("uses the PUT service update path, verifies caller access, and returns the stored settings", async () => {
    const h = setup();
    const putRow = h.makeRow("put-session");
    const mcpRow = h.makeRow("mcp-session");
    h.rows.set("put-session", putRow);
    h.rows.set("mcp-session", mcpRow);
    const patch = { default_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" } };

    const putResult = await h.service.update({} as never, "put-session", { settings: patch });
    const mcpResult = await h.call({ session_id: "mcp-session", ...patch });

    expect(mcpResult.isError).not.toBe(true);
    expect(mcpResult.structuredContent).toEqual({
      session_id: "mcp-session",
      settings: putResult.session.settings,
    });
    expect(putResult.model_change).toBe("next_execution_start");
    expect(h.modelChanges).toEqual(["next_execution_start", "next_execution_start"]);
    expect(h.commandPayloads).toHaveLength(2);
    expect(h.commandPayloads[1]).toMatchObject({
      type: "set_persistent_session_settings",
      agentSessionId: "mcp-session",
      settings: patch,
    });
    expect(h.accessCalls.at(-1)).toMatchObject({
      request: SERVICE_CALLER,
      sessionId: "mcp-session",
      accessEmail: "owner@example.com",
    });
    expect(h.resolveSessionOwner).toHaveBeenCalledWith("caller-session");
  });

  it("does not request a generation rollover for a display-only patch", async () => {
    const h = setup();
    h.rows.set("mcp-session", h.makeRow("mcp-session"));

    const result = await h.call({ session_id: "mcp-session", show_turn_usage: false });

    expect(result.isError).not.toBe(true);
    expect(h.commandPayloads).toHaveLength(1);
    expect(h.commandPayloads[0]).toMatchObject({ settings: { show_turn_usage: false } });
    expect(h.commandPayloads[0]!.settings).not.toHaveProperty("default_model");
    expect(h.modelChanges).toEqual(["none"]);
    expect(result.structuredContent).toMatchObject({ settings: { show_turn_usage: false } });
  });

  it("rejects unknown fields, invalid settings, missing/nonpersistent sessions, and unauthorized callers", async () => {
    const h = setup();
    h.rows.set("mcp-session", h.makeRow("mcp-session"));
    h.rows.set("ordinary", h.makeRow("ordinary", false));

    expect(await h.call({ session_id: "mcp-session", future_setting: true })).toMatchObject({ isError: true });
    expect(await h.call({ session_id: "mcp-session", show_character: "yes" })).toMatchObject({ isError: true });
    expect(await h.call({ session_id: "mcp-session", default_model: { model_preset: "claude-opus", reasoning_effort: "ultra" } })).toMatchObject({ isError: true });
    expect(await h.call({ session_id: "missing", show_character: false })).toMatchObject({ isError: true });
    expect(await h.call({ session_id: "ordinary", show_character: false })).toMatchObject({ isError: true });
    h.setCallerEmail("other@example.com");
    expect(await h.call({ session_id: "mcp-session", show_character: false })).toMatchObject({ isError: true });
    expect(h.commandPayloads).toHaveLength(0);
  });
});
