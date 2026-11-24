import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationCatalog } from "../src/conversation/conversation_catalog.js";
import { registerConversationRoutes } from "../src/conversation/conversation_routes.js";
import { ConversationService } from "../src/conversation/conversation_service.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const basePayload = {
  title: "스레드",
  selected_model: "preset-a",
  model_order: ["preset-a"],
  profile: "profile-a",
  initial_instruction: "",
  instructions: "",
};

type MemoryState = {
  bindings: Array<Record<string, any>>;
  executions: Array<Record<string, any>>;
  rows: Map<string, Record<string, any>>;
  settings: Map<string, Record<string, any>>;
};

/** Minimal in-memory stand-in for the conversation tables the service touches. */
function memorySql(state: MemoryState) {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("INSERT INTO conversation_bindings")) {
      const [account_id, namespace, external_key, session_id, active_session_id, selected_model,
        creation_request, phase, notices, first_input_is_initial_instruction] = values as any[];
      if (state.bindings.some(binding => binding.account_id === account_id
        && binding.namespace === namespace && binding.external_key === external_key)) return [];
      state.bindings.push({ account_id, namespace, external_key, session_id, active_session_id, selected_model,
        creation_request, phase, notices, first_input_is_initial_instruction,
        archived: false, instruction_id: null });
      state.executions.push({ thread_id: session_id, session_id, predecessor_session_id: null, ordinal: 0,
        first_input_is_initial_instruction: first_input_is_initial_instruction || Boolean(creation_request?.initial_instruction),
        notice: null, request: null, selected_model: null, phase: "complete", instruction_id: null,
        notices: [], release_pending: false });
      return [{ session_id }];
    }
    if (text.includes("SELECT * FROM conversation_bindings")) {
      if (text.includes("external_key=")) {
        const [account, namespace, key] = values as string[];
        return state.bindings.filter(binding => binding.account_id === account
          && binding.namespace === namespace && binding.external_key === key);
      }
      if (text.includes("session_id=")) {
        const [account, session_id] = values as string[];
        return state.bindings.filter(binding => binding.account_id === account && binding.session_id === session_id);
      }
      const [account, namespace] = values as string[];
      return state.bindings.filter(binding => binding.account_id === account && binding.namespace === namespace);
    }
    if (text.includes("UPDATE conversation_bindings SET phase=")) {
      const [phase, session_id] = values as string[];
      const binding = state.bindings.find(item => item.session_id === session_id);
      if (binding) binding.phase = phase;
      return [];
    }
    if (text.includes("SET creation_request=jsonb_set")) {
      const [modelOrder, sessionId] = values as any[];
      const binding = state.bindings.find(item => item.session_id === sessionId);
      if (binding) binding.creation_request = { ...binding.creation_request, model_order: modelOrder };
      return [];
    }
    if (text.includes("UPDATE conversation_bindings SET active_session_id=")) {
      const [active_session_id, selected_model, creation_request, instruction_id, session_id] = values as any[];
      const binding = state.bindings.find(item => item.session_id === session_id);
      if (binding) Object.assign(binding, { active_session_id, selected_model, creation_request, instruction_id });
      return [];
    }
    if (text.includes("UPDATE conversation_bindings SET selected_model=")) {
      const [selected_model, ...rest] = values as any[];
      const session_id = rest.at(-1);
      const binding = state.bindings.find(item => item.session_id === session_id);
      if (binding) {
        binding.selected_model = selected_model;
        if (rest.length === 2) binding.notices = rest[0];
      }
      return [];
    }
    if (text.includes("UPDATE conversation_bindings SET instruction_id=")) {
      const [instruction_id, session_id] = values as any[];
      const binding = state.bindings.find(item => item.session_id === session_id);
      if (binding) binding.instruction_id = instruction_id;
      return [];
    }
    if (text.includes("INSERT INTO conversation_executions")) {
      const [thread_id, session_id, predecessor_session_id, ordinal, request, selected_model,
        first_input_is_initial_instruction, notices] = values as any[];
      const execution = { thread_id, session_id, predecessor_session_id, ordinal, request, selected_model,
        first_input_is_initial_instruction, notices, notice: null, phase: "reserved", instruction_id: null,
        release_pending: false };
      state.executions.push(execution);
      return [execution];
    }
    if (text.includes("SELECT * FROM conversation_executions")) {
      const [thread_id] = values as string[];
      return state.executions.filter(execution => execution.thread_id === thread_id)
        .sort((a, b) => a.ordinal - b.ordinal);
    }
    if (text.includes("UPDATE conversation_executions SET phase='complete'")) {
      const [notice, session_id] = values as string[];
      const execution = state.executions.find(item => item.session_id === session_id);
      if (execution) Object.assign(execution, { phase: "complete", notice });
      return [];
    }
    if (text.includes("UPDATE conversation_executions SET phase=")) {
      const [phase, session_id] = values as string[];
      const execution = state.executions.find(item => item.session_id === session_id);
      if (execution) execution.phase = phase;
      return [];
    }
    if (text.includes("UPDATE conversation_executions SET selected_model=")) {
      const [selected_model, notices, session_id] = values as any[];
      const execution = state.executions.find(item => item.session_id === session_id);
      if (execution) Object.assign(execution, { selected_model, notices });
      return [];
    }
    if (text.includes("UPDATE conversation_executions SET instruction_id=")) {
      const [instruction_id, session_id] = values as any[];
      const execution = state.executions.find(item => item.session_id === session_id);
      if (execution) execution.instruction_id = instruction_id;
      return [];
    }
    if (text.includes("UPDATE conversation_executions SET release_pending=")) {
      const [release_pending, session_id] = values as any[];
      const execution = state.executions.find(item => item.session_id === session_id);
      if (execution) execution.release_pending = release_pending;
      return [];
    }
    return [];
  }) as any;
  sql.json = (value: unknown) => value;
  sql.begin = async (work: (tx: unknown) => Promise<unknown>) => await work(sql);
  return sql;
}

