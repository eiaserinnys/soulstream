import { readAssignedCardContext } from "./assigned_card_context.js";
import { acceptQueuedWork, validateWorkExecution, invalidWork, type CardWorkExecution } from "./card_work_lifecycle.js";
import { randomUUID } from "node:crypto";
import { generateKeyBetween } from "@soulstream/fractional-position";
import { CardRepository } from "./control_plane/card_repository.js";
import { CardMutationCore } from "./control_plane/card_mutation_core.js";
import { CardVersionConflict, assigneeToFields, type CardAssigneeInput } from "./control_plane/card_models.js";
import type { CardRow, CardStatus, CardMutationResult, SqlClient, RepositorySql, FolderActorParams, FolderDbPort, FolderBroadcasterPort, FolderStatus } from "./control_plane/card_types.js";
import {assertPolicyAdmission} from "./card_orchestration_repository.js";
import { assertCardTransition } from "./card_status.js";

export type PolicyAdmission = {runId:string;leaseToken:string;workerInput:Record<string,unknown>};
export type CardMutationParams = FolderActorParams & { cardId: string; expectedVersion?: number; idempotencyKey?: string | null; reason?: string | null };
export type CardMutationChange = {result:CardMutationResult;previousStatus?:CardStatus;previousAssigneeSessionId?:string | null;committedCard?:CardRow};
export class CardControlPlaneService {
  private readonly repo: CardRepository;
  private readonly core: CardMutationCore;
  constructor(private readonly repoSql: SqlClient, db: FolderDbPort, private readonly broadcaster?: FolderBroadcasterPort,
    private readonly onMutation?: (change:CardMutationChange)=>void) {
    this.repo=new CardRepository(repoSql);
    this.core=new CardMutationCore(db,this.repo,broadcaster);
  }
  getAssignedCardContext(sessionId: string) { return readAssignedCardContext(this.repoSql,sessionId); }
  getFolder(folderId: string) { return this.repo.getSnapshot(folderId); }
  listFolders(params: Parameters<CardRepository["listFolders"]>[0]) { return this.repo.listFolders(params); }
  listOperations(folderId: string,limit?: number,offset?: number) { return this.repo.listOperations(folderId,limit,offset); }
  listCards(params: Parameters<CardRepository["listCards"]>[0]={}) { return this.repo.listCards(params); }
  projectCards(cards: readonly CardRow[]) { return this.repo.projectCards(cards); }
  async getCard(cardId: string) {
    const card=await this.repo.getCard(cardId);
    if (!card) return null;
    const [reports,questions,comments,sessions]=await Promise.all([this.repo.listReports(cardId),this.repo.listQuestions(cardId),this.repo.listComments(cardId),this.repo.listSessions(cardId)]);
    return { card:(await this.repo.projectCards([card]))[0]!,reports,questions,comments,sessions };
  }
  listReports(cardId: string) { return this.repo.listReports(cardId); }
  setFolderStatus(params: FolderActorParams & { folderId: string; expectedVersion: number; status: FolderStatus; reason?: string | null; idempotencyKey?: string | null }) {
    return this.core.setFolderStatus(params);
  }
  async createCard(params: FolderActorParams & {
    folderId: string; title: string; request: string; queue?: boolean; assignee?: CardAssigneeInput | null;
    nodeId?: string | null; modelPreset?: string | null; idempotencyKey?: string | null;
  }) {
    const id=randomUUID();
    const result=await this.core.mutate({ folderId:params.folderId,targetKind:"card",targetId:id,operationType:"create_card",actor:params,
      idempotencyKey:params.idempotencyKey,payload:{ title:params.title,request:params.request,queue:params.queue ?? false,assignee:params.assignee ?? null,nodeId:params.nodeId ?? null,modelPreset:params.modelPreset ?? null },
      apply:async (sql,eventId) => {
        await this.lockFolder(sql,params.folderId);
        const position=await this.position(sql,params.folderId,null);
        const queuePosition=params.queue ? await this.position(sql,null,null) : null;
        const a=assigneeToFields(params.assignee);
        await sql`INSERT INTO cards(id,folder_id,position_key,queue_position_key,title,request,status,
          assignee_kind,assignee_agent_id,assignee_session_id,assignee_user_id,node_id,model_preset,
          created_session_id,created_event_id,updated_session_id,updated_event_id)
          VALUES(${id},${params.folderId},${position},${queuePosition},${params.title},${params.request},${params.queue ? "queued" : "todo"},
          ${a.assignee_kind},${a.assignee_agent_id},${a.assignee_session_id},${a.assignee_user_id},${params.nodeId ?? null},${params.modelPreset ?? null},
          ${params.actorSessionId},${eventId},${params.actorSessionId},${eventId})`;
      } });
    if (!result.idempotent) this.onMutation?.({result});
    return result;
  }
  async patchCard(params: CardMutationParams & { title?: string; brief?: string; archived?: boolean; assignee?: CardAssigneeInput | null; nodeId?: string | null; modelPreset?: string | null }) {
    return this.mutateCard(params,"update_card",{ title:params.title,brief:params.brief,archived:params.archived,
      ...(Object.hasOwn(params,"assignee") ? assigneeToFields(params.assignee) : {}),node_id:params.nodeId,model_preset:params.modelPreset },
    async (sql,card,eventId,payload) => { await this.patch(sql,card,payload,params,eventId); });
  }
  async setCardStatus(params: CardMutationParams & { status: CardStatus; blockedKind?: CardRow["blocked_kind"]; blockedDetail?: string | null }) {
    return this.mutateCard(params,"set_card_status",{ status:params.status,blocked_kind:params.blockedKind ?? null,blocked_detail:params.blockedDetail ?? null },async (sql,card,eventId) => {
      const counts=await sql<{ count:number }[]>`SELECT count(*)::int AS count FROM card_reports WHERE card_id=${card.id}`;
      assertCardTransition(card.status,params.status,params.actorKind ?? "agent",counts[0]?.count ?? 0,params.blockedKind ?? null);
      if (card.status === "review" && params.status === "running" && params.actorKind === "user" && !params.reason?.trim()) throw invalid("Review rejection requires a reason");
      const open=await sql`SELECT id FROM card_questions WHERE card_id=${card.id} AND answer IS NULL LIMIT 1`;
      if (open.length && (params.status !== "blocked" || params.blockedKind !== "question")) throw invalid("Open questions keep a card blocked");
      await this.patch(sql,card,{ status:params.status,
        blocked_kind:params.status === "blocked" ? params.blockedKind : null,blocked_detail:params.status === "blocked" ? params.blockedDetail ?? null : null,
        queue_position_key:params.status === "queued" ? await this.position(sql,null,null,card.id) : params.blockedKind === "limit" ? card.queue_position_key : null,
        completed_kind:params.status === "done" ? "user" : null,completed_session_id:params.status === "done" ? params.actorSessionId : null,
        completed_event_id:params.status === "done" ? eventId : null,completed_user_id:params.status === "done" ? params.actorUserId ?? null : null,
        completed_at:params.status === "done" ? new Date() : null },params,eventId);
    });
  }
  async startCardWork(params: CardMutationParams & { execution: CardWorkExecution }) {
    if (params.actorKind !== "agent" || !params.actorSessionId) throw invalidWork("Only the assignee session may start work");
    return this.mutateCard(params,"start_card_work",{execution:params.execution},async(sql,card,eventId)=>{
      if (card.archived) throw invalidWork("Cannot start archived work");
      if (card.assignee_session_id !== params.actorSessionId && !(card.status === "queued" && card.assignee_kind === "agent"))
        throw invalidWork("Only the assignee session may start work");
      if (!["todo","review","queued"].includes(card.status)) throw invalidWork("Cannot start this state; running requires replay of the same declaration");
      if (card.status === "review" && !params.reason?.trim()) throw invalidWork("Review work requires a reason");
      if ((await sql`SELECT id FROM card_questions WHERE card_id=${card.id} AND answer IS NULL LIMIT 1`).length) throw invalidWork("Open questions keep work blocked");
      await validateWorkExecution(sql,params.actorSessionId!,params.execution);
      if (card.status === "queued") await acceptQueuedWork(sql,card,params.actorSessionId!,params.execution);
      await this.patch(sql,card,{status:"running",queue_position_key:null,blocked_kind:null,blocked_detail:null,
        ...(card.status === "queued" ? {assignee_kind:"session",assignee_session_id:params.actorSessionId,assignee_agent_id:null} : {})},params,eventId);
    });
  }
  async moveCard(params: CardMutationParams & { folderId:string; afterCardId?:string | null }) {
    const result=await this.mutateCard(params,"move_card",{ folder_id:params.folderId,after_card_id:params.afterCardId ?? null },async (sql,card,eventId) => {
      await this.lockFolder(sql,params.folderId);
      await this.patch(sql,card,{ folder_id:params.folderId,position_key:await this.position(sql,params.folderId,params.afterCardId ?? null,card.id) },params,eventId);
    });
    if (!result.idempotent && result.snapshot.folder.id !== params.folderId) await this.broadcaster?.emitCardUpdated?.(params.cardId,params.folderId);
    return { ...result,snapshot:(await this.repo.getSnapshot(params.folderId))! };
  }
  async reorderQueue(params: CardMutationParams & { afterCardId?:string | null }) {
    if (params.actorKind !== "user") throw invalid("Only a human may reorder the queue");
    return this.mutateCard(params,"reorder_card_queue",{ after_card_id:params.afterCardId ?? null },async (sql,card,eventId) => {
      if (card.status !== "queued") throw invalid("Card is not queued");
      await this.patch(sql,card,{ queue_position_key:await this.position(sql,null,params.afterCardId ?? null,card.id,params.afterCardId === undefined) },params,eventId);
    });
  }
  async addReport(params: CardMutationParams & { title:string; format:"markdown" | "html"; body:string }) {
    return this.mutateCard(params,"add_card_report",{ title:params.title,format:params.format,body:params.body },async (sql,card) => {
      await sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id)
        VALUES(${randomUUID()},${card.id},${params.title},${params.format},${params.body},${params.actorSessionId})`;
    });
  }
  async addComment(params: CardMutationParams & { body:string; kind?:"comment" | "spoken" }) {
    const kind=params.actorKind === "agent" ? "spoken" : params.kind ?? "comment";
    if (params.actorKind !== "agent" && kind !== "comment") throw invalid("Only trusted session actors may add spoken comments");
    const existing=params.idempotencyKey ? await this.repo.getOperationByIdempotencyKey(params.idempotencyKey) : null;
    const existingCommentId=existing?.operation_type === "add_card_comment" && existing.target_kind === "card" && existing.target_id === params.cardId
      && typeof existing.payload_json.comment_id === "string" ? existing.payload_json.comment_id : null;
    const commentId=existingCommentId ?? randomUUID();
    const result=await this.mutateCard(params,"add_card_comment",{ comment_id:commentId,body:params.body,kind },async (sql,card) => {
      await sql`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body)
        VALUES(${commentId},${card.id},'user',${params.actorUserId ?? null},${params.actorSessionId},${kind},${params.body})`;
    });
    const storedId=String(result.operation.payload_json.comment_id ?? commentId);
    const comment=await this.repo.getComment(params.cardId,storedId);
    if (!comment) throw new Error("Card comment was not stored");
    return comment;
  }
  markCommentDelivered(cardId:string,commentId:string) { return this.repo.markCommentDelivered(cardId,commentId); }
  async askQuestion(params: CardMutationParams & { text:string; options?:string[] | null }) {
    return this.mutateCard(params,"ask_card_question",{ text:params.text,options:params.options ?? null },async (sql,card,eventId) => {
      assertCardTransition(card.status,"blocked",params.actorKind ?? "agent",0,"question");
      await sql`INSERT INTO card_questions(id,card_id,session_id,text,options)
        VALUES(${randomUUID()},${card.id},${params.actorSessionId},${params.text},${sql.json(params.options ?? null)})`;
      await this.patch(sql,card,{ status:"blocked",blocked_kind:"question",blocked_detail:params.text,queue_position_key:null },params,eventId);
    });
  }
  async answerQuestion(params: CardMutationParams & { questionId:string; answer:string }) {
    if (params.actorKind !== "user") throw invalid("Only a human may answer card questions");
    return this.mutateCard(params,"answer_card_question",{ question_id:params.questionId,answer:params.answer },async (sql,card,eventId) => {
      const rows=await sql`UPDATE card_questions SET answer=${params.answer},answered_at=NOW(),answered_by=${params.actorUserId ?? null}
        WHERE id=${params.questionId} AND card_id=${card.id} AND answer IS NULL RETURNING id`;
      if (!rows.length) throw invalid("Open question not found in card");
      const open=await sql`SELECT id FROM card_questions WHERE card_id=${card.id} AND answer IS NULL LIMIT 1`;
      if (!open.length) await this.patch(sql,card,{ status:"running",blocked_kind:null,blocked_detail:null },params,eventId);
    });
  }
  recordDispatch(params:{cardId:string;expectedVersion:number;sessionId:string;nodeId:string;admission?:PolicyAdmission}) {
    const actor={actorKind:"system" as const,actorSessionId:null,...params};
    return this.mutateCard(actor,"dispatch_card",{session_id:params.sessionId,node_id:params.nodeId},async(sql,card,eventId)=>{
      if (card.status !== "queued") throw invalid("Only queued cards may dispatch");
      await this.checkAdmission(sql,params);
      await this.patch(sql,card,{status:params.admission ? "queued" : "running",blocked_kind:null,blocked_detail:null,
        ...(!params.admission ? {queue_position_key:null} : {})},actor,eventId);
    });
  }
  resumeDispatchedCard(params:{cardId:string;expectedVersion:number;sessionId:string;nodeId?:string;admission?:PolicyAdmission}) {
    const actor={actorKind:"system" as const,actorSessionId:null,...params};
    return this.mutateCard(actor,"resume_card",{session_id:params.sessionId},async(sql,card,eventId)=>{
      if (card.status !== "blocked" || card.blocked_kind !== "limit") throw invalid("Only limit-blocked cards may resume");
      await this.checkAdmission(sql,{...params,nodeId:params.nodeId??card.node_id??"eiaserinnys"});
      await this.patch(sql,card,{status:params.admission ? "queued" : "running",blocked_kind:null,blocked_detail:null,
        ...(!params.admission ? {queue_position_key:null} : {})},actor,eventId);
    });
  }
  private async checkAdmission(sql:RepositorySql,params:{cardId:string;expectedVersion:number;sessionId:string;nodeId:string;admission?:PolicyAdmission}) {
    const enabled=(await sql<{enabled:boolean}[]>`SELECT (value->>'enabled')::boolean AS enabled FROM system_settings WHERE setting_key='card_orchestration'`)[0]?.enabled===true;
    if(!enabled){if(params.admission)throw invalid("Orchestration policy is disabled");return;}
    if(!params.admission)throw invalid("Enabled orchestration requires a fenced decision admission");
    await assertPolicyAdmission(sql,{...params,cardVersion:params.expectedVersion,...params.admission});
  }
  noteMissingAssignee(params:{cardId:string;expectedVersion:number}) {
    const actor={actorKind:"system" as const,actorSessionId:null,...params};
    return this.mutateCard(actor,"note_card_assignee",{blocked_detail:"담당 에이전트 없음"},async(sql,card,eventId,payload)=>{
      await this.patch(sql,card,payload,actor,eventId);
    });
  }
  private async mutateCard(params:CardMutationParams,operationType:string,payload:Record<string,unknown>,apply:(sql:RepositorySql,card:CardRow,eventId:number | null,payload:Record<string,unknown>)=>Promise<void>) {
    const card=await this.repo.getCard(params.cardId);
    if (!card) throw Object.assign(new Error("Card not found"),{ statusCode:404 });
    const clean=Object.fromEntries(Object.entries(payload).filter(([,v])=>v !== undefined));
    let previousStatus:CardStatus | undefined,previousAssigneeSessionId:string | null | undefined,committedCard:CardRow | undefined;
    const result=await this.core.mutate({ folderId:card.folder_id,targetKind:"card",targetId:card.id,operationType,actor:params,
      idempotencyKey:params.idempotencyKey,reason:params.reason,payload:clean,
      apply:async (sql,eventId) => {
        const locked=(await sql<CardRow[]>`SELECT * FROM cards WHERE id=${card.id} FOR UPDATE`)[0];
        if (!locked) throw Object.assign(new Error("Card not found"),{ statusCode:404 });
        if (params.expectedVersion !== undefined && locked.version !== params.expectedVersion) throw new CardVersionConflict("card",card.id,params.expectedVersion,locked.version);
        previousStatus=locked.status;
        previousAssigneeSessionId=locked.assignee_session_id;
        await apply(sql,locked,eventId,clean);
        committedCard=(await sql<CardRow[]>`SELECT * FROM cards WHERE id=${card.id}`)[0];
      } });
    if (!result.idempotent) this.onMutation?.({result,previousStatus,previousAssigneeSessionId,committedCard});
    return result;
  }
  private async patch(sql:RepositorySql,card:CardRow,fields:Record<string,unknown>,actor:FolderActorParams,eventId:number | null) {
    await sql`UPDATE cards SET ${sql(fields)},version=version+1,updated_at=NOW(),updated_session_id=${actor.actorSessionId},updated_event_id=${eventId} WHERE id=${card.id}`;
  }
  private async lockFolder(sql:RepositorySql,folderId:string) {
    const rows=await sql`SELECT id FROM folders WHERE id=${folderId} FOR UPDATE`;
    if (!rows.length) throw Object.assign(new Error("Folder not found"),{ statusCode:404 });
  }
  private async position(sql:RepositorySql,folderId:string | null,afterId:string | null,excludeId:string | null=null,append=true) {
    if (folderId === null) await sql`SELECT pg_advisory_xact_lock(hashtext('card_queue'))`;
    const rows=await sql<{ id:string; key:string }[]>`SELECT id,CASE WHEN ${folderId}::text IS NULL THEN queue_position_key ELSE position_key END AS key FROM cards
      WHERE (${folderId}::text IS NULL AND status='queued' AND archived=FALSE OR folder_id=${folderId}) AND id IS DISTINCT FROM ${excludeId}
      ORDER BY (CASE WHEN ${folderId}::text IS NULL THEN queue_position_key ELSE position_key END) COLLATE "C",id`;
    if (afterId) {
      const index=rows.findIndex(r=>r.id === afterId);
      if (index<0) throw invalid("Position anchor not found in target list");
      return generateKeyBetween(rows[index]!.key,rows[index+1]?.key ?? null);
    }
    return append ? generateKeyBetween(rows.at(-1)?.key ?? null,null) : generateKeyBetween(null,rows[0]?.key ?? null);
  }
}
function invalid(message:string) { return Object.assign(new Error(message),{ statusCode:422,code:"INVALID_CARD_REQUEST" }); }
