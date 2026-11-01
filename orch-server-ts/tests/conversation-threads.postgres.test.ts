import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { ConversationService } from "../src/conversation/conversation_service.js";
import { ConversationCatalog } from "../src/conversation/conversation_catalog.js";
import { registerConversationRoutes } from "../src/conversation/conversation_routes.js";
import { executeCreateSessionRoute } from "../src/session/session_command_routes.js";
import { ConversationMessageService } from "../src/conversation/conversation_messages.js";
import { createHash } from "node:crypto";

const request = JSON.parse(readFileSync(new URL("./fixtures/conversation-v1/request.json", import.meta.url), "utf8"));
const logger = { warn() {} };
describe("conversation thread API", () => {
  let db: FullSchemaPostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let service: ConversationService;
  let created = 0;
  let delay = 0;
  const rows = new Map<string, any>();
  const instructions = new Map<string, Array<{ id: string; text: string }>>();
  const settings = new Map<string, any>();
  let deny = false;
  let denySession: string | null = null;
  let loseInstructionAck = false;
  let rejectModelOnce = false;
  let unavailableNodeOnce = false;
  let offlineRelease = false;
  let failRelease = false;
  const createCalls: Array<{ nodeId: string; profile: string; model_preset: string; predecessor_session_id?: string }> = [];
  const delivered: string[] = [];
  beforeAll(async () => {
    db = await createFullSchemaPostgresHarness();
    const access = {
      requireFolderAccess: async () => { if (deny) throw Object.assign(new Error("denied"), { statusCode: 403 }); },
      requireSessionAccess: async ({sessionId}: {sessionId:string}) => { if (deny || denySession === sessionId) throw Object.assign(new Error("denied"), { statusCode: 403 }); },
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
        if (input.enabled === false && offlineRelease) throw Object.assign(new Error("Node unavailable"), { code: "NODE_UNAVAILABLE" });
        if (input.enabled === false && failRelease) throw new Error("Command failed");
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
    service = new ConversationService({ sql: db.sql as never, access: access as never, catalog,
      persistent: persistent as never, reads: async () => ({ getSession: async (id: string) => rows.get(id) ?? null }) as never,
      create: async (_request: unknown, body: any, id: string) => {
        createCalls.push({ nodeId: body.nodeId, profile: body.profile, model_preset: body.model_preset,
          ...(body.predecessor_session_id ? {predecessor_session_id:body.predecessor_session_id} : {}) });
        if (unavailableNodeOnce) { unavailableNodeOnce = false; return { status: 404, body: { error: { code: "NODE_NOT_FOUND", message: "offline" } } }; }
        if (rejectModelOnce) { rejectModelOnce = false; return { status: 400, body: { error: { code: "MODEL_PRESET_UNAVAILABLE", message: "quota" } } }; }
        created++; if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        await db.sql`INSERT INTO sessions(session_id,node_id,model_preset,agent_id,created_at) VALUES (${id},${body.nodeId},${body.model_preset},${body.profile},now())`;
        rows.set(id, { session_id: id, folder_id: body.folderId, display_name: null, node_id: body.nodeId,
          agent_id:body.profile, created_at: new Date("2026-10-30T00:00:00.000Z"), status: "completed", model_preset: body.model_preset });
        settings.set(id, { session_id: id, persistent: false, display_name: null,
          settings: { default_model: { model_preset: body.model_preset, reasoning_effort: null }, fallback_models: [] },
          runtime: { current_model: { model_preset: body.model_preset } } });
        return { status: 201, body: { agentSessionId: id } };
      },
      waitForCreatedSession: async (id: string) => rows.has(id), responseTimeoutMs: 250,
    });
    app = Fastify({ logger: false });
    const messages = new ConversationMessageService(db.sql as never, {
      caller:async () => ({source:"browser"}),
      upload:async () => { throw new Error("unexpected upload"); },
      intervene:async (_request,target) => { delivered.push(target); return {status:200,body:{}}; },
      read:async (_request,target) => new Response(target),
    });
    registerConversationRoutes(app, { service, messages, resolveAccount: async () => "account-a" });
    await app.ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await db?.cleanup(); });
  const ensure = (key: string, payload: unknown = request) => app.inject({ method: "PUT", url: `/api/conversations/v1/threads/by-key?namespace=n&key=${key}`, payload });
  it("switches an execution idempotently and finishes an offline release on a later request", async () => {
    const made = await ensure("switch-offline");
    const original = made.json().thread;
    const payload = { ...request, expected_execution_id: original.execution_id, profile: "roselin", selected_model: "n1:node-b:remote", model_order: ["n1:node-b:remote"] };
    const url = `/api/conversations/v1/threads/${original.id}/execution`;
    offlineRelease = true;
    const switched = await app.inject({ method: "PUT", url, payload });
    expect(switched.statusCode).toBe(200);
    const current = switched.json().thread;
    expect(current).toMatchObject({ id: original.id, profile: { id: "roselin", label: "로젤린" } });
    expect(current.execution_id).not.toBe(original.execution_id);
    expect(createCalls.at(-1)?.predecessor_session_id).toBe(original.execution_id);
    const [old] = await db.sql`SELECT release_pending FROM conversation_executions WHERE session_id=${original.execution_id}`;
    expect(old?.release_pending).toBe(true);
    const count = created;
    expect((await app.inject({ method: "PUT", url, payload })).json().thread.execution_id).toBe(current.execution_id);
    expect(created).toBe(count);
    expect((await app.inject({ method:"PUT", url, payload:{...payload,profile:"seosoyoung"} })).statusCode).toBe(409);
    offlineRelease = false;
    expect((await app.inject({ method: "GET", url: `/api/conversations/v1/threads/${original.id}` })).statusCode).toBe(200);
    const [released] = await db.sql`SELECT release_pending FROM conversation_executions WHERE session_id=${original.execution_id}`;
    expect(released?.release_pending).toBe(false);
    expect(settings.get(original.execution_id).persistent).toBe(false);
  });
  it("rejects a switch while an answer is in progress", async () => {
    const made = await ensure("switch-busy");
    const thread = made.json().thread;
    await db.sql`INSERT INTO events(session_id,id,event_type,payload) VALUES
      (${thread.execution_id},1,'intervention_sent',${db.sql.json({text:"working",caller_info:{source:"browser"}})})`;
    const before = created;
    const response = await app.inject({ method:"PUT", url:`/api/conversations/v1/threads/${thread.id}/execution`,
      payload:{...request, expected_execution_id:thread.execution_id, profile:"roselin", selected_model:"n1:node-b:remote"} });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe("답변이 끝난 뒤 바꿀 수 있습니다");
    expect(created).toBe(before);
  });
  it("allows a limit-stopped thread to switch and records model fallback notices", async () => {
    const thread = (await ensure("switch-limited")).json().thread;
    rows.get(thread.execution_id).status = "error";
    rows.get(thread.execution_id).termination_reason = "limit_hit";
    await db.sql`INSERT INTO events(session_id,id,event_type,payload) VALUES (${thread.execution_id},1,'intervention_sent',${db.sql.json({text:"stopped"})})`;
    const info = await app.inject({method:"GET",url:`/api/conversations/v1/threads/${thread.id}`});
    expect(info.json().busy).toBe(false);
    const result = await app.inject({method:"PUT",url:`/api/conversations/v1/threads/${thread.id}/execution`,
      payload:{...request,expected_execution_id:thread.execution_id,profile:"roselin",selected_model:"argon",model_order:["n1:node-b:remote"]}});
    expect(result.statusCode).toBe(200);
    expect(result.json().notices).toHaveLength(1);
    const executionId = result.json().thread.execution_id;
    const [fallback] = result.json().notices;
    const notifications = await db.sql`SELECT searchable_text FROM events
      WHERE session_id=${executionId} AND event_type='notification' ORDER BY id`;
    expect(notifications.map(event => event.searchable_text)).toEqual([
      fallback,
      "프로필을 로젤린(으)로 바꿔 새 세션으로 이었습니다.",
    ]);
    const history = await app.inject({method:"GET",url:`/api/conversations/v1/threads/${thread.id}/items`});
    expect(history.json().items.filter((item:{kind:string;id:string}) => item.kind === "notice" && item.id.startsWith("1:"))).toHaveLength(2);
  });
  it("stores an empty searchable text when event_append receives null", async () => {
    const thread = (await ensure("switch-null-searchable-text")).json().thread;
    const dedupeKey = `test-null-searchable-text:${thread.execution_id}`;
    await db.sql`SELECT event_append(${thread.execution_id}, 'notification', ${JSON.stringify({_conversation_notice:"empty text"})}, NULL, now(), ${dedupeKey})`;
    const [event] = await db.sql`SELECT searchable_text FROM events WHERE session_id=${thread.execution_id} AND dedupe_key=${dedupeKey}`;
    expect(event?.searchable_text).toBe("");
  });
  it("keeps the predecessor active on another release failure and completes the same reservation on retry", async () => {
    const original = (await ensure("switch-release-failure")).json().thread;
    const url = `/api/conversations/v1/threads/${original.id}/execution`;
    const payload = {...request,expected_execution_id:original.execution_id,profile:"roselin",selected_model:"n1:node-b:remote"};
    failRelease = true;
    const failed = await app.inject({method:"PUT",url,payload});
    expect(failed.statusCode).toBe(504);
    const [binding] = await db.sql`SELECT active_session_id FROM conversation_bindings WHERE session_id=${original.id}`;
    expect(binding?.active_session_id).toBe(original.execution_id);
    const count = created;
    failRelease = false;
    const retried = await app.inject({method:"PUT",url,payload});
    expect(retried.statusCode).toBe(200);
    expect(created).toBe(count);
    expect(retried.json().thread.execution_id).not.toBe(original.execution_id);
  });
  it("finishes a timed-out switch with the same reserved session", async () => {
    const thread = (await ensure("switch-slow")).json().thread;
    const url = `/api/conversations/v1/threads/${thread.id}/execution`;
    const payload = {...request,expected_execution_id:thread.execution_id,profile:"roselin",selected_model:"n1:node-b:remote"};
    delay = 300;
    const before = created;
    const timedOut = await app.inject({method:"PUT",url,payload});
    expect(timedOut.statusCode).toBe(504);
    await new Promise(resolve => setTimeout(resolve, 330));
    delay = 0;
    const retried = await app.inject({method:"PUT",url,payload});
    expect(retried.statusCode).toBe(200);
    expect(created - before).toBe(1);
  });
  it("releases a connected predecessor and cancels its scheduled resume", async () => {
    const original = (await ensure("switch-connected")).json().thread;
    await db.sql`INSERT INTO soulstream_schedules(schedule_id,session_id,kind,status,prompt,source_tool,recurring,next_run_at)
      VALUES ('switch-resume',${original.execution_id},'wakeup','active','resume','ResumeAfterLimit',false,now())`;
    const result = await app.inject({method:"PUT",url:`/api/conversations/v1/threads/${original.id}/execution`,
      payload:{...request,expected_execution_id:original.execution_id,profile:"roselin",selected_model:"n1:node-b:remote"}});
    expect(result.statusCode).toBe(200);
    expect(result.json().thread.id).toBe(original.id);
    expect(settings.get(original.execution_id).persistent).toBe(false);
    const [schedule] = await db.sql`SELECT status FROM soulstream_schedules WHERE schedule_id='switch-resume'`;
    expect(schedule?.status).toBe("cancelled");
    const history = await app.inject({method:"GET",url:`/api/conversations/v1/threads/${original.id}/items`});
    expect(history.json().items).toContainEqual(expect.objectContaining({id:"1:1",kind:"notice",text:"프로필을 로젤린(으)로 바꿔 새 세션으로 이었습니다."}));
  });
  it("keeps a pending receipt on its original execution and reads an old attachment after switching", async () => {
    const thread = (await ensure("switch-receipt")).json().thread;
    const body = {request_id:"old-request",text:"hello",attachments:[]};
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await db.sql`INSERT INTO conversation_message_receipts(session_id,request_id,request_hash,delivery_id,caller_info,status,target_session_id)
      VALUES (${thread.id},${body.request_id},${hash},'old-delivery','{}'::jsonb,'pending',${thread.execution_id})`;
    await db.sql`INSERT INTO events(session_id,id,event_type,payload) VALUES (${thread.execution_id},1,'intervention_sent',
      ${db.sql.json({text:"attachment",attachments:["/private/file.txt"],caller_info:{source:"browser"}})})`;
    await db.sql`INSERT INTO events(session_id,id,event_type,payload) VALUES (${thread.execution_id},2,'complete','{}'::jsonb)`;
    const switched = await app.inject({method:"PUT",url:`/api/conversations/v1/threads/${thread.id}/execution`,
      payload:{...request,expected_execution_id:thread.execution_id,profile:"roselin",selected_model:"n1:node-b:remote"}});
    expect(switched.statusCode).toBe(200);
    const active = switched.json().thread.execution_id;
    const url = `/api/conversations/v1/threads/${thread.id}/messages`;
    denySession = thread.execution_id;
    expect((await app.inject({method:"POST",url,payload:body})).statusCode).toBe(403);
    denySession = null;
    expect((await app.inject({method:"POST",url,payload:body})).json().status).toBe("accepted");
    expect(delivered.at(-1)).toBe(thread.execution_id);
    expect((await app.inject({method:"POST",url,payload:{request_id:"new-request",text:"new"}})).json().status).toBe("accepted");
    expect(delivered.at(-1)).toBe(active);
    const attachment = await app.inject({method:"GET",url:`/api/conversations/v1/threads/${thread.id}/items/1/attachments/path%3A0`});
    expect(attachment.statusCode).toBe(200);
    expect(attachment.body).toBe(thread.execution_id);
  });
  it("closes the live event stream when the execution changes", async () => {
    const thread = (await ensure("switch-stream")).json().thread;
    const streaming = Fastify();
    registerConversationRoutes(streaming, {service,resolveAccount:async () => "account-a",liveEvents:{subscribe:() => () => {}}});
    const address = await streaming.listen({port:0,host:"127.0.0.1"});
    const abort = new AbortController();
    try {
      const response = await fetch(`${address}/api/conversations/v1/threads/${thread.id}/events`,{signal:abort.signal});
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"snapshot"');
      const switched = await app.inject({method:"PUT",url:`/api/conversations/v1/threads/${thread.id}/execution`,
        payload:{...request,expected_execution_id:thread.execution_id,profile:"roselin",selected_model:"n1:node-b:remote"}});
      expect(switched.statusCode).toBe(200);
      expect((await reader.read()).done).toBe(true);
    } finally { abort.abort(); await streaming.close(); }
  });
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
