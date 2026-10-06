import type { FastifyRequest } from "fastify";
import {
  PERSISTENT_SETTINGS_DEFAULTS,
  parsePersistentSettingsPatch,
  readPersistentEnabled,
  readStoredPersistentSettings,
  type PersistentModelSelection,
  type PersistentSettingsPatch,
} from "@soulstream/wire-schema/persistent-session-settings";
import {
  parsePersistentInstructionsApplyPayload,
  readPersistentInstructions,
  type PersistentInstruction,
  type PersistentInstructionsApplyPayload,
} from "@soulstream/wire-schema/persistent-session-instructions";

import type { ServiceCaller } from "../auth/service_caller.js";
import type {
  HostPersistentSessionRow,
  HostSessionRow,
} from "../control_plane/repositories/session_read_repository.js";
import {
  ModelPresetAvailabilityError,
  type ModelPresetAvailabilityService,
} from "../model/model_preset_availability.js";
import type { NodeCommandResponse } from "../node/pending_commands.js";
import { sanitizePgText } from "../node/pg_text_sanitizer.js";
import type { ExistingSessionActionPayload } from "./session_action_command_payloads.js";
import type { SessionActionCommandDispatchOptions } from "./session_action_command_errors.js";
import type { SessionCatalogProvider } from "./session_catalog_routes.js";
import type { SessionCreateRouteResponse } from "./session_create_route_response.js";
import {
  SessionResourceAccessError,
  type SessionResourceAccessProvider,
} from "./session_resource_access.js";
import {
  buildPersistentSessionResource,
  currentModelOfRow,
  type PersistentModelSelectionView,
  type PersistentSessionResource,
  type PersistentSettingsView,
} from "./persistent_session_resource.js";

/** New PAS defaults live here and nowhere else; the screens only render what `create_defaults` returns. */
export const PERSISTENT_CREATE_NODE_ID = "eiaserinnys";
export const PERSISTENT_PREFERRED_AGENT_ID = "seosoyoung-pas";
export const PERSISTENT_DEFAULT_MODEL_PRESET = "claude-opus";
/** Used when the first message is left empty; ordinary session creation keeps its own empty-input prompt. */
export const PERSISTENT_INITIAL_INSTRUCTION =
  "새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.";

export type PersistentCreateDefaults = {
  node_id: string;
  preferred_agent_id: string | null;
  settings: PersistentSettingsView;
  initial_instruction: string;
  unavailable_reason: string | null;
};

export type PersistentSessionSettingsServiceDeps = {
  reads: () => Promise<{
    getSession(sessionId: string): Promise<HostSessionRow | null>;
    listPersistentSessions(): Promise<HostPersistentSessionRow[]>;
  }>;
  access: SessionResourceAccessProvider;
  catalog: Pick<SessionCatalogProvider, "renameSession">;
  commands: Pick<SessionActionCommandDispatchOptions, "router" | "bridge" | "timeoutMs">;
  createSession: (
    request: FastifyRequest | ServiceCaller,
    body: Record<string, unknown>,
    logger: Pick<FastifyRequest["log"], "warn">,
  ) => Promise<SessionCreateRouteResponse>;
  presets: Pick<ModelPresetAvailabilityService, "resolveStaticForNode" | "requireAvailable">;
  profiles: { listAgentProfiles(nodeId: string): Promise<Record<string, { name?: unknown }> | undefined> };
};

type CallerRequest = FastifyRequest | ServiceCaller;
type SettingsAck = { persistent: boolean; modelChange: "none" | "next_execution_start" };
type PersistentInstructionsAck = NodeCommandResponse & {
  type: "persistent_session_instructions_applied";
  results: Array<{
    status: "ok" | "cap_reached" | "not_found";
    item?: PersistentInstruction;
  }>;
};
type PersistentInstructionView = Pick<
  PersistentInstruction,
  "id" | "text" | "source_turns" | "created_at" | "updated_at" | "origin"
