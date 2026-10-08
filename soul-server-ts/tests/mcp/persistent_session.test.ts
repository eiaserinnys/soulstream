import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry } from "../../src/agent_registry.js";
import type { AgentProfile } from "../../src/agent_registry.js";
import { buildPersistentCheckpoint } from "../../src/context/persistent_checkpoint.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { ModelCatalog } from "../../src/model_catalog.js";
import type { SessionDB, SessionRow } from "../../src/db/session_db.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { hydrateEvictedTaskFromSessionRow } from "../../src/task/task_evicted_hydration.js";
import {
  beginGenerationRolloverIfPending,
  publishStarted,
} from "../../src/task/persistent_generation_rollover.js";
import { readPersistentInstructions } from "@soulstream/wire-schema/persistent-session-instructions";
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

        const added = await client.callTool({
          name: "add_persistent_instruction",
          arguments: { session_id: sessionId, text: "Keep replies concise." },
        });
        expect(added.structuredContent).toMatchObject({
          session_id: sessionId,
          status: "ok",
          instruction: { text: "Keep replies concise.", source_turns: [], origin: "agent" },
        });
        expect(added.content[0]).toMatchObject({ text: expect.stringMatching(/^Keep replies concise\./) });
        const instructionId = (added.structuredContent?.instruction as { id: string }).id;

        const listed = await client.callTool({
          name: "list_persistent_instructions",
          arguments: { session_id: sessionId },
        });
        expect(listed.structuredContent).toMatchObject({
          instructions: [{ id: instructionId, text: "Keep replies concise.", source_turns: [] }],
        });

        const removed = await client.callTool({
          name: "update_persistent_instruction",
          arguments: { session_id: sessionId, instruction_id: instructionId, status: "removed" },
        });
        expect(removed.structuredContent).toMatchObject({
          status: "ok",
          instruction: { id: instructionId, text: "Keep replies concise.", status: "removed" },
        });
        expect(removed.content[0]).toMatchObject({ text: expect.stringMatching(/^Keep replies concise\./) });

        const sourceRule = await taskManager.persistentSessions.applyPersistentInstructions(sessionId, {
          origin: "agent",
          ops: [{
            op: "add",
            text: "Preserve this instruction.",
            source_turns: ["T10", "T11", "T12"],
            source_event_ids: [101, 102, 103],
          }],
        });
        const sourceInstruction = sourceRule.results[0]?.item;
        expect(sourceInstruction).toBeDefined();

        const sourcesRemoved = await client.callTool({
          name: "update_persistent_instruction",
          arguments: {
            session_id: sessionId,
            instruction_id: sourceInstruction!.id,
            remove_source_turns: ["T11"],
            remove_source_event_ids: [103],
          },
        });
        expect(sourcesRemoved.structuredContent).toMatchObject({
          status: "ok",
          instruction: {
            id: sourceInstruction!.id,
            text: "Preserve this instruction.",
            source_turns: ["T10", "T12"],
            source_event_ids: [101, 102],
            created_at: sourceInstruction!.created_at,
            status: "active",
            origin: "agent",
          },
        });
        expect(readPersistentInstructions(row.metadata).find((item) => item.id === sourceInstruction!.id))
          .toMatchObject({ source_turns: ["T10", "T12"], source_event_ids: [101, 102] });

        const emptyRemoval = await client.callTool({
          name: "update_persistent_instruction",
          arguments: {
            session_id: sessionId,
            instruction_id: sourceInstruction!.id,
            remove_source_turns: [],
            remove_source_event_ids: [],
          },
        });
        expect(emptyRemoval.structuredContent).toMatchObject({
          status: "ok",
          instruction: { source_turns: ["T10", "T12"], source_event_ids: [101, 102] },
        });

        const metadataBeforeRejectedUpdate = row.metadata;
        const missingUpdate = await client.callTool({
          name: "update_persistent_instruction",
          arguments: { session_id: sessionId, instruction_id: sourceInstruction!.id },
        });
        const invalidSources = await client.callTool({
          name: "update_persistent_instruction",
          arguments: {
            session_id: sessionId,
            instruction_id: sourceInstruction!.id,
            remove_source_turns: ["not-a-turn"],
            remove_source_event_ids: [1.5],
          },
        });
        expect(missingUpdate.isError).toBe(true);
        expect(invalidSources.isError).toBe(true);
        expect(row.metadata).toBe(metadataBeforeRejectedUpdate);

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
      termination_reason: null,
      termination_event_id: null,
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
        {
          type: "persistent_instructions",
          value: [{
            id: "standing-1",
            text: "Keep the decision concise.",
            source_turns: [],
            source_event_ids: [],
            created_at: "2026-10-01T09:00:00.000Z",
            updated_at: "2026-10-05T09:00:00.000Z",
            status: "active",
            origin: "agent",
          }],
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
            reset_context: true,
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
                reset_context: true,
                keep_instructions: true,
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
            resetContext: true,
            keepInstructions: true,
          },
        });

        const instructionsBeforeRollover = readPersistentInstructions(hydratedTask.metadata);
        hydratedTask.interventionQueue.push({ text: "continue from checkpoint", user: "test" });
        const active = beginGenerationRolloverIfPending(
          hydratedTask,
          {
            id: "agent-1",
            name: "Agent",
            backend: "claude",
            workspace_dir: "/test",
          } satisfies AgentProfile,
          modelCatalog,
        );
        expect(active).toMatchObject({ resetContext: true, keepInstructions: true });

        const checkpoint = buildPersistentCheckpoint({
          material: {
            story: {
              highlight: null,
              narrative: "story-that-must-be-reset",
              unfoldedTurnSummaries: [{
                eventId: 12,
                turnNumber: 12,
                content: "summary-that-must-be-reset",
                turnStartEventId: 11,
                finalResponseEventId: 12,
                createdAt: new Date("2026-10-05T08:00:00.000Z"),
              }],
              narrativeThroughEventId: 12,
              foldCount: 1,
              updatedAt: new Date("2026-10-05T08:00:00.000Z"),
            },
            lastSummarizedFinalResponseEventId: null,
            recent: {
              records: [{
                event_id: 13,
                event_type: "user_message",
                text: "recent-that-must-be-reset",
                created_at: "2026-10-05T08:10:00.000Z",
              }],
              omittedUnsummarized: 0,
            },
            childSessions: [],
            childSessionTotal: 0,
            totals: { events: 13, turnSummaries: 12 },
          },
          cards: {
            capturedAt: "2026-10-05T08:00:00.000Z",
            counts: { running: 1, blocked: 0, review: 0, queued: 0, todo: 0 },
            cards: [{
              id: "current-state-card",
              title: "current-state-marker",
              status: "running",
              blockedKind: null,
              assignee: { kind: "session", agentId: "agent-1", sessionId },
            }],
            openQuestions: [],
            openQuestionTotal: 0,
          },
          standingInstructions: instructionsBeforeRollover
            .filter((instruction) => instruction.status === "active")
            .map((instruction) => `- ${instruction.text}`),
          ownSessionId: sessionId,
          resetContext: active?.resetContext,
          keepInstructions: active?.keepInstructions,
        });
        expect(String(checkpoint.item.content)).toContain("current-state-marker");
        expect(String(checkpoint.item.content)).toContain("Keep the decision concise.");
        expect(String(checkpoint.item.content)).not.toContain("story-that-must-be-reset");
        expect(String(checkpoint.item.content)).not.toContain("summary-that-must-be-reset");
        expect(String(checkpoint.item.content)).not.toContain("recent-that-must-be-reset");

        const enqueueEventAndWaitForSessionAck = vi.fn(async () => ({
          record: {} as never,
          eventId: 43,
        }));
        await publishStarted(hydratedTask, checkpoint.stats, {
          enqueueEventAndWaitForSessionAck,
        } as unknown as EventPersistence);
        expect(enqueueEventAndWaitForSessionAck.mock.calls[0]?.[1]).toMatchObject({
          type: "generation_started",
          generation: 2,
          context_reset: true,
        });

        const omitInstructions = await client.callTool({
          name: "request_session_generation_rollover",
          arguments: {
            session_id: sessionId,
            reset_context: true,
            keep_instructions: false,
          },
        });
        expect(omitInstructions.isError).not.toBe(true);
        expect(hydrateEvictedTaskFromSessionRow(row, pino({ level: "silent" }))?.persistentGeneration?.pending)
          .toMatchObject({ resetContext: true, keepInstructions: false });
        expect(readPersistentInstructions(hydratedTask.metadata)).toEqual(instructionsBeforeRollover);
        expect(readPersistentInstructions(row.metadata)).toEqual(instructionsBeforeRollover);
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
