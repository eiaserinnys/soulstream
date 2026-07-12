import type { Logger } from "pino";

import type { AgentProfile, AgentRegistry } from "../agent_registry.js";
import type { SessionDB, SessionRow } from "../db/session_db.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task, TaskStatus } from "../task/task_models.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: FormData;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface RealtimeCreateCallParams {
  agentSessionId: string;
  offerSdp: string;
  model?: string | null;
  voice?: string | null;
  instructions?: string | null;
}

export interface RealtimeCreateCallResult {
  status: "ok";
  agentSessionId: string;
  callId: string;
  answerSdp: string;
  eventId?: number;
}

export interface RealtimeRelayEventParams {
  agentSessionId: string;
  event: unknown;
  callId?: string | null;
}

export interface RealtimeRelayEventResult {
  status: "ok";
  agentSessionId: string;
  normalizedType?: string;
  eventId?: number;
}

export interface RealtimeResolveApprovalParams {
  agentSessionId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  message?: string;
  source?: "tap" | "voice";
  callId?: string | null;
}

export interface RealtimeResolveApprovalResult {
  status: "ok";
  agentSessionId: string;
  approvalId: string;
  decision: "approved" | "rejected";
  eventId?: number;
  dataChannelEvent: Record<string, unknown>;
}

export class RealtimeBroker {
  constructor(
    private readonly deps: {
      agentRegistry: AgentRegistry;
      db: SessionDB;
      persistence: EventPersistence;
      broadcaster: SessionBroadcaster;
      logger: Logger;
      processEnv: NodeJS.ProcessEnv;
      fetch?: FetchLike;
    },
  ) {}

  async createCall(params: RealtimeCreateCallParams): Promise<RealtimeCreateCallResult> {
    const { row, profile } = await this.getSessionContext(params.agentSessionId);
    const { model, instructions } = selectRealtimeConfig(profile, params);
    const apiKey = resolveProviderApiKey(profile, this.deps.processEnv);
    const baseUrl = normalizeBaseUrl(profile.agents_sdk?.provider?.base_url);
    const callUrl = `${baseUrl}/realtime/calls`;

    const sessionConfig: Record<string, unknown> = {
      type: "realtime",
      model,
      instructions,
    };
    if (params.voice) {
      sessionConfig.audio = {
        output: {
          voice: params.voice,
        },
      };
    }

    const form = new FormData();
    form.append("sdp", params.offerSdp);
    form.append("session", JSON.stringify(sessionConfig));

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
    };
    const provider = profile.agents_sdk?.provider;
    if (provider?.organization) headers["OpenAI-Organization"] = provider.organization;
    if (provider?.project) headers["OpenAI-Project"] = provider.project;

    const fetchImpl = this.deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    if (!fetchImpl) {
      throw new Error("Realtime broker requires fetch implementation");
    }
    const res = await fetchImpl(callUrl, {
      method: "POST",
      headers,
      body: form,
    });
    const answerSdp = await res.text();
    if (!res.ok) {
      throw new Error(
        `OpenAI Realtime call failed: HTTP ${res.status} ${res.statusText} ${answerSdp.slice(0, 200)}`.trim(),
      );
    }
    if (!answerSdp.trim()) {
      throw new Error("OpenAI Realtime call returned empty SDP answer");
    }

    const callId = extractCallId(res.headers.get("location")) ?? makeLocalCallId(row.session_id);
    const eventId = await this.persistAndBroadcast(
      row,
      asSse({
        type: "realtime_status",
        status: "connected",
        call_id: callId,
        message: "Realtime voice connected",
        timestamp: Date.now() / 1000,
      }),
    );

    return {
      status: "ok",
      agentSessionId: params.agentSessionId,
      callId,
      answerSdp,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }

  async relayEvent(params: RealtimeRelayEventParams): Promise<RealtimeRelayEventResult> {
    const { row } = await this.getSessionContext(params.agentSessionId);
    const normalized = normalizeRealtimeEvent(params.event, params.callId ?? undefined);
    if (!normalized) {
      return {
        status: "ok",
        agentSessionId: params.agentSessionId,
      };
    }
    const eventId = await this.persistAndBroadcast(row, normalized);
    return {
      status: "ok",
      agentSessionId: params.agentSessionId,
      normalizedType: (normalized as { type?: string }).type,
      ...(eventId !== undefined ? { eventId } : {}),
    };
  }

