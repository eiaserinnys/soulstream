import { randomUUID } from "node:crypto";
import { PendingNodeCommandRejectedError, PendingNodeCommandTimeoutError } from "../node/pending_commands.js";
import { NodeCommandTransportError } from "../session/session_command_transport.js";
import type { CardControlPlaneService, CardMutationParams } from "./card_control_plane_service.js";
import type { CardRow, SqlClient, RepositorySql, FolderActorParams } from "./control_plane/card_types.js";
import { CardVersionConflict } from "./control_plane/card_models.js";
import type { CardWorkExecution } from "./card_work_lifecycle.js";

export type ExecutionTarget = {nodeId:string;agentId:string;modelPreset:string|null;folderId?:string};
export interface CardExecutionRequest extends Record<string,unknown> {
  id:string; idempotency_key:string; keys:Record<string,{cardId:string;expectedVersion?:number}>;
  card_id:string;session_id:string;mode:"create"|"resume"|"observe";target:ExecutionTarget;
  state:"pending"|"succeeded"|"failed";sent:boolean;baseline_event_id:number;
  execution:CardWorkExecution|null;result_state:"started"|"already_running"|null;error:string|null;
}
export type ExecutionInput = {sessionId:string;requestId:string;cardId:string;target:ExecutionTarget};
export interface CardExecutionOptions {
  sql:SqlClient;cards:CardControlPlaneService;
  validate(card:CardRow):Promise<ExecutionTarget>;
  launch(input:ExecutionInput):Promise<unknown>;
  ensure(input:ExecutionInput):Promise<{state:"started"|"already_running";execution:CardWorkExecution}>;
}

