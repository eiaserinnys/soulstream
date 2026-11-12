import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import { hasPendingSessionModelFallback } from "@soulstream/wire-schema/model-preset-fallbacks";
import { cardAttachmentPaths } from "./card_attachment_paths.js";
import { buildCardChangeNotification, buildCardQuestionAnswerNotice, buildCardQuestionThreadNotice, cardQuestionDeliveryTarget, type CardChangeDelivery } from "./card_change_notification.js";
import { buildCardStatusReminder, MAX_REMINDERS_PER_TICK } from "./card_status_reminder.js";
import { buildCardBlockedNotice, buildCardDoneNotice, buildCardQuestionNotice, buildCardReviewNotice, selectCardBoardNotice } from "./card_board_notice.js";
import { type LimitResumeOwner } from "./card_limit_auto_resume.js";
import { randomUUID } from "node:crypto";
import type { NodeRegistryEvent } from "../node/registry_types.js";
import { isTerminalSessionStatus } from "../session/session_status.js";
import { isUsageLimitTermination } from "../session/session_limit_termination.js";
import { buildCardPrompt } from "./card_prompt.js";
import type { CardControlPlaneService, CardMutationChange } from "./card_control_plane_service.js";
import type { CardDispatchRepository, DispatchCard } from "./card_dispatch_repository.js";
import type { CardRow } from "./control_plane/card_types.js";
export type CardTarget = {
    sessionId?: string;
    capacityClaimed?: boolean;
    nodeId: string;
    agentId: string;
    modelPreset: string | null;
    available: boolean;
    reason: string | null;
};
export type CardLaunch = {
    sessionId: string;
    cardId: string;
    prompt: string;
    nodeId: string;
    agentId: string;
    modelPreset: string | null;
    folderId: string;
    attachments?: CardAttachment[];
    orchestrationAdmission?:{runId:string;executionToken:string;cardId:string};
};
export type CardNotification = {
    nodeId: string;
    cardId: string;
    folderId: string;
    title: string;
    kind: "question" | "review";
    question?: string;
};
export type CardDispatcherOptions = {
    repository: CardDispatchRepository;
    cards: () => Promise<CardControlPlaneService>;
    resolveTarget: (card: CardRow, modelPreset?: string | null) => CardTarget;
    launch: (input: CardLaunch) => Promise<unknown>;
    sendMessage: (sessionId: string, text: string, admission?:{runId:string;executionToken:string;cardId:string}, changeDelivery?:CardChangeDelivery, attachments?:readonly CardAttachment[]) => Promise<void>;
    prepareAttachments?: (card: CardRow, targetNodeId: string) => Promise<void>;
    deliveryExists: (deliveryId: string) => Promise<boolean>;
    abandonDelivery: (deliveryId: string, reason: string) => Promise<void>;
    notify: (input: CardNotification) => Promise<unknown>;
    warn: (message: string) => void;
    now?: () => number;
    orchestration?: {enabled:()=>Promise<boolean>;kick:()=>Promise<void>;ownsSession:(id:string)=>Promise<boolean>;decisionEnded?:(id:string)=>Promise<void>};
};
/** One selection seam; the director's global queue is the only scheduling policy. */
export function pickNextCard(cards: readonly DispatchCard[], occupancy: Record<string, number>, concurrency: Record<string, number>, resolveNode: (card: DispatchCard) => string): DispatchCard | undefined {
    return cards.find(card => card.assignee_kind !== "human" && !!card.assignee_agent_id
        && (occupancy[resolveNode(card)] ?? 0) < (concurrency[resolveNode(card)] ?? concurrency.default!));
}
export class CardDispatcher {
    private pending: Promise<void> = Promise.resolve();
    private lastLimitCheck = 0;
    constructor(private readonly options: CardDispatcherOptions) { }
    private enqueue(work: () => Promise<void>): Promise<void> {
        this.pending = this.pending.then(work).catch(error => this.options.warn(`card dispatch: ${String(error)}`));
        return this.pending;
    }
    async drain(): Promise<void> { let previous; do {
        previous = this.pending;
        await previous;
    } while (previous !== this.pending); }
    dispatch(): Promise<void> { return this.enqueue(() => this.dispatchOnce()); }
    checkLimits(): Promise<void> { return this.enqueue(async () => { await this.resumeAutoLimits(); await this.wakeAwaitingVerifications(this.options.now?.() ?? Date.now()); if (await this.options.orchestration?.enabled()) { await this.options.orchestration!.kick(); return; } await this.resumeLimits(); await this.dispatchOnce(); }); }
    async tick(): Promise<void> {
        const now = this.options.now?.() ?? Date.now();
        if (now - this.lastLimitCheck < 60000)
            return;
        this.lastLimitCheck = now;
        await this.checkLimits();
        await this.enqueue(() => this.checkReminders());
    }
    accept(events: readonly NodeRegistryEvent[]): void {
        for (const event of events) {
            if (event.type !== "node_session_session_updated" || event.committedIngress !== true)
                continue;
            const data = event.data;
            const nested = data.session as Record<string, unknown> | undefined;
            const id = data.agentSessionId ?? data.agent_session_id ?? data.sessionId ?? data.session_id ?? nested?.agentSessionId ?? nested?.agent_session_id;
            if (typeof id === "string")
                void this.sessionEnded(id);
        }
    }
    sessionEnded(sessionId: string): Promise<void> {
        return this.enqueue(async () => {
            await this.checkReminders(sessionId);
            if (await this.options.orchestration?.ownsSession(sessionId)) { await this.options.orchestration?.decisionEnded?.(sessionId); return; }
            for (const work of await this.options.repository.endedWork(sessionId)) {
              if (!isUsageLimitTermination(work.terminal_session)) continue;
              // 일반 세션 모델 대체 pending이면 다음 세대가 이어받으므로 막힘으로 다루지 않는다.
              if (hasPendingSessionModelFallback(work.metadata)) continue;
              const cards=await this.options.cards(),detail=await cards.getCard(work.card_id);
              const owner=await this.options.repository.ownerSession(sessionId);
              if (detail?.card.status === "running" && detail.card.assignee_session_id === sessionId && owner)
                await this.blockForLimit(detail.card, owner);
            }
            await this.reconcileTerminal(sessionId);
            await this.dispatchOnce();
        });
    }
    acceptMutation(change: CardMutationChange): void {
        if (change.result.idempotent)
            return;
        void this.enqueue(() => this.handleMutation(change));
    }
    private async checkReminders(endedRootId?: string): Promise<void> {
        try {
            if (endedRootId) {
                const session = await this.options.repository.ownerSession(endedRootId);
                if (!isTerminalSessionStatus(session?.status ?? undefined)) return;
            }
            let sent = 0;
            for (const facts of await this.options.repository.reminderFacts(this.options.now?.() ?? Date.now(), endedRootId)) {
                if (!endedRootId && sent >= MAX_REMINDERS_PER_TICK) break;
                const reminder = buildCardStatusReminder(facts, endedRootId !== undefined);
                if (!reminder) continue;
                try {
                    if (await this.options.deliveryExists(reminder.deliveryId)) continue;
                    sent++;
                    await this.options.sendMessage(reminder.sessionId, reminder.text, undefined, reminder);
                } catch (error) { this.options.warn(`card ${facts.cardId} reminder delivery failed: ${String(error)}`); }
            }
        } catch (error) { this.options.warn(`card reminder check failed: ${String(error)}`); }
    }
    private async handleMutation(change: CardMutationChange): Promise<void> {
        const {result,previousStatus}=change;
        const op = result.operation;
        const cards = await this.options.cards();
        const detail = await cards.getCard(op.target_id);
        if (!detail)
            return;
        const card = detail.card;
        const payload = op.payload_json;
        const commentId=String(payload.comment_id ?? "");
        const comment=op.operation_type === "add_card_comment" ? detail.comments.find(item=>item.id === commentId) : undefined;
        // 질문 글타래에 사용자가 남긴 글은 일반 커멘트 알림 대신 질문별 알림으로 전달한다.
        const threadQuestion=op.operation_type === "add_card_comment" && comment?.author_kind === "user" && comment.question_id != null
            ? detail.questions.find(question=>String(question.id) === String(comment.question_id)) : undefined;
        const fallback=comment && !change.previousAssigneeSessionId ? await this.options.repository.latestDispatchedSessionId(card.id) : null;
        let notification=threadQuestion ? null : buildCardChangeNotification(change,comment,fallback);
        if (notification && op.operation_type === "add_card_comment" && comment?.author_kind === "user") {
          const rawItemId=comment.item_id;
          const itemId=rawItemId == null ? undefined : Number(rawItemId);
          const itemTarget=itemId === undefined ? undefined : change.committedCard?.items?.find(item=>item.id===itemId);
          const confirmedItemIds=await cards.listConfirmedItemsSinceLastCommentDelivery(card.id,op.created_at);
          notification=buildCardChangeNotification(change,comment,fallback,{
            ...(itemTarget ? {itemTarget:{id:itemTarget.id,title:itemTarget.title,state:itemTarget.state,confirmed:itemTarget.confirmed !== null}} : {}),confirmedItemIds,
          });
        }
        const answeredQuestion=op.operation_type === "answer_card_question" ? detail.questions.find(q=>q.id === payload.question_id) : undefined;
        // 전달 대상은 배달 시점 카드의 현재 담당이다. 담당이 있으면 질문을 만든 옛 세션으로 되돌아가지 않는다.
        const answerTargetSessionId=answeredQuestion
            ? cardQuestionDeliveryTarget(card,{session_id:typeof answeredQuestion.session_id === "string" ? answeredQuestion.session_id : null}) : null;
        const answerTarget=answerTargetSessionId ? await this.options.repository.ownerSession(answerTargetSessionId) : null;
        const mergeAnswer=notification && answerTargetSessionId !== null && answerTargetSessionId === notification.sessionId;
        if (notification && !mergeAnswer) {
          try {
            await this.deliver(card,notification.sessionId,notification.text,notification);
            if (comment) await cards.markCommentDelivered(card.id,commentId);
          } catch (error) { this.options.warn(`card ${card.id} change delivery failed: ${String(error)}`); }
        }
        if (threadQuestion && comment) {
          const threadTarget=cardQuestionDeliveryTarget(card,{session_id:typeof threadQuestion.session_id === "string" ? threadQuestion.session_id : null});
          if (threadTarget) {
            const text=buildCardQuestionThreadNotice(card,{
              id:String(threadQuestion.id),text:String(threadQuestion.text),title:threadQuestion.title == null ? null : String(threadQuestion.title),
              answer:threadQuestion.answer == null ? null : String(threadQuestion.answer),
              selected_option:threadQuestion.selected_option == null ? null : String(threadQuestion.selected_option),
            },String(comment.body));
            try {
              await this.deliver(card,threadTarget,text,{deliveryId:`card:${card.id}:question-comment:${op.id}:${threadTarget}`,actorKind:op.actor_kind,actorSessionId:op.actor_session_id});
              await cards.markCommentDelivered(card.id,commentId);
            } catch (error) { this.options.warn(`card ${card.id} question thread delivery failed: ${String(error)}`); }
          }
        }
        if (op.operation_type === "set_card_status" && previousStatus !== "review" && payload.status === "review")
            await this.notify(card, "review");
        if (op.operation_type === "answer_card_question") {
            const q = answeredQuestion;
            const autoResumed=previousStatus === "blocked" && change.committedCard?.status === "running";
            if (answerTargetSessionId && answerTarget) {
                const answer=buildCardQuestionAnswerNotice(card,{
                    id:String(q!.id),text:String(q!.text),title:q!.title == null ? null : String(q!.title),
                    answer:String(q!.answer),selected_option:q!.selected_option == null ? null : String(q!.selected_option),
                });
                try {
                    if (mergeAnswer) await this.deliver(card,answerTargetSessionId,`${notification!.text}\n${answer}`,notification!);
                    else await this.deliver(card,answerTargetSessionId,answer,{deliveryId:`card:${card.id}:answer:${op.id}:${answerTargetSessionId}`,actorKind:op.actor_kind,actorSessionId:op.actor_session_id});
                } catch (error) { this.options.warn(`card ${card.id} answer delivery failed: ${String(error)}`); }
            }
            if (autoResumed && !answerTarget) {
                const latest=await cards.getCard(card.id);
                if (latest?.card.status === "running" && latest.card.version === change.committedCard!.version)
                    await cards.setCardStatus({ actorKind: "system", actorSessionId: null, cardId: card.id, status: "queued", expectedVersion: latest.card.version });
            }
        }
        if (card.status === "queued" || op.operation_type === "reorder_card_queue" || op.operation_type === "answer_card_question" || (previousStatus !== "review" && card.status === "review"))
            await this.dispatchOnce();
        const committed = change.committedCard;
        const kind = committed ? selectCardBoardNotice({operationType:op.operation_type, actorKind:op.actor_kind, previousStatus, committed, payload}) : null;
        if (kind && committed) {
            let text: string | null;
            if (kind === "blocked") {
                const owner = committed.assignee_session_id ? await this.options.repository.ownerSession(committed.assignee_session_id) : null;
                const autoResume = committed.blocked_kind === "limit" && committed.limit_resume_session_id===committed.assignee_session_id ? committed.limit_resume_at : null;
                text = autoResume ? null : buildCardBlockedNotice(committed, owner);
            } else if (kind === "question") {
                const question = [...detail.questions].reverse().find(q => q.answer == null && q.withdrawn_at == null
                    && q.session_id === op.actor_session_id && q.text === payload.text);
                text = buildCardQuestionNotice(committed, payload.text as string, payload.options as string[], question?.id as string | undefined);
            } else if (kind === "review") text = buildCardReviewNotice(committed);
            else text = buildCardDoneNotice(committed);
            if (text !== null) for (const sessionId of await this.options.repository.boardSessions(committed.id)) {
                if (sessionId === committed.assignee_session_id || sessionId === op.actor_session_id) continue;
                const deliveryId = `card-${kind}:${committed.id}:${op.id}:${sessionId}`;
                try {
                    if (await this.options.deliveryExists(deliveryId)) continue;
                    await this.options.sendMessage(sessionId, text, undefined, {deliveryId, actorKind:"system", actorSessionId:null});
                } catch (error) { this.options.warn(`card ${committed.id} ${kind} notice delivery failed: ${String(error)}`); }
            }
        }
    }
    private async deliver(card:CardRow, sessionId:string, text:string, changeDelivery?:CardChangeDelivery):Promise<void> {
        if(card.attachments?.length) return this.options.sendMessage(sessionId,text,undefined,changeDelivery,card.attachments);
        if(changeDelivery) return this.options.sendMessage(sessionId,text,undefined,changeDelivery);
        return this.options.sendMessage(sessionId,text);
    }
    private async notify(card: CardRow, kind: "question" | "review", question?: string): Promise<void> {
        try {
            const session = await this.options.repository.latestSession(card.id);
            await this.options.notify({ nodeId: session?.node_id ?? card.node_id ?? "eiaserinnys", cardId: card.id, folderId: card.folder_id, title: card.title, kind,
                ...(question === undefined ? {} : { question }) });
        } catch (error) {
            this.options.warn(`card ${card.id} notification failed: ${String(error)}`);
        }
    }
    private async reconcileTerminal(sessionId: string): Promise<void> {
        const session = await this.options.repository.session(sessionId);
        if (!session || !isTerminalSessionStatus(session.status))
            return;
        const cards = await this.options.cards();
        const detail = await cards.getCard(session.card_id);
        if (!detail || detail.card.status !== "running" || detail.card.assignee_session_id !== sessionId)
            return;
        if (await this.options.repository.hasExplicitWork(session.card_id)) return;
        if (!isUsageLimitTermination(session)) return;
        // 일반 세션 모델 대체 pending이면 다음 세대가 이어받으므로 막힘으로 다루지 않는다.
        if (hasPendingSessionModelFallback(session.metadata)) return;
        await this.blockForLimit(detail.card, session);
    }
    private async blockForLimit(card: CardRow, session: LimitResumeOwner): Promise<void> {
        const cards = await this.options.cards();
        await cards.blockCardForLimit({cardId:card.id,expectedVersion:card.version,sessionId:session.session_id,terminationEventId:session.termination_event_id});
    }