  async resolveToolApproval(
    params: RealtimeResolveApprovalParams,
  ): Promise<RealtimeResolveApprovalResult> {
    const { row } = await this.getSessionContext(params.agentSessionId);
    const event = asSse({
      type: "tool_approval_resolved",
      approval_id: params.approvalId,
      approvalId: params.approvalId,
      decision: params.decision,
      realtime: true,
      ...(params.source ? { source: params.source } : {}),
      ...(params.callId ? { call_id: params.callId } : {}),
      ...(params.message ? { message: params.message } : {}),
      timestamp: Date.now() / 1000,
    });
    const eventId = await this.persistAndBroadcast(row, event);
    return {
      status: "ok",
      agentSessionId: params.agentSessionId,
      approvalId: params.approvalId,
      decision: params.decision,
      ...(eventId !== undefined ? { eventId } : {}),
      dataChannelEvent: {
        type: "tool_approval.response",
        approval_id: params.approvalId,
        decision: params.decision,
        ...(params.message ? { message: params.message } : {}),
      },
    };
  }

  private async getSessionContext(
    agentSessionId: string,
  ): Promise<{ row: SessionRow; profile: AgentProfile }> {
    if (!agentSessionId) {
      throw new Error("realtime requires agentSessionId");
    }
    const row = await this.deps.db.getSession(agentSessionId);
    if (!row) {
      throw new Error(`Realtime session not found: ${agentSessionId}`);
    }
    if (!row.agent_id) {
      throw new Error(`Realtime session ${agentSessionId} has no agent profile`);
    }
    const profile = this.deps.agentRegistry.get(row.agent_id);
    if (!profile) {
      throw new Error(`Realtime session ${agentSessionId} profile not registered: ${row.agent_id}`);
    }
    if (profile.backend !== "codex") {
      throw new Error(
        `Realtime requires codex backend; session ${agentSessionId} uses ${profile.backend}`,
      );
    }
    return { row, profile };
  }

  private async persistAndBroadcast(
    row: SessionRow,
    event: SSEEventPayload,
  ): Promise<number | undefined> {
    const task = taskFromSessionRow(row);
    let eventId: number | undefined;
    try {
      eventId = await this.deps.persistence.persistEvent(row.session_id, event);
      task.lastEventId = eventId;
      (event as Record<string, unknown>)._event_id = eventId;
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: row.session_id, eventType: (event as { type?: string }).type },
        "realtime persistEvent failed",
      );
    }
    try {
      await this.deps.broadcaster.emitEventEnvelope(row.session_id, event);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: row.session_id, eventType: (event as { type?: string }).type },
        "realtime emitEventEnvelope failed",
      );
    }
    try {
      await this.deps.persistence.handleSideEffects(row.session_id, event, task);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: row.session_id, eventType: (event as { type?: string }).type },
        "realtime handleSideEffects failed",
      );
    }
    return eventId;
  }
}