>;

/** Failure with the HTTP status and public error code the route should answer with. */
export class PersistentSessionApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PersistentSessionApiError";
  }
}

export class PersistentSessionSettingsService {
  constructor(private readonly deps: PersistentSessionSettingsServiceDeps) {}

  async list(request: CallerRequest) {
    const rows = await (await this.deps.reads()).listPersistentSessions();
    const visible = await this.accessibleRows(request, rows);
    const names = await this.agentNames(visible);
    return {
      sessions: visible.map((row) => buildPersistentSessionResource(row, names.get(agentKey(row)) ?? null)),
      total: visible.length,
      create_defaults: await this.createDefaults(),
    };
  }

  async get(request: CallerRequest, sessionId: string): Promise<{ session: PersistentSessionResource }> {
    await this.deps.access.requireSessionAccess({ request, sessionId });
    return { session: await this.resource(await this.requireRow(sessionId)) };
  }

  async listInstructions(
    request: CallerRequest,
    sessionId: string,
  ): Promise<{ instructions: PersistentInstructionView[] }> {
    const row = await this.requirePersistentRow(request, sessionId);
    const instructions = readPersistentInstructions(row.metadata)
      .filter((instruction) => instruction.status === "active")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map(({ id, text, source_turns, created_at, updated_at, origin }) => ({
        id, text, source_turns, created_at, updated_at, origin,
      }));
    return { instructions };
  }

  async addInstruction(
    request: CallerRequest,
    sessionId: string,
    input: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const payload = parseInstructionAddBody(sessionId, input);
    await this.requirePersistentRow(request, sessionId);
    const result = firstInstructionResult(await this.sendInstructions(payload));
    if (result.status === "cap_reached") return { status: 409, body: { error: "cap_reached" } };
    if (result.status !== "ok" || result.item === undefined) {
      throw new Error(`Unexpected persistent instruction add result: ${result.status}`);
    }
    return { status: 201, body: { instruction: result.item } };
  }

  async updateInstruction(
    request: CallerRequest,
    sessionId: string,
    instructionId: string,
    input: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const payload = parseInstructionUpdateBody(sessionId, instructionId, input);
    await this.requirePersistentRow(request, sessionId);
    const result = firstInstructionResult(await this.sendInstructions(payload));
    if (result.status === "not_found") return { status: 404, body: { error: "not_found" } };
    if (result.status !== "ok" || result.item === undefined) {
      throw new Error(`Unexpected persistent instruction update result: ${result.status}`);
    }
    return { status: 200, body: { instruction: result.item } };
  }

  async update(request: CallerRequest, sessionId: string, input: unknown) {
    const body = parseUpdateBody(input);
    await this.deps.access.requireSessionAccess({ request, sessionId });
    const row = await this.requireRow(sessionId);
    if (row.session_type === "llm") {
      throw new PersistentSessionApiError(422, "INVALID_REQUEST", "LLM sessions cannot be persistent");
    }
    if (body.enabled === undefined && !readPersistentEnabled(row.metadata)) {
      throw new PersistentSessionApiError(409, "NOT_PERSISTENT", "Session is not a persistent agent session");
    }

    let settings = body.settings;
    if (settings?.default_model !== undefined) {
      settings = { ...settings, default_model: await this.normalizeDefaultModel(row, settings.default_model) };
    }
    if (body.display_name !== undefined && body.display_name !== row.display_name) {
      await this.deps.catalog.renameSession(sessionId, body.display_name);
    }
    const ack = await this.sendSettings(sessionId, {
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(settings === undefined ? {} : { settings }),
    });
    return {
      session: await this.resource(await this.requireRow(sessionId)),
      model_change: ack.modelChange,
    };
  }

