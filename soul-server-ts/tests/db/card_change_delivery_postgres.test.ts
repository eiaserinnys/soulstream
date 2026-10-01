import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { createFullSchemaPostgresHarness,type FullSchemaPostgresHarness } from "./full_schema_postgres_harness.js";
import { SessionDeliveryRepository } from "../../../orch-server-ts/src/control_plane/repositories/session_delivery_repository.js";
import { sendCardChangeOnce } from "../../../orch-server-ts/src/cards/card_change_delivery.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";
import type { InterveneNodeCommandPayload } from "../../../orch-server-ts/src/session/session_action_command_payloads.js";

// Real sender CAS + receiving ledger, using the existing full-schema PostgreSQL harness.
describe("card-only durable callback acceptance",()=>{
  let h:FullSchemaPostgresHarness,repo:SessionDeliveryRepository,peer:SessionDeliveryRepository,gate:TaskDeliveryLedgerGate;
  const payload=(id:string):InterveneNodeCommandPayload=>({type:"intervene",agentSessionId:"owner",text:"사용자가 카드 상태를 변경했습니다",user:"system",
    delivery_id:id,delivery_intent:"durable_next_turn",source:"card_change",relation_key:id,completion_id:id,caller_info:{source:"browser"}});
  beforeAll(async()=>{h=await createFullSchemaPostgresHarness();repo=new SessionDeliveryRepository(h.sql);peer=new SessionDeliveryRepository(h.createPeer());gate=new TaskDeliveryLedgerGate(true,repo);},60000);
  beforeEach(async()=>{await h.sql`DELETE FROM session_deliveries`;await h.sql`INSERT INTO sessions(session_id,status,agent_id) VALUES ('owner','running','roselin') ON CONFLICT DO NOTHING`;});
  afterAll(async()=>h?.cleanup());
  const params=(p:InterveneNodeCommandPayload)=>({agentSessionId:p.agentSessionId,text:p.text,user:p.user??"system",deliveryId:p.delivery_id,
    deliveryIntent:p.delivery_intent,relationKey:p.relation_key,completionId:p.completion_id,source:p.source,callerInfo:p.caller_info,deliveryAttemptToken:p.delivery_attempt_token});
  async function accept(p:InterveneNodeCommandPayload) {
    const admitted=await gate.beginDispatch(await gate.admit(params(p)));
    expect(admitted.kind).toBe("admitted");
    // Existing local admission succeeds before recordResult marks queued (not model consumption).
    await gate.recordResult(admitted,{delivered:true});
    return {status:"ok",outcome:"delivered"};
  }
  it("allows one sender across concurrent callbacks, and suppresses queued/consumed replay",async()=>{
    let release!:()=>void,arrived!:()=>void;
    const atReceiver=new Promise<void>(resolve=>arrived=resolve),hold=new Promise<void>(resolve=>release=resolve);
    const send=vi.fn(async(p:InterveneNodeCommandPayload)=>{arrived();await hold;return accept(p);});
    const p=payload("card:card1:state:operation1:owner");
    const first=sendCardChangeOnce(repo,p,send);
    await atReceiver;
    // Second callback races between first sender's claim and downstream acceptance.
    await expect(sendCardChangeOnce(peer,p,send)).rejects.toThrow("no confirmed acceptance");
    release();await first;
    expect(send).toHaveBeenCalledTimes(1);
    expect((await repo.get(p.delivery_id!))?.state).toBe("queued");
    await sendCardChangeOnce(peer,p,send);expect(send).toHaveBeenCalledTimes(1);
    await repo.markConsumed(p.delivery_id!,"turn1");
    await sendCardChangeOnce(repo,p,send);expect(send).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent registration and claim when neither callback has seen the ID",async()=>{
    const send=vi.fn(accept),p=payload("card:card1:comment:operation2:owner");
    const results=await Promise.allSettled([sendCardChangeOnce(repo,p,send),sendCardChangeOnce(peer,p,send)]);
    expect(send).toHaveBeenCalledTimes(1);expect(results.some(r=>r.status==="fulfilled")).toBe(true);
    expect((await repo.get(p.delivery_id!))?.state).toBe("queued");
  });
  it.each(["transport_failure","unknown","deferred","suppressed"])("does not report %s as accepted after claim",async outcome=>{
    const p=payload(`card:card1:state:${outcome}:owner`);
    const send=vi.fn(async()=>{if(outcome==="transport_failure")throw Error("offline");return {status:"ok",outcome};});
    await expect(sendCardChangeOnce(repo,p,send)).rejects.toThrow();
    const row=await repo.get(p.delivery_id!);expect(row?.state).toBe("claimed");expect(row?.delivered_at).toBeNull();expect(row?.queued_at).toBeNull();
    await expect(sendCardChangeOnce(repo,p,send)).rejects.toThrow();expect(send).toHaveBeenCalledTimes(1);
  });
  it("requires the atomic receiving beginDispatch even when the token is replayed",async()=>{
    const p=payload("card:card1:state:operation3:owner");
    const send=vi.fn(async(p:InterveneNodeCommandPayload)=>{
      const admissions=await Promise.all([gate.admit(params(p)),gate.admit(params(p))]);
      const begun=await Promise.all(admissions.map(a=>gate.beginDispatch(a)));
      expect(begun.filter(a=>a.kind==="admitted")).toHaveLength(1);
      await gate.recordResult(begun.find(a=>a.kind==="admitted")!,{delivered:true});
      return {status:"ok",outcome:"delivered"};
    });
    await sendCardChangeOnce(repo,p,send);
  });
  it("preserves the existing generic queued re-claim policy outside the card sender",async()=>{
    const p=payload("card:card1:state:operation4:owner");await sendCardChangeOnce(repo,p,accept);
    const admission=await gate.admit({...params(p),deliveryAttemptToken:undefined});
    expect(admission.kind).toBe("admitted");
  });
});
