import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB, SessionRow } from "../../src/db/session_db.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import {
  normalizeRealtimeEvent,
  RealtimeBroker,
} from "../../src/realtime/realtime_broker.js";

const logger = pino({ level: "silent" });

const profile: AgentProfile = {
  id: "codex-realtime",
  name: "Realtime Agent",
  backend: "codex",
  workspace_dir: "/tmp/agents",
  agents_sdk: {
    entry_agent: "triage",
    provider: {
      type: "openai",
      api_key_env: "OPENAI_REALTIME_TEST_KEY",
    },
    agents: [
      {
        id: "triage",
        name: "Triage",
        instructions: "Talk briefly.",
        model: "gpt-realtime",
        handoffs: [],
        tools: [],
        hosted_tools: [],
        mcp_servers: [],
      },
    ],
    guardrails: { input_blocklist: [], output_blocklist: [] },
  },
};

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: "sess-rt",
    folder_id: null,
    display_name: null,
    node_id: "node-1",
    session_type: "claude",
    status: "running",
    prompt: "hello",
    client_id: null,
    claude_session_id: null,
    last_message: null,
    metadata: [],
    was_running_at_shutdown: false,
    last_event_id: 0,
    last_read_event_id: 0,
    created_at: new Date("2026-05-21T00:00:00Z"),
    updated_at: new Date("2026-05-21T00:00:00Z"),
    agent_id: "codex-realtime",
    caller_session_id: null,
    away_summary: null,
    ...overrides,
  };
}

function createBroker(opts: {
  row?: SessionRow | null;
  fetch?: any;
  env?: NodeJS.ProcessEnv;
  profile?: AgentProfile;
  modelCatalog?: {
    resolve(presetId: string): {
      id: string;
      label: string;
      backend: "claude" | "codex" | "openai-agents";
      model: string;
    };
  };
} = {}) {
  const row = opts.row === undefined ? sessionRow() : opts.row;
  const selectedProfile = opts.profile ?? profile;
  const getSession = vi.fn(async () => row);
  const enqueueEventAndWaitForSessionAck = vi.fn(async () => ({
    record: { source_seq: 1 },
    eventId: 7,
  }));
  const handleSideEffects = vi.fn(async () => undefined);
  const emitEventEnvelope = vi.fn(async () => undefined);
  const broker = new RealtimeBroker({
    agentRegistry: new AgentRegistry([selectedProfile]),
    db: { getSession } as unknown as SessionDB,
    persistence: {
      enqueueEventAndWaitForSessionAck,
      handleSideEffects,
    } as unknown as EventPersistence,
    broadcaster: { emitEventEnvelope } as unknown as SessionBroadcaster,
    logger,
    processEnv: opts.env ?? { OPENAI_REALTIME_TEST_KEY: "sk-test" },
    fetch: opts.fetch,
    modelCatalog: opts.modelCatalog,
  });
  return {
    broker,
    getSession,
    enqueueEventAndWaitForSessionAck,
    handleSideEffects,
    emitEventEnvelope,
  };
}