  async create(
    request: CallerRequest,
    input: unknown,
    logger: Pick<FastifyRequest["log"], "warn">,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const body = parseCreateBody(input);
    const defaultModel = await this.normalizeNewDefaultModel(PERSISTENT_CREATE_NODE_ID, body.default_model);
    const created = await this.deps.createSession(request, {
      profile: body.agent_id,
      nodeId: PERSISTENT_CREATE_NODE_ID,
      model_preset: defaultModel.model_preset,
      ...(defaultModel.reasoning_effort === null ? {} : { reasoningEffort: defaultModel.reasoning_effort }),
      ...(body.folder_id === undefined ? {} : { folderId: body.folder_id }),
      initial_instruction: body.initial_instruction || PERSISTENT_INITIAL_INSTRUCTION,
    }, logger);
    if (created.status !== 201 || typeof created.body.agentSessionId !== "string") return created;

    const sessionId = created.body.agentSessionId;
    try {
      // session_rename updates silently when the row is missing, so require the row first.
      await this.requireRow(sessionId);
      await this.deps.catalog.renameSession(sessionId, body.display_name);
      await this.sendSettings(sessionId, { enabled: true, settings: { default_model: defaultModel } });
    } catch (error) {
      throw new PersistentSessionApiError(
        503,
        "PERSISTENT_REGISTRATION_FAILED",
        `The session was created but could not be registered as persistent: ${errorMessage(error)}`,
        { created_session: { session_id: sessionId, display_name: body.display_name } },
      );
    }
    return {
      status: 201,
      body: {
        session: await this.resource(await this.requireRow(sessionId)),
        creation: "started",
        warnings: Array.isArray(created.body.warnings) ? created.body.warnings : [],
      },
    };
  }

  private async requireRow(sessionId: string): Promise<HostSessionRow> {
    const row = await (await this.deps.reads()).getSession(sessionId);
    if (row === null) throw new PersistentSessionApiError(404, "SESSION_NOT_FOUND", "Session not found");
    return row;
  }

  private async requirePersistentRow(request: CallerRequest, sessionId: string): Promise<HostSessionRow> {
    await this.deps.access.requireSessionAccess({ request, sessionId });
    const row = await this.requireRow(sessionId);
    if (row.session_type === "llm") {
      throw new PersistentSessionApiError(422, "INVALID_REQUEST", "LLM sessions cannot be persistent");
    }
    if (!readPersistentEnabled(row.metadata)) {
      throw new PersistentSessionApiError(409, "NOT_PERSISTENT", "Session is not a persistent agent session");
    }
    return row;
  }

  private async resource(row: Record<string, unknown>): Promise<PersistentSessionResource> {
    const names = await this.agentNames([row]);
    return buildPersistentSessionResource(row, names.get(agentKey(row)) ?? null);
  }

  private async sendSettings(
    sessionId: string,
    fields: { enabled?: boolean; settings?: PersistentSettingsPatch },
  ): Promise<SettingsAck> {
    const payload: ExistingSessionActionPayload<"set_persistent_session_settings"> = {
      type: "set_persistent_session_settings",
      agentSessionId: sessionId,
      ...fields,
    };
    const routed = await this.deps.commands.router.routeExistingSessionPendingCommand(payload, {
      timeoutMs: this.deps.commands.timeoutMs,
    });
    const response: NodeCommandResponse = await this.deps.commands.bridge.sendPendingCommand(routed);
    return {
      persistent: response.persistent === true,
      modelChange: response.modelChange === "next_execution_start" ? "next_execution_start" : "none",
    };
  }

