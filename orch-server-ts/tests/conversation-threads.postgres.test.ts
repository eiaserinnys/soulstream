import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { ConversationService } from "../src/conversation/conversation_service.js";
import { ConversationCatalog } from "../src/conversation/conversation_catalog.js";
import { registerConversationRoutes } from "../src/conversation/conversation_routes.js";
import { executeCreateSessionRoute } from "../src/session/session_command_routes.js";

const request = JSON.parse(readFileSync(new URL("./fixtures/conversation-v1/request.json", import.meta.url), "utf8"));
const logger = { warn() {} };
describe("conversation thread API", () => {
  let db: FullSchemaPostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let created = 0;
  let delay = 0;
  const rows = new Map<string, any>();
  const instructions = new Map<string, Array<{ id: string; text: string }>>();
  const settings = new Map<string, any>();
  let deny = false;
  let loseInstructionAck = false;
  let rejectModelOnce = false;
  let unavailableNodeOnce = false;
  const createCalls: Array<{ nodeId: string; profile: string; model_preset: string }> = [];
  beforeAll(async () => {
    db = await createFullSchemaPostgresHarness();
    const access = {
      requireFolderAccess: async () => { if (deny) throw Object.assign(new Error("denied"), { statusCode: 403 }); },
      requireSessionAccess: async () => { if (deny) throw Object.assign(new Error("denied"), { statusCode: 403 }); },
    };
    const presetSets = {
      eiaserinnys: [
        { id: "argon", label: "Argon", available: false, reason_label: "quota" },
        { id: "opus", label: "Opus", available: true },
        { id: "sol", label: "Sol", available: true },
      ],
      "node-b": [{ id: "remote", label: "Remote", available: true }, { id: "backup", label: "Backup", available: true }],
      "node-c": [{ id: "offline", label: "Offline", available: true }],
    };
    const catalog = new ConversationCatalog({
      defaultNodeId: "eiaserinnys",
      listNodes: () => [
        { nodeId: "node-c", connected: false },
        { nodeId: "node-b", connected: true },
        { nodeId: "eiaserinnys", connected: true },
      ],
      listKnownForNode: nodeId => (presetSets as Record<string, any[]>)[nodeId]?.map(preset => ({
        ...preset, reason: preset.id === "argon" ? "limit_rejected" : null,
        reason_label: preset.reason_label ?? null,
        resets_at: preset.id === "argon" ? "2026-10-30T22:06:34Z" : null,
        usage_warning: false, weekly_headroom: null,
      })),
      listAgentProfiles: async (nodeId): Promise<Record<string, { name?: unknown }> | undefined> => {
        if (nodeId === "eiaserinnys") return { seosoyoung: { name: "서소영" } };
        if (nodeId === "node-b") return { seosoyoung: { name: "서소영" }, roselin: { name: "로젤린" } };
        return undefined;
      },
    });
    const persistent = {
      get: async (_: unknown, id: string) => ({ session: settings.get(id) }),
      update: async (_: unknown, id: string, input: any) => {
        const old = settings.get(id); settings.set(id, { ...old, persistent: input.enabled ?? old.persistent,
          display_name: input.display_name ?? old.display_name,
          settings: { ...old.settings, ...input.settings } });
        rows.get(id).display_name = input.display_name ?? rows.get(id).display_name;
        return { session: settings.get(id) };
      },
      listInstructions: async (_: unknown, id: string) => ({ instructions: instructions.get(id) ?? [] }),
      addInstruction: async (_: unknown, id: string, input: any) => {
        const list = instructions.get(id) ?? []; const item = { id: `i-${list.length}`, text: input.text };
        instructions.set(id, [...list, item]);
        if (loseInstructionAck) { loseInstructionAck = false; throw new Error("lost ack"); }
        return { status: 201, body: { instruction: item } };
      },
      updateInstruction: async (_: unknown, id: string, instructionId: string, input: any) => {
        const item = instructions.get(id)!.find(x => x.id === instructionId)!; item.text = input.text;
        return { status: 200, body: { instruction: item } };
      },
    };
    const service = new ConversationService({ sql: db.sql as never, access: access as never, catalog,
      persistent: persistent as never, reads: async () => ({ getSession: async (id: string) => rows.get(id) ?? null }) as never,
      create: async (_request: unknown, body: any, id: string) => {
        createCalls.push({ nodeId: body.nodeId, profile: body.profile, model_preset: body.model_preset });
        if (unavailableNodeOnce) { unavailableNodeOnce = false; return { status: 404, body: { error: { code: "NODE_NOT_FOUND", message: "offline" } } }; }
        if (rejectModelOnce) { rejectModelOnce = false; return { status: 400, body: { error: { code: "MODEL_PRESET_UNAVAILABLE", message: "quota" } } }; }
        created++; if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        rows.set(id, { session_id: id, folder_id: body.folderId, display_name: null, node_id: body.nodeId,
          created_at: new Date("2026-10-30T00:00:00.000Z"), status: "completed", model_preset: body.model_preset });
        settings.set(id, { session_id: id, persistent: false, display_name: null,
          settings: { default_model: { model_preset: body.model_preset, reasoning_effort: null }, fallback_models: [] },
          runtime: { current_model: { model_preset: body.model_preset } } });
        return { status: 201, body: { agentSessionId: id } };
      },
      waitForCreatedSession: async (id: string) => rows.has(id), responseTimeoutMs: 250,
    });
    app = Fastify({ logger: false });
    registerConversationRoutes(app, { service, resolveAccount: async () => "account-a" });
    await app.ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await db?.cleanup(); });
  const ensure = (key: string, payload: unknown = request) => app.inject({ method: "PUT", url: `/api/conversations/v1/threads/by-key?namespace=n&key=${key}`, payload });
  it("serializes the fixture request and converges concurrent creation on one session with fallback and instructions", async () => {
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
    const before = created;
    const [a, b] = await Promise.all([ensure("concurrent"), ensure("concurrent")]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().thread.id).toBe(b.json().thread.id);
    expect(created - before).toBe(1);
    expect(a.json().thread.model).toEqual({ id: "opus", label: "Opus", group: { id: "eiaserinnys", label: "eiaserinnys" } });
    expect(a.json().notices).toHaveLength(1);
    const byKey = await app.inject({ method: "GET", url: "/api/conversations/v1/threads/by-key?namespace=n&key=concurrent" });
    expect(byKey.json().thread).toEqual(a.json().thread);
    const list = await app.inject({ method: "GET", url: "/api/conversations/v1/threads?namespace=n" });
    expect(list.json().refs).toContainEqual(expect.objectContaining({ id: a.json().thread.id }));
    expect(instructions.get(a.json().thread.id)).toHaveLength(1);
    expect(settings.get(a.json().thread.id).settings.fallback_models.map((x: any) => x.model_preset)).toEqual(["argon", "sol"]);
  });
  it("falls through on an availability error at dispatch", async () => {
    rejectModelOnce = true;
    const response = await ensure("late-model-limit");
    expect(response.statusCode).toBe(200);
    expect(response.json().thread.model.id).toBe("sol");
    expect(response.json().notices).toHaveLength(1);
  });
  it("lists node groups, profile-unavailable choices, limits, offline presets, and profile union", async () => {
    const models = await app.inject({ method: "GET", url: "/api/conversations/v1/models?profile=roselin" });
    expect(models.statusCode).toBe(200);
    expect(models.json().models.map((model: any) => model.id)).toEqual([
      "argon", "opus", "sol", "n1:node-b:remote", "n1:node-b:backup", "n1:node-c:offline",
    ]);
    expect(models.json().models[0]).toMatchObject({
      group: { id: "eiaserinnys", label: "eiaserinnys" }, available: false,
      reason_code: "profile_unavailable", reason: "이 노드에 프로필 없음",
    });
    const limited = await app.inject({ method: "GET", url: "/api/conversations/v1/models" });
    expect(limited.json().models[0]).toMatchObject({
      available: false, reason: "quota", reason_code: "limit_rejected", resets_at: "2026-10-30T22:06:34Z",
    });
    expect(limited.json().models[5]).toMatchObject({ available: false, reason_code: "offline", reason: "노드 연결 끊김" });
    const profiles = await app.inject({ method: "GET", url: "/api/conversations/v1/profiles" });
    expect(profiles.statusCode).toBe(200);
    expect(profiles.json().profiles).toEqual([
      { id: "seosoyoung", label: "서소영", available: true },
      { id: "roselin", label: "로젤린", available: true },
    ]);
  });
  it("creates a selected secondary-node model with its selected profile", async () => {
    const payload = { ...request, selected_model: "n1:node-b:remote", model_order: ["n1:node-b:remote"], profile: "roselin" };
    const response = await ensure("remote-model", payload);
    expect(response.statusCode).toBe(200);
    expect(response.json().thread.model).toEqual({
      id: "n1:node-b:remote", label: "Remote", group: { id: "node-b", label: "node-b" },
    });
    expect(createCalls.at(-1)).toEqual({ nodeId: "node-b", profile: "roselin", model_preset: "remote" });
  });
  it("keeps legacy default-node model ids through by-key, info, and same-node PATCH", async () => {
    const made = await ensure("legacy-model");
    const id = made.json().thread.id;
    const byKey = await app.inject({ method: "GET", url: "/api/conversations/v1/threads/by-key?namespace=n&key=legacy-model" });
    expect(byKey.json().thread.model).toMatchObject({ id: "opus", group: { id: "eiaserinnys" } });
    const info = await app.inject({ method: "GET", url: `/api/conversations/v1/threads/${id}` });
    expect(info.json().thread.model).toMatchObject({ id: "opus", group: { id: "eiaserinnys" } });
    expect(info.json().current_model).toMatchObject({ id: "opus", group: { id: "eiaserinnys" } });
    const patched = await app.inject({ method: "PATCH", url: `/api/conversations/v1/threads/${id}`,
      payload: { model: "sol", model_order: ["sol", "opus", "n1:node-b:remote"] } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().thread.model).toMatchObject({ id: "sol", group: { id: "eiaserinnys" } });
    expect(settings.get(id).settings.fallback_models.map((model: any) => model.model_preset)).toEqual(["opus"]);
  });
  it("falls from a limited preferred model to a usable model on another node", async () => {
    const payload = { ...request, selected_model: "argon", model_order: ["n1:node-b:remote"], profile: "seosoyoung" };
    const response = await ensure("cross-node-fallback", payload);
    expect(response.statusCode).toBe(200);
    expect(response.json().thread.model.id).toBe("n1:node-b:remote");
    expect(response.json().notices).toEqual([
      "Argon(eiaserinnys)은 quota이라 Remote(node-b)로 시작했습니다.",
    ]);
    expect(createCalls.at(-1)).toEqual({ nodeId: "node-b", profile: "seosoyoung", model_preset: "remote" });
  });
  it("rejects switching a thread to another node through PATCH", async () => {
    const made = await ensure("patch-cross-node");
    const id = made.json().thread.id;
    const response = await app.inject({ method: "PATCH", url: `/api/conversations/v1/threads/${id}`, payload: { model: "n1:node-b:remote" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe("다른 위치의 모델은 execution으로 바꾼다");
  });
  it("retries a NODE_NOT_FOUND candidate on a later ensure without changing its reservation", async () => {
    unavailableNodeOnce = true;
    const payload = { ...request, selected_model: "n1:node-b:remote", model_order: [], profile: "roselin" };
    const before = createCalls.length;
    const first = await ensure("offline", payload);
    expect(first.statusCode).toBe(422); expect(first.json().error.code).toBe("model_unavailable");
    expect(createCalls.slice(before).map(call => call.nodeId)).toEqual(["node-b"]);
    const second = await ensure("offline", payload);
    expect(second.statusCode).toBe(200); expect(second.json().thread.model.id).toBe("n1:node-b:remote");
    expect(createCalls.slice(before).map(call => call.nodeId)).toEqual(["node-b", "node-b"]);
  });
  it("reserves ids only through the internal create argument", async () => {
    const sent: any[] = [];
    const opts: any = { router: { createSession: (payload: any) => { sent.push(payload); return { node: { nodeId: "node" } }; } },
      bridge: { sendPendingCommand: async () => ({}) } };
    const fakeRequest: any = {};
    const id = "84b26b6c-81c5-46d9-a49e-651b17b6b43d";
    const first = await executeCreateSessionRoute(opts, fakeRequest, { prompt: "hello", agentSessionId: id }, logger as any);
    const second = await executeCreateSessionRoute(opts, fakeRequest, { prompt: "hello" }, logger as any, id);
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect(sent[0].agentSessionId).not.toBe(id); expect(sent[1].agentSessionId).toBe(id);
  });
  it("continues after the response times out and a retry observes the same thread", async () => {
    delay = 300;
    const payload = { ...request, selected_model: "n1:node-b:remote", model_order: ["opus"] };
    const before = created; const beforeCalls = createCalls.length; const first = await ensure("slow", payload);
    expect(first.statusCode).toBe(504); expect(first.json().error.code).toBe("pending");
    expect(createCalls.slice(beforeCalls).map(call => call.nodeId)).toEqual(["node-b"]);
    await new Promise(resolve => setTimeout(resolve, 330)); delay = 0;
    const second = await ensure("slow", payload);
    expect(second.statusCode).toBe(200); expect(created - before).toBe(1);
    expect(createCalls.slice(beforeCalls).map(call => call.nodeId)).toEqual(["node-b"]);
    expect(second.json().thread.id).toBe(first.json().thread_id);
  });
  it("reconciles an instruction saved before its acknowledgement was lost", async () => {
    loseInstructionAck = true;
    const first = await ensure("instruction-ack"); expect(first.statusCode).toBe(503);
    const second = await ensure("instruction-ack"); expect(second.statusCode).toBe(200);
    expect(instructions.get(second.json().thread.id)).toHaveLength(1);
  });
  it("adopts an existing session id and rejects a different binding", async () => {
    const id = "existing-1"; rows.set(id, { session_id: id, folder_id: "allowed", display_name: "Existing", node_id: "eiaserinnys", created_at: new Date(), status: "completed", model_preset: "opus" });
    settings.set(id, { session_id: id, persistent: true, display_name: "Existing", settings: { default_model: { model_preset: "opus" }, fallback_models: [] }, runtime: { current_model: { model_preset: "opus" } } });
    const a = await app.inject({ method: "PUT", url: "/api/conversations/v1/threads/by-key/adoption?namespace=n&key=adopt", payload: { session_id: id } });
    expect(a.statusCode).toBe(200); expect(a.json().thread.id).toBe(id);
    const b = await app.inject({ method: "PUT", url: "/api/conversations/v1/threads/by-key/adoption?namespace=n&key=adopt", payload: { session_id: "other" } });
    expect(b.statusCode).toBe(409);
  });
  it("stores the initial-input adoption flag and rejects a conflicting retry", async () => {
    const id = "existing-with-initial";
    rows.set(id, { session_id: id, folder_id: "allowed", display_name: "Existing", node_id: "eiaserinnys", created_at: new Date(), status: "completed", model_preset: "opus" });
    const url = "/api/conversations/v1/threads/by-key/adoption?namespace=n&key=initial";
    const adopt = (flag: boolean) => app.inject({ method: "PUT", url, payload: { session_id: id, first_input_is_initial_instruction: flag } });
    expect((await adopt(true)).statusCode).toBe(200);
    expect((await adopt(true)).statusCode).toBe(200);
    expect((await adopt(false)).statusCode).toBe(409);
    const [binding] = await db.sql`SELECT first_input_is_initial_instruction FROM conversation_bindings WHERE session_id=${id}`;
    expect(binding?.first_input_is_initial_instruction).toBe(true);
  });
  it("enforces session folder access and updates existing thread", async () => {
    const made = await ensure("patch"); const id = made.json().thread.id;
    deny = true; const hidden = await app.inject({ method: "GET", url: `/api/conversations/v1/threads/${id}` }); deny = false;
    expect(hidden.statusCode).toBe(403);
    const patched = await app.inject({ method: "PATCH", url: `/api/conversations/v1/threads/${id}`, payload: { title: "Changed", archived: true } });
    expect(patched.statusCode).toBe(200); expect(patched.json().thread).toMatchObject({ title: "Changed", archived: true });
  });
});
