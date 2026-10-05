import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { ModelCatalog } from "../../src/model_catalog.js";
import type { SessionDB, SessionRow } from "../../src/db/session_db.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { hydrateEvictedTaskFromSessionRow } from "../../src/task/task_evicted_hydration.js";
import { PersistentSessionControl } from "../../src/task/persistent_session_control.js";
import type { Task } from "../../src/task/task_models.js";
import { TaskManager } from "../../src/task/task_manager.js";

function makeRow(sessionId: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: sessionId,
    folder_id: null,
    display_name: null,
    node_id: "node-1",
    session_type: "claude",
    status: "completed",
    prompt: "original prompt",
    client_id: null,
    claude_session_id: null,
    last_message: null,
    metadata: [],
    was_running_at_shutdown: false,
    last_event_id: 1,
    last_read_event_id: 0,
    created_at: new Date("2026-10-05T09:00:00.000Z"),
    updated_at: new Date("2026-10-05T09:00:00.000Z"),
    agent_id: "agent-1",
    caller_session_id: null,
    away_summary: null,
    termination_reason: "completed_ok",
    termination_detail: null,
    termination_event_id: 1,
    last_assistant_text: "done",
    ...overrides,
  };
}

function makeRuntime(taskManager: TaskManager, db: SessionDB): McpRuntime {
  return {
    nodeId: "node-1",
    agentsConfigPath: "/test/agents.yaml",
    db,
    taskManager,
    taskExecutor: {},
    onResume: () => undefined,
    agentRegistry: new AgentRegistry([]),
    catalogService: {},
    logger: pino({ level: "silent" }),
  } as unknown as McpRuntime;
}

