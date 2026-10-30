import Fastify from "fastify";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";
import { SessionDeliveryRepository } from "../src/control_plane/repositories/session_delivery_repository.js";
import { executeSessionIntervention } from "../src/session/session_action_command_routes.js";
import { ConversationService } from "../src/conversation/conversation_service.js";
import { createConversationMessagePorts } from "../src/conversation/conversation_message_ports.js";
import { ConversationMessageService } from "../src/conversation/conversation_messages.js";
import { registerConversationRoutes } from "../src/conversation/conversation_routes.js";
import { registerProductionAuthGuard } from "../src/runtime/production_auth_guard.js";
import { createOAuthAccessTokenResolver } from "../src/oauth/oauth_access.js";
import { createLiveAuthenticatedUserResolvers } from "../src/runtime/live_authenticated_user_resolver.js";
import { createSessionResourceAccessProvider } from "../src/session/session_resource_access.js";

let db: FullSchemaPostgresHarness;
const session = "message-test-session";
const base = `/api/conversations/v1/threads/${session}`;
const upload = { name:"한글.txt", mime:"text/plain", data_base64:Buffer.from("hello").toString("base64") };
let deny = false;
let failUpload = false;
const uploads = new Map<string, Buffer>();
let eventId = 0;
const ports = {
  upload: vi.fn(async (_request: unknown, _session: string, file: typeof upload) => {
    if (failUpload && file.name === "fail.txt") throw new Error("secret internal path");
    const path = `/private/${session}/${file.name}`;
    uploads.set(path, Buffer.from(file.data_base64, "base64"));
    return { path, name:file.name, mime:file.mime };
  }),
  caller: vi.fn(async (_request: import("fastify").FastifyRequest, _target:string):Promise<Record<string,unknown>> => ({source:"browser",transport:"oauth",oauth_client_id:"client",oauth_client_name:"Client"})),
  intervene: vi.fn(async (request: import("fastify").FastifyRequest, target: string, body: { text:string; attachment_paths:string[]; delivery_id:string }, caller:Record<string,unknown>) => {
    return await executeSessionIntervention({
      router:{routeExistingSessionPendingCommand:async (payload:unknown) => payload} as never,
      bridge:{sendPendingCommand:async (payload: {text:string;attachment_paths?:string[];caller_info:Record<string,unknown>}) => {
        await db.sql`INSERT INTO events(session_id,id,event_type,payload,created_at) VALUES
          (${target}, ${++eventId}, 'intervention_sent', ${db.sql.json({ text:payload.text, attachments:payload.attachment_paths ?? [], caller_info:payload.caller_info } as never)}, now())`;
        return {status:"ok"};
      }} as never,
      resolveCallerInfo:() => caller,
      deliveryRepositoryProvider:async () => new SessionDeliveryRepository(db.sql as never),
    },request,target,body);
  }),
  read: vi.fn(async (_request: unknown, _session: string, attachment: {path?:string}) => {
    const bytes = uploads.get(attachment.path ?? "");
    if (!bytes) throw new Error("not found");
    return new Response(bytes);
  }),
};

