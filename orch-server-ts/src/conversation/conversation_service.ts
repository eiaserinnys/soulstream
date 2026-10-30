import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { HostSessionRow } from "../control_plane/repositories/session_read_repository.js";
import type { ModelPresetAvailabilityService } from "../model/model_preset_availability.js";
import type { PersistentSessionSettingsService } from "../session/persistent_session_settings_service.js";
import { PERSISTENT_CREATE_NODE_ID } from "../session/persistent_session_settings_service.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import type { SessionCreateRouteResponse } from "../session/session_create_route_response.js";
import { ConversationRepository } from "./conversation_repository.js";
import { ConversationError, type Binding, type EnsureRequest, type PatchRequest, type Thread } from "./conversation_types.js";

type Caller = FastifyRequest;
type Deps = {
  sql: SqlClient;
  access: Pick<SessionResourceAccessProvider, "requireFolderAccess" | "requireSessionAccess">;
  reads: () => Promise<{ getSession(id: string): Promise<HostSessionRow | null> }>;
  persistent: Pick<PersistentSessionSettingsService, "get" | "update" | "listInstructions" | "addInstruction" | "updateInstruction">;
  presets: Pick<ModelPresetAvailabilityService, "listForNode">;
  create: (request: Caller, body: Record<string, unknown>, id: string, logger: Pick<Caller["log"], "warn">) => Promise<SessionCreateRouteResponse>;
  waitForCreatedSession: (id: string) => Promise<boolean>;
  responseTimeoutMs?: number;
};

export class ConversationService {
  private readonly repo: ConversationRepository;
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(private readonly deps: Deps) { this.repo = new ConversationRepository(deps.sql); }