describe("set_session_persistent MCP tool", () => {
  it("writes the metadata effect and that metadata hydrates a persistent Task", async () => {
    const sessionId = "session-persistent";
    const row = makeRow(sessionId, {
      metadata: [
        { type: "other_metadata", value: { retained: true } },
        { type: "persistent_session", value: { enabled: false, updated_at: "old" } },
      ],
    });
    const rows = new Map([[sessionId, row]]);
    const db = {
      getSession: vi.fn(async (id: string) => rows.get(id) ?? null),
    } as unknown as SessionDB;
    const enqueueMetadataEffect = vi.fn(async (
      id: string,
      entry: Record<string, unknown>,
      options: { replaceExistingType?: string; waitForAck?: boolean },
    ) => {
      const stored = rows.get(id)!;
      const metadata = Array.isArray(stored.metadata)
        ? stored.metadata as Array<Record<string, unknown>>
        : [];
      stored.metadata = [
        ...metadata.filter((item) => item.type !== options.replaceExistingType),
        entry,
      ];
      return 42;
    });
    const persistence = { enqueueMetadataEffect } as unknown as EventPersistence;
    const taskManager = new TaskManager(
      "node-1",
      db,
      {} as never,
      pino({ level: "silent" }),
      persistence,
    );
    const runtime = makeRuntime(taskManager, db);

    await withMcpRequestContext({}, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "persistent-session-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const enabled = await client.callTool({
          name: "set_session_persistent",
          arguments: { session_id: sessionId, enabled: true },
        });

        expect(enabled.structuredContent).toEqual({
          session_id: sessionId,
          persistent: true,
          generation: 1,
        });
        expect(enqueueMetadataEffect).toHaveBeenCalledWith(
          sessionId,
          expect.objectContaining({
            type: "persistent_session",
            value: expect.objectContaining({ enabled: true, updated_at: expect.any(String) }),
          }),
          { replaceExistingType: "persistent_session", waitForAck: true },
        );
        expect(taskManager.getTask(sessionId)).toMatchObject({ persistent: true });
        expect((row.metadata as Array<Record<string, unknown>>)
          .filter((entry) => entry.type === "persistent_session")).toHaveLength(1);

        const hydratedTask = hydrateEvictedTaskFromSessionRow(row, pino({ level: "silent" }));
        expect(hydratedTask?.persistent).toBe(true);

        const disabled = await client.callTool({
          name: "set_session_persistent",
          arguments: { session_id: sessionId, enabled: false },
        });
        expect(disabled.structuredContent).toEqual({
          session_id: sessionId,
          persistent: false,
          generation: 1,
        });
        expect(taskManager.getTask(sessionId)).toMatchObject({ persistent: false });
        expect(hydrateEvictedTaskFromSessionRow(row, pino({ level: "silent" }))?.persistent)
          .toBe(false);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  it("rejects LLM and other-node sessions before writing metadata", async () => {
    const llmRow = makeRow("session-llm", { session_type: "llm" });
    const otherNodeRow = makeRow("session-other-node", { node_id: "node-2" });
    const rows = new Map([
      [llmRow.session_id, llmRow],
      [otherNodeRow.session_id, otherNodeRow],
    ]);
    const db = {
      getSession: vi.fn(async (id: string) => rows.get(id) ?? null),
    } as unknown as SessionDB;
    const enqueueMetadataEffect = vi.fn();
    const taskManager = new TaskManager(
      "node-1",
      db,
      {} as never,
      pino({ level: "silent" }),
      { enqueueMetadataEffect } as unknown as EventPersistence,
    );
    const runtime = makeRuntime(taskManager, db);

    await withMcpRequestContext({}, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "persistent-session-errors-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const llm = await client.callTool({
          name: "set_session_persistent",
          arguments: { session_id: llmRow.session_id, enabled: true },
        });
        expect(llm.isError).toBe(true);
        expect(taskManager.getTask(llmRow.session_id)).toBeDefined();

        const otherNode = await client.callTool({
          name: "set_session_persistent",
          arguments: { session_id: otherNodeRow.session_id, enabled: true },
        });
        expect(otherNode.isError).toBe(true);
        expect(otherNode.content.some((item) => item.type === "text" && item.text.includes("owner=node-2")))
          .toBe(true);
        expect(enqueueMetadataEffect).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});

describe("request_session_generation_rollover MCP tool", () => {
  it("stores pending metadata, preserves first-call usage, and hydrates it again", async () => {
    const sessionId = "session-generation-request";
    const firstCall = {
      generation: 1,
      input_tokens: 246708,
      cached_input_tokens: 245563,
      model_preset: "claude-opus",
      model: "claude-opus-4-6",
      measured_at: "2026-10-05T09:00:00.000Z",
    };
    const row = makeRow(sessionId, {
      status: "running",
      claude_session_id: "native-current",
      model_preset: "claude-opus",
      model: "claude-opus-4-6",
      metadata: [
        { type: "persistent_session", value: { enabled: true, updated_at: "old" } },
        {
          type: "persistent_generation",
          value: {
            number: 1,
            backend_session_id: "native-current",
            started_at: "2026-10-01T09:00:00.000Z",
            first_call: firstCall,
            pending: null,
          },
        },
      ],
    });
    const presets: Record<string, Record<string, unknown>> = {
      "claude-opus": {
        id: "claude-opus",
        model: "claude-opus-4-6",
        backend: "claude",
        env: {},
        supported_efforts: ["low", "medium", "high"],
        default_effort: "medium",
      },
      "codex-balanced": {
        id: "codex-balanced",
        model: "gpt-5-codex",
        backend: "codex",
        env: {},
        supported_efforts: ["low", "medium", "high"],
        default_effort: "medium",
      },
    };
    const modelCatalog = {
      resolve: (presetId: string) => {
        const preset = presets[presetId];
        if (!preset) throw new Error(`Unknown model preset: ${presetId}`);
        return preset;
      },
    } as unknown as Pick<ModelCatalog, "resolve">;
    let rememberedTask: Task | undefined;
    const enqueueMetadataEffect = vi.fn(async (
      id: string,
      entry: Record<string, unknown>,
      options: { replaceExistingType?: string },
    ) => {
      const current = Array.isArray(row.metadata)
        ? row.metadata as Array<Record<string, unknown>>
        : [];
      row.metadata = [
        ...current.filter((item) => item.type !== options.replaceExistingType),
        entry,
      ];
      return id === sessionId ? 42 : 0;
    });
    const control = new PersistentSessionControl({
      getTask: (id) => rememberedTask?.agentSessionId === id ? rememberedTask : undefined,
      loadEvictedTask: async (id) => id === sessionId
        ? hydrateEvictedTaskFromSessionRow(row, pino({ level: "silent" }))
        : null,
      rememberTask: (task) => { rememberedTask = task; },
      persistence: { enqueueMetadataEffect } as unknown as EventPersistence,
      modelCatalog,
      resolveCurrentBackend: (task) => task.modelPresetBackend
        ?? (task.modelPreset ? modelCatalog.resolve(task.modelPreset).backend : undefined),
    });
    const runtime = makeRuntime(
      { persistentSessions: control } as unknown as TaskManager,
      {} as SessionDB,
    );

    await withMcpRequestContext({}, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "generation-rollover-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const response = await client.callTool({
          name: "request_session_generation_rollover",
          arguments: {
            session_id: sessionId,
            model_preset: "codex-balanced",
            reasoning_effort: "high",
          },
        });

        expect(response.structuredContent).toEqual({
          session_id: sessionId,
          generation: 1,
          pending_generation: 2,
          session_status: "running",
          applies: "next_execution_start",
        });
        expect(enqueueMetadataEffect).toHaveBeenCalledWith(
          sessionId,
          expect.objectContaining({
            type: "persistent_generation",
            value: expect.objectContaining({
              first_call: firstCall,
              pending: expect.objectContaining({
                number: 2,
                reason: "manual",
                target_model_preset: "codex-balanced",
                target_reasoning_effort: "high",
              }),
            }),
          }),
          { replaceExistingType: "persistent_generation", waitForAck: true },
        );
        expect((row.metadata as Array<Record<string, unknown>>)
          .filter((entry) => entry.type === "persistent_session")).toHaveLength(1);

        const hydratedTask = hydrateEvictedTaskFromSessionRow(row, pino({ level: "silent" }));
        expect(hydratedTask?.persistentGeneration).toMatchObject({
          number: 1,
          firstCall: {
            generation: 1,
            inputTokens: 246708,
            cachedInputTokens: 245563,
          },
          pending: {
            number: 2,
            targetModelPreset: "codex-balanced",
            targetReasoningEffort: "high",
          },
        });
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  it("rejects a non-persistent session without writing metadata", async () => {
    const sessionId = "session-not-persistent";
    const row = makeRow(sessionId);
    const db = {
      getSession: vi.fn(async (id: string) => id === sessionId ? row : null),
    } as unknown as SessionDB;
    const enqueueMetadataEffect = vi.fn();
    const taskManager = new TaskManager(
      "node-1",
      db,
      {} as never,
      pino({ level: "silent" }),
      { enqueueMetadataEffect } as unknown as EventPersistence,
    );
    const runtime = makeRuntime(taskManager, db);

    await withMcpRequestContext({}, async () => {
      const server = buildMcpServer(runtime);
      const client = new Client({ name: "generation-rollover-error-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const response = await client.callTool({
          name: "request_session_generation_rollover",
          arguments: { session_id: sessionId },
        });

        expect(response.isError).toBe(true);
        expect(enqueueMetadataEffect).not.toHaveBeenCalled();
        expect(row.metadata).toEqual([]);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
