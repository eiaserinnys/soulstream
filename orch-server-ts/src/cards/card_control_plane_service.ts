import { assertNoPendingCardExecution } from "./card_execution_reservation.js";
import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type { CardColor } from "@soulstream/wire-schema/card-colors";
import { applyCardMoveTx } from "./control_plane/card_move.js";
import { readAssignedCardContext } from "./assigned_card_context.js";
import { readSupervisedCardContext } from "./supervised_card_context.js";
import type { SupervisedCardSnapshot } from "./supervised_card_context.js";
import { acceptQueuedWork, validateWorkExecution, invalidWork, type CardWorkExecution } from "./card_work_lifecycle.js";
import { randomUUID } from "node:crypto";
import { generateKeyBetween } from "@soulstream/fractional-position";
import { CardRepository } from "./control_plane/card_repository.js";
import { CardMutationCore } from "./control_plane/card_mutation_core.js";
import { CardVersionConflict, assigneeToFields, type CardAssigneeInput } from "./control_plane/card_models.js";
import type { CardRow, CardStatus, CardMutationResult, SqlClient, RepositorySql, FolderActorParams, FolderDbPort, FolderBroadcasterPort, FolderStatus } from "./control_plane/card_types.js";
import {assertPolicyAdmission} from "./card_orchestration_repository.js";
import { claimableCardSessions, assertSingleCardAssignee, translateAssigneeConflict, invalidCard } from "./card_assignee.js";

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
  getSupervisedCardContext(params: { sessionId: string; folderIds: string[] | null; cardLimit: number; questionLimit: number }): Promise<SupervisedCardSnapshot> {
    return readSupervisedCardContext(this.repoSql, params);
  }
  getFolder(folderId: string, includeCompleted = true) { return this.repo.getSnapshot(folderId, includeCompleted); }
  listFolders(params: Parameters<CardRepository["listFolders"]>[0]) { return this.repo.listFolders(params); }
  listOperations(folderId: string,limit?: number,offset?: number) { return this.repo.listOperations(folderId,limit,offset); }
  listCards(params: Parameters<CardRepository["listCards"]>[0]={}) { return this.repo.listCards(params); }
  listCompletedCards(params: Parameters<CardRepository["listCompletedCards"]>[0]) { return this.repo.listCompletedCards(params); }
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
    folderId: string; title: string; request: string; attachments?: CardAttachment[]; queue?: boolean; assignee?: CardAssigneeInput | null;
    nodeId?: string | null; modelPreset?: string | null; idempotencyKey?: string | null; brief?: string;
  }) {
    if (params.actorKind === "agent" && params.actorSessionId && !Object.hasOwn(params,"assignee")) {
      const creator=(await this.repoSql<{agent_id:string;node_id:string;model_preset:string | null}[]>`SELECT agent_id,node_id,model_preset FROM sessions WHERE session_id=${params.actorSessionId}`)[0];
      if (!creator?.agent_id) throw invalidCard("Creating session must have an agent_id");
      params={...params,assignee:{kind:"agent",agentId:creator.agent_id},nodeId:params.nodeId ?? creator.node_id,modelPreset:params.modelPreset ?? creator.model_preset};
    }
    const id=randomUUID();
    const a=assigneeToFields(params.assignee);
    const result=await this.core.mutate({ folderId:params.folderId,targetKind:"card",targetId:id,operationType:"create_card",actor:params,
      idempotencyKey:params.idempotencyKey,payload:{ title:params.title,request:params.request,brief:params.brief ?? "",attachments:params.attachments ?? [],queue:params.queue ?? false,assignee:params.assignee ?? null,nodeId:params.nodeId ?? null,modelPreset:params.modelPreset ?? null },
      apply:async (sql,eventId) => {
        await this.lockFolder(sql,params.folderId);
        const position=await this.position(sql,params.folderId,null);
        const queuePosition=params.queue ? await this.position(sql,null,null) : null;
        if (a.assignee_session_id) await assertSingleCardAssignee(sql,a.assignee_session_id,id);
        await sql`INSERT INTO cards(id,folder_id,position_key,queue_position_key,title,request,brief,attachments,status,
          assignee_kind,assignee_agent_id,assignee_session_id,assignee_user_id,node_id,model_preset,
          created_session_id,created_event_id,updated_session_id,updated_event_id)
          VALUES(${id},${params.folderId},${position},${queuePosition},${params.title},${params.request},${params.brief ?? ""},${sql.json(params.attachments ?? [])},${params.queue ? "queued" : "todo"},
          ${a.assignee_kind},${a.assignee_agent_id},${a.assignee_session_id},${a.assignee_user_id},${params.nodeId ?? null},${params.modelPreset ?? null},
          ${params.actorSessionId},${eventId},${params.actorSessionId},${eventId})`;
      } }).catch(error=>translateAssigneeConflict(this.repoSql,error,a.assignee_session_id));
    if (!result.idempotent) this.onMutation?.({result});
    return result;
  }
  async patchCard(params: CardMutationParams & { title?: string; brief?: string; archived?: boolean; assignee?: CardAssigneeInput | null; nodeId?: string | null; modelPreset?: string | null; color?: CardColor }) {
    return this.mutateCard(params,"update_card",{ title:params.title,brief:params.brief,archived:params.archived,
      ...(Object.hasOwn(params,"assignee") ? assigneeToFields(params.assignee) : {}),node_id:params.nodeId,model_preset:params.modelPreset,color:params.color },
    async (sql,card,eventId,payload) => { await this.patch(sql,card,payload,params,eventId); });
  }
  async saveExecutionSettings(params:CardMutationParams & {folderId:string;nodeId:string|null;agentId:string|null;modelPreset:string|null}) {
    const result=await this.mutateCard(params,"card_execution_settings",{folder_id:params.folderId,node_id:params.nodeId,agent_id:params.agentId,model_preset:params.modelPreset},async(sql,card,eventId)=>{
      await assertNoPendingCardExecution(sql,card.id);
      if(card.assignee_session_id) throw Object.assign(new Error("담당 세션이 연결된 카드의 설정은 변경할 수 없습니다."),{statusCode:409});
      if(card.folder_id!==params.folderId) await applyCardMoveTx(sql,card,params.folderId,null,params,eventId);
      await this.patch(sql,card,{node_id:params.nodeId,model_preset:params.modelPreset,...assigneeToFields(params.agentId?{kind:"agent",agentId:params.agentId}:null)},params,eventId);
    });
    if(result.snapshot.folder.id!==params.folderId) await this.broadcaster?.emitCardUpdated?.(params.cardId,params.folderId);
    return {...result,snapshot:(await this.repo.getSnapshot(params.folderId))!};
  }
  /** Records the requesting side's execution evidence; it is not an assignee session's declaration. */
  async recordExecution(params:CardMutationParams & {requestId:string;sessionId:string;execution?:CardWorkExecution}) {
    return this.mutateCard(params,"execute_card",{request_id:params.requestId,session_id:params.sessionId,execution:params.execution},async(sql,card,eventId)=>{
      const session=(await sql`SELECT card_id FROM sessions WHERE session_id=${params.sessionId} FOR SHARE`)[0];
      if(session?.card_id!==card.id || card.assignee_session_id && card.assignee_session_id!==params.sessionId)
        throw invalid("실행 세션과 카드 담당이 일치하지 않습니다.");
      const stateChanged=(await sql`SELECT c.status_changed_at>r.updated_at AS changed FROM cards c
        JOIN card_execution_requests r ON r.card_id=c.id WHERE c.id=${card.id} AND r.id=${params.requestId} AND r.session_id=${params.sessionId}`)[0]?.changed===true;
      // Confirming startup is independent of a later formal review/completion.
      await this.patch(sql,card,{assignee_kind:"session",assignee_session_id:params.sessionId,assignee_agent_id:null,
        ...(params.execution&&!stateChanged?{status:"running",queue_position_key:null,blocked_kind:null,blocked_detail:null,
          completed_kind:null,completed_session_id:null,completed_event_id:null,completed_user_id:null,completed_at:null}: {})},params,eventId);
    });
  }
  async setCardStatus(params: CardMutationParams & { status: CardStatus; blockedKind?: CardRow["blocked_kind"]; blockedDetail?: string | null }) {
    return this.mutateCard(params,"set_card_status",{ status:params.status,blocked_kind:params.blockedKind ?? null,blocked_detail:params.blockedDetail ?? null },async (sql,card,eventId,payload) => {
      const claim=params.actorKind === "agent" ? await this.claim(sql,card,params.actorSessionId,payload) : {};
      if (params.actorKind === "agent" && (!params.actorSessionId || card.assignee_session_id !== params.actorSessionId))
        throw Object.assign(new Error("Only the current assignee session may change card status. An authenticated internal agent session with card mutation access may use transfer_card_assignee to assign the card; handoff changes assignment only and does not start or stop work."), {statusCode:403});
      await this.patch(sql,card,{ ...claim,status:params.status,
        blocked_kind:params.status === "blocked" ? params.blockedKind ?? null : null,blocked_detail:params.status === "blocked" ? params.blockedDetail ?? null : null,
        queue_position_key:params.status === "queued" ? await this.position(sql,null,null,card.id) : params.status === "blocked" && params.blockedKind === "limit" ? card.queue_position_key : null,
        completed_kind:params.status === "done" ? params.actorKind === "system" ? null : params.actorKind ?? "agent" : null,completed_session_id:params.status === "done" ? params.actorSessionId : null,
        completed_event_id:params.status === "done" ? eventId : null,completed_user_id:params.status === "done" ? params.actorUserId ?? null : null,
        completed_at:params.status === "done" ? new Date() : null },params,eventId);
    });
  }
  async startCardWork(params: CardMutationParams & { execution: CardWorkExecution }) {
    if (params.actorKind !== "agent" || !params.actorSessionId) throw invalidWork("Only the current assignee session may start work. An authenticated internal agent session with card mutation access may use transfer_card_assignee to assign the card; handoff changes assignment only and does not start or stop work.");
    return this.mutateCard(params,"start_card_work",{execution:params.execution},async(sql,card,eventId,payload)=>{
      await validateWorkExecution(sql,params.actorSessionId!,params.execution);
      const dispatch = await acceptQueuedWork(sql,card,params.actorSessionId!,params.execution);
      const claim=dispatch ? {} : await this.claim(sql,card,params.actorSessionId,payload);
      if (card.assignee_session_id !== params.actorSessionId && !dispatch)
        throw invalidWork("Only the current assignee session may start work. An authenticated internal agent session with card mutation access may use transfer_card_assignee to assign the card; handoff changes assignment only and does not start or stop work.");
      await this.patch(sql,card,{...claim,status:"running",queue_position_key:null,blocked_kind:null,blocked_detail:null,
        completed_kind:null,completed_session_id:null,completed_event_id:null,completed_user_id:null,completed_at:null,
        ...(dispatch ? {assignee_kind:"session",assignee_session_id:params.actorSessionId,assignee_agent_id:null} : {})},params,eventId);
    });
  }
  async moveCard(params: CardMutationParams & { folderId:string; afterCardId?:string | null }) {
    const result=await this.mutateCard(params,"move_card",{ folder_id:params.folderId,after_card_id:params.afterCardId ?? null },async (sql,card,eventId) => {
      await applyCardMoveTx(sql,card,params.folderId,params.afterCardId ?? null,params,eventId);
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
  async addComment(params: CardMutationParams & { body:string; kind?:"comment" | "spoken"; mode?:"spoken" | "reply" }) {
    const external=params.actorKind === "llm";
    const reply=params.mode === "reply";
    if (params.mode && (params.actorKind !== "agent" || !params.actorSessionId)) throw invalid("Only trusted session actors may select a comment mode");
    const kind=external ? "comment" : params.actorKind === "agent" ? reply ? "comment" : "spoken" : params.kind ?? "comment";
    if (params.actorKind !== "agent" && kind !== "comment") throw invalid("Only trusted session actors may add spoken comments");
    const existing=params.idempotencyKey ? await this.repo.getOperationByIdempotencyKey(params.idempotencyKey) : null;
    const existingCommentId=existing?.operation_type === "add_card_comment" && existing.target_kind === "card" && existing.target_id === params.cardId
      && typeof existing.payload_json.comment_id === "string" ? existing.payload_json.comment_id : null;
    const commentId=existingCommentId ?? randomUUID();
    const result=await this.mutateCard(params,"add_card_comment",{ comment_id:commentId,body:params.body,kind,
      ...(reply ? {author_kind:"agent",session_id:params.actorSessionId} : {}) },async (sql,card,eventId,payload) => {
      const claim=reply ? await this.claim(sql,card,params.actorSessionId,payload) : {};
      if (reply && (card.assignee_kind !== "session" || card.assignee_session_id !== params.actorSessionId))
        throw invalid("Only the current assignee session may reply to a card comment. An authenticated internal agent session with card mutation access may use transfer_card_assignee to assign the card; handoff changes assignment only and does not start or stop work.");
      if (Object.keys(claim).length) await this.patch(sql,card,claim,params,eventId);
      await sql`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body)
        VALUES(${commentId},${card.id},${reply ? "agent" : "user"},${external || reply ? null : params.actorUserId ?? null},${external ? null : params.actorSessionId},${kind},${params.body})`;
    });
    const storedId=String(result.operation.payload_json.comment_id ?? commentId);
    const comment=await this.repo.getComment(params.cardId,storedId);
    if (!comment) throw new Error("Card comment was not stored");
    return comment;
  }
  markCommentDelivered(cardId:string,commentId:string) { return this.repo.markCommentDelivered(cardId,commentId); }
  async askQuestion(params: CardMutationParams & { text:string; options?:string[] | null }) {
    return this.mutateCard(params,"ask_card_question",{ text:params.text,options:params.options ?? null },async (sql,card,eventId) => {
      await sql`INSERT INTO card_questions(id,card_id,session_id,text,options)
        VALUES(${randomUUID()},${card.id},${params.actorSessionId},${params.text},${sql.json(params.options ?? null)})`;
      await this.patch(sql,card,{ status:"blocked",blocked_kind:"question",blocked_detail:params.text,queue_position_key:null,
        completed_kind:null,completed_session_id:null,completed_event_id:null,completed_user_id:null,completed_at:null },params,eventId);
    });
  }
  async answerQuestion(params: CardMutationParams & { questionId:string; answer:string }) {
    if (params.actorKind !== "user") throw invalid("Only a human may answer card questions");
    return this.mutateCard(params,"answer_card_question",{ question_id:params.questionId,answer:params.answer },async (sql,card,eventId) => {
      const rows=await sql`UPDATE card_questions SET answer=${params.answer},answered_at=NOW(),answered_by=${params.actorUserId ?? null}
        WHERE id=${params.questionId} AND card_id=${card.id} AND answer IS NULL RETURNING id`;
      if (!rows.length) throw invalid("Open question not found in card");
      const open=await sql`SELECT id FROM card_questions WHERE card_id=${card.id} AND answer IS NULL LIMIT 1`;
      if (!open.length && card.status === "blocked" && card.blocked_kind === "question")
        await this.patch(sql,card,{ status:"running",blocked_kind:null,blocked_detail:null },params,eventId);
    });
  }
  recordDispatch(params:{cardId:string;expectedVersion:number;sessionId:string;nodeId:string;admission?:PolicyAdmission}) {
    const actor={actorKind:"system" as const,actorSessionId:null,...params};
    return this.mutateCard(actor,"dispatch_card",{session_id:params.sessionId,node_id:params.nodeId},async(sql,card,eventId)=>{
      if (card.status !== "queued") throw invalid("Only queued cards may dispatch");
      await assertNoPendingCardExecution(sql,card.id);
      await this.checkAdmission(sql,params);
      await this.patch(sql,card,{status:params.admission ? "queued" : "running",blocked_kind:null,blocked_detail:null,
        ...(!params.admission ? {queue_position_key:null} : {})},actor,eventId);
    });
  }
  resumeDispatchedCard(params:{cardId:string;expectedVersion:number;sessionId:string;nodeId?:string;admission?:PolicyAdmission}) {
    const actor={actorKind:"system" as const,actorSessionId:null,...params};
    return this.mutateCard(actor,"resume_card",{session_id:params.sessionId},async(sql,card,eventId)=>{
      if (card.status !== "blocked" || card.blocked_kind !== "limit") throw invalid("Only limit-blocked cards may resume");
      await assertNoPendingCardExecution(sql,card.id);
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
      } }).catch(error=>translateAssigneeConflict(this.repoSql,error,
        typeof clean.assignee_session_id === "string" ? clean.assignee_session_id : params.actorSessionId ?? card.assignee_session_id));
    if (!result.idempotent) this.onMutation?.({result,previousStatus,previousAssigneeSessionId,committedCard});
    return result;
  }
  private async patch(sql:RepositorySql,card:CardRow,fields:Record<string,unknown>,actor:FolderActorParams,eventId:number | null) {
    const sessionId=Object.hasOwn(fields,"assignee_session_id") ? fields.assignee_session_id : card.assignee_session_id;
    if (typeof sessionId === "string" && (Object.hasOwn(fields,"assignee_session_id") || fields.archived === false)
      && !(fields.archived ?? card.archived))
      await assertSingleCardAssignee(sql,sessionId,card.id);
    await sql`UPDATE cards SET ${sql(fields)},
      status_changed_at=CASE WHEN ${fields.status !== undefined && fields.status !== card.status} THEN NOW() ELSE status_changed_at END,
      version=version+1,updated_at=NOW(),updated_session_id=${actor.actorSessionId},updated_event_id=${eventId} WHERE id=${card.id}`;
  }
  private async claim(sql:RepositorySql,card:CardRow,sessionId:string | null,payload:Record<string,unknown>) {
    if (!sessionId || !(await claimableCardSessions(sql,card.id,sessionId)).length) return {};
    const fields={assignee_kind:"session",assignee_session_id:sessionId,assignee_agent_id:null};
    Object.assign(card,fields);
    payload.claimed_assignee=true;
    return fields;
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