describe("conversation message receipts", () => {
  let app: ReturnType<typeof Fastify>;
  let service: ConversationService;
  let resolveCaller: typeof ports.caller;
  const post = (request_id:string, text:string, attachments:typeof upload[] = []) => app.inject({
    method:"POST", url:base + "/messages", headers:{ authorization:"Bearer good" }, payload:{request_id,text,attachments},
  });
  const get = (path:string, auth = "good") => app.inject({ method:"GET", url:base + path, headers:{ authorization:`Bearer ${auth}` } });
  beforeAll(async () => {
    db = await createFullSchemaPostgresHarness();
    await db.sql`INSERT INTO folders(id,name) VALUES ('allowed','Allowed'),('other','Other')`;
    await db.sql`INSERT INTO sessions(session_id,folder_id,node_id,model_preset,created_at) VALUES (${session},'allowed','test-node','sol',now())`;
    await db.sql`INSERT INTO conversation_bindings(account_id,namespace,external_key,session_id,selected_model,phase)
      VALUES ('person@example.test','n','k',${session},'sol','complete')`;
    const access = createSessionResourceAccessProvider({
      accessProvider:{ resolveAccess:() => ({restricted:true, allowedFolderIds:deny ? ["other"] : ["allowed"]}) },
      repository:{ getSessionAccessRecord:async id => {
        const [row] = await db.sql`SELECT session_id,folder_id FROM sessions WHERE session_id=${id}`;
        return row ? {sessionId:row.session_id,folderId:row.folder_id} : null;
      }, listFoldersForAccess:async () => (await db.sql`SELECT id,parent_folder_id FROM folders`).map(row => ({id:row.id,parentFolderId:row.parent_folder_id})) },
    });
    service = new ConversationService({sql:db.sql as never, access, reads:async () => ({getSession:async () => ({session_id:session,node_id:"test-node",created_at:new Date(),model_preset:"sol"})}) as never,
      presets:{listForNode:() => []} as never,persistent:{} as never,create:async () => ({} as never),waitForCreatedSession:async () => true});
    const token = (scope:string) => ({accountId:"person@example.test",clientId:"client",scope});
    await db.sql`INSERT INTO oauth_entities(kind,id,payload,expires_at) VALUES
      ('Client','client',${db.sql.json({client_name:"Client"})},NULL),
      ('AccessToken','good',${db.sql.json(token("conversations"))},now()+interval '1 hour'),
      ('AccessToken','wrong',${db.sql.json(token("cards:read"))},now()+interval '1 hour')`;
    const users = createLiveAuthenticatedUserResolvers({jwt:{issueToken:async () => "",verifyToken:async () => null},resolveOAuthToken:createOAuthAccessTokenResolver(db.sql as never),isServiceBearer:async () => false});
    ports.caller.mockImplementation(async (request, target) => users.resolveCallerInfo(request,undefined,target));
    resolveCaller = ports.caller;
    app = Fastify();
    registerProductionAuthGuard(app,{resolveTokenAccess:async () => ({ok:false,statusCode:401,detail:"Authentication required"}),resolveOAuthAccess:users.resolveOAuthAccess});
    registerConversationRoutes(app,{service,resolveAccount:users.resolveEmail,messages:new ConversationMessageService(db.sql as never, ports)});
    await app.ready();
  },60_000);
  afterAll(async () => { await app?.close(); await db?.cleanup(); });

  it("accepts an attachment-only message once, preserves metadata and reads its bytes",async () => {
    const first = await post("r1","",[upload]);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({request_id:"r1",status:"accepted"});
    expect((await post("r1","",[upload])).json()).toEqual(first.json());
    expect((await post("r1","changed",[upload])).statusCode).toBe(409);
    expect(ports.intervene).toHaveBeenCalledTimes(1);
    const [ledger] = await db.sql`SELECT d.delivery_id,d.payload_hash,d.payload,r.uploads FROM session_deliveries d JOIN conversation_message_receipts r ON r.delivery_id=d.delivery_id WHERE r.request_id='r1'`;
    expect(ledger!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger!.payload.caller_info).toMatchObject({source:"browser",transport:"oauth",oauth_client_id:"client"});
    expect(ledger!.payload.attachment_paths).toEqual([ledger!.uploads[0].path]);
    expect(ports.upload).toHaveBeenCalledTimes(1);
    const items = (await get("/items")).json().items;
    expect(items).toHaveLength(1);
    expect(items[0].attachments).toEqual([{id:"path:0",name:"한글.txt",mime:"text/plain"}]);
    const data = await get(`/items/${items[0].id}/attachments/${encodeURIComponent("path:0")}`);
    expect(data.statusCode).toBe(200); expect(data.rawPayload).toEqual(Buffer.from("hello"));
    expect(data.headers["content-type"]).toContain("text/plain");
    expect(data.headers["content-disposition"]).toContain("filename*=");
  });
  it("coalesces simultaneous requests with the same id",async () => {
    const beforeUploads=ports.upload.mock.calls.length, beforeSends=ports.intervene.mock.calls.length;
    const [first,second]=await Promise.all([post("concurrent","together",[upload]),post("concurrent","together",[upload])]);
    expect(first.json()).toEqual({request_id:"concurrent",status:"accepted"});
    expect(second.json()).toEqual(first.json());
    expect(ports.upload).toHaveBeenCalledTimes(beforeUploads+1);
    expect(ports.intervene).toHaveBeenCalledTimes(beforeSends+1);
  });
  it("reconciles pending receipts with the durable ledger on GET",async () => {
    await db.sql`UPDATE conversation_message_receipts SET status='pending' WHERE session_id=${session} AND request_id='r1'`;
    expect((await get("/messages/r1")).json()).toEqual({request_id:"r1",status:"accepted"});
    const [row] = await db.sql`SELECT status FROM conversation_message_receipts WHERE session_id=${session} AND request_id='r1'`;
    expect(row!.status).toBe("accepted");
    const body = {request_id:"not-admitted",text:"resume",attachments:[]};
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    await db.sql`INSERT INTO conversation_message_receipts(session_id,request_id,request_hash,delivery_id,caller_info,status)
      VALUES (${session},'not-admitted',${hash},'not-admitted-delivery',${db.sql.json({source:"browser"})},'pending')`;
    expect((await get("/messages/not-admitted")).json()).toEqual({request_id:"not-admitted",status:"pending"});
    expect((await post(body.request_id,body.text)).json()).toEqual({request_id:"not-admitted",status:"accepted"});
    const [resumed] = await db.sql`SELECT delivery_id FROM session_deliveries WHERE delivery_id='not-admitted-delivery'`;
    expect(resumed?.delivery_id).toBe("not-admitted-delivery");
  });
  it("records a safe failed receipt without intervention when an upload fails",async () => {
    failUpload = true;
    const before = ports.intervene.mock.calls.length;
    const result = await post("r2","hello",[upload,{...upload,name:"fail.txt"}]);
    expect(result.json()).toMatchObject({request_id:"r2",status:"failed",error:{code:"unavailable"}});
    expect(result.body).not.toContain("secret");
    expect(ports.intervene).toHaveBeenCalledTimes(before);
    expect((await get("/messages/r2")).json()).toEqual(result.json());
    failUpload = false;
    expect((await post("r3","hello",[upload])).json().status).toBe("accepted");
  });
  it("continues after a disconnected response and converges by receipt",async () => {
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>(r => {release=r;});
    const started = new Promise<void>(r => {entered=r;});
    ports.upload.mockImplementationOnce(async (_r,_s,file) => { entered(); await waiting; const path=`/private/${session}/delayed`; uploads.set(path,Buffer.from(file.data_base64,"base64")); return {path,name:file.name,mime:file.mime}; });
    const address = await app.listen({port:0,host:"127.0.0.1"});
    const abort = new AbortController();
    const sending = fetch(address+base+"/messages",{method:"POST",headers:{authorization:"Bearer good","content-type":"application/json"},body:JSON.stringify({request_id:"r4",text:"",attachments:[upload]}),signal:abort.signal}).catch(() => undefined);
    await started; abort.abort(); await sending;
    expect((await get("/messages/r4")).json().status).toBe("pending");
    release();
    for (let i=0;i<100;i++) { if ((await get("/messages/r4")).json().status === "accepted") return; await new Promise(r => setTimeout(r,10)); }
    throw new Error("receipt did not converge");
  });
  it("treats a dispatch error after durable admission as accepted",async () => {
    const original=ports.intervene.getMockImplementation()!;
    ports.intervene.mockImplementationOnce(async (...args) => { await original(...args); throw new Error("response lost after admission"); });
    const result=await post("admitted-before-error","hello");
    expect(result.json()).toEqual({request_id:"admitted-before-error",status:"accepted"});
    expect((await get("/messages/admitted-before-error")).json()).toEqual(result.json());
  });
  it("returns 413 for attachment limits",async () => {
    const result = await post("limit","x",Array(11).fill(upload));
    expect(result.statusCode).toBe(413); expect(result.json().error.code).toBe("attachment_limit");
    const large = Buffer.alloc(20*1024*1024+1).toString("base64");
    expect((await post("file-limit","x",[{...upload,data_base64:large}])).statusCode).toBe(413);
    const medium = Buffer.alloc(16*1024*1024).toString("base64");
    expect((await post("total-limit","x",[{...upload,data_base64:medium},{...upload,data_base64:medium}])).statusCode).toBe(413);
    const bodyLimit=await post("body-limit","x".repeat(48*1024*1024));
    expect(bodyLimit.statusCode).toBe(413); expect(bodyLimit.json().error.code).toBe("attachment_limit");
  });
  it("reads old path-only records and restores their filenames",async () => {
    const path=`/private/${session}/2026-10-30T00-00-00.000Z-note-0123456789abcdef0123456789abcdef.txt`;
    uploads.set(path,Buffer.from("old"));
    await db.sql`INSERT INTO events(session_id,id,event_type,payload,created_at) VALUES (${session},${++eventId},'user_message',${db.sql.json({text:"old",attachments:[path],caller_info:{source:"kaleidoscope"}})},now())`;
    const items=(await get("/items")).json().items; const item=items.find((v:{text:string}) => v.text === "old");
    expect(item.attachments[0]).toEqual({id:"path:0",name:"note.txt",mime:"text/plain"});
    expect((await get(`/items/${item.id}/attachments/${encodeURIComponent("path:0")}`)).rawPayload).toEqual(Buffer.from("old"));
  });
  it("checks folder access, OAuth scope and authentication before all operations",async () => {
    deny=true; expect((await get("/messages/r1")).statusCode).toBe(403); expect((await post("r5","hi")).statusCode).toBe(403); deny=false;
    expect((await get("/messages/r1","wrong")).json().error.code).toBe("forbidden");
    const anonymous=await app.inject({method:"GET",url:base+"/messages/r1"});
    expect(anonymous.statusCode).toBe(401); expect(anonymous.json().error.code).toBe("login_required");
  });
  it("wires owned upload and legacy cache through the real intervention and projects one attachment",async () => {
    const saved = new Map<string,Buffer>();
    let id = "";
    const attachmentPorts = {
      assetUpload:{
        resolveActor:async () => ({kind:"user",email:"person@example.test"}),
        requireRegistration:async () => ({registrationScope:{type:"session",id:session},sourceNodeId:null,sourceSessionId:session,outputCommandId:null}),
        commits:{putSmall:async ({spec,body}: {spec:{attachmentId:string;originalName:string;mimeType:string};body:Buffer}) => {
          id=spec.attachmentId; saved.set(id,Buffer.from(body));
          await db.sql`INSERT INTO file_assets(id,storage_key,storage_purpose,original_name,mime_type,byte_size,upload_status)
            VALUES (${id},${"key-"+id},'attachment',${spec.originalName},${spec.mimeType},${body.length},'committed')`;
          return {attachmentId:id,byteSize:body.length,mimeType:spec.mimeType};
        }},
        repository:{findLegacyAliasForUpload:async () => null,insertLegacyAlias:async () => ({})},
      },
      assetRead:{resolveActor:async () => ({kind:"user",email:"person@example.test"}),service:{content:async (_actor:unknown, asset:string) => new Response(saved.get(asset)),legacy:async () => { throw Object.assign(new Error("no asset id evidence"),{statusCode:403}); }}},
      provider:{getNode:async () => ({id:"test-node"})},
      transport:{uploadAttachment:async (_node:unknown, input:{sessionId:string;filename:string;contentType:string;expectedSize:number}) => ({
        path:`/private/${session}/cached`,filename:input.filename,size:input.expectedSize,content_type:input.contentType,
      }),downloadAttachment:async () => ({content_b64:Buffer.from("old-node").toString("base64")})},
    };
    const commands = {
      resolveCallerInfo:(request:import("fastify").FastifyRequest,_body:unknown,target:string) => resolveCaller(request,target),
      deliveryRepositoryProvider:async () => new SessionDeliveryRepository(db.sql as never),
      admitAttachmentInput:async (_request:unknown, input:{attachmentPaths:string[]}) => ({attachment_paths:input.attachmentPaths,attachment_ids:[id],attachment_bindings:[{attachment_id:id,node_id:"test-node",path:input.attachmentPaths[0]}]}),
      router:{routeExistingSessionPendingCommand:async (payload:unknown) => payload},
      bridge:{sendPendingCommand:async (payload:{text:string;attachment_paths:string[];attachment_ids:string[];caller_info:Record<string,unknown>}) => {
        await db.sql`INSERT INTO events(session_id,id,event_type,payload,created_at) VALUES (${session},${++eventId},'intervention_sent',
          ${db.sql.json({text:payload.text,attachments:payload.attachment_paths,attachment_ids:payload.attachment_ids,caller_info:payload.caller_info} as never)},now())`;
        return {status:"ok"};
      }},
    };
    const wired = Fastify();
    registerConversationRoutes(wired,{service,resolveAccount:async () => "person@example.test",messages:new ConversationMessageService(db.sql as never,createConversationMessagePorts(db.sql as never,attachmentPorts as never,commands as never))});
    const result=await wired.inject({method:"POST",url:base+"/messages",payload:{request_id:"wired",text:"wired",attachments:[upload]}});
    expect(result.json()).toMatchObject({status:"accepted"});
    const items=(await wired.inject({method:"GET",url:base+"/items"})).json().items;
    const item=items.find((value:{text:string}) => value.text === "wired");
    expect(item.attachments).toEqual([{id,name:upload.name,mime:upload.mime}]);
    const content=await wired.inject({method:"GET",url:base+`/items/${item.id}/attachments/${id}`});
    expect(content.statusCode).toBe(200); expect(content.rawPayload).toEqual(Buffer.from("hello"));
    const legacy=items.find((value:{text:string}) => value.text === "old");
    const oldContent=await wired.inject({method:"GET",url:base+`/items/${legacy.id}/attachments/${encodeURIComponent("path:0")}`});
    expect(oldContent.statusCode).toBe(200); expect(oldContent.rawPayload).toEqual(Buffer.from("old-node"));
    await db.sql`INSERT INTO events(session_id,id,event_type,payload,created_at) VALUES (${session},${++eventId},'user_message',
      ${db.sql.json({text:"foreign path",attachments:["/private/other-session/file.txt"],caller_info:{source:"browser"}})},now())`;
    const foreignItems=(await wired.inject({method:"GET",url:base+"/items"})).json().items;
    const foreign=foreignItems.find((value:{text:string}) => value.text === "foreign path");
    const forbiddenPath=await wired.inject({method:"GET",url:base+`/items/${foreign.id}/attachments/${encodeURIComponent("path:0")}`});
    expect(forbiddenPath.statusCode).toBe(404);
    await wired.close();
  });

});
