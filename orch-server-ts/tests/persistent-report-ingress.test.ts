import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { createActionHarness } from "./session-action-command-test-helpers.js";
import { executeSessionIntervention } from "../src/session/session_action_command_routes.js";
import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import { registerPersistenceHostRoutes } from "../src/control_plane/persistence_host_routes.js";
import type { PersistenceHostRepositories } from "../src/control_plane/persistence_host_runtime.js";

describe('report ingress uses existing message and persistence boundaries',()=>{
  it('accepts trusted human context once and still sends the unchanged intervention payload',async()=>{
    const h=createActionHarness();
    const accept=vi.fn(async()=>undefined);
    const onHumanSessionInput=vi.fn(async()=>undefined);
    const context=[{key:'persistent_report_reply',content:{key:'r1',option:'진행'}},{key:'persistent_report_visible',content:{key:'r1',title:'보고'}}];
    const result=await executeSessionIntervention({router:h.router,bridge:h.bridge,resolveCallerInfo:()=>({source:'browser'}),acceptPersistentReportReply:accept,onHumanSessionInput},SERVICE_CALLER,'sess-contract',{text:'보고: 진행',context_items:context});
    expect(result.status).toBe(200);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith('sess-contract',context,{source:'browser'},SERVICE_CALLER);
    expect(onHumanSessionInput).not.toHaveBeenCalled();
    expect(h.sent.at(-1)).toMatchObject({type:'intervene',text:'보고: 진행',extra_context_items:context});
    await h.app.close();
  });
  it('turns a card-question board answer into a pass-through ACK without delivering to the session',async()=>{
    const h=createActionHarness();
    const accept=vi.fn(async()=>({handled:true}));
    const context=[{key:'persistent_report_reply',content:{key:'cq_q-1',option:'진행'}}];
    const result=await executeSessionIntervention({router:h.router,bridge:h.bridge,resolveCallerInfo:()=>({source:'browser'}),acceptPersistentReportReply:accept},SERVICE_CALLER,'sess-contract',{text:'진행',context_items:context});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({type:'intervene_ack',status:'ok',outcome:'delivered',agentSessionId:'sess-contract',
      delivered:true,consumeWhen:null,reason:'card_question_answered'});
    expect(h.sent).toHaveLength(0);
    await h.app.close();
  });
  it('returns the card route failure for a rejected board answer',async()=>{
    const h=createActionHarness();
    const accept=vi.fn(async()=>({handled:false,failure:{status:409,body:{detail:{error:{code:'CARD_QUESTION_CLOSED'}}}}}));
    const result=await executeSessionIntervention({router:h.router,bridge:h.bridge,resolveCallerInfo:()=>({source:'browser'}),acceptPersistentReportReply:accept},SERVICE_CALLER,'sess-contract',{text:'진행',context_items:[{key:'persistent_report_reply',content:{key:'cq_q-1',option:'진행'}}]});
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({detail:{error:{code:'CARD_QUESTION_CLOSED'}}});
    expect(h.sent).toHaveLength(0);
    await h.app.close();
  });
  it('keeps message delivery when the ancillary report update fails',async()=>{
    const h=createActionHarness();
    const result=await executeSessionIntervention({router:h.router,bridge:h.bridge,acceptPersistentReportReply:async()=>{throw new Error('report unavailable');}},SERVICE_CALLER,'sess-contract',{text:'그대로 전달'});
    expect(result.status).toBe(200);expect(h.sent.at(-1)).toMatchObject({type:'intervene',text:'그대로 전달'});
    await h.app.close();
  });
  it('authenticates the central host and preserves snake-case entry keys',async()=>{
    const put=vi.fn(async()=>({ok:true,entries:[],persistent_report:[]}));
    const app=Fastify();
    registerPersistenceHostRoutes(app,{ nodeCredentials: null,authBearerToken:'test-service',environment:'test',repositoryProvider:async()=>({persistentReports:{put}} as unknown as PersistenceHostRepositories)});
    const args=['own-pas',{key:'r1',card_numbers:[270],question_id:'q1'}];
    expect((await app.inject({method:'POST',url:'/api/session-data/host/put_report_entry',payload:{args}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url:'/api/session-data/host/put_report_entry',headers:{authorization:'Bearer test-service'},payload:{args}})).statusCode).toBe(200);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(...args);
    await app.close();
  });
});

describe('card question answers never fall through to generic intervention',()=>{
  const textReply=[{key:'persistent_report_reply',content:{key:'cq_q-1',mode:'text',text:'직접 쓴 답'}}];
  it('acknowledges a text answer without sending a message or resuming the session',async()=>{
    const h=createActionHarness();
    const accept=vi.fn(async()=>({handled:true}));
    const onHumanSessionInput=vi.fn(async()=>undefined);
    const result=await executeSessionIntervention({router:h.router,bridge:h.bridge,resolveCallerInfo:()=>({source:'browser'}),acceptPersistentReportReply:accept,onHumanSessionInput},SERVICE_CALLER,'sess-contract',{text:'직접 쓴 답',context_items:textReply});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({reason:'card_question_answered'});
    expect(h.sent).toHaveLength(0);
    expect(onHumanSessionInput).not.toHaveBeenCalled();
    await h.app.close();
  });
  it('returns a rejected malformed card question answer instead of delivering it',async()=>{
    const h=createActionHarness();
    const onHumanSessionInput=vi.fn(async()=>undefined);
    const result=await executeSessionIntervention({router:h.router,bridge:h.bridge,resolveCallerInfo:()=>({source:'browser'}),acceptPersistentReportReply:async()=>({handled:false,failure:{status:422,body:{detail:{error:{code:'CARD_QUESTION_ANSWER_INVALID'}}}}}),onHumanSessionInput},SERVICE_CALLER,'sess-contract',{text:'잘못된 답',context_items:[{key:'persistent_report_reply',content:{key:'cq_q-1'}}]});
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({detail:{error:{code:'CARD_QUESTION_ANSWER_INVALID'}}});
    expect(h.sent).toHaveLength(0);
    expect(onHumanSessionInput).not.toHaveBeenCalled();
    await h.app.close();
  });
  it('turns a processing exception on a card question answer into an explicit failure',async()=>{
    const h=createActionHarness();
    const onHumanSessionInput=vi.fn(async()=>undefined);
    const result=await executeSessionIntervention({router:h.router,bridge:h.bridge,resolveCallerInfo:()=>({source:'browser'}),acceptPersistentReportReply:async()=>{throw Object.assign(new Error('card unavailable'),{statusCode:503,code:'CARD_UNAVAILABLE'});},onHumanSessionInput},SERVICE_CALLER,'sess-contract',{text:'답',context_items:textReply});
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({detail:{error:{code:'CARD_UNAVAILABLE'}}});
    expect(h.sent).toHaveLength(0);
    expect(onHumanSessionInput).not.toHaveBeenCalled();
    await h.app.close();
  });
});
