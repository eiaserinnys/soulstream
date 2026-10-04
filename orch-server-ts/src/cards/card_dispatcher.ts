import type { CardAttachment } from "@soulstream/wire-schema/card-attachments";
import { cardAttachmentPaths } from "./card_attachment_paths.js";
import { buildCardChangeNotification, type CardChangeDelivery } from "./card_change_notification.js";
import { buildCardStatusReminder, MAX_REMINDERS_PER_TICK } from "./card_status_reminder.js";
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
    deliveryExists: (deliveryId: string) => Promise<boolean>;
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
    checkLimits(): Promise<void> { return this.enqueue(async () => { if (await this.options.orchestration?.enabled()) { await this.options.orchestration!.kick(); return; } await this.resumeLimits(); await this.dispatchOnce(); }); }
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
              const limited=isUsageLimitTermination(work.terminal_session);
              if (!limited) continue;
              const cards=await this.options.cards(),detail=await cards.getCard(work.card_id);
              if (detail?.card.status === "running" && detail.card.assignee_session_id === sessionId)
                await cards.setCardStatus({actorKind:"system",actorSessionId:null,cardId:work.card_id,expectedVersion:detail.card.version,status:"blocked",blockedKind:"limit",blockedDetail:"세션 사용량 한도"});
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
        const fallback=comment && !change.previousAssigneeSessionId ? await this.options.repository.latestDispatchedSessionId(card.id) : null;
        const notification=buildCardChangeNotification(change,comment,fallback);
        const answeredQuestion=op.operation_type === "answer_card_question" ? detail.questions.find(q=>q.id === payload.question_id) : undefined;
        const questionSession=answeredQuestion && typeof answeredQuestion.session_id === "string"
            ? await this.options.repository.ownerSession(answeredQuestion.session_id) : null;
        const mergeAnswer=notification && questionSession && answeredQuestion?.session_id === notification.sessionId;
        if (notification && !mergeAnswer) {
          try {
            await this.deliver(card,notification.sessionId,notification.text,notification);
            if (comment) await cards.markCommentDelivered(card.id,commentId);
          } catch (error) { this.options.warn(`card ${card.id} change delivery failed: ${String(error)}`); }
        }
        if (op.operation_type === "ask_card_question" || op.operation_type === "set_card_status"
            && previousStatus !== "blocked" && payload.status === "blocked" && payload.blocked_kind === "question") {
            await this.notify(card, "question", String(payload.text ?? card.blocked_detail ?? ""));
        }
        if (op.operation_type === "set_card_status" && previousStatus !== "review" && payload.status === "review")
            await this.notify(card, "review");
        if (op.operation_type === "answer_card_question") {
            const q = answeredQuestion;
            const autoResumed=previousStatus === "blocked" && change.committedCard?.status === "running";
            const resumeCurrent=autoResumed && card.status === "running" && card.version === change.committedCard!.version;
            if (questionSession) {
                const answer=`질문에 답이 왔습니다: ${String(q!.text)} → ${String(q!.answer)}. ` + (resumeCurrent
                    ? "질문 대기가 해제됐습니다. 이어서 진행합니다."
                    : `현재 카드 상태는 ${card.status} 입니다. 답변 수신만으로 카드 상태를 바꾸거나 완료된 작업을 재착수하지 않습니다.`);
                try {
                    if (mergeAnswer) await this.deliver(card,String(q!.session_id),`${notification!.text}\n${answer}`,notification!);
                    else await this.deliver(card,String(q!.session_id),answer);
                } catch (error) { this.options.warn(`card ${card.id} answer delivery failed: ${String(error)}`); }
            }
            if (autoResumed && !questionSession) {
                const latest=await cards.getCard(card.id);
                if (latest?.card.status === "running" && latest.card.version === change.committedCard!.version)
                    await cards.setCardStatus({ actorKind: "system", actorSessionId: null, cardId: card.id, status: "queued", expectedVersion: latest.card.version });
            }
        }
        if (card.status === "queued" || op.operation_type === "reorder_card_queue" || op.operation_type === "answer_card_question" || (previousStatus !== "review" && card.status === "review"))
            await this.dispatchOnce();
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
        await cards.setCardStatus({ actorKind: "system", actorSessionId: null, cardId: session.card_id, expectedVersion: detail.card.version,
            status: "blocked", blockedKind: "limit", blockedDetail: "세션 사용량 한도" });
    }
    private async resumeLimits(): Promise<void> {
        const cards = await this.options.cards();
        for (const card of await this.options.repository.limited()) {
            const session = card.assignee_session_id ? await this.options.repository.ownerSession(card.assignee_session_id) : null;
            const target = this.options.resolveTarget(card, session?.model_preset);
            if (!target.available)
                continue;
            const settings = await this.options.repository.settings();
            const occupancy = await this.options.repository.occupancy();
            if ((occupancy[target.nodeId] ?? 0) >= (settings.nodeConcurrency[target.nodeId] ?? settings.nodeConcurrency.default))
                continue;
            if (session && isUsageLimitTermination(session)) {
                try { cardAttachmentPaths(card.attachments ?? [], session.node_id!); } catch(error) {
                    await cards.setCardStatus({actorKind:"system",actorSessionId:null,cardId:card.id,expectedVersion:card.version,status:"blocked",blockedKind:"no_report",blockedDetail:String(error)});
                    continue;
                }
                await cards.resumeDispatchedCard({ cardId: card.id, expectedVersion: card.version, sessionId: session.session_id });
                await this.deliver(card,session.session_id, "한도가 풀려 재개한다. 첫 행동은 WIP 커밋이다. 이어서 카드 규칙대로 진행한다.");
            }
            else
                await cards.setCardStatus({ actorKind: "system", actorSessionId: null, cardId: card.id, status: "queued", expectedVersion: card.version });
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
                comments: detail.comments.filter(comment => comment.author_kind === "user").map(comment => ({ createdAt: comment.created_at as Date | string, body: String(comment.body) })),
                running: running.filter(c => c.id !== card.id).map(c => ({ title: c.title, folderName: c.folder_name })),
                queued: queue.map(c => ({ title: c.title, folderName: c.folder_name })) });
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