  private async sendInstructions(payload: PersistentInstructionsApplyPayload): Promise<PersistentInstructionsAck["results"]> {
    const command: ExistingSessionActionPayload<"apply_persistent_session_instructions"> = {
      type: "apply_persistent_session_instructions",
      agentSessionId: payload.session_id,
      origin: payload.origin,
      ops: payload.ops,
      ...(payload.anchor === undefined ? {} : { anchor: payload.anchor }),
    };
    const routed = await this.deps.commands.router.routeExistingSessionPendingCommand(command, {
      timeoutMs: this.deps.commands.timeoutMs,
    });
    const response = await this.deps.commands.bridge.sendPendingCommand(routed) as PersistentInstructionsAck;
    if (response.type !== "persistent_session_instructions_applied") {
      throw new Error(`Unexpected persistent instruction response: ${response.type}`);
    }
    return response.results;
  }

  /** Existing default (stored, else the running model) decides whether this save changes the preset or keeps the effort. */
  private async normalizeDefaultModel(
    row: Record<string, unknown>,
    requested: PersistentModelSelection,
  ): Promise<PersistentModelSelection> {
    const nodeId = typeof row.node_id === "string" ? row.node_id : "";
    const current = currentModelOfRow(row);
    const existing = readStoredPersistentSettings(row.metadata)?.default_model
      ?? (current.model_preset === null
        ? null
        : { model_preset: current.model_preset, reasoning_effort: current.reasoning_effort });
    const samePreset = existing?.model_preset === requested.model_preset;
    return this.normalizeModel(nodeId, requested, {
      requireAvailable: !samePreset,
      keepEffort: samePreset ? existing?.reasoning_effort ?? null : undefined,
    });
  }

  private async normalizeNewDefaultModel(nodeId: string, requested: PersistentModelSelection) {
    return this.normalizeModel(nodeId, requested, { requireAvailable: true, keepEffort: undefined });
  }

  private normalizeModel(
    nodeId: string,
    requested: PersistentModelSelection,
    options: { requireAvailable: boolean; keepEffort: string | null | undefined },
  ): PersistentModelSelection {
    let preset: ReturnType<ModelPresetAvailabilityService["resolveStaticForNode"]>;
    try {
      preset = this.deps.presets.resolveStaticForNode(nodeId, requested.model_preset);
      if (options.requireAvailable) this.deps.presets.requireAvailable(nodeId, requested.model_preset);
    } catch (error) {
      if (error instanceof ModelPresetAvailabilityError) {
        throw new PersistentSessionApiError(422, "INVALID_MODEL_PRESET", error.message);
      }
      throw error;
    }
    if (preset.backend !== "claude" && preset.backend !== "codex") {
      throw new PersistentSessionApiError(
        422,
        "INVALID_MODEL_PRESET",
        `Persistent sessions support claude and codex presets only: ${preset.id}`,
      );
    }
    if (requested.reasoning_effort !== null) {
      if (!preset.supported_efforts?.includes(requested.reasoning_effort)) {
        throw new PersistentSessionApiError(
          422,
          "UNSUPPORTED_REASONING_EFFORT",
          `Reasoning effort "${requested.reasoning_effort}" is not supported by model preset "${preset.id}"`,
        );
      }
      return { model_preset: preset.id, reasoning_effort: requested.reasoning_effort };
    }
    return {
      model_preset: preset.id,
      reasoning_effort: options.keepEffort !== undefined ? options.keepEffort : preset.default_effort ?? null,
    };
  }

  private async accessibleRows(request: CallerRequest, rows: HostPersistentSessionRow[]) {
    const decisions = new Map<string | null, Promise<boolean>>();
    const allowed = (folderId: string | null) => {
      let decision = decisions.get(folderId);
      if (decision === undefined) {
        decision = this.deps.access.requireFolderAccess({ request, folderId }).then(
          () => true,
          (error: unknown) => {
            if (error instanceof SessionResourceAccessError) return false;
            throw error;
          },
        );
        decisions.set(folderId, decision);
      }
      return decision;
    };
    const visible: HostPersistentSessionRow[] = [];
    for (const row of rows) {
      if (await allowed(row.folder_id)) visible.push(row);
    }
    return visible;
  }