export function normalizeRealtimeEvent(
  rawEvent: unknown,
  callId?: string,
): SSEEventPayload | null {
  if (!isRecord(rawEvent)) {
    return asSse({
      type: "realtime_status",
      status: "event_ignored",
      message: "Realtime event was not an object",
      ...(callId ? { call_id: callId } : {}),
      timestamp: Date.now() / 1000,
    });
  }
  const type = typeof rawEvent.type === "string" ? rawEvent.type : "";
  if (type === "realtime_status" || type === "realtime_transcript") {
    return withRealtimeDefaults(rawEvent, callId);
  }
  if (type === "tool_approval_requested") {
    return withRealtimeDefaults({ ...rawEvent, realtime: true }, callId);
  }
  if (type === "tool_approval_resolved") {
    return withRealtimeDefaults({ ...rawEvent, realtime: true }, callId);
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = stringField(rawEvent, "transcript");
    if (!text) return null;
    return asSse({
      type: "realtime_transcript",
      role: "user",
      text,
      final: true,
      ...(stringField(rawEvent, "item_id") ? { item_id: stringField(rawEvent, "item_id") } : {}),
      ...(callId ? { call_id: callId } : {}),
      raw_event_type: type,
      timestamp: Date.now() / 1000,
    });
  }
  if (type === "response.audio_transcript.done" || type === "response.output_text.done") {
    const text = stringField(rawEvent, "transcript") || stringField(rawEvent, "text");
    if (!text) return null;
    return asSse({
      type: "realtime_transcript",
      role: "assistant",
      text,
      final: true,
      ...(stringField(rawEvent, "item_id") ? { item_id: stringField(rawEvent, "item_id") } : {}),
      ...(callId ? { call_id: callId } : {}),
      raw_event_type: type,
      timestamp: Date.now() / 1000,
    });
  }
  if (type === "input_audio_buffer.speech_started" || type === "input_audio_buffer.speech_stopped") {
    return asSse({
      type: "realtime_status",
      status: type.endsWith("started") ? "listening" : "processing",
      ...(callId ? { call_id: callId } : {}),
      raw_event_type: type,
      timestamp: Date.now() / 1000,
    });
  }
  if (type === "response.created" || type === "response.done") {
    return asSse({
      type: "realtime_status",
      status: type === "response.created" ? "responding" : "idle",
      ...(callId ? { call_id: callId } : {}),
      raw_event_type: type,
      timestamp: Date.now() / 1000,
    });
  }
  if (type === "error") {
    return asSse({
      type: "error",
      message: stringField(rawEvent, "message") || "Realtime API error",
      ...(callId ? { call_id: callId } : {}),
      timestamp: Date.now() / 1000,
    });
  }
  return null;
}

function selectRealtimeConfig(
  profile: AgentProfile,
  params: RealtimeCreateCallParams,
): { model: string; instructions: string } {
  const config = profile.agents_sdk;
  if (!config) {
    throw new Error(`Realtime profile ${profile.id} is missing agents_sdk config`);
  }
  const entry = config.agents.find((agent) => agent.id === config.entry_agent);
  if (!entry) {
    throw new Error(`Realtime profile ${profile.id} entry_agent not found: ${config.entry_agent}`);
  }
  const model = params.model ?? entry.model;
  if (!model) {
    throw new Error(
      `Realtime profile ${profile.id} requires agents_sdk.agents[].model or request model`,
    );
  }
  const instructions = params.instructions ?? entry.instructions;
  return { model, instructions };
}

function resolveProviderApiKey(
  profile: AgentProfile,
  env: NodeJS.ProcessEnv,
): string {
  const apiKeyEnv = profile.agents_sdk?.provider?.api_key_env;
  if (!apiKeyEnv) {
    throw new Error(
      `Realtime profile ${profile.id} requires agents_sdk.provider.api_key_env`,
    );
  }
  const apiKey = env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(`Realtime provider api key env ${apiKeyEnv} is not set`);
  }
  return apiKey;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

function extractCallId(location: string | null): string | null {
  if (!location) return null;
  const cleaned = location.replace(/\/+$/, "");
  const last = cleaned.split("/").pop();
  return last || null;
}

function makeLocalCallId(sessionId: string): string {
  return `rt_${sessionId}_${Date.now().toString(36)}`;
}

function taskFromSessionRow(row: SessionRow): Task {
  return {
    agentSessionId: row.session_id,
    prompt: row.prompt ?? "",
    status: normalizeTaskStatus(row.status),
    reviewRequired: row.review_required === true,
    reviewState: row.review_state ?? "not_required",
    profileId: row.agent_id ?? undefined,
    callerSessionId: row.caller_session_id ?? undefined,
    metadata: Array.isArray(row.metadata) ? row.metadata as Array<Record<string, unknown>> : [],
    createdAt: row.created_at ?? new Date(),
    lastEventId: row.last_event_id ?? 0,
    lastReadEventId: row.last_read_event_id ?? 0,
    interventionQueue: [],
  };
}

function normalizeTaskStatus(status: string | null): TaskStatus {
  if (status === "completed" || status === "error" || status === "interrupted") {
    return status;
  }
  return "running";
}

function withRealtimeDefaults(
  event: Record<string, unknown>,
  callId?: string,
): SSEEventPayload {
  return asSse({
    ...event,
    ...(callId && !event.call_id ? { call_id: callId } : {}),
    ...(typeof event.timestamp === "number" ? {} : { timestamp: Date.now() / 1000 }),
  });
}

function asSse(event: Record<string, unknown>): SSEEventPayload {
  return event as unknown as SSEEventPayload;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
