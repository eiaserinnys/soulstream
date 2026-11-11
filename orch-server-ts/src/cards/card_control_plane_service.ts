import { isUsageLimitTermination } from "../session/session_limit_termination.js";
import { decideCardTransition } from './state/card_decision.js';
import { decodeCardDecision } from './state/card_decision_decoder.js';
import { formatCardDecisionRejection } from './state/card_decision_errors.js';
import { humanCardEvidence } from './state/card_human_evidence.js';
import { assertCardCommandEntrance } from './state/card_command_entrance.js';
import type { HumanCardCommand } from './state/card_human_command.js';
import type { DecodedCardWrite } from './state/card_decision_decoder.js';
import { patchCardTx } from "./control_plane/card_patch.js";
import { readLimitAutoResumeAt, formatLimitResumeClock, type LimitResumeOwner } from "./card_limit_auto_resume.js";
import { assertNoPendingCardExecution } from "./card_execution_reservation.js";
// 500줄 예외: 카드 aggregate의 기존 트랜잭션 facade. 보고 저장 로직은 별도 service에 둔다.
import { PersistentReportService, type PublishPersistentReports } from "../session/persistent_report_service.js";
import type { AppendReportTimeline } from "../session/report_timeline_publisher.js";
import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import type { CardColor } from "@soulstream/wire-schema/card-colors";
import type { AttachmentRef } from "@soulstream/wire-schema/attachments";
import { attachmentRefIds, attachmentRefsOf, collectCardAttachmentRefs, collectCardItemAttachmentRefs, validateCardSourceRefsTx } from "./card_attachment_refs.js";
import { requireCardAttachmentTx } from "./card_attachment_policy.js";
import { normalizedMimeType, previewInfo } from "../attachments/attachment_read_http.js";
import { mergeCardSourceAttachmentRefs, resolveCardLegacySourceRefsTx } from "./card_attachment_legacy_refs.js";
import { applyCardMoveTx } from "./control_plane/card_move.js";
import { readAssignedCardContext } from "./assigned_card_context.js";
import { readSupervisedCardContext } from "./supervised_card_context.js";
import { parseCardReference, cardQuestionOptionsSchema, type CardReferenceLookupResult } from "@soulstream/mcp-contract";
import { findCardSessionByOrdinal, findCardsByNumber, readCardChildOrdinals, readSessionReferences } from "./card_reference_repository.js";
import type { SupervisedCardSnapshot } from "./supervised_card_context.js";
import { acceptQueuedWork, validateWorkExecution, invalidWork, type CardWorkExecution } from "./card_work_lifecycle.js";
import { CardMcpReadService } from "./card_mcp_read.js";
import { readCardSessionMessages, type CardSessionMessagesQuery } from "./card_session_messages.js";
import { randomUUID } from "node:crypto";
import { generateKeyBetween } from "@soulstream/fractional-position";
import { CardRepository } from "./control_plane/card_repository.js";
import { CardMaintenanceService, type BulkSetCardStatusInput, type CardMaintenanceChange, type MergeCardsInput, type MergeCardsResult, type UpdateUnstartedFields, type UpdateUnstartedResult, type AuthorizeFolder } from "./card_maintenance_service.js";
import { assertBulkStatusGuardTx } from "./card_maintenance_tx.js";
import { isCardOffBoard } from "./control_plane/card_types.js";
import { CardMutationCore, type FolderMutateParams } from "./control_plane/card_mutation_core.js";
import { CardVersionConflict, assigneeToFields, type CardAssigneeInput } from "./control_plane/card_models.js";
import type { CardRow, CardStatus, CardMutationResult, FolderOperationRow, SqlClient, RepositorySql, FolderActorParams, FolderDbPort, FolderBroadcasterPort, FolderStatus } from "./control_plane/card_types.js";
import {
  addCardItem as addItemRule,
  codePointLength,
  confirmCardItem as confirmItemRule,
  makeCardNow,
  openCardItemFix,
  questionCardNow,
  reportCardItem as reportItemRule,
  reviewCardNow,
  setCardItems as setItemsRule,
  type CardItemEvidence,
  type CardItemState,
  type CardNowTurn,
  type ReportCardItemInput,
} from "./card_item_rules.js";
import { hasUserInputAfterLastReplyTx, readCardItemSourceTx } from "./control_plane/card_item_store.js";
import { parseVerificationWakeAt, validateVerificationWait, verificationWaitNow } from "./card_verification_wait.js";
import {assertPolicyAdmission} from "./card_orchestration_repository.js";
import { claimableCardSessions, assertSingleCardAssignee, translateAssigneeConflict, invalidCard } from "./card_assignee.js";