  models() {
    const presets = this.deps.presets.listForNode(PERSISTENT_CREATE_NODE_ID);
    if (!presets) throw new ConversationError(503, "unavailable", "Model provider is unavailable");
    return { models: presets.map(p => ({ id: p.id, label: p.label, available: p.available,
      ...(p.available || !p.reason_label ? {} : { reason: p.reason_label }) })) };
  }
  private model(id: string) { return this.deps.presets.listForNode(PERSISTENT_CREATE_NODE_ID)?.find(p => p.id === id); }
  private choose(body: EnsureRequest) {
    const candidates = [...new Set([body.selected_model, ...body.model_order])];
    const models = this.models().models;
    const chosen = candidates.map(id => models.find(m => m.id === id)).find(m => m?.available);
    if (!chosen) throw new ConversationError(422, "model_unavailable", "No requested model is available");
    return chosen;
  }
  async list(request: Caller, account: string, namespace: string, cursor?: string) {
    const bindings = await this.repo.list(account, namespace);
    const refs: Array<Pick<Thread, "id" | "title" | "created_at" | "archived">> = [];
    let nextCursor: string | undefined;
    let refsCursor = "";
    for (const binding of bindings) {
      if (cursor !== undefined && binding.external_key <= cursor) continue;
      try {
        const thread = await this.thread(request, binding);
        if (refs.length === 100) { nextCursor = refsCursor; break; }
        refs.push({ id: thread.id, title: thread.title, created_at: thread.created_at, archived: thread.archived });
        refsCursor = binding.external_key;
      } catch (error) {
        if (error instanceof ConversationError && (error.status === 404 || error.status === 504)) continue;
        if (isStatus(error, 403) || isStatus(error, 404)) continue;
        throw error;
      }
    }
    return { refs, ...(nextCursor ? { next_cursor: nextCursor } : {}) };
  }
  async byKey(request: Caller, account: string, namespace: string, key: string) {
    const binding = await this.repo.byKey(account, namespace, key);
    if (!binding) throw notFound();
    return { thread: await this.thread(request, binding) };
  }
  async info(request: Caller, account: string, id: string) {
    const binding = await this.requireBinding(account, id);
    const thread = await this.thread(request, binding);
    const row = await this.requireRow(id);
    const events = await this.deps.sql<Array<{ event_type: string; payload: Record<string, unknown> }>>`
      SELECT event_type,payload FROM events WHERE session_id=${id}
      AND event_type IN ('user_message','intervention_sent','tool_start','tool_result','complete','error','assistant_error')
      ORDER BY id DESC LIMIT 1`;
    const event = events[0];
    const busy = event ? ["user_message", "intervention_sent", "tool_start", "tool_result"].includes(event.event_type) : false;
    const tool = event?.event_type === "tool_start" && typeof event.payload?.tool_name === "string" ? event.payload.tool_name : null;
    const currentId = typeof row.model_preset === "string" ? row.model_preset : null;
    return { thread, busy, tool, current_model: currentId ? { id: currentId, label: this.model(currentId)?.label ?? currentId } : null };
  }
  async ensure(request: Caller, account: string, namespace: string, key: string, body: EnsureRequest) {
    let binding = await this.repo.byKey(account, namespace, key);
    let created = false;
    if (!binding) {
      await this.deps.access.requireFolderAccess({ request, folderId: body.collection });
      const selected = this.choose(body);
      const notices = selected.id === body.selected_model ? [] : [`${body.selected_model}을(를) 사용할 수 없어 ${selected.label}(으)로 시작했습니다.`];
      created = await this.repo.reserve(account, namespace, key, randomUUID(), selected.id, body, "reserved", notices);
      binding = await this.repo.byKey(account, namespace, key);
      if (!binding) throw new ConversationError(409, "conflict", "Session binding already exists");
    }
    if (binding.phase === "complete") return { thread: await this.thread(request, binding), created: false, notices: binding.notices };
    if (binding.creation_request) await this.deps.access.requireFolderAccess({ request, folderId: binding.creation_request.collection });
    const id = binding.session_id;
    let work = this.inFlight.get(id);
    if (!work) {
      work = this.initialize(request, binding).finally(() => { this.inFlight.delete(id); });
      this.inFlight.set(id, work);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(pendingError(id)), this.deps.responseTimeoutMs ?? 15_000); });
      await Promise.race([work, pending]);
    } finally { if (timer) clearTimeout(timer); }
    const current = await this.requireBinding(account, id);
    return { thread: await this.thread(request, current), created, notices: current.notices };
  }
  private async initialize(request: Caller, binding: Binding): Promise<void> {
    const id = binding.session_id;
    const body = binding.creation_request;
    if (!body) throw new ConversationError(503, "unavailable", "Creation data is missing");
    let row = await (await this.deps.reads()).getSession(id);
    if (!row && binding.phase === "reserved") {
      await this.repo.phase(id, "dispatched");
      let result = await this.deps.create(request, {
        profile: body.profile, nodeId: PERSISTENT_CREATE_NODE_ID, folderId: body.collection,
        model_preset: binding.selected_model, initial_instruction: body.initial_instruction,
      }, id, request.log);
      const attempted = new Set([binding.selected_model]);
      while (result.status !== 201 && (result.body.error as { code?: string } | undefined)?.code === "MODEL_PRESET_UNAVAILABLE") {
        const models = this.models().models;
        const candidate = [...new Set([body.selected_model, ...body.model_order])]
          .map(model => models.find(item => item.id === model))
          .find(item => item?.available && !attempted.has(item.id));
        if (!candidate) { await this.repo.phase(id, "reserved"); throw new ConversationError(422, "model_unavailable", "No requested model is available"); }
        attempted.add(candidate.id); binding.selected_model = candidate.id;
        binding.notices = candidate.id === body.selected_model ? [] : [`${body.selected_model}을(를) 사용할 수 없어 ${candidate.label}(으)로 시작했습니다.`];
        await this.repo.selection(id, candidate.id, binding.notices);
        result = await this.deps.create(request, { profile: body.profile, nodeId: PERSISTENT_CREATE_NODE_ID, folderId: body.collection,
          model_preset: candidate.id, initial_instruction: body.initial_instruction }, id, request.log);
      }
      if (result.status !== 201) {
        const error = result.body.error as { code?: string; message?: string } | undefined;
        if (error?.code === "NODE_COMMAND_TIMEOUT") throw pendingError(id);
        // A rejected input or unavailable node did not create a session; permit a later retry.
        const unavailable = ["NO_AVAILABLE_NODE", "NODE_NOT_FOUND", "TRANSPORT_MISSING", "TRANSPORT_STALE", "TRANSPORT_JSON_FAILED"].includes(error?.code ?? "");
        if (result.status < 500 || unavailable) {
          await this.repo.phase(id, "reserved");
        }
        const status = unavailable ? 503 : result.status === 403 ? 403 : result.status < 500 ? 400 : 503;
        throw new ConversationError(status, status === 403 ? "forbidden" : status === 400 ? "invalid_request" : "unavailable", error?.message ?? "Session creation failed");
      }
      row = await (await this.deps.reads()).getSession(id);
    }
    if (!row) {
      await this.deps.waitForCreatedSession(id);
      row = await (await this.deps.reads()).getSession(id);
      if (!row) throw pendingError(id);
    }
    await this.deps.access.requireSessionAccess({ request, sessionId: id });
    let resource = (await this.deps.persistent.get(request, id)).session;
    if (!resource.persistent || resource.display_name !== body.title) {
      await this.deps.persistent.update(request, id, { enabled: true, display_name: body.title });
      resource = (await this.deps.persistent.get(request, id)).session;
    }
    const fallbacks = [...new Set(body.model_order)].filter(model => model !== binding.selected_model);
    const defaultModel = resource.settings.default_model.model_preset;
    const existingFallbacks = resource.settings.fallback_models.map(x => x.model_preset);
    if (defaultModel !== binding.selected_model || JSON.stringify(existingFallbacks) !== JSON.stringify(fallbacks)) {
      await this.deps.persistent.update(request, id, { settings: {
        default_model: { model_preset: binding.selected_model, reasoning_effort: null },
        fallback_models: fallbacks.map(model_preset => ({ model_preset, reasoning_effort: null })),
      } });
    }
    if (body.instructions.trim()) await this.setInstruction(request, binding, body.instructions);
    await this.repo.phase(id, "complete");
  }
  private async setInstruction(request: Caller, binding: Binding, text: string) {
    const id = binding.session_id;
    const list = (await this.deps.persistent.listInstructions(request, id)).instructions;
    const target = binding.instruction_id ? list.find(i => i.id === binding.instruction_id) : undefined;
    const existing = target ?? list.find(i => i.text === text.trim());
    if (existing) {
      if (existing.text !== text.trim()) {
        const result = await this.deps.persistent.updateInstruction(request, id, existing.id, { text });
        if (result.status !== 200) throw new ConversationError(503, "unavailable", "Could not update instructions");
      }
      await this.repo.instruction(id, existing.id); return;
    }
    const result = await this.deps.persistent.addInstruction(request, id, { text });
    const item = result.body.instruction as { id?: unknown } | undefined;
    if (result.status !== 201 || typeof item?.id !== "string") throw new ConversationError(503, "unavailable", "Could not add instructions");
    await this.repo.instruction(id, item.id);
  }
  async adopt(request: Caller, account: string, namespace: string, key: string, id: string) {
    let existing = await this.repo.byKey(account, namespace, key);
    if (existing) {
      await this.thread(request, existing);
      if (existing.session_id !== id) throw new ConversationError(409, "conflict", "External key is already bound to another thread");
      return { thread: await this.thread(request, existing), created: false, notices: existing.notices };
    }
    await this.deps.access.requireSessionAccess({ request, sessionId: id });
    const row = await this.requireRow(id);
    const model = typeof row.model_preset === "string" ? row.model_preset : "";
    if (!model) throw new ConversationError(422, "invalid_request", "Session has no model");
    const inserted = await this.repo.reserve(account, namespace, key, id, model, null, "complete", []);
    existing = await this.repo.byKey(account, namespace, key);
    if (!existing || existing.session_id !== id) throw new ConversationError(409, "conflict", "Thread or external key is already bound");
    return { thread: await this.thread(request, existing), created: inserted, notices: existing.notices };
  }
  async patch(request: Caller, account: string, id: string, patch: PatchRequest) {
    const binding = await this.requireBinding(account, id);
    await this.thread(request, binding);
    if (patch.title !== undefined) await this.deps.persistent.update(request, id, { display_name: patch.title });
    if (patch.model !== undefined || patch.model_order !== undefined) {
      const model = patch.model ?? binding.selected_model;
      const current = (await this.deps.persistent.get(request, id)).session;
      const order = patch.model_order ?? [binding.selected_model, ...current.settings.fallback_models.flatMap(x => x.model_preset ? [x.model_preset] : [])];
      await this.deps.persistent.update(request, id, { settings: {
        default_model: { model_preset: model, reasoning_effort: null },
        fallback_models: [...new Set(order)].filter(x => x !== model).map(model_preset => ({ model_preset, reasoning_effort: null })),
      } });
      await this.repo.model(id, model);
    }
    if (patch.instructions !== undefined) {
      if (patch.instructions.trim()) await this.setInstruction(request, binding, patch.instructions);
      else if (binding.instruction_id) {
        const result = await this.deps.persistent.updateInstruction(request, id, binding.instruction_id, { status: "removed" });
        if (result.status !== 200) throw new ConversationError(503, "unavailable", "Could not remove instructions");
        await this.repo.clearInstruction(id);
      }
    }
    if (patch.archived === true && !binding.archived) {
      await this.deps.persistent.update(request, id, { enabled: false });
      await this.repo.archive(id);
    }
    return { thread: await this.thread(request, await this.requireBinding(account, id)) };
  }
  private async thread(request: Caller, binding: Binding): Promise<Thread> {
    const row = await (await this.deps.reads()).getSession(binding.session_id);
    if (!row) {
      if (binding.phase !== "complete") {
        if (binding.creation_request) await this.deps.access.requireFolderAccess({ request, folderId: binding.creation_request.collection });
        throw pendingError(binding.session_id);
      }
      throw notFound();
    }
    await this.deps.access.requireSessionAccess({ request, sessionId: binding.session_id });
    const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(String(row.created_at)).toISOString();
    return { id: binding.session_id, external: { namespace: binding.namespace, key: binding.external_key },
      title: typeof row.display_name === "string" ? row.display_name : "",
      model: { id: binding.selected_model, label: this.model(binding.selected_model)?.label ?? binding.selected_model },
      created_at: createdAt, archived: binding.archived };
  }
  private async requireRow(id: string) { const row = await (await this.deps.reads()).getSession(id); if (!row) throw notFound(); return row; }
  private async requireBinding(account: string, id: string) { const b = await this.repo.byId(account, id); if (!b) throw notFound(); return b; }
}
function notFound() { return new ConversationError(404, "not_found", "Thread not found"); }
function pendingError(id: string) { return new ConversationError(504, "pending", "Thread creation is pending", id); }
function isStatus(error: unknown, status: number) { return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === status; }
