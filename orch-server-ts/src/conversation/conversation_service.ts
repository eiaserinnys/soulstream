import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { SqlClient } from "../control_plane/control_plane_types.js";
import type { HostSessionRow } from "../control_plane/repositories/session_read_repository.js";
import type { PersistentSessionSettingsService } from "../session/persistent_session_settings_service.js";
import { PERSISTENT_CREATE_NODE_ID } from "../session/persistent_session_settings_service.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import type { SessionCreateRouteResponse } from "../session/session_create_route_response.js";
import { ConversationRepository } from "./conversation_repository.js";
import { ConversationCatalog, type ConversationModel } from "./conversation_catalog.js";
import { ConversationError, type Binding, type EnsureRequest, type PatchRequest, type Thread } from "./conversation_types.js";

type Caller = FastifyRequest;
type Deps = {
  sql: SqlClient;
  access: Pick<SessionResourceAccessProvider, "requireFolderAccess" | "requireSessionAccess">;
  reads: () => Promise<{ getSession(id: string): Promise<HostSessionRow | null> }>;
  persistent: Pick<PersistentSessionSettingsService, "get" | "update" | "listInstructions" | "addInstruction" | "updateInstruction">;
  catalog: ConversationCatalog;
  create: (request: Caller, body: Record<string, unknown>, id: string, logger: Pick<Caller["log"], "warn">) => Promise<SessionCreateRouteResponse>;
  waitForCreatedSession: (id: string, nodeId: string) => Promise<boolean>;
  responseTimeoutMs?: number;
};

export class ConversationService {
  private readonly repo: ConversationRepository;
  private readonly inFlight = new Map<string, Promise<void>>();
  constructor(private readonly deps: Deps) { this.repo = new ConversationRepository(deps.sql); }