describe("RealtimeBroker.createCall", () => {
  it("posts SDP offer to OpenAI Realtime calls and persists connected status", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (name: string) => name.toLowerCase() === "location" ? "/v1/realtime/calls/call_123" : null },
      text: async () => "answer-sdp",
    }));
    const { broker, enqueueEventAndWaitForSessionAck, emitEventEnvelope } = createBroker({ fetch });

    const result = await broker.createCall({
      agentSessionId: "sess-rt",
      offerSdp: "offer-sdp",
      voice: "alloy",
    });

    expect(result).toMatchObject({
      status: "ok",
      callId: "call_123",
      answerSdp: "answer-sdp",
      eventId: 7,
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/calls",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer sk-test" },
      }),
    );
    const form = fetch.mock.calls[0][1].body as FormData;
    expect(form.get("sdp")).toBe("offer-sdp");
    expect(JSON.parse(String(form.get("session")))).toMatchObject({
      type: "realtime",
      model: "gpt-realtime",
      instructions: "Talk briefly.",
      audio: { output: { voice: "alloy" } },
    });
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
      "sess-rt",
      expect.objectContaining({ type: "realtime_status", status: "connected" }),
    );
    expect(emitEventEnvelope).not.toHaveBeenCalled();
  });

  it("fails explicitly when provider api_key_env is missing from process env", async () => {
    const { broker } = createBroker({ env: {} });
    await expect(
      broker.createCall({ agentSessionId: "sess-rt", offerSdp: "offer" }),
    ).rejects.toThrow(/OPENAI_REALTIME_TEST_KEY/);
  });

  it("rejects non-codex sessions before calling Realtime", async () => {
    const claudeProfile: AgentProfile = {
      ...profile,
      id: "claude-agent",
      backend: "claude",
    };
    const fetch = vi.fn();
    const broker = new RealtimeBroker({
      agentRegistry: new AgentRegistry([claudeProfile]),
      db: { getSession: vi.fn(async () => sessionRow({ agent_id: "claude-agent" })) } as unknown as SessionDB,
      persistence: {
        enqueueEventAndWaitForSessionAck: vi.fn(),
        handleSideEffects: vi.fn(),
      } as unknown as EventPersistence,
      broadcaster: { emitEventEnvelope: vi.fn() } as unknown as SessionBroadcaster,
      logger,
      processEnv: { OPENAI_REALTIME_TEST_KEY: "sk-test" },
      fetch,
    });

    await expect(
      broker.createCall({ agentSessionId: "sess-rt", offerSdp: "offer" }),
    ).rejects.toThrow(/Realtime requires codex backend/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows a Claude profile session whose persisted preset backend is Codex", async () => {
    const claudeProfile: AgentProfile = {
      ...profile,
      backend: "claude",
    };
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => "/v1/realtime/calls/call_preset" },
      text: async () => "answer-sdp",
    }));
    const { broker } = createBroker({
      row: sessionRow({ model_preset: "codex-5.6-sol" }),
      profile: claudeProfile,
      fetch,
      modelCatalog: {
        resolve: () => ({
          id: "codex-5.6-sol",
          label: "Codex - 5.6 Sol",
          backend: "codex",
          model: "gpt-5.6-sol",
        }),
      },
    });

    await expect(broker.createCall({
      agentSessionId: "sess-rt",
      offerSdp: "offer",
    })).resolves.toMatchObject({ callId: "call_preset" });
  });

  it("rejects a Codex profile session whose persisted preset backend is Claude", async () => {
    const fetch = vi.fn();
    const { broker } = createBroker({
      row: sessionRow({ model_preset: "claude-opus" }),
      fetch,
      modelCatalog: {
        resolve: () => ({
          id: "claude-opus",
          label: "Claude - Opus",
          backend: "claude",
          model: "opus",
        }),
      },
    });

    await expect(broker.createCall({
      agentSessionId: "sess-rt",
      offerSdp: "offer",
    })).rejects.toThrow(/Realtime requires codex backend.*claude/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("RealtimeBroker.relayEvent", () => {
  it("maps final user transcript to realtime_transcript", async () => {
    const { broker, enqueueEventAndWaitForSessionAck } = createBroker();
    const result = await broker.relayEvent({
      agentSessionId: "sess-rt",
      callId: "call_123",
      event: {
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "승인합니다",
        item_id: "item_1",
      },
    });

    expect(result).toMatchObject({
      status: "ok",
      normalizedType: "realtime_transcript",
      eventId: 7,
    });
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
      "sess-rt",
      expect.objectContaining({
        type: "realtime_transcript",
        role: "user",
        text: "승인합니다",
        call_id: "call_123",
      }),
    );
  });
});

describe("RealtimeBroker.resolveToolApproval", () => {
  it("persists resolved approval and returns data-channel decision event", async () => {
    const { broker, enqueueEventAndWaitForSessionAck } = createBroker();
    const result = await broker.resolveToolApproval({
      agentSessionId: "sess-rt",
      approvalId: "approval-1",
      decision: "rejected",
      source: "voice",
      message: "no",
    });

    expect(result.dataChannelEvent).toEqual({
      type: "tool_approval.response",
      approval_id: "approval-1",
      decision: "rejected",
      message: "no",
    });
    expect(enqueueEventAndWaitForSessionAck).toHaveBeenCalledWith(
      "sess-rt",
      expect.objectContaining({
        type: "tool_approval_resolved",
        approval_id: "approval-1",
        decision: "rejected",
        realtime: true,
        source: "voice",
      }),
    );
  });
});

describe("normalizeRealtimeEvent", () => {
  it("ignores transient delta events", () => {
    expect(
      normalizeRealtimeEvent({ type: "response.audio_transcript.delta", delta: "he" }),
    ).toBeNull();
  });
});