  /** Profile display names by node and agent id; a node that is offline simply has no names. */
  private async agentNames(rows: ReadonlyArray<Record<string, unknown>>): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const nodeIds = new Set(rows.flatMap((row) => typeof row.node_id === "string" ? [row.node_id] : []));
    for (const nodeId of nodeIds) {
      const profiles = await this.deps.profiles.listAgentProfiles(nodeId);
      for (const [agentId, profile] of Object.entries(profiles ?? {})) {
        if (typeof profile.name === "string" && profile.name.length > 0) names.set(`${nodeId}\u0000${agentId}`, profile.name);
      }
    }
    return names;
  }

  async createDefaults(): Promise<PersistentCreateDefaults> {
    const reasons: string[] = [];
    const profiles = await this.deps.profiles.listAgentProfiles(PERSISTENT_CREATE_NODE_ID);
    let preferredAgentId: string | null = null;
    if (profiles === undefined) {
      reasons.push(`노드 ${PERSISTENT_CREATE_NODE_ID}에 연결할 수 없어 프로필을 확인하지 못했습니다.`);
    } else if (PERSISTENT_PREFERRED_AGENT_ID in profiles) {
      preferredAgentId = PERSISTENT_PREFERRED_AGENT_ID;
    } else {
      reasons.push(`프로필 ${PERSISTENT_PREFERRED_AGENT_ID}이(가) 노드 ${PERSISTENT_CREATE_NODE_ID}에 없습니다.`);
    }
    let defaultModel: PersistentModelSelectionView = { model_preset: null, reasoning_effort: null };
    try {
      const preset = this.deps.presets.resolveStaticForNode(PERSISTENT_CREATE_NODE_ID, PERSISTENT_DEFAULT_MODEL_PRESET);
      defaultModel = { model_preset: preset.id, reasoning_effort: preset.default_effort ?? null };
    } catch (error) {
      if (!(error instanceof ModelPresetAvailabilityError)) throw error;
      reasons.push(`기본 모델 ${PERSISTENT_DEFAULT_MODEL_PRESET}이(가) 노드 ${PERSISTENT_CREATE_NODE_ID}에 없습니다.`);
    }
    return {
      node_id: PERSISTENT_CREATE_NODE_ID,
      preferred_agent_id: preferredAgentId,
      settings: {
        default_model: defaultModel,
        fallback_model: { ...PERSISTENT_SETTINGS_DEFAULTS.fallback_model },
        show_generation_separator: PERSISTENT_SETTINGS_DEFAULTS.show_generation_separator,
        show_character: PERSISTENT_SETTINGS_DEFAULTS.show_character,
        show_jev_candidates: PERSISTENT_SETTINGS_DEFAULTS.show_jev_candidates,
        show_turn_usage: PERSISTENT_SETTINGS_DEFAULTS.show_turn_usage,
        animate_character: PERSISTENT_SETTINGS_DEFAULTS.animate_character,
      },
      initial_instruction: PERSISTENT_INITIAL_INSTRUCTION,
      unavailable_reason: reasons.length === 0 ? null : reasons.join(" "),
    };
  }
}