export type PolicyAdmission = {runId:string;leaseToken:string;workerInput:Record<string,unknown>};
export type CardMutationParams = FolderActorParams & { cardId: string; expectedVersion?: number; idempotencyKey?: string | null; reason?: string | null };
export type CardMutationChange = {result:CardMutationResult;previousStatus?:CardStatus;previousAssigneeSessionId?:string | null;committedCard?:CardRow};
type CreateCardParams = FolderActorParams & {
  folderId: string; title: string; request: string; attachments?: CardAttachment[]; queue?: boolean; assignee?: CardAssigneeInput | null;
  nodeId?: string | null; modelPreset?: string | null; idempotencyKey?: string | null; brief?: string;
};
type AddCommentParams = CardMutationParams & { body:string; kind?:"comment" | "spoken"; mode?:"spoken" | "reply"; itemId?:number };
type CardCommentRow = NonNullable<Awaited<ReturnType<CardRepository["getComment"]>>>;
export type CardReportSyncParams = {
  previousStatus: CardStatus | undefined;
  committedCard: CardRow | undefined;
  questionChanged: boolean;
  cardChanged?: boolean;
  previousCard?: Pick<CardRow,"now"|"title"|"archived"|"number">;
};
const shortTitle = (title: string) => [...title].slice(0, 60).join("");
export class CardControlPlaneService {
  private readonly repo: CardRepository;
  private readonly core: CardMutationCore;
  private readonly reports?: PersistentReportService;
  private readonly maintenance: CardMaintenanceService;
  readonly mcpRead: CardMcpReadService;
  constructor(private readonly repoSql: SqlClient, db: FolderDbPort, private readonly broadcaster?: FolderBroadcasterPort,
    private readonly onMutation?: (change:CardMutationChange)=>void,
    onReportsChanged?: PublishPersistentReports,
    private readonly warn: (message: string) => void = console.warn,
    corsAllowedOrigins: readonly string[] = [],
    private readonly onQuestionAsked?: (input:{cardId:string;questionId:string})=>void | Promise<void>,
    appendTimeline?: AppendReportTimeline) {
    this.repo=new CardRepository(repoSql, corsAllowedOrigins);
    this.core=new CardMutationCore(db,this.repo,broadcaster);
    this.reports=onReportsChanged ? new PersistentReportService(repoSql,onReportsChanged,undefined,appendTimeline) : undefined;
    this.mcpRead=new CardMcpReadService(repoSql, corsAllowedOrigins);
    this.maintenance=new CardMaintenanceService({
      sql:repoSql,repo:this.repo,core:this.core,
      patchTx:(sql,card,fields,actor,eventId)=>this.patch(sql,card,fields,actor,eventId),
      statusTx:(sql,card,eventId,params,payload)=>this.applyStatusTx(sql,card,eventId,params,payload,"bulk_idle"),
      afterCommit:changes=>this.afterCommitMaintenance(changes),
    });
  }
  getAssignedCardContext(sessionId: string) { return readAssignedCardContext(this.repoSql,sessionId); }
  getSupervisedCardContext(params: { sessionId: string; folderIds: string[] | null; cardLimit: number; questionLimit: number }): Promise<SupervisedCardSnapshot> {
    return readSupervisedCardContext(this.repoSql, params);
  }
  getCardChildOrdinals(cardId: string) { return readCardChildOrdinals(this.repoSql, cardId); }
  getSessionReferences(sessionIds: string[]) { return readSessionReferences(this.repoSql, sessionIds); }
  /** Resolves `#412` and `#412.s2` to full IDs. A card the caller may not see answers like a number nobody was given. */
  async resolveReferences(refs: string[], allowFolder: (folderId: string) => boolean = () => true): Promise<CardReferenceLookupResult[]> {
    const parsed = refs.map(ref => ({ ref, reference: parseCardReference(ref) }));
    const numbers = new Set(parsed.flatMap(({ reference }) => reference ? [reference.cardNumber] : []));
    const cards = new Map((await findCardsByNumber(this.repoSql, [...numbers])).map(card => [card.number, card]));
    return Promise.all(parsed.map(async ({ ref, reference }): Promise<CardReferenceLookupResult> => {
      if (!reference || (reference.kind !== "card" && reference.kind !== "session"))
        return { ref, error: `카드 번호(#412)와 카드에 붙은 세션 번호(#412.s2)만 풀 수 있습니다: ${ref}` };
      const card = cards.get(reference.cardNumber);
      if (!card || !allowFolder(card.folder_id)) return { ref, error: `#${reference.cardNumber} 번호의 카드가 없습니다.` };
      if (reference.kind === "card") return { ref, kind: "card", id: card.id, title: shortTitle(card.title) };
      const { session, total } = await findCardSessionByOrdinal(this.repoSql, card.id, reference.ordinal!);
      return session
        ? { ref, kind: "session", id: session.session_id, title: session.display_name ? shortTitle(session.display_name) : "이름 없음" }
        : { ref, error: `카드 #${card.number}에 붙은 세션은 ${total}개입니다. ${ref}는 없습니다.` };
    }));
  }
  getFolder(folderId: string, includeCompleted = true) { return this.repo.getSnapshot(folderId, includeCompleted); }
  listFolders(params: Parameters<CardRepository["listFolders"]>[0]) { return this.repo.listFolders(params); }
  listOperations(folderId: string,limit?: number,offset?: number) { return this.repo.listOperations(folderId,limit,offset); }
  listCards(params: Parameters<CardRepository["listCards"]>[0]={}) { return this.repo.listCards(params); }
  listCompletedCards(params: Parameters<CardRepository["listCompletedCards"]>[0]) { return this.repo.listCompletedCards(params); }
  listPagedCards(params: Parameters<CardRepository["listPagedCards"]>[0]) { return this.repo.listPagedCards(params); }
  projectCards(cards: readonly CardRow[]) { return this.repo.projectCards(cards); }
  async getCard(cardId: string) {
    const card=await this.repo.getCard(cardId);
    if (!card) return null;
    const [reports,questions,comments,sessions,notes,nowHistory]=await Promise.all([
      this.repo.listReports(cardId),this.repo.listQuestions(cardId),this.repo.listComments(cardId),this.repo.listSessions(cardId),
      this.repo.listAllCardNotes(cardId),this.repo.listCardNowHistory(cardId),
    ]);
    return { card:(await this.repo.projectCards([card]))[0]!,reports,questions,comments,sessions,notes,nowHistory };
  }
  async getCardSessionMessages(cardId: string, query?: CardSessionMessagesQuery) {
    const detail=await this.getCard(cardId);
    return detail ? await readCardSessionMessages(this.repoSql, detail, query) : null;
  }
  listReports(cardId: string) { return this.repo.listReports(cardId); }
  listConfirmedItemsSinceLastCommentDelivery(cardId:string,throughAt:Date) {
    return this.repo.listConfirmedItemsSinceLastCommentDelivery(cardId,throughAt);
  }
  async listCardNotes(params:CardMutationParams & {limit?:number;before?:string}) {
    const card=await this.repo.getCard(params.cardId);
    if (!card) throw Object.assign(new Error("Card not found"),{statusCode:404});
    const limit=params.limit ?? 20;
    if (!Number.isInteger(limit) || limit<1 || limit>100) throw invalid("limit은 1에서 100 사이여야 합니다");
    return this.repo.listCardNotes(params.cardId,limit,params.before);
  }
  setFolderStatus(params: FolderActorParams & { folderId: string; expectedVersion: number; status: FolderStatus; reason?: string | null; idempotencyKey?: string | null }) {
    return this.core.setFolderStatus(params);
  }
  async createCard(params: CreateCardParams) {
    params = await this.prepareCreateCardParams(this.repoSql, params);
    const id=randomUUID();
    const a=assigneeToFields(params.assignee);
    const result=await this.core.mutate(this.createCardMutation(params,id))
      .catch(error=>translateAssigneeConflict(this.repoSql,error,a.assignee_session_id));
    if (!result.idempotent) this.onMutation?.({result});
    return result;
  }
  async createCardTx(
    sql: RepositorySql,
    params: CreateCardParams & {cardId:string},
  ): Promise<{operation:FolderOperationRow;eventId:number | null;card:CardRow}> {
    const prepared=await this.prepareCreateCardParams(sql,params);
    const result=await this.core.mutateTx(sql,this.createCardMutation(prepared,params.cardId));
    const card=(await sql<CardRow[]>`SELECT * FROM cards WHERE id=${params.cardId}`)[0];
    if (!card) throw new Error("Card was not stored");
    return {...result,card};
  }
  private async prepareCreateCardParams(sql:RepositorySql,params:CreateCardParams):Promise<CreateCardParams> {
    if (params.actorKind !== "agent" || !params.actorSessionId) return params;
    if (params.assignee !== undefined && params.assignee?.kind !== "agent") return params;
    const creator=(await sql<{agent_id:string;node_id:string;model_preset:string | null}[]>`SELECT agent_id,node_id,model_preset FROM sessions WHERE session_id=${params.actorSessionId}`)[0];
    const assignee=params.assignee ?? (creator?.agent_id ? {kind:"agent" as const,agentId:creator.agent_id} : null);
    if (!assignee) throw invalidCard("Creating session must have an agent_id");
    return {...params,assignee,nodeId:params.nodeId ?? creator?.node_id,modelPreset:params.modelPreset ?? creator?.model_preset};
  }
  private createCardMutation(params:CreateCardParams,id:string):FolderMutateParams {
    const assignee=assigneeToFields(params.assignee);
    return { folderId:params.folderId,targetKind:"card",targetId:id,operationType:"create_card",actor:params,
      idempotencyKey:params.idempotencyKey,payload:{ title:params.title,request:params.request,brief:params.brief ?? "",attachments:params.attachments ?? [],queue:params.queue ?? false,assignee:params.assignee ?? null,nodeId:params.nodeId ?? null,modelPreset:params.modelPreset ?? null },
      apply:async (sql,eventId) => {
        await this.lockFolder(sql,params.folderId);
        const position=await this.position(sql,params.folderId,null);
        const {writes}=await this.humanDecision(sql,null,{...params,type:'CREATE'},params,eventId,[],{},
          {'command.assignment':assignee});
        const initial=Object.fromEntries(writes.flatMap(write=>Object.entries(write.fields)));
        const queuePosition=initial.queue_position_key;
        if (assignee.assignee_session_id) await assertSingleCardAssignee(sql,assignee.assignee_session_id,id);
        await validateCardSourceRefsTx(sql,{cardId:id,actorKind:params.actorKind ?? "agent",actorSessionId:params.actorSessionId,body:params.request,existingRefs:[]});
        const legacyRefs=await resolveCardLegacySourceRefsTx(sql,{cardId:id,assigneeSessionId:assignee.assignee_session_id,actor:params,body:params.request,format:"markdown",attachments:params.attachments ?? []});
        const refs=mergeCardSourceAttachmentRefs(collectCardAttachmentRefs({request:params.request,attachments:params.attachments ?? [],items:[],previousRefs:[],previousItems:[]}),legacyRefs);
        await sql`INSERT INTO cards(id,folder_id,position_key,queue_position_key,title,request,brief,attachments,attachment_refs,status,
          assignee_kind,assignee_agent_id,assignee_session_id,assignee_user_id,node_id,model_preset,
          created_session_id,created_event_id,updated_session_id,updated_event_id)
          VALUES(${id},${params.folderId},${position},${queuePosition},${params.title},${params.request},${params.brief ?? ""},${sql.json(params.attachments ?? [])},${sql.json(refs)},${initial.status},
          ${initial.assignee_kind},${initial.assignee_agent_id},${initial.assignee_session_id},${initial.assignee_user_id},${params.nodeId ?? null},${params.modelPreset ?? null},
          ${params.actorSessionId},${eventId},${params.actorSessionId},${eventId})`;
      } };
  }
  updateUnstartedCard(params:CardMutationParams & UpdateUnstartedFields & {idempotencyKey:string}, authorizeFolder:AuthorizeFolder):Promise<UpdateUnstartedResult> {
    return this.maintenance.updateUnstartedCard(params, authorizeFolder);
  }
  mergeCards(params:FolderActorParams & MergeCardsInput, authorizeFolder:AuthorizeFolder):Promise<MergeCardsResult> {
    return this.maintenance.mergeCards(params, authorizeFolder);
  }
  bulkSetCardStatus(params:FolderActorParams & BulkSetCardStatusInput, authorizeFolder:AuthorizeFolder) {
    return this.maintenance.bulkSetCardStatus(params, authorizeFolder);
  }
  async patchCard(params: CardMutationParams & { title?: string; brief?: string; archived?: boolean; assignee?: CardAssigneeInput | null; nodeId?: string | null; modelPreset?: string | null; color?: CardColor }) {
    return this.mutateCard(params,"update_card",{ title:params.title,brief:params.brief,archived:params.archived,
      ...(Object.hasOwn(params,"assignee") ? assigneeToFields(params.assignee) : {}),node_id:params.nodeId,model_preset:params.modelPreset,color:params.color },
    async (sql,card,eventId,payload) => { await this.patch(sql,card,payload,params,eventId); });
  }
  async updateCardBrief(params: CardMutationParams & { brief:string }) {
    return this.mutateCard(params,"update_card",{ brief:params.brief },async (sql,card,eventId) => {
      assertNotOtherSessionAssignee(card,params);
      await this.patch(sql,card,{ brief:params.brief },params,eventId);
    });
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
      if(card.assignee_session_id ? card.assignee_session_id!==params.sessionId : session?.card_id!==card.id)
        throw invalid("실행 세션과 카드 담당이 일치하지 않습니다.");
      const stateChanged=(await sql`SELECT c.status_changed_at>r.updated_at AS changed FROM cards c
        JOIN card_execution_requests r ON r.card_id=c.id WHERE c.id=${card.id} AND r.id=${params.requestId} AND r.session_id=${params.sessionId}`)[0]?.changed===true;
      // Confirming startup is independent of a later formal review/completion.
      await this.patch(sql,card,{assignee_kind:"session",assignee_session_id:params.sessionId,assignee_agent_id:null,
        ...(params.execution&&!stateChanged?{status:"running",queue_position_key:null,blocked_kind:null,blocked_detail:null,
          completed_kind:null,completed_session_id:null,completed_event_id:null,completed_user_id:null,completed_at:null}: {})},params,eventId);
    });
  }
  async setCardStatus(params: CardMutationParams & { status: CardStatus; blockedKind?: CardRow["blocked_kind"]; blockedDetail?: string | null; wakeAt?: string; waitingFor?: string }) {
    // 재시도 비교가 시간대 표기 차이로 깨지지 않도록 페이로드에 넣기 전에 정규화한다.
    // 지금보다 뒤인지와 7일 이내인지는 상태를 확정하는 트랜잭션 안에서 따진다.
    const wakeAt = params.wakeAt === undefined ? null : parseVerificationWakeAt(params.wakeAt);
    if (params.wakeAt !== undefined && !wakeAt) throw invalid("wake_at은 오프셋이 있는 ISO 8601 시각이어야 합니다");
    const waitingFor = params.waitingFor === undefined ? null : params.waitingFor.trim();
    return this.mutateCard(params,"set_card_status",{
      status:params.status,blocked_kind:params.blockedKind ?? null,blocked_detail:params.blockedDetail ?? null,
      wake_at:wakeAt?.toISOString() ?? null,waiting_for:waitingFor,
    },async (sql,card,eventId,payload) => {
      const candidates=params.actorKind==='agent'&&params.actorSessionId?await claimableCardSessions(sql,card.id,params.actorSessionId):[];
      const {writes}=await this.humanDecision(sql,card,{...params,type:'SET_STATUS',wakeAt:wakeAt?.toISOString(),waitingFor:waitingFor??undefined},params,eventId,[],
        humanCardEvidence(candidates,params.actorSessionId,false),{'formatted.verification':wakeAt&&waitingFor?verificationWaitNow(waitingFor,wakeAt,new Date(),params.actorSessionId):undefined});
      if(writes.some(write=>write.fields.assignee_session_id===params.actorSessionId))payload.claimed_assignee=true;
      await this.patchDecisionWrites(sql,card,writes,params,eventId);
    });
  }
  async resumeBlockedCardOnHumanInput(params:{cardId:string;expectedVersion:number}) {
    const actor={actorKind:"system" as const,actorSessionId:null,...params,reason:"사용자 메시지로 작업 재개"};
    return this.mutateCard(actor,"set_card_status",{status:"running",blocked_kind:null,blocked_detail:null},async(sql,card,eventId,payload)=>{
      const {decision,writes}=await this.humanDecision(sql,card,{type:'HUMAN_INPUT'},actor,eventId);
      if(decision.kind==='noop')return false;
      await this.patchDecisionWrites(sql,card,writes,actor,eventId);
      return this.closeOpenQuestionsTx(sql,card.id,String(writes.find(write=>write.kind==='closeQuestions')!.fields.withdrawal_reason));
    },false);
  }
  async requestCardReview(params: CardMutationParams & { ask?: string }) {
    return this.mutateCard(params,"set_card_status",{status:"review",blocked_kind:null,blocked_detail:null,ask:params.ask},async(sql,card,eventId,payload)=>{
      const candidates=params.actorKind==='agent'&&params.actorSessionId?await claimableCardSessions(sql,card.id,params.actorSessionId):[];
      const {writes}=await this.humanDecision(sql,card,{...params,type:'REQUEST_REVIEW'},params,eventId,[],humanCardEvidence(candidates,params.actorSessionId,false),
        {'formatted.review':reviewCardNow(card.now??null,params.ask,new Date().toISOString(),params.actorSessionId)});
      if(writes.some(write=>write.fields.assignee_session_id===params.actorSessionId))payload.claimed_assignee=true;
      await this.patchDecisionWrites(sql,card,writes,params,eventId);
    });
  }
  async setCardItems(params: CardMutationParams & { items: string[] }) {
    const at=new Date().toISOString();
    return this.mutateCard(params,"set_card_items",{items:params.items.map(title=>({title}))},async(sql,card,eventId)=>{
      assertAssignedCardSession(card,params);
      const items=setItemsRule(card.items ?? [],params.items,at);
      await this.patch(sql,card,{items:sql.json(items)},params,eventId);
    });
  }
  async addCardItem(params: CardMutationParams & { title: string; fromCommentId?: string }) {
    const at=new Date().toISOString();
    return this.mutateCard(params,"add_card_item",{title:params.title,from_comment_id:params.fromCommentId},async(sql,card,eventId)=>{
      assertAssignedCardSession(card,params);
      const source=params.fromCommentId ? await readCardItemSourceTx(sql,card.id,params.fromCommentId) : null;
      const items=addItemRule(card.items ?? [],params.title,source,at);
      await this.patch(sql,card,{items:sql.json(items)},params,eventId);
    });
  }
  async reportCardItem(params: CardMutationParams & {
    itemId: number; state: Exclude<CardItemState,"todo">; result?: string;
    evidence?: CardItemEvidence[]; caveat?: string; reopenReason?: string;
  }) {
    const at=new Date().toISOString();
    const input:ReportCardItemInput={state:params.state,...(params.result===undefined?{}:{result:params.result}),
      ...(params.evidence===undefined?{}:{evidence:params.evidence}),...(params.caveat===undefined?{}:{caveat:params.caveat}),
      ...(params.reopenReason===undefined?{}:{reopenReason:params.reopenReason})};
    return this.mutateCard(params,"report_card_item",{item_id:params.itemId,state:params.state,result:params.result,
      evidence:params.evidence,caveat:params.caveat,reopen_reason:params.reopenReason},async(sql,card,eventId)=>{
      assertAssignedCardSession(card,params);
      const items=reportItemRule(card.items ?? [],params.itemId,input,at);
      await linkItemEvidenceTx(sql,card,params.itemId,params.actorSessionId!,input.evidence);
      const refs=collectCardItemAttachmentRefs({request:card.request,attachments:card.attachments,items,
        previousRefs:attachmentRefsOf(card.attachment_refs),previousItems:card.items ?? []});
      await this.patch(sql,card,{items:sql.json(items),attachment_refs:sql.json(refs)},params,eventId);
    });
  }
  async confirmCardItem(params: CardMutationParams & { itemId: number; confirmed: boolean }) {
    if (params.actorKind !== "user") throw Object.assign(new Error("Only a human may confirm card items"),{statusCode:403});
    const at=new Date().toISOString();
    return this.mutateCard(params,"confirm_card_item",{item_id:params.itemId,confirmed:params.confirmed},async(sql,card,eventId)=>{
      const items=confirmItemRule(card.items ?? [],params.itemId,params.confirmed,at);
      await this.patch(sql,card,{items:sql.json(items)},params,eventId);
    },false);
  }
  async updateCardNow(params: CardMutationParams & { now: string; turn: CardNowTurn; ask?: string }) {
    const existing=params.idempotencyKey ? await this.repo.getOperationByIdempotencyKey(params.idempotencyKey) : null;
    const previous=existing?.operation_type === "update_card_now" && existing.target_kind === "card" && existing.target_id === params.cardId
      ? existing.payload_json : null;
    const at=typeof previous?.updatedAt === "string" ? previous.updatedAt : new Date().toISOString();
    const now=makeCardNow({text:params.now,turn:params.turn,...(params.ask===undefined?{}:{ask:params.ask})},at,params.actorSessionId);
    return this.mutateCard(params,"update_card_now",now as unknown as Record<string,unknown>,async(sql,card,eventId)=>{
      if (params.actorKind !== "system") assertAssignedCardSession(card,params);
      await this.patch(sql,card,{now:sql.json(now)},params,eventId);
    });
  }
  async addCardNote(params: CardMutationParams & { text: string }) {
    const existing=params.idempotencyKey ? await this.repo.getOperationByIdempotencyKey(params.idempotencyKey) : null;
    const existingNoteId=existing?.operation_type === "add_card_note" && existing.target_kind === "card" && existing.target_id === params.cardId
      && typeof existing.payload_json.note_id === "string" ? existing.payload_json.note_id : null;
    const noteId=existingNoteId ?? randomUUID();
    await this.mutateCard(params,"add_card_note",{note_id:noteId,text:params.text},async(sql,card)=>{
      assertAssignedCardSession(card,params);
      const length=codePointLength(params.text);
      if (length === 0) throw invalid("note.text은 비워 둘 수 없습니다");
      if (length > 4000) throw invalid(`note.text은 4000자까지입니다. 지금 ${length}자입니다`);
      const existingRefs=attachmentRefsOf(card.attachment_refs);
      await validateCardSourceRefsTx(sql,{cardId:card.id,actorKind:params.actorKind ?? "agent",actorSessionId:params.actorSessionId,body:params.text,existingRefs});
      const legacyRefs=await resolveCardLegacySourceRefsTx(sql,{cardId:card.id,assigneeSessionId:card.assignee_session_id,actor:params,body:params.text,format:"markdown"});
      const refs=mergeCardSourceAttachmentRefs(collectCardAttachmentRefs({request:params.text,attachments:[],items:card.items ?? [],previousRefs:existingRefs,previousItems:card.items ?? []}),legacyRefs);
      await sql`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body,attachment_refs)
        VALUES(${noteId},${card.id},'agent',NULL,${params.actorSessionId},'note',${params.text},${sql.json(refs)})`;
    });
    const note=await this.repo.getComment(params.cardId,noteId);
    if (!note) throw new Error("Card note was not stored");
    return note;
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
      if ((card.items ?? []).length > 0) throw invalid("결과는 항목에 다세요(report_card_item)");
      const existingRefs=attachmentRefsOf(card.attachment_refs);
      let refs:AttachmentRef[]=[];
      if (params.format === "markdown") {
        await validateCardSourceRefsTx(sql,{cardId:card.id,actorKind:params.actorKind ?? "agent",actorSessionId:params.actorSessionId,body:params.body,existingRefs});
        refs=collectCardAttachmentRefs({request:params.body,attachments:[],items:card.items ?? [],previousRefs:existingRefs,previousItems:card.items ?? []});
      }
      const legacyRefs=await resolveCardLegacySourceRefsTx(sql,{cardId:card.id,assigneeSessionId:card.assignee_session_id,actor:params,body:params.body,format:params.format});
      refs=mergeCardSourceAttachmentRefs(refs,legacyRefs);
      await sql`INSERT INTO card_reports(id,card_id,title,format,body,session_id,attachment_refs)
        VALUES(${randomUUID()},${card.id},${params.title},${params.format},${params.body},${params.actorSessionId},${sql.json(refs)})`;
    });
  }
  async addComment(params: AddCommentParams) {
    const existing=params.idempotencyKey ? await this.repo.getOperationByIdempotencyKey(params.idempotencyKey) : null;
    const existingCommentId=existing?.operation_type === "add_card_comment" && existing.target_kind === "card" && existing.target_id === params.cardId
      && typeof existing.payload_json.comment_id === "string" ? existing.payload_json.comment_id : null;
    const commentId=existingCommentId ?? randomUUID();
    const prepared=this.prepareAddComment(params,commentId);
    const result=await this.mutateCard(params,"add_card_comment",prepared.payload,async (sql,card,eventId,payload) => {
      return this.applyAddCommentTx(sql,card,eventId,payload,params,commentId,prepared.kind,prepared.external,prepared.reply);
    });
    const storedId=String(result.operation.payload_json.comment_id ?? commentId);
    const comment=await this.repo.getComment(params.cardId,storedId);
    if (!comment) throw new Error("Card comment was not stored");
    return comment;
  }
  async addCommentTx(
    sql:RepositorySql,
    params:AddCommentParams & {commentId:string},
    entrance:"followup"="followup",
  ):Promise<{operation:FolderOperationRow;eventId:number | null;card:CardRow;comment:CardCommentRow;previousStatus:CardStatus;questionChanged:boolean}> {
    const prepared=this.prepareAddComment(params,params.commentId);
    const payload=Object.fromEntries(Object.entries(prepared.payload).filter(([,value])=>value!==undefined));
    const card=(await sql<CardRow[]>`SELECT * FROM cards WHERE id=${params.cardId}`)[0];
    if (!card) throw Object.assign(new Error("Card not found"),{statusCode:404});
    let previousStatus:CardStatus | undefined;
    let questionChanged=false;
    const result=await this.core.mutateTx(sql,{
      folderId:card.folder_id,targetKind:"card",targetId:card.id,operationType:"add_card_comment",actor:params,
      idempotencyKey:params.idempotencyKey,reason:params.reason,payload,
      apply:async (tx,eventId) => {
        const locked=(await tx<CardRow[]>`SELECT * FROM cards WHERE id=${card.id} FOR UPDATE`)[0];
        if (!locked) throw Object.assign(new Error("Card not found"),{statusCode:404});
        if (params.expectedVersion!==undefined && locked.version!==params.expectedVersion)
          throw new CardVersionConflict("card",card.id,params.expectedVersion,locked.version);
        previousStatus=locked.status;
        questionChanged=await this.applyAddCommentTx(tx,locked,eventId,payload,params,params.commentId,prepared.kind,prepared.external,prepared.reply,entrance);
      },
    });
    const savedCard=(await sql<CardRow[]>`SELECT * FROM cards WHERE id=${params.cardId}`)[0];
    if (!savedCard) throw new Error("Card was not stored");
    const comment=(await sql<CardCommentRow[]>`SELECT * FROM card_comments WHERE card_id=${params.cardId} AND id=${params.commentId}`)[0];
    if (!comment) throw new Error("Card comment was not stored");
    if (previousStatus===undefined) throw new Error("Card status was not captured");
    return {...result,card:savedCard,comment,previousStatus,questionChanged};
  }
  markCommentDelivered(cardId:string,commentId:string) { return this.repo.markCommentDelivered(cardId,commentId); }
  async askQuestion(params: CardMutationParams & { text:string; options:string[] }) {
    if (!cardQuestionOptionsSchema.safeParse(params.options).success)
      throw invalid("options: 선택지는 1~3개, 각 12자 이하로 줄이고 설명은 질문 글에 쓰세요");
    const questionId=randomUUID();
    const result=await this.mutateCard(params,"ask_card_question",{ text:params.text,options:params.options ?? null },async (sql,card,eventId) => {
      const {writes}=await this.humanDecision(sql,card,{...params,type:'ASK_QUESTION'},params,eventId,[],{},
        {'formatted.question':questionCardNow(card.now??null,params.text,new Date().toISOString(),params.actorSessionId)});
      const fields=writes.find(write=>write.kind==='questionInsert')!.fields;
      await sql`INSERT INTO card_questions(id,card_id,session_id,text,options)
        VALUES(${questionId},${card.id},${fields.session_id},${fields.text},${sql.json(fields.options as never)})`;
      await this.patchDecisionWrites(sql,card,writes,params,eventId);
    });
    if (!result.idempotent && this.onQuestionAsked) {
      try { await this.onQuestionAsked({ cardId:params.cardId,questionId }); }
      catch (error) { this.warn(`카드 질문 판 게시 실패(카드 ${params.cardId}): ${String(error)}`); }
    }
    return result;
  }
  async answerQuestion(params: CardMutationParams & { questionId:string; answer:string }) {
    assertCardCommandEntrance('ANSWER_QUESTION',{}, {kind:params.actorKind,sessionId:params.actorSessionId});
    return this.mutateCard(params,"answer_card_question",{ question_id:params.questionId,answer:params.answer },async (sql,card,eventId) => {
      const questions=await sql<Record<string,unknown>[]>`SELECT id,session_id,answer,withdrawn_at FROM card_questions WHERE card_id=${card.id}`;
      const {writes}=await this.humanDecision(sql,card,{...params,type:'ANSWER_QUESTION'},params,eventId,questions);
      const fields=writes.find(write=>write.kind==='questionAnswer')!.fields;
      const rows=await sql`UPDATE card_questions SET answer=${fields.answer},answered_at=NOW(),answered_by=${fields.answered_by}
        WHERE id=${params.questionId} AND card_id=${card.id} AND answer IS NULL AND withdrawn_at IS NULL RETURNING id`;
      if (!rows.length) throw invalid("Open question not found in card");
      await this.patchDecisionWrites(sql,card,writes,params,eventId);
    });
  }
  async withdrawQuestion(params: CardMutationParams & { questionId:string; reason:string }) {
    const reason=params.reason.trim();
    const length=codePointLength(reason);
    if (!length) throw invalid("철회 사유를 입력하세요");
    if (length > 200) throw invalid(`철회 사유는 200자까지입니다. 지금 ${length}자입니다`);
    return this.mutateCard(params,"withdraw_card_question",{ question_id:params.questionId,reason },async (sql,card,eventId) => {
      const questions=await sql<Record<string,unknown>[]>`SELECT id,session_id,answer,withdrawn_at FROM card_questions WHERE card_id=${card.id}`;
      const {writes}=await this.humanDecision(sql,card,{...params,type:'WITHDRAW_QUESTION',reason},params,eventId,questions);
      const fields=writes.find(write=>write.kind==='questionWithdraw')!.fields;
      const rows=await sql`UPDATE card_questions SET withdrawn_at=NOW(),withdrawn_by_session_id=${fields.withdrawn_by_session_id},withdrawal_reason=${fields.withdrawal_reason}
        WHERE id=${params.questionId} AND card_id=${card.id} AND answer IS NULL AND withdrawn_at IS NULL RETURNING id`;
      if (!rows.length) throw invalid("Question not found in card");
      await this.patchDecisionWrites(sql,card,writes,params,eventId);
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
      if (card.status!=="blocked" || card.blocked_kind!=="limit" || card.archived
        || card.assignee_session_id!==params.sessionId || card.limit_resume_session_id!==params.sessionId || card.limit_resume_at!==null)
        throw invalid("Only the recorded current long-limit assignee may resume");
      await assertNoPendingCardExecution(sql,card.id);
      await this.checkAdmission(sql,{...params,nodeId:params.nodeId??card.node_id??"eiaserinnys"});
      await this.patch(sql,card,{status:params.admission ? "queued" : "running",blocked_kind:null,blocked_detail:null,
        ...(!params.admission ? {queue_position_key:null} : {})},actor,eventId);
    });
  }
  /** Capture both the quota owner and optional short reset under the card lock. */
  blockCardForLimit(params:{cardId:string;expectedVersion:number;sessionId:string;terminationEventId:number | null}) {
    const actor={actorKind:"system" as const,actorSessionId:null};
    return this.mutateCard({...actor,cardId:params.cardId,expectedVersion:params.expectedVersion},"set_card_status",
      {status:"blocked",blocked_kind:"limit",session_id:params.sessionId},async(sql,card,eventId)=>{
      if (card.status!=="running" || card.archived || card.assignee_kind!=="session" || card.assignee_session_id!==params.sessionId)
        throw invalid("Only the current running assignee may enter limit-blocked");
      const owner=(await sql<LimitResumeOwner[]>`SELECT session_id,status,termination_reason,termination_event_id FROM sessions WHERE session_id=${params.sessionId} FOR SHARE`)[0];
      if (!owner || !isUsageLimitTermination(owner) || owner.termination_event_id!==params.terminationEventId)
        throw invalid("Quota termination changed before the card was blocked");
      const resumeAt=await readLimitAutoResumeAt(sql,owner);
      const clock=resumeAt ? formatLimitResumeClock(resumeAt) : null;
      await this.patch(sql,card,{status:"blocked",blocked_kind:"limit",queue_position_key:card.queue_position_key,
        blocked_detail:clock ? `사용량 한도, ${clock} 자동 재개` : "세션 사용량 한도",
        limit_resume_session_id:params.sessionId,limit_resume_at:resumeAt,
        ...(clock ? {now:sql.json(makeCardNow({text:`사용량 한도로 멈춤, ${clock}에 저절로 이어집니다`,turn:"outside"},new Date().toISOString(),null))} : {}),
      },actor,eventId);
    });
  }
  /** Resume only the unchanged, due short reservation, independent of session liveness. */
  resumeLimitedCard(params:{cardId:string;sessionId:string;resumeAt:string;now:number}) {
    const actor={actorKind:"system" as const,actorSessionId:null};
    return this.mutateCard({...actor,cardId:params.cardId},"resume_card",{session_id:params.sessionId,limit_resume_at:params.resumeAt},async(sql,card,eventId)=>{
      if (card.status!=="blocked" || card.blocked_kind!=="limit" || card.archived
        || card.assignee_kind!=="session" || card.assignee_session_id!==params.sessionId
        || card.limit_resume_session_id!==params.sessionId || !card.limit_resume_at
        || new Date(card.limit_resume_at).toISOString()!==params.resumeAt || new Date(card.limit_resume_at).getTime()>params.now)
        throw invalid("Only the current assignee's unchanged due limit reservation may resume");
      await assertNoPendingCardExecution(sql,card.id);
      await this.patch(sql,card,{status:"running",blocked_kind:null,blocked_detail:null,queue_position_key:null,
        now:sql.json(makeCardNow({text:"담당이 이어서 진행합니다",turn:"agent"},new Date().toISOString(),null))},actor,eventId);
    });
  }
  /** 검증 대기 시각이 되어 담당을 깨운 뒤 실행 중으로 되돌린다. 새 실행이나 배정 판단이 아니다. */
  resumeVerificationCard(params:{cardId:string;sessionId:string;wakeAt:string}) {
    const actor={actorKind:"system" as const,actorSessionId:null};
    return this.mutateCard({...actor,cardId:params.cardId,reason:"검증 대기 시각이 되어 담당을 깨웠습니다"},"resume_card",
      {session_id:params.sessionId,wake_at:params.wakeAt},async(sql,card,eventId)=>{
      if (card.status !== "awaiting_verification" || !card.wake_at
        || new Date(card.wake_at).toISOString() !== params.wakeAt
        || card.assignee_kind !== "session" || card.assignee_session_id !== params.sessionId)
        throw invalid("Only the currently assigned verification-wait card at this wake time may resume");
      const now=makeCardNow({text:"담당이 기다리던 것을 확인합니다",turn:"agent"},new Date().toISOString(),params.sessionId);
      await this.patch(sql,card,{status:"running",blocked_kind:null,blocked_detail:null,queue_position_key:null,now:sql.json(now)},actor,eventId);
    });
  }
  private prepareAddComment(params:AddCommentParams,commentId:string) {
    assertCardCommandEntrance('ADD_COMMENT',{hasMode:Boolean(params.mode),requestedSpoken:params.kind==='spoken'}, {kind:params.actorKind,sessionId:params.actorSessionId});
    const external=params.actorKind === "llm";
    const reply=params.mode === "reply";
    const kind=external ? "comment" : params.actorKind === "agent" ? reply ? "comment" : "spoken" : params.kind ?? "comment";
    return {
      external,
      reply,
      kind,
      payload:{ comment_id:commentId,body:params.body,kind,
        ...(params.itemId===undefined?{}:{item_id:params.itemId}),...(reply ? {author_kind:"agent",session_id:params.actorSessionId} : {}) },
    };
  }
  private async applyAddCommentTx(
    sql:RepositorySql,
    card:CardRow,
    eventId:number | null,
    payload:Record<string,unknown>,
    params:AddCommentParams,
    commentId:string,
    kind:"comment" | "spoken",
    external:boolean,
    reply:boolean,
    entrance:"direct"|"followup"="direct",
  ):Promise<boolean> {
    const candidates=reply&&params.actorSessionId?await claimableCardSessions(sql,card.id,params.actorSessionId):[];
    const userInput=reply&&(card.items??[]).length>0?await hasUserInputAfterLastReplyTx(sql,card.id):false;
    const {writes}=await this.humanDecision(sql,card,{...params,type:'ADD_COMMENT',entrance},params,eventId,[],
      humanCardEvidence(candidates,params.actorSessionId,userInput),
      ()=>({'formatted.items':params.itemId!==undefined&&!reply?openCardItemFix(card.items??[],params.itemId):undefined}));
    const claim=writes.filter(write=>write.stage==='claim');
    if(claim.length){Object.assign(card,...claim.map(write=>write.fields));payload.claimed_assignee=true;}
    const existingRefs=attachmentRefsOf(card.attachment_refs);
    await validateCardSourceRefsTx(sql,{cardId:card.id,actorKind:params.actorKind ?? "agent",actorSessionId:params.actorSessionId,body:params.body,existingRefs});
    const legacyRefs=await resolveCardLegacySourceRefsTx(sql,{cardId:card.id,assigneeSessionId:card.assignee_session_id,actor:params,body:params.body,format:"markdown"});
    const refs=mergeCardSourceAttachmentRefs(collectCardAttachmentRefs({request:params.body,attachments:[],items:card.items ?? [],previousRefs:existingRefs,previousItems:card.items ?? []}),legacyRefs);
    await this.patchDecisionWrites(sql,card,claim,params,eventId);
    await sql`INSERT INTO card_comments(id,card_id,author_kind,author_id,session_id,kind,body,item_id,attachment_refs)
      VALUES(${commentId},${card.id},${reply ? "agent" : "user"},${external || reply ? null : params.actorUserId ?? null},${external ? null : params.actorSessionId},${kind},${params.body},${params.itemId ?? null},${sql.json(refs)})`;
    await this.patchDecisionWrites(sql,card,writes.filter(write=>write.stage!=='claim'),params,eventId);
    const close=writes.find(write=>write.kind==='closeQuestions');
    if(close)return this.closeOpenQuestionsTx(sql,card.id,String(close.fields.withdrawal_reason));
    return false;
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
  private async applyStatusTx(
    sql:RepositorySql,
    card:CardRow,
    eventId:number | null,
    params:CardMutationParams & {status:CardStatus;blockedKind?:CardRow["blocked_kind"];blockedDetail?:string | null;wakeAt?:string;waitingFor?:string},
    payload:Record<string,unknown>,
    mode:"normal" | "bulk_idle" = "normal",
  ):Promise<Record<string,unknown>> {
    if (mode === "bulk_idle") await assertBulkStatusGuardTx(sql,card,params.status);
    const bulkApproved=mode === "bulk_idle" && card.assignee_session_id !== null;
    const claim=params.actorKind === "agent" && !bulkApproved ? await this.claim(sql,card,params.actorSessionId,payload) : {};
    const unassignedRest=params.actorKind === "agent" && Boolean(params.actorSessionId)
      && card.assignee_session_id === null && card.assignee_kind !== "human"
      && ["todo","queued","on_hold","cancelled"].includes(params.status);
    if (params.actorKind === "agent" && (!params.actorSessionId || card.assignee_session_id !== params.actorSessionId) && !unassignedRest && !bulkApproved)
      throw Object.assign(new Error("Only the current assignee session may change card status. An authenticated internal agent session with card mutation access may use transfer_card_assignee to assign the card; handoff changes assignment only and does not start or stop work. A card without an assignee session can be moved to todo, queued, on_hold or cancelled by any internal agent session."), {statusCode:403});
    const fields:Record<string,unknown> = { ...claim,status:params.status,
      blocked_kind:params.status === "blocked" ? params.blockedKind ?? null : null,
      blocked_detail:params.status === "blocked" ? params.blockedDetail ?? null : null,
      queue_position_key:params.status === "queued" ? await this.position(sql,null,null,card.id)
        : params.status === "blocked" && params.blockedKind === "limit" ? card.queue_position_key : null,
      completed_kind:params.status === "done" ? params.actorKind === "system" ? null : params.actorKind ?? "agent" : null,
      completed_session_id:params.status === "done" ? params.actorSessionId : null,
      completed_event_id:params.status === "done" ? eventId : null,
      completed_user_id:params.status === "done" ? params.actorUserId ?? null : null,
      completed_at:params.status === "done" ? new Date() : null };
    if (params.status === "awaiting_verification") {
      // claim이 방금 담당을 세운 경우를 포함해, 이 트랜잭션에서 확정된 담당만 인정한다.
      if (card.assignee_kind !== "session" || !card.assignee_session_id)
        throw invalid("검증 대기는 담당 세션이 있는 카드만 설정할 수 있습니다");
      const at=new Date();
      const check=validateVerificationWait({wakeAt:params.wakeAt,waitingFor:params.waitingFor},at);
      if (!check.ok) throw invalid(check.message);
      fields.wake_at=check.wakeAt;
      fields.waiting_for=check.waitingFor;
      fields.now=sql.json(verificationWaitNow(check.waitingFor,check.wakeAt,at,params.actorSessionId));
    }
    return fields;
  }
  private async mutateCard(params:CardMutationParams,operationType:string,payload:Record<string,unknown>,apply:(sql:RepositorySql,card:CardRow,eventId:number | null,payload:Record<string,unknown>)=>Promise<void | boolean>,notifyMutation=true) {
    const card=await this.repo.getCard(params.cardId);
    if (!card) throw Object.assign(new Error("Card not found"),{ statusCode:404 });
    const clean=Object.fromEntries(Object.entries(payload).filter(([,v])=>v !== undefined));
    let previousStatus:CardStatus | undefined,previousAssigneeSessionId:string | null | undefined,committedCard:CardRow | undefined;
    let previousCard:Pick<CardRow,"now"|"title"|"archived"|"number"> | undefined;
    let applyQuestionChanged=false;
    const result=await this.core.mutate({ folderId:card.folder_id,targetKind:"card",targetId:card.id,operationType,actor:params,
      idempotencyKey:params.idempotencyKey,reason:params.reason,payload:clean,
      apply:async (sql,eventId) => {
        const locked=(await sql<CardRow[]>`SELECT * FROM cards WHERE id=${card.id} FOR UPDATE`)[0];
        if (!locked) throw Object.assign(new Error("Card not found"),{ statusCode:404 });
        if (params.expectedVersion !== undefined && locked.version !== params.expectedVersion) throw new CardVersionConflict("card",card.id,params.expectedVersion,locked.version);
        previousStatus=locked.status;
        previousCard={now:locked.now,title:locked.title,archived:locked.archived,number:locked.number};
        previousAssigneeSessionId=locked.assignee_session_id;
        applyQuestionChanged=await apply(sql,locked,eventId,clean)===true;
        committedCard=(await sql<CardRow[]>`SELECT * FROM cards WHERE id=${card.id}`)[0];
      },
      afterCommit: async () => {
        const questionChanged = applyQuestionChanged || operationType === "ask_card_question" || operationType === "answer_card_question"
          || operationType === "withdraw_card_question";
        const cardChanged = previousStatus !== committedCard?.status || previousCard?.title !== committedCard?.title
          || previousCard?.archived !== committedCard?.archived || JSON.stringify(previousCard?.now) !== JSON.stringify(committedCard?.now);
        await this.syncReportsAfterCommit(card.id,{previousStatus,previousCard,committedCard,questionChanged,cardChanged});
      } }).catch(error=>translateAssigneeConflict(this.repoSql,error,
        typeof clean.assignee_session_id === "string" ? clean.assignee_session_id : params.actorSessionId ?? card.assignee_session_id));
    if (!result.idempotent && notifyMutation) this.onMutation?.({result,previousStatus,previousAssigneeSessionId,committedCard});
    return result;
  }
  private async afterCommitMaintenance(changes:CardMaintenanceChange[]):Promise<void> {
    for (const change of changes) {
      const cardId=change.result.operation.target_id;
      const folderId=change.result.operation.folder_id;
      try {
        await this.syncReportsAfterCommit(cardId,{previousStatus:change.previousStatus,committedCard:change.committedCard,
          questionChanged:false,cardChanged:change.cardChanged});
        if (folderId) await this.broadcaster?.emitCardUpdated?.(cardId,folderId);
        if (folderId) {
          const snapshot=await this.repo.getSnapshot(folderId);
          if (snapshot) this.onMutation?.({result:{...change.result,eventId:change.result.eventId ?? 0,snapshot},previousStatus:change.previousStatus,
            previousAssigneeSessionId:change.previousAssigneeSessionId,committedCard:change.committedCard});
        }
      } catch (error) { this.warn(`카드 ${cardId} 정비 후처리 실패: ${String(error)}`); }
    }
  }
  async syncReportsAfterCommit(cardId:string,change:CardReportSyncParams):Promise<void> {
    const {previousStatus,committedCard,questionChanged}=change;
    const cardChanged=change.cardChanged ?? previousStatus !== committedCard?.status;
    if (!this.reports || !committedCard) return;
    try {
      await this.reports.syncCard(cardId);
      if (previousStatus !== committedCard.status) await this.reports.recordCardTimeline(cardId);
    } catch (error) { this.warn(`PAS report sync failed after card ${cardId} committed: ${String(error)}`); }
  }
  private async closeOpenQuestionsTx(sql:RepositorySql,cardId:string,reason:string):Promise<boolean> {
    const closed=await sql`UPDATE card_questions SET withdrawn_at=NOW(),withdrawn_by_session_id=NULL,withdrawal_reason=${reason}
      WHERE card_id=${cardId} AND answer IS NULL AND withdrawn_at IS NULL RETURNING id`;
    return closed.length>0;
  }
  private async patch(sql:RepositorySql,card:CardRow,fields:Record<string,unknown>,actor:FolderActorParams,eventId:number | null) {
    await patchCardTx(sql,card,fields,actor,eventId);
  }
  private async humanDecision(sql:RepositorySql,card:CardRow|null,command:HumanCardCommand,params:FolderActorParams,eventId:number|null,
    questions:Record<string,unknown>[]=[],evidence:{claim?:boolean;userInput?:boolean}={},values:Record<string,unknown>|(()=>Record<string,unknown>)={}) {
    const actor={kind:params.actorKind,sessionId:params.actorSessionId,userId:params.actorUserId};
    const at=new Date();
    const decision=decideCardTransition(card,questions,evidence,command,actor,at.getTime());
    if(decision.kind==='reject') {
      const failure=formatCardDecisionRejection(command.type,card?.id??'',decision.failure,{length:codePointLength('body' in command?command.body:'waitingFor' in command?command.waitingFor??'':'')});
      throw Object.assign(new Error(failure.message!),{...(failure.statusCode===null?{}:{statusCode:failure.statusCode}),...(failure.code===null?{}:{code:failure.code})});
    }
    const needsQueue=decision.actions.some(action=>Object.values(action.params?.fields??{}).some(value=>(value as {bind?:string}).bind==='queue.new'));
    const writes=decodeCardDecision(decision,{card:card??{},command,actor:{...actor,kind:params.actorKind??'agent'},now:at,eventId,
      queuePosition:needsQueue?await this.position(sql,null,null,card?.id??null):undefined,values:typeof values==='function'?values():values},true);
    return {decision,writes};
  }
  private async patchDecisionWrites(sql:RepositorySql,card:CardRow,writes:DecodedCardWrite[],params:FolderActorParams,eventId:number|null) {
    for(const write of writes.filter(write=>write.kind==='card')) {
      const fields={...write.fields};
      for(const key of ['now','items'])if(fields[key]!==undefined&&fields[key]!==null)fields[key]=sql.json(fields[key] as never);
      await this.patch(sql,card,fields,params,eventId);
    }
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
function assertAssignedCardSession(card:CardRow,params:CardMutationParams):void {
  if (params.actorKind !== "agent" || !params.actorSessionId
    || card.assignee_kind !== "session" || card.assignee_session_id !== params.actorSessionId) {
    const assignee = card.assignee_kind === "session" && card.assignee_session_id ? ` (${card.assignee_session_id})` : "";
    throw invalid(`카드 쓰기는 현재 담당 세션만 할 수 있습니다. 담당 세션${assignee}에 전하세요.`);
  }
}
function assertNotOtherSessionAssignee(card:CardRow,params:CardMutationParams):void {
  if (params.actorKind === "agent" && card.assignee_kind === "session" && card.assignee_session_id !== params.actorSessionId)
    throw invalid("다른 세션이 담당인 카드입니다. 인계 요약, 질문, 발언 기록은 담당 세션만 씁니다.");
}
/**
 * 새 증거 ID는 생산자·등록 scope까지 검사한다. 같은 항목에 이미 저장되어 카드 ref에 남은 같은 ID/type는
 * 생산 세션이 사라진 뒤에도 유지할 수 있어야 하므로 committed와 이미지 정책만 다시 본다.
 */
async function linkItemEvidenceTx(sql:RepositorySql,card:CardRow,itemId:number,sessionId:string,evidence:readonly CardItemEvidence[] | undefined):Promise<void> {
  if (evidence === undefined) return;
  const stored=(card.items ?? []).find(item=>item.id === itemId)?.evidence ?? [];
  const keptRefIds=attachmentRefIds(attachmentRefsOf(card.attachment_refs));
  for (const proof of evidence) {
    if (proof.attachment_id === undefined) continue;
    const kept=keptRefIds.has(proof.attachment_id)
      && stored.some(old=>old.attachment_id === proof.attachment_id && old.type === proof.type);
    if (!kept) await requireCardAttachmentTx(sql,card,{sessionId},proof.attachment_id,proof.type);
    else await assertKeptEvidenceUsableTx(sql,proof.attachment_id,proof.type);
  }
}
async function assertKeptEvidenceUsableTx(sql:RepositorySql,id:string,type:"image" | "link"):Promise<void> {
  const row=(await sql<{upload_status:string;mime_type:string}[]>`SELECT upload_status,mime_type FROM file_assets
    WHERE id=${id} AND storage_purpose='attachment' AND garbage_collected_at IS NULL LIMIT 1`)[0];
  if (!row) throw Object.assign(new Error("첨부를 찾을 수 없습니다."),{statusCode:404,code:"ATTACHMENT_NOT_FOUND"});
  if (row.upload_status !== "committed")
    throw Object.assign(new Error("아직 커밋되지 않은 첨부입니다."),{statusCode:409,code:"ATTACHMENT_NOT_COMMITTED"});
  if (type === "image" && previewInfo(normalizedMimeType(row.mime_type)).kind !== "image")
    throw Object.assign(new Error("이미지 첨부가 아닙니다."),{statusCode:422,code:"ATTACHMENT_IMAGE_REQUIRED"});
}
function invalid(message:string) { return Object.assign(new Error(message),{ statusCode:422,code:"INVALID_CARD_REQUEST" }); }