    private async wakeAwaitingVerifications(now: number): Promise<void> {
        const cards = await this.options.cards();
        for (const card of await this.options.repository.awaitingVerification(new Date(now))) {
            try {
                await this.wakeAwaitingVerification(card, cards);
            } catch (error) { this.options.warn(`card ${card.id} verification wake failed: ${String(error)}`); }
        }
    }
    private async wakeAwaitingVerification(card: DispatchCard, cards: CardControlPlaneService): Promise<void> {
        const owner = card.assignee_session_id ? await this.options.repository.ownerSession(card.assignee_session_id) : null;
        if (!owner) {
            await this.blockVerificationWake(card, cards, "담당 세션이 없습니다");
            return;
        }
        const wakeAt = new Date(card.wake_at!).toISOString();
        const deliveryId = `card-verify-wake:${card.id}:${wakeAt}`;
        try {
            if (!(await this.options.deliveryExists(deliveryId)))
                await this.deliver(card, owner.session_id,
                    `[검증 대기 시각] 기다리던 것: ${card.waiting_for}. 확인해 결과를 항목에 남기고, 아직이면 다시 검증 대기로 둔다.`,
                    { deliveryId, actorKind: "system", actorSessionId: null });
        } catch (error) {
            await this.options.abandonDelivery(deliveryId, String(error));
            await this.blockVerificationWake(card, cards, String(error));
            return;
        }
        await cards.resumeVerificationCard({ cardId: card.id, sessionId: owner.session_id, wakeAt });
    }
    private async blockVerificationWake(card: DispatchCard, cards: CardControlPlaneService, reason: string): Promise<void> {
        await cards.setCardStatus({ actorKind: "system", actorSessionId: null, cardId: card.id, status: "blocked",
            blockedKind: "no_report", blockedDetail: `검증 대기 시각에 담당을 깨우지 못함: ${reason}`, expectedVersion: card.version });
    }
    private async resumeAutoLimits(): Promise<void> {
        for (const card of await this.options.repository.limited()) {
            try {
                await this.resumeAutoLimitedCard(card);
            } catch (error) { this.options.warn(`card ${card.id} limit auto resume failed: ${String(error)}`); }
        }
    }
    private async resumeAutoLimitedCard(card: DispatchCard): Promise<void> {
        const owner = card.assignee_session_id ? await this.options.repository.ownerSession(card.assignee_session_id) : null;
        if (!owner) return;
        if (await this.options.repository.hasPendingExecution(card.id)) return;
        const cards = await this.options.cards();
        const resumeAt=card.limit_resume_at;
        if (card.limit_resume_session_id!==owner.session_id || !resumeAt || new Date(resumeAt).getTime()>(this.options.now?.() ?? Date.now())) return;
        const target = this.options.resolveTarget({ ...card, node_id: owner.node_id, assignee_agent_id: owner.agent_id }, owner.model_preset);
        if (!target.available) return;
        try {
            if (this.options.prepareAttachments)
                await this.options.prepareAttachments(card, owner.node_id!);
            else
                cardAttachmentPaths(card.attachments ?? [], owner.node_id!);
        } catch (error) {
            await cards.setCardStatus({ actorKind: "system", actorSessionId: null, cardId: card.id, expectedVersion: card.version,
                status: "blocked", blockedKind: "no_report", blockedDetail: String(error) });
            return;
        }
        const latest=(await cards.getCard(card.id))?.card;
        if (!latest || latest.status!=="blocked" || latest.blocked_kind!=="limit" || latest.archived
          || latest.assignee_session_id!==owner.session_id || latest.limit_resume_session_id!==owner.session_id
          || !latest.limit_resume_at || new Date(latest.limit_resume_at).getTime()!==new Date(resumeAt).getTime()
          || await this.options.repository.hasPendingExecution(card.id)) return;
        const deliveryId = `card-limit-resume:${card.id}:${owner.termination_event_id}:${Date.now()}`;
        try {
            await this.deliver(card, owner.session_id, "한도가 풀려 재개한다. 첫 행동은 WIP 커밋이다.",
                { deliveryId, actorKind: "system", actorSessionId: null });
        } catch (error) {
            await this.options.abandonDelivery(deliveryId, String(error));
            this.options.warn(`card ${card.id} limit auto resume delivery failed: ${String(error)}`);
            return;
        }
        await cards.resumeLimitedCard({cardId:card.id,sessionId:owner.session_id,resumeAt:new Date(resumeAt).toISOString(),now:this.options.now?.() ?? Date.now()});
    }
    private async resumeLimits(): Promise<void> {
        const cards = await this.options.cards();
        for (const card of await this.options.repository.limited()) {
            const session = card.assignee_session_id ? await this.options.repository.ownerSession(card.assignee_session_id) : null;
            if (!session || card.limit_resume_session_id!==session.session_id || card.limit_resume_at!==null) continue;
            const target = this.options.resolveTarget({...card,node_id:session.node_id,assignee_agent_id:session.agent_id}, session.model_preset);
            if (!target.available)
                continue;
            const settings = await this.options.repository.settings();
            const occupancy = await this.options.repository.occupancy();
            if ((occupancy[target.nodeId] ?? 0) >= (settings.nodeConcurrency[target.nodeId] ?? settings.nodeConcurrency.default))
                continue;
            {
                try {
                    if (this.options.prepareAttachments)
                        await this.options.prepareAttachments(card, session.node_id!);
                    else
                        cardAttachmentPaths(card.attachments ?? [], session.node_id!);
                } catch(error) {
                    await cards.setCardStatus({actorKind:"system",actorSessionId:null,cardId:card.id,expectedVersion:card.version,status:"blocked",blockedKind:"no_report",blockedDetail:String(error)});
                    continue;
                }
                await cards.resumeDispatchedCard({ cardId: card.id, expectedVersion: card.version, sessionId: session.session_id });
                await this.deliver(card,session.session_id, "한도가 풀려 재개한다. 첫 행동은 WIP 커밋이다.");
            }
        }
    }
    private async dispatchOnce(): Promise<void> {
        if (await this.options.orchestration?.enabled()) { await this.options.orchestration!.kick(); return; }
        const cards = await this.options.cards();
        const settings = await this.options.repository.settings();
        let queue = await this.options.repository.queued();
        for (const card of queue.filter(c => c.assignee_kind === "human" || !c.assignee_agent_id)) {
            if (card.blocked_detail !== "담당 에이전트 없음")
                await cards.noteMissingAssignee({ cardId: card.id, expectedVersion: card.version });
        }
        while (queue.length) {
            const targets = new Map<string, CardTarget>();
            for (const card of queue)
                if (card.assignee_kind !== "human" && card.assignee_agent_id)
                    targets.set(card.id, this.options.resolveTarget(card));
            const occupancy = await this.options.repository.occupancy();
            const card = pickNextCard(queue, occupancy, settings.nodeConcurrency, c => targets.get(c.id)!.nodeId);
            if (!card)
                break;
            queue = queue.filter(c => c.id !== card.id);
            const target = targets.get(card.id)!;
            if (!target.available) continue;
            const detail = await cards.getCard(card.id);
            if (!detail || detail.card.status !== "queued")
                continue;
            const answers = detail.questions.filter(q => q.answer !== null).map(q => `${String(q.text)} → ${String(q.answer)}`).join("\n");
            const running = await this.options.repository.running();
            const prompt = buildCardPrompt({ cardId: card.id, title: card.title, folderName: card.folder_name, request: card.request,
                brief: [card.brief, answers].filter(Boolean).join("\n"), reason: await this.options.repository.rejectionReason(card.id),
                comments: detail.comments.filter(comment => comment.author_kind === "user").map(comment => ({ id:String(comment.id),createdAt: comment.created_at as Date | string, body: String(comment.body) })),
                running: running.filter(c => c.id !== card.id).map(c => ({ title: c.title, folderName: c.folder_name })) });
            const sessionId = randomUUID();
            await cards.recordDispatch({ cardId: card.id, expectedVersion: detail.card.version, sessionId, nodeId: target.nodeId });
            try {
                await this.options.launch({ sessionId, cardId: card.id, prompt, nodeId: target.nodeId, agentId: target.agentId, modelPreset: target.modelPreset, folderId: card.folder_id, attachments: detail.card.attachments ?? [] });
            }
            catch (error) {
                // Confirmed create rejection leaves the card for the director to retry.
                const current = await cards.getCard(card.id);
                if (current?.card.status === "running")
                    await cards.setCardStatus({ actorKind: "system", actorSessionId: null, cardId: card.id, status: "blocked", blockedKind: "no_report", blockedDetail: `세션 생성 실패: ${String(error)}`, expectedVersion: current.card.version });
                this.options.warn(`card ${card.id} create failed: ${String(error)}`);
                continue;
            }
            await this.reconcileTerminal(sessionId);
        }
    }
}