function seedThread(state: MemoryState, folderId: string | null) {
  const id = "thread-1";
  state.rows.set(id, {
    session_id: id, folder_id: folderId, display_name: "스레드", node_id: "node-a",
    agent_id: null, created_at: new Date("2026-11-19T00:00:00.000Z"), status: "completed", model_preset: "preset-a",
  });
  state.bindings.push({
    account_id: "account-a", namespace: "ns", external_key: "key", session_id: id, active_session_id: id,
    selected_model: "preset-a", creation_request: null, phase: "complete", notices: [],
    archived: false, first_input_is_initial_instruction: false, instruction_id: null,
  });
  state.executions.push({
    thread_id: id, session_id: id, predecessor_session_id: null, ordinal: 0,
    first_input_is_initial_instruction: false, notice: null, request: null, selected_model: null,
    phase: "complete", instruction_id: null, notices: [], release_pending: false,
  });
  state.settings.set(id, {
    session_id: id, persistent: false, display_name: null,
    settings: { default_model: { model_preset: "preset-a", reasoning_effort: null }, fallback_models: [] },
  });
}

function setup(options: { seedFolderId?: string | null; denyFolders?: string[]; defaultModels?: string[]; firstUnavailable?: boolean } = {}) {
  const state: MemoryState = { bindings: [], executions: [], rows: new Map(), settings: new Map() };
  if ("seedFolderId" in options) seedThread(state, options.seedFolderId!);
  const catalog = new ConversationCatalog({
    defaultNodeId: "node-a",
    modelCatalog: { snapshot: () => ({ persistent_defaults: {
      model_preset: options.defaultModels?.[0] ?? "missing",
      fallback_models: (options.defaultModels ?? []).slice(1).map(model_preset => ({ model_preset })),
    } }) } as never,
    listNodes: () => [{ nodeId: "node-a", connected: true }],
    listKnownForNode: () => [{
      id: "preset-a", label: "Preset A", backend: "claude", available: !options.firstUnavailable,
      reason: options.firstUnavailable ? "limit_rejected" : null, reason_label: options.firstUnavailable ? "한도" : null, resets_at: null,
      usage_warning: false, weekly_headroom: null,
    }, { id: "preset-b", label: "Preset B", backend: "claude", available: true,
      reason: null, reason_label: null, resets_at: null, usage_warning: false, weekly_headroom: null }],
    listAgentProfiles: async () => ({ "profile-a": { name: "Profile A" }, "profile-b": { name: "Profile B" } }),
  });
  const denied = new Set(["missing-folder", ...(options.denyFolders ?? [])]);
  const requireFolderAccess = vi.fn(async (input: { folderId: string | null }) => {
    if (input.folderId !== null && denied.has(input.folderId)) {
      throw new SessionResourceAccessError("SESSION_ACCESS_DENIED", "Folder access denied", 403);
    }
  });
  const moveSessionToFolder = vi.fn(async (sessionId: string, folderId: string | null) => {
    const row = state.rows.get(sessionId);
    if (row) row.folder_id = folderId;
  });
  const createBodies: Array<Record<string, any>> = [];
  const persistent = {
    get: async (_request: unknown, id: string) => ({ session: state.settings.get(id) ?? {
      session_id: id, persistent: false, display_name: null,
      settings: { default_model: { model_preset: null, reasoning_effort: null }, fallback_models: [] },
    } }),
    update: async (_request: unknown, id: string, input: Record<string, any>) => {
      const old = (await persistent.get(_request, id)).session;
      const next = { ...old, persistent: input.enabled ?? old.persistent,
        display_name: input.display_name ?? old.display_name,
        settings: { ...old.settings, ...input.settings } };
      state.settings.set(id, next);
      return { session: next };
    },
    listInstructions: async () => ({ instructions: [] }),
    addInstruction: async () => ({ status: 201, body: { instruction: { id: "instruction-1", text: "" } } }),
    updateInstruction: async () => ({ status: 200, body: {} }),
  };
  const service = new ConversationService({
    sql: memorySql(state),
    access: {
      requireFolderAccess,
      requireSessionAccess: async () => undefined,
    } as never,
    catalog,
    persistent: persistent as never,
    reads: async () => ({ getSession: async (id: string) => state.rows.get(id) ?? null }) as never,
    create: (async (_request: unknown, body: Record<string, any>, id: string) => {
      createBodies.push(body);
      state.rows.set(id, {
        session_id: id, folder_id: body.folderId ?? null, display_name: null, node_id: body.nodeId,
        agent_id: body.profile, created_at: new Date("2026-11-19T00:00:00.000Z"),
        status: "completed", model_preset: body.model_preset,
      });
      return { status: 201, body: { agentSessionId: id } };
    }) as never,
    waitForCreatedSession: async () => true,
    moveSessionToFolder,
    responseTimeoutMs: 1000,
  });
  const app = Fastify({ logger: false });
  apps.push(app);
  registerConversationRoutes(app, { service, resolveAccount: async () => "account-a" });
  return { app, state, createBodies, requireFolderAccess, moveSessionToFolder };
}