/** The card lock owns reservation; no network operation runs inside its transaction. */
export class CardExecutionService {
  private readonly observing=new Map<string,Promise<Awaited<ReturnType<CardExecutionService["response"]>>>>();
  private readonly inFlight=new Map<string,Promise<unknown>>();
  constructor(private readonly options:CardExecutionOptions) {}
  async execute(params:CardMutationParams & {expectedVersion:number;idempotencyKey:string}) {
    const current=await this.options.cards.getCard(params.cardId);
    if(!current) throw failure("카드를 찾을 수 없습니다.",404);
    const row=await this.options.sql.begin(async sql=>{
      const card=(await sql<CardRow[]>`SELECT * FROM cards WHERE id=${params.cardId} FOR UPDATE`)[0]!;
      const existing=(await sql<CardExecutionRequest[]>`SELECT * FROM card_execution_requests WHERE idempotency_key=${params.idempotencyKey} OR keys ? ${params.idempotencyKey} LIMIT 1`)[0];
      const payload={cardId:params.cardId,expectedVersion:params.expectedVersion};
      if(existing){
        const prior=existing.keys[params.idempotencyKey];
        if(existing.card_id!==params.cardId || JSON.stringify(prior)!==JSON.stringify(payload)) throw failure("같은 요청 키의 내용이 다릅니다.",409);
        if(existing.state==='failed'){
          const owner=(await sql`SELECT * FROM sessions WHERE session_id=${existing.session_id} AND card_id=${card.id}`)[0];
          return (await sql<CardExecutionRequest[]>`UPDATE card_execution_requests SET state='pending',sent=FALSE,error=NULL,execution=NULL,result_state=NULL,
            mode=${owner?'resume':'create'},baseline_event_id=${Number(owner?.last_event_id??0)},updated_at=NOW() WHERE id=${existing.id} RETURNING *`)[0]!;
        }
        return existing;
      }
      const pending=(await sql<CardExecutionRequest[]>`SELECT * FROM card_execution_requests WHERE card_id=${card.id} AND state='pending' LIMIT 1`)[0];
      if(pending){
        const keys={...pending.keys,[params.idempotencyKey]:payload};
        await sql`UPDATE card_execution_requests SET keys=${sql.json(keys)} WHERE id=${pending.id}`;
        return pending;
      }
      if(card.version!==params.expectedVersion) throw new CardVersionConflict("card",card.id,params.expectedVersion,card.version);
      const automatic=await activeAutomaticReservation(sql,card);
      const prior=(await sql<CardExecutionRequest[]>`SELECT * FROM card_execution_requests WHERE card_id=${card.id} AND state='failed' ORDER BY created_at DESC LIMIT 1`)[0];
      const priorSession=prior ? (await sql`SELECT * FROM sessions WHERE session_id=${prior.session_id} AND card_id=${card.id}`)[0] : null;
      const sessionId=card.assignee_session_id ?? automatic ?? (priorSession ? prior!.session_id : randomUUID());
      const owner=(await sql`SELECT * FROM sessions WHERE session_id=${sessionId}`)[0];
      // Only a new manual create needs catalog preflight. Replay/observation remains available.
      const target=!owner && !automatic ? await this.options.validate(card) : null;
      const selected=owner ? {folderId:card.folder_id,nodeId:String(owner.node_id),agentId:String(owner.agent_id),modelPreset:owner.model_preset as string|null}:{...target!,folderId:card.folder_id};
      const mode=automatic ? "observe" : owner ? "resume" : "create";
      return (await sql<CardExecutionRequest[]>`INSERT INTO card_execution_requests(id,idempotency_key,keys,card_id,session_id,mode,target,previous_status,baseline_event_id,actor_user_id)
        VALUES(${randomUUID()},${params.idempotencyKey},${sql.json({[params.idempotencyKey]:payload})},${card.id},${sessionId},${mode},${sql.json(selected)},${card.status},${mode==='observe'?0:Number(owner?.last_event_id ?? 0)},${params.actorUserId ?? null}) RETURNING *`)[0]!;
    });
    if(row.state==='failed') throw failure(`${row.error} 같은 담당 세션에서 다시 시작하려면 다시 실행하세요.`,422);
    if(row.state==='succeeded') return this.response(row);
    let work=this.inFlight.get(row.id);
    if(!work){work=this.sendAndObserve(row,params);this.inFlight.set(row.id,work);}
    try{await work;}finally{if(this.inFlight.get(row.id)===work)this.inFlight.delete(row.id);}
    return this.observe(params.cardId,row.id,params);
  }
  async observe(cardId:string,requestId:string,actor:FolderActorParams) {
    const key=cardId+":"+requestId;
    const existing=this.observing.get(key);if(existing)return existing;
    const work=this.observeOnce(cardId,requestId,{actorKind:actor.actorKind,actorSessionId:actor.actorSessionId,actorUserId:actor.actorUserId});
    this.observing.set(key,work);
    try{return await work;}finally{if(this.observing.get(key)===work)this.observing.delete(key);}
  }
  private async observeOnce(cardId:string,requestId:string,actor:FolderActorParams) {
    let row=(await this.options.sql<CardExecutionRequest[]>`SELECT * FROM card_execution_requests WHERE id=${requestId} AND card_id=${cardId}`)[0];
    if(!row) throw failure("실행 요청을 찾을 수 없습니다.",404);
    if(row.state==='pending'){
      const automatic=row.mode==='observe'?await this.automaticOutcome(row):null;
      const proof=automatic?.proof??await this.registration(row);
      const owner=(await this.options.sql`SELECT card_id,status,execution_registration_id FROM sessions WHERE session_id=${row.session_id}`)[0];
      if(owner?.card_id===cardId && row.mode!=='observe') await this.options.cards.recordUserExecution({...actor,cardId,sessionId:row.session_id,requestId:row.id,
        idempotencyKey:`card-execution-link:${row.id}`,});
      if(row.mode==='observe' && !automatic?.proof){
        if(automatic?.error){await this.fail(row,automatic.error);throw failure(automatic.error,422);}
        return this.response(row);
      }
      if(proof){
        if(row.mode!=='observe')await this.options.cards.recordUserExecution({...actor,cardId,sessionId:row.session_id,requestId:row.id,execution:proof,idempotencyKey:`card-execution-success:${row.id}`});
        [row]=await this.options.sql<CardExecutionRequest[]>`UPDATE card_execution_requests SET state='succeeded',execution=${this.options.sql.json(proof)},result_state=COALESCE(result_state,'started'),updated_at=NOW() WHERE id=${row.id} RETURNING *`;
      }else if(automatic?.error){
        await this.fail(row,automatic.error);throw failure(automatic.error,422);
      }else if(owner && ['error','interrupted'].includes(String(owner.status)) && !owner.execution_registration_id && row.mode!=='observe'){
        await this.fail(row,"세션은 생성됐지만 실행 시작에 실패했습니다.");
        throw failure("실행 시작에 실패했습니다. 같은 담당 세션에서 다시 실행하세요.",422);
      }
    }
    if(row!.state==='failed') throw failure(row!.error ?? "실행 실패",422);
    return this.response(row!);
  }
  private async sendAndObserve(row:CardExecutionRequest,actor:FolderActorParams) {
    actor={actorKind:actor.actorKind,actorSessionId:actor.actorSessionId,actorUserId:actor.actorUserId};
    if(row.mode==='observe') return;
    const proof=await this.registration(row);
    if(proof) return;
    // An explicit POST can recover a send which never reached the node. Existing
    // create/initializing state remains observation-only; the node also serializes
    // fixed-ID creation, so an ACK loss cannot create a second session.
    if(row.mode==='create'){
      const owner=(await this.options.sql`SELECT session_id FROM sessions WHERE session_id=${row.session_id}`)[0];
      if(owner)return;
    }
    await this.options.sql`UPDATE card_execution_requests SET sent=TRUE WHERE id=${row.id}`;
    const input={requestId:row.id,sessionId:row.session_id,cardId:row.card_id,target:row.target};
    try{
      if(row.mode==='create') await this.options.launch(input);
      else {
        const result=await this.options.ensure(input);
        await this.options.sql`UPDATE card_execution_requests SET execution=${this.options.sql.json(result.execution)},result_state=${result.state} WHERE id=${row.id}`;
      }
    }catch(error){
      const evidence=await this.registration(row);
      if(evidence)return;
      const text=error instanceof Error?error.message:String(error);
      if(text.includes('Task already exists'))return;
      // Transport uncertainty remains observable under the same fixed identity.
      if(error instanceof PendingNodeCommandTimeoutError || (error instanceof PendingNodeCommandRejectedError && !error.response)
        || (error instanceof NodeCommandTransportError && error.code==='TRANSPORT_SEND_FAILED'))return;
      const owner=(await this.options.sql`SELECT card_id FROM sessions WHERE session_id=${row.session_id}`)[0];
      if(owner?.card_id===row.card_id) await this.options.cards.recordUserExecution({...actor,cardId:row.card_id,sessionId:row.session_id,requestId:row.id,idempotencyKey:`card-execution-link:${row.id}`});
      await this.fail(row,text);
      throw failure(`${text} 다시 실행하면 같은 담당 세션을 사용합니다.`,422);
    }
  }
  /** Observe accepted automatic work, independently of the card's later status. */
  private async automaticOutcome(row:CardExecutionRequest):Promise<{proof:CardWorkExecution|null;error?:string}>{
    const sql=this.options.sql;
    const dispatch=(await sql`SELECT state,reason,input,launch_deadline<=NOW() AS expired FROM card_orchestration_dispatches
      WHERE card_id=${row.card_id} AND session_id=${row.session_id} ORDER BY created_at DESC LIMIT 1`)[0];
    const work=(await sql`SELECT payload_json->'execution' AS proof FROM folder_operations
      WHERE target_id=${row.card_id} AND actor_session_id=${row.session_id} AND operation_type='start_card_work' ORDER BY created_at DESC LIMIT 1`)[0];
    const proof=work?.proof??(dispatch?.state==='running'?(dispatch.input as {execution?:CardWorkExecution})?.execution:null);
    if(proof)return {proof:proof as CardWorkExecution};
    if(dispatch?.state==='rejected'||dispatch?.expired)return {proof:null,error:String(dispatch.reason??'자동 배정이 거부되거나 만료되었습니다. 진행 중을 다시 선택하세요.')};
    const owner=(await sql`SELECT status FROM sessions WHERE session_id=${row.session_id}`)[0];
    if(owner&&['error','interrupted'].includes(String(owner.status)))return {proof:null,error:'자동 배정 실행 시작에 실패했습니다. 진행 중을 다시 선택하세요.'};
    return {proof:null};
  }
  private async registration(row:CardExecutionRequest):Promise<CardWorkExecution|null> {
    const saved=(await this.options.sql`SELECT execution FROM card_execution_requests WHERE id=${row.id}`)[0]?.execution;
    if(saved)return saved as CardWorkExecution;
    const receipt=(await this.options.sql<{proof:{registration_id:string;execution_command_id:string}|null}[]>`SELECT effect_application->'canonical_execution_registration' AS proof FROM event_ingress_receipts
      WHERE session_id=${row.session_id} AND event_id>${row.baseline_event_id} AND effect_application->>'applied'='true'
      AND effect_application->'canonical_execution_registration'->>'registration_id' IS NOT NULL ORDER BY event_id LIMIT 1`)[0]?.proof;
    if(receipt)return {registrationId:String(receipt.registration_id),executionCommandId:String(receipt.execution_command_id)};
    const owner=(await this.options.sql`SELECT execution_registration_id,execution_command_id,last_event_id FROM sessions WHERE session_id=${row.session_id}`)[0];
    return owner?.execution_registration_id && Number(owner.last_event_id)>row.baseline_event_id ? {registrationId:String(owner.execution_registration_id),executionCommandId:String(owner.execution_command_id)}:null;
  }
  private async fail(row:CardExecutionRequest,error:string){await this.options.sql`UPDATE card_execution_requests SET state='failed',error=${error},updated_at=NOW() WHERE id=${row.id}`;}
  private async response(row:CardExecutionRequest){return {card:(await this.options.cards.getCard(row.card_id))!.card,execution:{requestId:row.id,sessionId:row.session_id,state:row.state==='succeeded'?row.result_state??'started':'pending'}};}
}
function failure(message:string,statusCode:number){return Object.assign(new Error(message),{statusCode,code:'CARD_EXECUTION_ERROR'});}
async function activeAutomaticReservation(sql:RepositorySql,card:CardRow):Promise<string|null>{
  const policy=await sql`SELECT session_id FROM card_orchestration_dispatches WHERE card_id=${card.id} AND state IN ('admitted','launching') ORDER BY created_at DESC LIMIT 1`;
  if(policy[0])return String(policy[0].session_id);
  if(card.status==='running' && !card.assignee_session_id){
    const legacy=(await sql`SELECT payload_json->>'session_id' AS id FROM folder_operations WHERE target_id=${card.id} AND operation_type='dispatch_card' ORDER BY created_at DESC LIMIT 1`)[0];
    if(legacy?.id)return String(legacy.id);
  }
  return null;
}