  models(profile?: string) { return this.deps.catalog.models(profile); }
  profiles() { return this.deps.catalog.profiles(); }
  private model(id: string) { return this.deps.catalog.model(id); }
  private async candidates(body: EnsureRequest) {
    const profiles = await this.deps.catalog.profiles();
    if (!profiles.profiles.some(profile => profile.id === body.profile)) {
      throw new ConversationError(422, "invalid_request", "Profile is not available on any connected node");
    }
    const models = (await this.deps.catalog.models(body.profile)).models;
    return [...new Set([body.selected_model, ...body.model_order])]
      .map(id => models.find(model => model.id === id))
      .filter((model): model is NonNullable<typeof model> => model !== undefined);
  }
  private notice(preferred: { id: string; label: string; group?: { label: string }; reason?: string },
    selected: { label: string; group?: { label: string } }, reason: string) {
    const preferredNode = preferred.group?.label ?? PERSISTENT_CREATE_NODE_ID;
    const selectedNode = selected.group?.label ?? PERSISTENT_CREATE_NODE_ID;
    return `${preferred.label}(${preferredNode})은 ${reason}이라 ${selected.label}(${selectedNode})로 시작했습니다.`;
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
    const currentId = typeof row.model_preset === "string" && typeof row.node_id === "string"
      ? this.deps.catalog.idFor(row.node_id, row.model_preset) : null;
    const current = currentId ? await this.model(currentId) : undefined;
    return { thread, busy, tool, current_model: currentId ? { id: currentId, label: current?.label ?? currentId,
      ...(current?.group ? { group: current.group } : {}) } : null };
  }
  async ensure(request: Caller, account: string, namespace: string, key: string, body: EnsureRequest) {
    let binding = await this.repo.byKey(account, namespace, key);
    let created = false;
    if (!binding) {
      await this.deps.access.requireFolderAccess({ request, folderId: body.collection });
      const candidates = await this.candidates(body);
      const selected = candidates.find(model => model.available);
      if (!selected) throw new ConversationError(422, "model_unavailable", "No requested model is available");
      const preferred: ConversationModel = candidates.find(model => model.id === body.selected_model)
        ?? { id: body.selected_model, label: body.selected_model, available: false, group: { id: PERSISTENT_CREATE_NODE_ID, label: PERSISTENT_CREATE_NODE_ID } };
      const notices = selected.id === body.selected_model ? []
        : [this.notice(preferred, selected, preferred.reason ?? "사용할 수 없습니다")];
      created = await this.repo.reserve(account, namespace, key, randomUUID(), selected.id, body, "reserved", notices);
      binding = await this.repo.byKey(account, namespace, key);
      if (!binding) throw new ConversationError(409, "conflict", "Session binding already exists");
    }
    if (binding.phase === "complete") return { thread: await this.thread(request, binding), created: false, notices: binding.notices.map(n => n.text) };
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
    return { thread: await this.thread(request, current), created, notices: current.notices.map(n => n.text) };
  }
  private async initialize(request: Caller, binding: Binding): Promise<void> {
    const id = binding.session_id;
    const body = binding.creation_request;
    if (!body) throw new ConversationError(503, "unavailable", "Creation data is missing");
    let row = await (await this.deps.reads()).getSession(id);
    let selectedNodeId = this.deps.catalog.resolve(binding.selected_model)?.nodeId ?? PERSISTENT_CREATE_NODE_ID;
    if (!row && binding.phase === "reserved") {
      await this.repo.phase(id, "dispatched");
      const candidates = await this.candidates(body);
      const firstPreferred: ConversationModel = candidates.find(model => model.id === body.selected_model)
        ?? { id: body.selected_model, label: body.selected_model, available: false, group: { id: PERSISTENT_CREATE_NODE_ID, label: PERSISTENT_CREATE_NODE_ID } };
      const attempted = new Set<string>();
      let candidate = candidates.find(model => model.id === binding.selected_model && model.available)
        ?? candidates.find(model => model.available);
      if (!candidate) { await this.repo.phase(id, "reserved"); throw new ConversationError(422, "model_unavailable", "No requested model is available"); }
      let failureReason = candidate.id === body.selected_model ? undefined : firstPreferred.reason ?? "사용할 수 없습니다";
      let result: SessionCreateRouteResponse;
      while (true) {
        const reference = this.deps.catalog.resolve(candidate.id);
        if (!reference) throw new ConversationError(422, "model_unavailable", "Model selection is invalid");
        selectedNodeId = reference.nodeId;
        if (candidate.id !== binding.selected_model) {
          binding.selected_model = candidate.id;
          const text = candidate.id === body.selected_model ? undefined : this.notice(firstPreferred, candidate, failureReason ?? firstPreferred.reason ?? "사용할 수 없습니다");
          binding.notices = text ? [{ id: "notice:0", text, at: binding.notices[0]?.at ?? new Date().toISOString() }] : [];
          await this.repo.selection(id, candidate.id, binding.notices);
        }
        attempted.add(candidate.id);
        result = await this.deps.create(request, {
          profile: body.profile, nodeId: reference.nodeId, folderId: body.collection,
          model_preset: reference.presetId, initial_instruction: body.initial_instruction,
        }, id, request.log);
        const error = result.body.error as { code?: string; message?: string } | undefined;
        if (result.status === 201) break;
        if (error?.code === "NODE_COMMAND_TIMEOUT") throw pendingError(id);
        if (error?.code !== "MODEL_PRESET_UNAVAILABLE" && error?.code !== "NODE_NOT_FOUND") break;
        failureReason = candidate.id === body.selected_model ? error.message ?? candidate.reason ?? "사용할 수 없습니다" : failureReason;
        candidate = candidates.find(item => item.available && !attempted.has(item.id));
        if (!candidate) {
          await this.repo.phase(id, "reserved");
          throw new ConversationError(422, "model_unavailable", "No requested model is available");
        }
      }
      if (result.status !== 201) {
        const error = result.body.error as { code?: string; message?: string } | undefined;
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
      await this.deps.waitForCreatedSession(id, selectedNodeId);
      row = await (await this.deps.reads()).getSession(id);
      if (!row) throw pendingError(id);
    }
    await this.deps.access.requireSessionAccess({ request, sessionId: id });
    let resource = (await this.deps.persistent.get(request, id)).session;
    if (!resource.persistent || resource.display_name !== body.title) {
      await this.deps.persistent.update(request, id, { enabled: true, display_name: body.title });
      resource = (await this.deps.persistent.get(request, id)).session;
    }
    const activeModel = this.deps.catalog.resolve(binding.selected_model);
    const activeNode = activeModel?.nodeId ?? row.node_id;
    const activePresetId = activeModel?.presetId ?? binding.selected_model;
    const fallbacks = [...new Set(body.model_order)].flatMap(model => {
      const reference = this.deps.catalog.resolve(model);
      return reference && reference.nodeId === activeNode && reference.presetId !== activePresetId
        ? [reference.presetId] : [];
    }).slice(0, 3);
    const defaultModel = resource.settings.default_model.model_preset;
    const existingFallbacks = resource.settings.fallback_models.map(x => x.model_preset);
    if (defaultModel !== activePresetId || JSON.stringify(existingFallbacks) !== JSON.stringify(fallbacks)) {
      await this.deps.persistent.update(request, id, { settings: {
        default_model: { model_preset: activePresetId, reasoning_effort: null },
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
  async adopt(request: Caller, account: string, namespace: string, key: string, id: string, firstInputIsInitial = false) {
    let existing = await this.repo.byKey(account, namespace, key);
    if (existing) {
      await this.thread(request, existing);
      if (existing.session_id !== id || existing.first_input_is_initial_instruction !== firstInputIsInitial) throw new ConversationError(409, "conflict", "External key is already bound to another thread");
      return { thread: await this.thread(request, existing), created: false, notices: existing.notices.map(n => n.text) };
    }
    await this.deps.access.requireSessionAccess({ request, sessionId: id });
    const row = await this.requireRow(id);
    const presetId = typeof row.model_preset === "string" ? row.model_preset : "";
    const nodeId = typeof row.node_id === "string" ? row.node_id : "";
    if (!presetId || !nodeId) throw new ConversationError(422, "invalid_request", "Session has no model");
    const model = this.deps.catalog.idFor(nodeId, presetId);
    const inserted = await this.repo.reserve(account, namespace, key, id, model, null, "complete", [], firstInputIsInitial);
    existing = await this.repo.byKey(account, namespace, key);
    if (!existing || existing.session_id !== id || existing.first_input_is_initial_instruction !== firstInputIsInitial) throw new ConversationError(409, "conflict", "Thread or external key is already bound");
    return { thread: await this.thread(request, existing), created: inserted, notices: existing.notices.map(n => n.text) };
  }
  async patch(request: Caller, account: string, id: string, patch: PatchRequest) {
    const binding = await this.requireBinding(account, id);
    await this.thread(request, binding);
    if (patch.title !== undefined) await this.deps.persistent.update(request, id, { display_name: patch.title });
    if (patch.model !== undefined || patch.model_order !== undefined) {
      const row = await this.requireRow(id);
      const currentNodeId = typeof row.node_id === "string" ? row.node_id : PERSISTENT_CREATE_NODE_ID;
      const selectedId = patch.model ?? binding.selected_model;
      const selected = this.deps.catalog.resolve(selectedId);
      if (!selected) throw new ConversationError(422, "model_unavailable", "Model selection is invalid");
      if (selected.nodeId !== currentNodeId) {
        throw new ConversationError(409, "conflict", "다른 위치의 모델은 execution으로 바꾼다");
      }
      const current = (await this.deps.persistent.get(request, id)).session;
      const storedOrder = (binding.creation_request as EnsureRequest | null)?.model_order;
      const order = patch.model_order ?? storedOrder ?? [
        binding.selected_model,
        ...current.settings.fallback_models.flatMap(x => x.model_preset ? [this.deps.catalog.idFor(currentNodeId, x.model_preset)] : []),
      ];
      const fallbacks = [...new Set(order)].flatMap(modelId => {
        const reference = this.deps.catalog.resolve(modelId);
        return reference && reference.nodeId === currentNodeId && reference.presetId !== selected.presetId
          ? [reference.presetId] : [];
      }).slice(0, 3);
      await this.deps.persistent.update(request, id, { settings: {
        default_model: { model_preset: selected.presetId, reasoning_effort: null },
        fallback_models: fallbacks.map(model_preset => ({ model_preset, reasoning_effort: null })),
      } });
      if (patch.model !== undefined) await this.repo.model(id, selectedId);
      if (patch.model_order !== undefined) await this.repo.order(id, order);
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
    const model = await this.model(binding.selected_model);
    return { id: binding.session_id, external: { namespace: binding.namespace, key: binding.external_key },
      title: typeof row.display_name === "string" ? row.display_name : "",
      model: { id: binding.selected_model, label: model?.label ?? binding.selected_model,
        ...(model?.group ? { group: model.group } : {}) },
      created_at: createdAt, archived: binding.archived };
  }
  private async requireRow(id: string) { const row = await (await this.deps.reads()).getSession(id); if (!row) throw notFound(); return row; }
  private async requireBinding(account: string, id: string) { const b = await this.repo.byId(account, id); if (!b) throw notFound(); return b; }
  async historyBinding(request: Caller, account: string, id: string): Promise<Binding> {
    const binding = await this.requireBinding(account, id);
    await this.thread(request, binding);
    return binding;
  }
  get historySql(): SqlClient { return this.deps.sql; }
}
function notFound() { return new ConversationError(404, "not_found", "Thread not found"); }
function pendingError(id: string) { return new ConversationError(504, "pending", "Thread creation is pending", id); }
function isStatus(error: unknown, status: number) { return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === status; }