function agentKey(row: Record<string, unknown>): string {
  return `${String(row.node_id)}\u0000${String(row.agent_id)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type UpdateBody = {
  display_name?: string;
  enabled?: boolean;
  settings?: PersistentSettingsPatch;
};

function parseInstructionAddBody(sessionId: string, input: unknown): PersistentInstructionsApplyPayload {
  const body = requireObjectBody(input);
  rejectInstructionUnknownKeys(body, ["text"]);
  return parseInstructionPayload(sessionId, { op: "add", text: body.text });
}

function parseInstructionUpdateBody(
  sessionId: string,
  instructionId: string,
  input: unknown,
): PersistentInstructionsApplyPayload {
  const body = requireObjectBody(input);
  rejectInstructionUnknownKeys(body, ["text", "status"]);
  return parseInstructionPayload(sessionId, {
    op: "update",
    id: instructionId,
    ...(body.text === undefined ? {} : { text: body.text }),
    ...(body.status === undefined ? {} : { status: body.status }),
  });
}

function parseInstructionPayload(sessionId: string, op: Record<string, unknown>): PersistentInstructionsApplyPayload {
  const parsed = parsePersistentInstructionsApplyPayload({
    session_id: sessionId,
    origin: "user",
    ops: [op],
  });
  if (!parsed.ok) throw new PersistentSessionApiError(400, "INVALID_REQUEST", parsed.message);
  return parsed.value;
}

function rejectInstructionUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new PersistentSessionApiError(400, "INVALID_REQUEST", `${unknown} is not supported`);
  }
}

function firstInstructionResult(results: PersistentInstructionsAck["results"]) {
  const result = results[0];
  if (result === undefined) throw new Error("Persistent instruction ACK returned no result");
  return result;
}

function parseUpdateBody(input: unknown): UpdateBody {
  const body = requireObjectBody(input);
  rejectUnknownKeys(body, ["display_name", "enabled", "settings"]);
  const result: UpdateBody = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    result.enabled = body.enabled;
  }
  if (body.display_name !== undefined) result.display_name = parseDisplayName(body.display_name);
  if (body.settings !== undefined) result.settings = parseSettings(body.settings);
  if (result.enabled === false && (result.display_name !== undefined || result.settings !== undefined)) {
    throw invalid("display_name and settings cannot be combined with enabled=false");
  }
  return result;
}

type CreateBody = {
  display_name: string;
  agent_id: string;
  folder_id?: string;
  initial_instruction: string;
  default_model: PersistentModelSelection;
};

function parseCreateBody(input: unknown): CreateBody {
  const body = requireObjectBody(input);
  rejectUnknownKeys(body, ["display_name", "agent_id", "folder_id", "initial_instruction", "settings"]);
  if (typeof body.agent_id !== "string" || body.agent_id.trim().length === 0) {
    throw invalid("agent_id must be a non-empty string");
  }
  if (body.folder_id !== undefined && body.folder_id !== null
    && (typeof body.folder_id !== "string" || body.folder_id.length === 0)) {
    throw invalid("folder_id must be a non-empty string");
  }
  if (body.initial_instruction !== undefined && typeof body.initial_instruction !== "string") {
    throw invalid("initial_instruction must be a string");
  }
  const settings = body.settings === undefined ? undefined : parseSettings(body.settings);
  if (settings?.default_model === undefined) throw invalid("settings.default_model is required");
  const hiddenKeys = Object.keys(settings).filter((key) => key !== "default_model");
  if (hiddenKeys.length > 0) throw invalid(`settings.${hiddenKeys[0]} cannot be set when creating a session`);
  return {
    display_name: parseDisplayName(body.display_name),
    agent_id: body.agent_id.trim(),
    ...(typeof body.folder_id === "string" ? { folder_id: body.folder_id } : {}),
    initial_instruction: typeof body.initial_instruction === "string" ? body.initial_instruction.trim() : "",
    default_model: settings.default_model,
  };
}

function parseDisplayName(value: unknown): string {
  const name = typeof value === "string" ? sanitizePgText(value).trim() : "";
  if (name.length === 0) throw invalid("display_name must be a non-empty string");
  return name;
}

function parseSettings(value: unknown): PersistentSettingsPatch {
  const parsed = parsePersistentSettingsPatch(value);
  if (!parsed.ok) throw invalid(parsed.message);
  return parsed.value;
}

function requireObjectBody(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PersistentSessionApiError(400, "INVALID_REQUEST", "Request body must be a JSON object");
  }
  return input as Record<string, unknown>;
}

function rejectUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw invalid(`${unknown} is not supported`);
}

function invalid(message: string): PersistentSessionApiError {
  return new PersistentSessionApiError(422, "INVALID_REQUEST", message);
}