const ensure = (app: ReturnType<typeof Fastify>, key: string, payload: Record<string, unknown> = basePayload) =>
  app.inject({ method: "PUT", url: `/api/conversations/v1/threads/by-key?namespace=ns&key=${key}`, payload });

describe("conversation thread collection", () => {
  it("expands default in creation, execution and patch before saving models", async () => {
    const { app, state, createBodies } = setup({ defaultModels: ["preset-a", "preset-b"], firstUnavailable: true });
    const payload = { ...basePayload, selected_model: "default", model_order: ["default", "preset-b", "n1:unregistered:preset-c"] };
    const made = await ensure(app, "model-default", payload);
    expect(made.statusCode, made.body).toBe(200);
    const thread = made.json().thread;
    expect(createBodies.at(-1)?.model_preset).toBe("preset-b");
    expect(made.json().notices).toEqual([]);
    expect(state.bindings[0]?.creation_request).toMatchObject({ selected_model: "preset-b", model_order: ["preset-a", "preset-b", "n1:unregistered:preset-c"] });
    expect(state.settings.get(thread.id)?.settings).toMatchObject({
      default_model: { model_preset: "preset-b" }, fallback_models: [{ model_preset: "preset-a" }],
    });

    const switched = await app.inject({ method: "PUT", url: `/api/conversations/v1/threads/${thread.id}/execution`,
      payload: { ...payload, expected_execution_id: thread.execution_id } });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(state.executions.at(-1)?.request).toMatchObject({ selected_model: "preset-b", model_order: ["preset-a", "preset-b", "n1:unregistered:preset-c"] });
    expect(state.executions.at(-1)?.notices).toEqual([]);
    const active = switched.json().thread.execution_id;
    const patched = await app.inject({ method: "PATCH", url: `/api/conversations/v1/threads/${thread.id}`,
      payload: { model: "default", model_order: ["default", "preset-b"] } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(state.bindings[0]?.creation_request.model_order).toEqual(["preset-a", "preset-b"]);
    expect(state.bindings[0]?.selected_model).toBe("preset-b");
    expect(state.settings.get(active)?.settings.fallback_models).toEqual([{ model_preset: "preset-a", reasoning_effort: null }]);
  });

  it("preserves unknown model ids in creation and execution orders without default", async () => {
    const { app, state } = setup();
    const order = ["preset-a", "n1:unregistered:preset-c", "preset-b"];
    const payload = { ...basePayload, model_order: order };
    const made = await ensure(app, "unknown-model", payload);
    expect(made.statusCode, made.body).toBe(200);
    expect(state.bindings[0]?.creation_request.model_order).toEqual(order);
    const thread = made.json().thread;
    const switched = await app.inject({ method: "PUT", url: `/api/conversations/v1/threads/${thread.id}/execution`,
      payload: { ...payload, expected_execution_id: thread.execution_id } });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(state.executions.at(-1)?.request.model_order).toEqual(order);
  });

  it("expands default after an explicit selection and when patching the selected model", async () => {
    const { app, state } = setup({ defaultModels: ["preset-b", "preset-a"] });
    const made = await ensure(app, "model-order", { ...basePayload, model_order: ["default", "preset-a"] });
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().thread.id;
    expect(state.bindings[0]?.creation_request.model_order).toEqual(["preset-b", "preset-a"]);
    expect(state.settings.get(id)?.settings.fallback_models).toEqual([{ model_preset: "preset-b", reasoning_effort: null }]);

    const patched = await app.inject({ method: "PATCH", url: `/api/conversations/v1/threads/${id}`, payload: { model: "default" } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(state.bindings[0]).toMatchObject({ selected_model: "preset-b", creation_request: { model_order: ["preset-b", "preset-a"] } });
    expect(state.settings.get(id)?.settings).toMatchObject({ default_model: { model_preset: "preset-b" }, fallback_models: [{ model_preset: "preset-a" }] });
  });

  it("uses the default candidate order even when no model order is supplied", async () => {
    const { app, state } = setup({ defaultModels: ["preset-a", "preset-b"] });
    const made = await ensure(app, "default-alone", { ...basePayload, selected_model: "default", model_order: [] });
    expect(made.statusCode, made.body).toBe(200);
    expect(state.bindings[0]?.creation_request).toMatchObject({ selected_model: "preset-a", model_order: ["preset-a", "preset-b"] });
    expect(state.settings.get(made.json().thread.id)?.settings.fallback_models).toEqual([{ model_preset: "preset-b", reasoning_effort: null }]);
  });
  it("moves the thread session to the collection and carries it in the patch response", async () => {
    const { app, state, moveSessionToFolder, requireFolderAccess } = setup({ seedFolderId: null });
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/conversations/v1/threads/thread-1",
      payload: { collection: "folder-b" },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().thread.collection).toBe("folder-b");
    expect(moveSessionToFolder).toHaveBeenCalledTimes(1);
    expect(moveSessionToFolder).toHaveBeenCalledWith("thread-1", "folder-b");
    expect(requireFolderAccess).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: "folder-b" }),
    );
    expect(state.rows.get("thread-1")?.folder_id).toBe("folder-b");

    const single = await app.inject({ method: "GET", url: "/api/conversations/v1/threads/thread-1" });
    expect(single.statusCode).toBe(200);
    expect(single.json().thread.collection).toBe("folder-b");
  });

  it("carries the current collection in the list and single thread responses", async () => {
    const { app } = setup({ seedFolderId: "folder-a" });
    const single = await app.inject({ method: "GET", url: "/api/conversations/v1/threads/thread-1" });
    expect(single.json().thread.collection).toBe("folder-a");

    const list = await app.inject({ method: "GET", url: "/api/conversations/v1/threads?namespace=ns" });
    expect(list.statusCode).toBe(200);
    expect(list.json().refs).toContainEqual(
      expect.objectContaining({ id: "thread-1", collection: "folder-a" }),
    );
  });

  it("rejects a collection the session folder route would reject", async () => {
    const { app, moveSessionToFolder, state } = setup({ seedFolderId: "folder-a" });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/conversations/v1/threads/thread-1",
      payload: { collection: "missing-folder" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "SESSION_ACCESS_DENIED", message: "Folder access denied" },
    });
    expect(moveSessionToFolder).not.toHaveBeenCalled();
    expect(state.rows.get("thread-1")?.folder_id).toBe("folder-a");
  });

  it("creates a thread in the default folder when collection is omitted or null", async () => {
    const payloads: Array<Record<string, unknown>> = [{ ...basePayload }, { ...basePayload, collection: null }];
    for (const payload of payloads) {
      const { app, createBodies, requireFolderAccess } = setup();
      const response = await ensure(app, `default-${String(payload.collection ?? "omitted")}`, payload);

      expect(response.statusCode).toBe(200);
      expect(response.json().thread.collection).toBe("claude");
      expect(createBodies.at(-1)?.folderId).toBe("claude");
      expect(requireFolderAccess).toHaveBeenCalledWith(
        expect.objectContaining({ folderId: "claude" }),
      );
    }
  });

  it("rejects an empty or non-string collection with 400", async () => {
    const { app, createBodies } = setup();
    const empty = await ensure(app, "empty", { ...basePayload, collection: "" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("invalid_request");

    const numeric = await ensure(app, "numeric", { ...basePayload, collection: 7 });
    expect(numeric.statusCode).toBe(400);
    expect(numeric.json().error.code).toBe("invalid_request");

    const object = await ensure(app, "object", { ...basePayload, collection: { id: "folder-a" } });
    expect(object.statusCode).toBe(400);
    expect(object.json().error.code).toBe("invalid_request");
    expect(createBodies).toHaveLength(0);
  });

  it("keeps an existing thread's folder when ensure omits the collection", async () => {
    const { app, state, moveSessionToFolder } = setup();
    const made = await ensure(app, "existing", { ...basePayload, collection: "folder-a" });
    expect(made.statusCode).toBe(200);
    const id = made.json().thread.id;

    const again = await ensure(app, "existing", { ...basePayload });
    expect(again.statusCode).toBe(200);
    expect(again.json().thread.collection).toBe("folder-a");
    expect(state.rows.get(id)?.folder_id).toBe("folder-a");
    expect(moveSessionToFolder).not.toHaveBeenCalled();
  });

  it("keeps the current thread folder when an execution switch omits the collection", async () => {
    const { app, createBodies } = setup();
    const made = await ensure(app, "switch", { ...basePayload, collection: "folder-a" });
    const thread = made.json().thread;

    const switched = await app.inject({
      method: "PUT",
      url: `/api/conversations/v1/threads/${thread.id}/execution`,
      payload: { ...basePayload, expected_execution_id: thread.execution_id },
    });

    expect(switched.statusCode).toBe(200);
    expect(switched.json().thread.collection).toBe("folder-a");
    expect(createBodies.at(-1)?.folderId).toBe("folder-a");
  });

  it("falls back to the default folder when the switched thread has none", async () => {
    const { app, state, createBodies } = setup();
    const made = await ensure(app, "switch-no-folder", { ...basePayload, collection: "folder-a" });
    const thread = made.json().thread;
    state.rows.get(thread.execution_id)!.folder_id = null;

    const switched = await app.inject({
      method: "PUT",
      url: `/api/conversations/v1/threads/${thread.id}/execution`,
      payload: { ...basePayload, expected_execution_id: thread.execution_id },
    });

    expect(switched.statusCode).toBe(200);
    expect(switched.json().thread.collection).toBe("claude");
    expect(createBodies.at(-1)?.folderId).toBe("claude");
  });

  it("rejects a blocked default folder with the same error as an explicit folder", async () => {
    // Both folders are real to the caller's access rule and denied by it; the
    // default folder must fail exactly like a named folder denied the same way.
    const { app } = setup({ denyFolders: ["claude", "folder-blocked"] });
    const defaultDenied = await ensure(app, "denied-default", { ...basePayload });
    const explicitDenied = await ensure(app, "denied-explicit", { ...basePayload, collection: "folder-blocked" });

    expect(defaultDenied.statusCode).toBe(403);
    expect(explicitDenied.statusCode).toBe(403);
    expect(defaultDenied.json()).toEqual(explicitDenied.json());
  });
});
