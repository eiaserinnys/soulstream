import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { ConversationService } from "../src/conversation/conversation_service.js";
import { ConversationCatalog } from "../src/conversation/conversation_catalog.js";
import { registerConversationRoutes } from "../src/conversation/conversation_routes.js";
import { createSessionResourceAccessProvider } from "../src/session/session_resource_access.js";
import { RuntimeSessionEventHub } from "../src/runtime/session_event_hub.js";
import { ConversationHistory } from "../src/conversation/conversation_history.js";

describe("conversation items and events", () => {
  let db: FullSchemaPostgresHarness;
  let app: ReturnType<typeof Fastify>;
  let service: ConversationService;
  let deny = false;
  const session = "s4-session";
  const base = `/api/conversations/v1/threads/${session}`;
  const insert = async (id: number, type: string, payload: Record<string, unknown>) => {
    await db.sql`INSERT INTO events(session_id,id,event_type,payload,created_at)
      VALUES (${session}, ${id}, ${type}, ${db.sql.json(payload as never)}, '2026-10-30T00:00:00Z')`;
  };
  const insertFor = async (sessionId: string, id: number, type: string, payload: Record<string, unknown>) => {
    await db.sql`INSERT INTO events(session_id,id,event_type,payload,created_at)
      VALUES (${sessionId}, ${id}, ${type}, ${db.sql.json(payload as never)}, '2026-10-30T00:00:00Z')`;
  };
  beforeAll(async () => {
    db = await createFullSchemaPostgresHarness();
    await db.sql`INSERT INTO folders(id,name) VALUES ('allowed-folder','Allowed'),('other-folder','Other')`;
    await db.sql`INSERT INTO sessions(session_id,folder_id,model_preset,created_at) VALUES (${session},'allowed-folder','sol','2026-10-30T00:00:00Z')`;
    await db.sql`INSERT INTO file_assets(id,storage_key,storage_purpose,original_name,mime_type,byte_size,upload_status)
      VALUES ('asset-1','test-key','attachment','image.png','image/png',10,'committed')`;
    await db.sql`INSERT INTO conversation_bindings(account_id,namespace,external_key,session_id,selected_model,phase,first_input_is_initial_instruction,notices)
      VALUES ('person','n','k',${session},'sol','complete',true,${db.sql.json([{ id: "notice:0", text: "fallback", at: "2026-10-30T00:00:00.000Z" }])})`;
    const events: Array<[number, string, Record<string, unknown>]> = [
      [1,"user_message",{ text:"initial", caller_info:{source:"browser"} }],
      [2,"assistant_message",{ content:"greeting" }],
      [3,"user_message",{ text:"cache", purpose:"cache_keepalive", input_id:"hidden" }],
      [4,"tool_start",{ tool_name:"invisible", input_id:"hidden" }],
      [5,"assistant_message",{ content:"hidden", input_id:"hidden" }],
      [6,"complete",{}],
      [7,"user_message",{ text:"hello\n[첨부 파일 로컬 경로: /tmp/file]", caller_info:{source:"external-client"}, attachment_ids:["asset-1"], attachments:["/tmp/2026-10-30T00-00-00.000Z-note-0123456789abcdef0123456789abcdef.txt"] }],
      [8,"assistant_message",{ content:"[SILENT]" }],
      [9,"intervention_sent",{ text:"from app", caller_info:{source:"soul-app"} }],
      [10,"user_message",{ text:"internal", caller_info:{source:"agent"} }],
      [11,"assistant_message",{ content:"네." }],
      [12,"user_message",{ text:"slack", caller_info:{source:"slack"} }],
      [13,"tool_start",{ tool_name:"Read" }],
      [14,"session_ended",{}],
      [15,"assistant_message",{ content:"answer" }],
      [16,"error",{ message:"error" }]
    ];
    for (const [id,type,payload] of events) await insert(id,type,payload);
    const access = createSessionResourceAccessProvider({
      accessProvider: { resolveAccess: () => ({ restricted:true, allowedFolderIds: deny ? ["other-folder"] : ["allowed-folder"] }) },
      repository: {
        getSessionAccessRecord: async (id) => {
          const [row] = await db.sql`SELECT session_id,folder_id FROM sessions WHERE session_id=${id}`;
          return row ? { sessionId:row.session_id, folderId:row.folder_id } : null;
        },
        listFoldersForAccess: async () => {
          const rows = await db.sql`SELECT id,parent_folder_id FROM folders`;
          return rows.map(row => ({ id:row.id, parentFolderId:row.parent_folder_id }));
        },
      },
    });
    service = new ConversationService({
      sql: db.sql as never,
      access,
      reads: async () => ({ getSession: async () => ({ session_id:session, created_at:new Date(), model_preset:"sol" }) }) as never,
      catalog: new ConversationCatalog({ defaultNodeId:"eiaserinnys", listNodes:() => [{nodeId:"eiaserinnys",connected:true}],
        listKnownForNode:() => [], listAgentProfiles:async () => ({}) }), persistent: {} as never, create: async () => ({} as never),
      waitForCreatedSession: async () => true,
    });
    app = Fastify();
    registerConversationRoutes(app, { service, resolveAccount: async request => request.headers.authorization ? "person" : null,
      closeAfterHistorySync: true });
    await app.ready();
  }, 60_000);
  afterAll(async () => { await app?.close(); await db?.cleanup(); });
  const get = (path: string, headers: Record<string, string> = { authorization: "Bearer test" }) =>
    app.inject({ method: "GET", url: base + path, headers });
  it("paginates and resumes across executions with overlapping event numbers", async () => {
    const first = "history-first", second = "history-second";
    await db.sql`INSERT INTO sessions(session_id,folder_id,model_preset,created_at) VALUES
      (${first},'allowed-folder','sol',now()), (${second},'allowed-folder','sol',now())`;
    await db.sql`INSERT INTO conversation_bindings(account_id,namespace,external_key,session_id,active_session_id,selected_model,phase)
      VALUES ('person','n','history',${first},${second},'sol','complete')`;
    await db.sql`INSERT INTO conversation_executions(thread_id,session_id,ordinal,predecessor_session_id) VALUES
      (${first},${first},0,NULL), (${first},${second},1,${first})`;
    await insertFor(first, 1, "user_message", { text:"old", caller_info:{source:"browser"} });
    await insertFor(second, 1, "user_message", { text:"new", caller_info:{source:"browser"} });
    const path = `/api/conversations/v1/threads/${first}`;
    const page = await app.inject({ method:"GET", url:`${path}/items?limit=1`, headers:{authorization:"Bearer test"} });
    expect(page.json()).toMatchObject({ items:[{ id:"1:1", text:"new" }], next_before:"1:1", cursor:"1:1" });
    const previous = await app.inject({ method:"GET", url:`${path}/items?limit=1&before=1%3A1`, headers:{authorization:"Bearer test"} });
    expect(previous.json().items).toMatchObject([{ id:"1", text:"old" }]);
    const stream = await app.inject({ method:"GET", url:`${path}/events`, headers:{authorization:"Bearer test", "last-event-id":"1"} });
    expect(stream.body).toContain('"id":"1:1"');
    expect(stream.body).not.toContain('"text":"old"');
  });
  it("projects events, orders by provider cursor, includes stable notices and paginates", async () => {
    const response = await get("/items?limit=3");
    expect(response.statusCode).toBe(200);
    const page = response.json();
    expect(page.items.map((x: any) => x.text)).toEqual(["slack", "answer", "error"]);
    expect(page.cursor).toBe("16");
    const older = await get(`/items?limit=20&before=${encodeURIComponent(page.next_before)}`);
    expect(older.json().items.map((x: any) => x.text)).toEqual(["fallback","greeting","hello","from app"]);
    expect(older.json().items[2].attachments).toEqual([
      { id:"asset-1", name:"image.png", mime:"image/png" },
      { id:"path:0", name:"note.txt", mime:"text/plain" },
    ]);
    expect((await get("/items?limit=201")).statusCode).toBe(400);
  });
  it("replays items after the page cursor once on SSE reconnect", async () => {
    await insert(17, "user_message", { text:"between", caller_info:{source:"browser"} });
    await insert(18, "assistant_message", { content:"after" });
    const response = await get("/events", { authorization:"Bearer test", "last-event-id":"16" });
    expect(response.statusCode).toBe(200);
    const frames = response.body.split("\n\n").filter(Boolean);
    const snapshot = frames.map((x: string) => x.split("\n").find(line => line.startsWith("data: ")))
      .filter(Boolean).map((x: string) => JSON.parse(x.slice(6))).find((x: any) => x.kind === "snapshot");
    expect(snapshot.snapshot.items.map((x: any) => x.text)).toEqual(["between","after"]);
    const reconnect = await get("/events", { authorization:"Bearer test", "last-event-id":snapshot.snapshot.cursor });
    expect(reconnect.body).not.toContain("between");
    expect(reconnect.body).not.toContain("after");
  });
  it("hides the initial instruction after an earlier intervention for created and adopted threads", async () => {
    const cases = [
      { id: "s4-race-created", key: "race-created", creation: { title: "created", initial_instruction: "initial instruction" }, adopted: false },
      { id: "s4-race-adopted", key: "race-adopted", creation: null, adopted: true },
    ];
    for (const thread of cases) {
      await db.sql`INSERT INTO sessions(session_id,folder_id,model_preset,created_at)
        VALUES (${thread.id},'allowed-folder','sol','2026-10-30T00:00:00Z')`;
      await db.sql`INSERT INTO conversation_bindings(account_id,namespace,external_key,session_id,selected_model,creation_request,phase,first_input_is_initial_instruction,notices)
        VALUES ('person','n',${thread.key},${thread.id},'sol',${thread.creation === null ? null : db.sql.json(thread.creation)},'complete',${thread.adopted},'[]'::jsonb)`;
      await insertFor(thread.id, 1, "intervention_sent", { text: "sent before startup", caller_info: { source: "browser" } });
      await insertFor(thread.id, 2, "user_message", { text: "initial instruction", caller_info: { source: "browser" } });
      await insertFor(thread.id, 3, "user_message", { text: "follow-up", caller_info: { source: "browser" } });
      const threadBase = `/api/conversations/v1/threads/${thread.id}`;
      const itemsResponse = await app.inject({ method: "GET", url: `${threadBase}/items`, headers: { authorization: "Bearer test" } });
      expect(itemsResponse.statusCode).toBe(200);
      const visibleItems = itemsResponse.json().items.map((item: { text: string }) => item.text);
      expect(visibleItems).toEqual(["sent before startup", "follow-up"]);

      const eventsResponse = await app.inject({ method: "GET", url: `${threadBase}/events`, headers: { authorization: "Bearer test" } });
      expect(eventsResponse.statusCode).toBe(200);
      const frames = eventsResponse.body.split("\n\n").filter(Boolean);
      const snapshot = frames.map((frame: string) => frame.split("\n").find(line => line.startsWith("data: ")))
        .filter(Boolean).map((line: string) => JSON.parse(line.slice(6))).find((value: { kind: string }) => value.kind === "snapshot");
      expect(snapshot.snapshot.items.map((item: { text: string }) => item.text)).toEqual(visibleItems);
    }
  });
  it("checks access before history and stream", async () => {
    deny = true;
    expect((await get("/items")).statusCode).toBe(403);
    expect((await get("/events")).statusCode).toBe(403);
    deny = false;
    expect((await get("/items", {})).statusCode).toBe(401);
  });
  it("combines the live snapshot and queued deltas without repeating their prefix", async () => {
    await insert(19, "user_message", { text:"working", caller_info:{ source:"browser" } });
    const other = Fastify();
    registerConversationRoutes(other, {
      service, resolveAccount: async () => "person", closeAfterHistorySync:true,
      liveEvents: {
        subscribe: (_id, listener) => {
          listener({ event:{ type:"text_delta", streamIdentity:"stream-1", liveSeq:1, liveTextMode:"append", text:"hel" } });
          listener({ event:{ type:"text_delta", streamIdentity:"stream-1", liveSeq:2, liveTextMode:"append", text:"lo" } });
          return () => {};
        },
        snapshotLiveText: () => ({ throughLiveSeq:1, streams:[{
          streamIdentity:"stream-1", text:"hel", updatedAt:"2026-10-30T00:00:00Z", truncated:false, resetRequired:false, recovery:"none",
        }] }),
      },
    });
    const response = await other.inject({ method:"GET", url:base + "/events", headers:{ "last-event-id":"18" } });
    const events = response.body.split("\n\n").flatMap(part => {
      const line = part.split("\n").find(row => row.startsWith("data: "));
      return line ? [JSON.parse(line.slice(6))] : [];
    });
    expect(events[0].snapshot).toMatchObject({ busy:true, stream_id:"stream-1", text:"hel" });
    expect(events[1]).toEqual({ kind:"text", stream_id:"stream-1", text:"hello" });
    expect(response.body.split("\n").filter(line => line.startsWith("id: "))).toEqual(["id: 19"]);
    await other.close();
  });
  it("streams a stored item and cumulative text on a real HTTP connection", async () => {
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    let unsubscribeCount = 0;
    let unsubscribed!: () => void;
    const closed = new Promise<void>(resolve => { unsubscribed = resolve; });
    const other = Fastify();
    registerConversationRoutes(other, {
      service, resolveAccount: async () => "person",
      liveEvents: { subscribe: (_id, callback) => { listener = callback; return () => { unsubscribeCount++; unsubscribed(); }; } },
    });
    const address = await other.listen({ port:0, host:"127.0.0.1" });
    const abort = new AbortController();
    try {
      const response = await fetch(address + base + "/events", { headers:{ "last-event-id":"19" }, signal:abort.signal });
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('"kind":"snapshot"');
      await insert(20, "user_message", { text:"live", caller_info:{source:"browser"} });
      const saved = { eventId:20, event:{ type:"user_message", text:"live", caller_info:{source:"browser"} } };
      listener!(saved); listener!(saved);
      listener!({ event:{ type:"text_start", streamIdentity:"live-stream", liveSeq:1 } });
      listener!({ event:{ type:"text_delta", streamIdentity:"live-stream", liveSeq:2, liveTextMode:"append", text:"hello" } });
      let received = "";
      while (!received.includes('"kind":"text"')) {
        const chunk = await reader.read();
        received += new TextDecoder().decode(chunk.value);
      }
      expect(received.match(/"kind":"item"/g)).toHaveLength(1);
      expect(received).toContain('"text":"hello"');
      expect(received.split("\n").filter(line => line.startsWith("id: "))).toEqual(["id: 20"]);
    } finally { abort.abort(); await closed; await other.close(); }
    expect(unsubscribeCount).toBe(1);
  });
  it("unsubscribes when the server closes the streaming connection", async () => {
    let unsubscribeCount = 0;
    let unsubscribed!: () => void;
    const closed = new Promise<void>(resolve => { unsubscribed = resolve; });
    const other = Fastify();
    registerConversationRoutes(other, {
      service, resolveAccount: async () => "person",
      liveEvents: { subscribe: () => () => { unsubscribeCount++; unsubscribed(); } },
    });
    const address = await other.listen({ port:0, host:"127.0.0.1" });
    const response = await fetch(address + base + "/events");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"kind":"snapshot"');
    other.server.closeAllConnections();
    await closed;
    await other.close();
    expect(unsubscribeCount).toBe(1);
  });
  it("delivers a stored final response queued before the live snapshot and can resume after completion", async () => {
    const hub = new RuntimeSessionEventHub();
    const original = ConversationHistory.prototype.load;
    const spy = vi.spyOn(ConversationHistory.prototype, "load").mockImplementationOnce(async function (this: ConversationHistory, binding) {
      const result = await original.call(this, binding);
      const publish = (event: Record<string, unknown>, eventId?: number) =>
        hub.publish({ nodeId:"node", data:{ agentSessionId:session, ...(eventId === undefined ? {} : { eventId }), event } });
      publish({ type:"text_start", tool_use_id:"stream-race", raw_event_type:"item/started" });
      publish({ type:"text_delta", tool_use_id:"stream-race", raw_event_type:"item/delta", text:"response" });
      const answer = { type:"assistant_message", content:"race answer", tool_use_id:"stream-race", raw_event_type:"item/completed", _final_for_live_stream:true };
      await insert(21, "assistant_message", answer);
      publish(answer, 21);
      await insert(22, "complete", {});
      publish({ type:"complete" }, 22);
      return result;
    });
    const other = Fastify();
    registerConversationRoutes(other, {
      service, resolveAccount: async () => "person", closeAfterHistorySync:true,
      liveEvents: {
        subscribe: (id, listener) => hub.subscribe(id, event => listener(event.data)),
        snapshotLiveText: id => hub.snapshotLiveText(id),
      },
    });
    try {
      const response = await other.inject({ method:"GET", url:base + "/events", headers:{ "last-event-id":"20" } });
      const frames = response.body.split("\n\n").filter(Boolean);
      const answerFrame = frames.find(frame => frame.includes('"text":"race answer"'));
      expect(answerFrame).toContain("id: 21");
      expect(frames.some(frame => frame.includes("id: 22") && frame.includes('"busy":false'))).toBe(true);
      const again = await other.inject({ method:"GET", url:base + "/events", headers:{ "last-event-id":"22" } });
      expect(again.body).not.toContain("race answer");
    } finally { spy.mockRestore(); await other.close(); }
  });
  it("emits an unstored runtime termination error without advancing the stored cursor", async () => {
    await insert(23, "user_message", { text:"work again", caller_info:{source:"browser"} });
    const hub = new RuntimeSessionEventHub();
    const other = Fastify();
    registerConversationRoutes(other, {
      service, resolveAccount: async () => "person", closeAfterHistorySync:true,
      liveEvents: {
        subscribe: (id, listener) => hub.subscribe(id, event => listener(event.data)),
        snapshotLiveText: id => {
          hub.dispatchNodeRegistryEvents([{
            type:"node_session_session_updated", nodeId:"node",
            data:{ agentSessionId:session, status:"error", termination_detail:"runtime failed" },
          }]);
          return hub.snapshotLiveText(id);
        },
      },
    });
    try {
      const response = await other.inject({ method:"GET", url:base + "/events", headers:{ "last-event-id":"23" } });
      const frames = response.body.split("\n\n").filter(Boolean);
      const errorFrame = frames.find(frame => frame.includes('"kind":"error"'));
      expect(errorFrame).toContain("runtime failed");
      expect(errorFrame).not.toContain("\nid:");
      const activityFrame = frames.find(frame => frame.includes('"kind":"activity"') && frame.includes('"busy":false'));
      expect(activityFrame).toBeDefined();
      expect(activityFrame).not.toContain("\nid:");
      expect(response.body.split("\n").filter(line => line.startsWith("id: "))).toEqual(["id: 23"]);
    } finally { await other.close(); }
  });
  it.each([
    { order:"stored-first", inputId:25, errorId:26 },
    { order:"runtime-first", inputId:29, errorId:30 },
  ])("emits one error in $order order and advances the stored cursor", async ({order,inputId,errorId}) => {
    await insert(inputId - 1, "complete", {});
    await insert(inputId, "user_message", { text:"start", caller_info:{source:"browser"} });
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const original = ConversationHistory.prototype.load;
    const spy = vi.spyOn(ConversationHistory.prototype, "load").mockImplementationOnce(async function (this: ConversationHistory, binding) {
      const result = await original.call(this, binding);
      const stored = { type:"error", message:"same failure" };
      await insert(errorId, "error", stored);
      const saved = { eventId:errorId, event:stored };
      const runtime = { event:{ type:"error", message:"same failure" } };
      for (const event of order === "stored-first" ? [saved,runtime] : [runtime,saved]) listener!(event);
      return result;
    });
    const other = Fastify();
    registerConversationRoutes(other, {
      service, resolveAccount:async () => "person", closeAfterHistorySync:true,
      liveEvents:{ subscribe:(_id, callback) => { listener=callback; return () => {}; } },
    });
    try {
      const response = await other.inject({ method:"GET", url:base+"/events", headers:{"last-event-id":String(inputId)} });
      const frames = response.body.split("\n\n").filter(Boolean);
      const events = frames.flatMap(frame => {
        const data=frame.split("\n").find(line => line.startsWith("data: "));
        return data ? [JSON.parse(data.slice(6))] : [];
      });
      expect(events.filter(event => event.kind === "item" && event.item.kind === "error")).toHaveLength(1);
      expect(events.some(event => event.kind === "activity" && event.busy === false)).toBe(true);
      expect(frames.some(frame => frame.split("\n").includes(`id: ${errorId}`))).toBe(true);
    } finally { spy.mockRestore(); await other.close(); }
  });
  it("does not repeat an error already present in the reconnect snapshot", async () => {
    await insert(31, "complete", {});
    await insert(32, "error", { message:"stored failure" });
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const other = Fastify();
    registerConversationRoutes(other, {
      service, resolveAccount:async () => "person", closeAfterHistorySync:true,
      liveEvents:{
        subscribe:(_id, callback) => { listener=callback; return () => {}; },
        snapshotLiveText:() => { listener!({event:{type:"error",message:"stored failure"}}); return {throughLiveSeq:0,streams:[]}; },
      },
    });
    try {
      const response = await other.inject({ method:"GET", url:base+"/events", headers:{"last-event-id":"31"} });
      const frames = response.body.split("\n\n").filter(Boolean);
      const events = frames.flatMap(frame => {
        const data=frame.split("\n").find(line => line.startsWith("data: "));
        return data ? [JSON.parse(data.slice(6))] : [];
      });
      expect(events[0].snapshot.items.filter((item: {kind:string}) => item.kind === "error")).toHaveLength(1);
      expect(events.filter(event => event.kind === "item" && event.item.kind === "error")).toHaveLength(0);
      expect(events.some(event => event.kind === "activity" && event.busy === false)).toBe(true);
      expect(frames[0]).toContain("id: 32");
    } finally { await other.close(); }
  });
  it.each([
    { order:"stored-then-runtime", start:40 },
    { order:"runtime-then-stored", start:50 },
  ])("shows a new turn's error after $order", async ({order,start}) => {
    await insert(start - 1, "complete", {});
    await insert(start, "user_message", {text:"first turn",caller_info:{source:"browser"}});
    let listener: ((event: Record<string, unknown>) => void) | undefined;
    const original = ConversationHistory.prototype.load;
    const spy = vi.spyOn(ConversationHistory.prototype, "load").mockImplementationOnce(async function (this: ConversationHistory, binding) {
      const result = await original.call(this, binding);
      const first = {type:"error",message:"first failure"};
      const input = {type:"user_message",text:"next turn",caller_info:{source:"browser"}};
      const second = {type:"error",message:"second failure"};
      if (order === "stored-then-runtime") {
        await insert(start + 1,"error",first);
        listener!({eventId:start + 1,event:first});
      } else listener!({event:first});
      await insert(start + 2,"user_message",input);
      listener!({eventId:start + 2,event:input});
      if (order === "runtime-then-stored") {
        await insert(start + 3,"error",second);
        listener!({eventId:start + 3,event:second});
      } else listener!({event:second});
      return result;
    });
    const other = Fastify();
    registerConversationRoutes(other, {service,resolveAccount:async () => "person",closeAfterHistorySync:true,
      liveEvents:{subscribe:(_id,callback) => {listener=callback; return () => {};}}});
    try {
      const response = await other.inject({method:"GET",url:base+"/events",headers:{"last-event-id":String(start)}});
      const frames = response.body.split("\n\n").filter(Boolean);
      const events = frames.flatMap(frame => {
        const data=frame.split("\n").find(line => line.startsWith("data: "));
        return data ? [JSON.parse(data.slice(6))] : [];
      });
      expect(events.filter(event => event.kind === "item" && event.item.kind === "error").map(event => event.item.text))
        .toEqual(["first failure","second failure"]);
      expect(events.some(event => event.kind === "activity" && event.busy === false)).toBe(true);
      expect(frames.some(frame => frame.split("\n").includes(`id: ${order === "runtime-then-stored" ? start + 3 : start + 2}`))).toBe(true);
    } finally { spy.mockRestore(); await other.close(); }
  });

});
