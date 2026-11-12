import type { NodeRegistryEvent } from "../node/registry_types.js";
import { cardBoardEntries,cardSituationText,clip,dismissalMatches,isServerBoardKey,type BoardCard,type BoardQuestion,type DismissedCard } from "./card_board_entries.js";
import { readBoardCards,readCardBoardSessions } from "./card_board_connections.js";
export { readCardBoardSessions } from "./card_board_connections.js";
export { clip } from "./card_board_entries.js";
import { cardQuestionState } from "../cards/card_question_rules.js";
import { cardQuestionOptionLabels } from "@soulstream/wire-schema/card-questions";
import { projectCardQuestionRows } from "../cards/card_attachment_projection.js";
import { readPersistentEnabled } from "@soulstream/wire-schema/persistent-session-settings";
import {
  parsePersistentReportEntry, parsePersistentReportReply, readPersistentReport,
  CARD_ENTRY_KEY_PREFIX, CARD_QUESTION_KEY_PREFIX,
  PERSISTENT_REPORT_KEY, PERSISTENT_REPORT_LIMIT, PERSISTENT_REPORT_METADATA_TYPE,
  REPORT_TIMELINE_EVENT_TYPE, REPORT_TIMELINE_QUESTION_CLOSED_EVENT_TYPE,
  type PersistentReportEntry, type PersistentReportIssue, type PersistentReportResult,
  type ReportTimelineLine, type ReportTimelineQuestionClosed, type ReportTimelineStatus,
} from "@soulstream/wire-schema/persistent-report";
import { isCardOffBoard, type CardStatus, type SqlClient, type RepositorySql } from "../cards/control_plane/card_types.js";
import type { AppendReportTimeline } from "./report_timeline_publisher.js";

export type PersistentReportUpdate = { agent_session_id: string; node_id: string | null; persistent_report: PersistentReportEntry[] };
export type PublishPersistentReports = (updates: PersistentReportUpdate[]) => void | Promise<void>;
export type OnPersistentReportPosted = (input: { sessionId: string; entry: PersistentReportEntry }) => void | Promise<void>;
/** 판에서 온 답을 어떻게 처리할지 라우트에 알리는 결정. reject는 사용자에게 그대로 돌려줄 오류다. */
export type PersistentReportReplyDecision =
  | { action: "none" }
  | { action: "card"; cardId: string; questionId: string; option: string }
  | { action: "card-acked"; cardId: string }
  | { action: "reject"; cardId: string; code: string; status: number; message: string };
type ReportRow = Record<string, unknown> & { session_id: string; node_id: string | null; metadata: unknown; session_type: string | null };
type CardQuestionRow = { card_id: string; options: string[] | null; answer: string | null; withdrawn_at: Date | null };
type CardStateRow = BoardCard;
const CARD_TIMELINE_STATUSES = new Set(["review", "blocked", "done", "cancelled", "on_hold"]);

export class PersistentReportService {
  constructor(
    private readonly sql: SqlClient,
    private readonly publish: PublishPersistentReports,
    private readonly onPosted?: OnPersistentReportPosted,
    private readonly appendTimeline?: AppendReportTimeline,
  ) {}
  async get(sessionId: string): Promise<PersistentReportEntry[]> {
    const row = (await this.sql<ReportRow[]>`SELECT metadata FROM sessions WHERE session_id=${sessionId}`)[0];
    return readPersistentReport(row?.metadata);
  }
  async put(sessionId: string, input: unknown): Promise<PersistentReportResult> {
    let directChanged=false;
    const result = await this.mutate(sessionId, async (sql, entries) => {
      const rawKey = input !== null && typeof input === "object" && "key" in input && typeof (input as { key: unknown }).key === "string"
        ? (input as { key: string }).key : null;
      if (rawKey !== null && (rawKey.startsWith(CARD_QUESTION_KEY_PREFIX) || rawKey.startsWith(CARD_ENTRY_KEY_PREFIX)))
        return [{ path: "key", reason: "서버가 쓰는 key입니다" }];
      const parsed = parsePersistentReportEntry(input);
      if (!parsed.ok) return parsed.errors;
      const cards = parsed.value.card_numbers.length
        ? await sql<{ id: string }[]>`SELECT id FROM cards WHERE number=ANY(${sql.array(parsed.value.card_numbers)}::integer[])` : [];
      for (const card of cards) {
        if (await this.isBoardCard(sql, sessionId, card.id))
          return [{ path: "card_numbers", reason: "이 카드는 서버가 판에 올립니다. 담당이 상황판과 카드 질문을 쓰게 하세요" }];
      }
      const previous=entries.find(entry=>entry.key===parsed.value.key);
      const errors=await this.upsertEntry(sql, entries, parsed.value);
      directChanged=errors===null&&(!previous||!sameReportEntry(previous,parsed.value));
      return errors;
    });
    const key = input !== null && typeof input === "object" && "key" in input
      && typeof (input as { key: unknown }).key === "string"
      ? (input as { key: string }).key
      : undefined;
    if (result.ok && directChanged && key !== undefined) {
      const entry = result.persistent_report.find(candidate => candidate.key === key && candidate.state === "open");
      if (entry) {
        if (this.appendTimeline) {
          let lineKey = `report:${entry.key}`;
          let cardId: string | null = null;
          let cardNumber: number | null = null;
          if (entry.card_numbers.length === 1) {
            const number = entry.card_numbers[0]!;
            const card = (await this.sql<{ id: string }[]>`SELECT id FROM cards WHERE number=${number}`)[0];
            if (card) {
              lineKey = `card:${card.id}`;
              cardId = card.id;
              cardNumber = number;
            }
          }
          const line: ReportTimelineLine = {
            line_key: lineKey,
            status: entry.kind === "ask" ? "question" : "report",
            title: entry.title,
            detail: entry.context,
            card_id: cardId,
            card_number: cardNumber,
          };
          await this.appendTimeline(sessionId, { type: REPORT_TIMELINE_EVENT_TYPE, ...line });
        }
        await this.onPosted?.({ sessionId, entry });
      }
    }
    return result;
  }
  /**
   * 담당이 남긴 카드 질문을 그 카드를 시킨 PAS(감독 세션)의 판에만 `cq_<질문ID>` 장으로 올린다.
   * 감독 PAS가 없으면(사용자가 웹에서 직접 만든 카드 등) 어느 판에도 오르지 않고 빈 결과를 돌려준다.
   */
  async placeQuestion(cardId: string, questionId: string): Promise<{ placed: string[]; failed: string[]; changed: string[] }> {
    const placed: string[] = [];
    const failed: string[] = [];
    const changed: string[] = [];
    for (const sessionId of await this.connectedSessions(this.sql, cardId)) {
      const result = await this.putQuestion(sessionId, questionId);
      if(result.ok) {
        const q=(await this.sql<BoardQuestion[]>`SELECT * FROM card_questions WHERE id=${questionId}`)[0];
        const card=(await this.sql<BoardCard[]>`SELECT * FROM cards WHERE id=${cardId}`)[0];
        if(q&&card&&q.answer===null&&q.withdrawn_at===null)
          await this.appendTimeline?.(sessionId,{type:REPORT_TIMELINE_EVENT_TYPE,line_key:`card:${cardId}`,status:"question",title:clip(card.title,60),detail:clip(q.text,120),card_id:cardId,card_number:card.number,question_id:questionId});
      }
      if (result.ok) {
        placed.push(sessionId);
        if (result.changed) changed.push(sessionId);
      } else failed.push(sessionId);
    }
    return { placed, failed, changed };
  }
  /** Compatibility entry point: rebuild the board from facts, without partially storing one question. */
  async putQuestion(sessionId: string, questionId: string): Promise<PersistentReportResult> {
    const question=(await this.sql<BoardQuestion[]>`SELECT * FROM card_questions WHERE id=${questionId}`)[0];
    if(!question)return {ok:false,code:"INVALID_REPORT",errors:[{path:"question_id",reason:"질문이 없습니다"}],entries:[]};
    return this.mutate(sessionId,async()=>null);
  }
  private async upsertEntry(sql: RepositorySql, entries: PersistentReportEntry[], entry: Omit<PersistentReportEntry, "updated_at">): Promise<PersistentReportIssue[] | null> {
    const cards = entry.card_numbers.length ? await sql<{ number: number; id: string }[]>`SELECT number,id FROM cards WHERE number=ANY(${sql.array(entry.card_numbers)}::integer[])` : [];
    if (cards.length !== new Set(entry.card_numbers).size) return [{ path: "card_numbers", reason: "없는 카드 번호가 있습니다" }];
    if (entry.question_id) {
      const q = (await sql<{ card_id: string }[]>`SELECT card_id FROM card_questions WHERE id=${entry.question_id}`)[0];
      if (!q || (cards.length > 0 && !cards.some(c => c.id === q.card_id))) return [{ path: "question_id", reason: "질문이 없거나 묶인 카드에 속하지 않습니다" }];
    }
    const index = entries.findIndex(e => e.key === entry.key);
    if (index < 0 && entries.filter(e=>!isServerBoardKey(e.key)).length >= PERSISTENT_REPORT_LIMIT) return [{ path: "entries", reason: "장은 12개까지입니다" }];
    if (index >= 0 && sameReportEntry(entries[index]!, entry)) return null;
    const stored = { ...entry, updated_at: new Date().toISOString() };
    if (index < 0) entries.push(stored); else entries[index] = stored;
    return null;
  }
  async remove(sessionId: string, key: string): Promise<PersistentReportResult> {
    return this.mutate(sessionId, async (sql, entries, dismissed) => {
      if (typeof key !== "string" || !PERSISTENT_REPORT_KEY.test(key)) return [{ path: "key", reason: "올바른 장 key가 필요합니다" }];
      if(key.startsWith(CARD_QUESTION_KEY_PREFIX))return [{path:"key",reason:"질문 장은 답하거나 철회하면 내려갑니다"}];
      if(key.startsWith(CARD_ENTRY_KEY_PREFIX)){
        const card=(await sql<BoardCard[]>`SELECT * FROM cards WHERE id=${key.slice(CARD_ENTRY_KEY_PREFIX.length)}`)[0];
        if(card&&entries.some(e=>e.key===key)){
          dismissed.splice(0,dismissed.length,...dismissed.filter(d=>d.card_id!==card.id),
            {card_id:card.id,status:card.status,blocked_kind:card.blocked_kind,status_changed_at:new Date(card.status_changed_at).toISOString()});
        }
      }
      const index = entries.findIndex(e => e.key === key);
      if (index >= 0) entries.splice(index, 1);
      return null;
    });
  }
  /**
   * 사람이 판에서 보낸 답을 해석한다. 카드 질문 장이면 카드 답으로 넘기고(라우트가 기존 answer_card_question 경로를 호출),
   * 일반 장이면 지금까지처럼 장 상태만 answered로 바꾼다. 카드 질문 장 자체는 카드 답이 커밋될 때 syncCard가 내린다.
   */
  async acceptReply(sessionId: string, context: unknown, caller: Record<string, unknown> | undefined): Promise<PersistentReportReplyDecision> {
    if (!caller || !["browser", "soul-app", "slack"].includes(String(caller.source))) return { action: "none" };
    const reply = parsePersistentReportReply(context);
    if (!reply) return { action: "none" };
    let plan: { errors: PersistentReportIssue[] | null; decision: PersistentReportReplyDecision } = { errors: null, decision: { action: "none" } };
    const result = await this.mutate(sessionId, async (sql, entries) => {
      const index = entries.findIndex(e => e.key === reply.key && e.kind === "ask" && e.state === "open");
      if (index >= 0) {
        const entry = entries[index]!;
        if (entry.question_id) { plan = await this.cardQuestionDecision(sql, entry.question_id, reply.option); return plan.errors; }
        entries[index] = { ...entry, state: "answered", answer: reply.option, updated_at: new Date().toISOString() };
        plan = { errors: null, decision: { action: "none" } };
        return null;
      }
      plan = await this.cardQuestionResendDecision(sql, reply.key, reply.option);
      return plan.errors;
    });
    if (plan.decision.action === "reject") return plan.decision;
    return result.ok ? plan.decision : { action: "none" };
  }
  private async cardQuestionDecision(sql: RepositorySql, questionId: string, option: string): Promise<{ errors: PersistentReportIssue[] | null; decision: PersistentReportReplyDecision }> {
    const question = (await sql<CardQuestionRow[]>`SELECT card_id,options,answer,withdrawn_at FROM card_questions WHERE id=${questionId}`)[0];
    if (!question) return { errors: null, decision: { action: "none" } };
    const state = cardQuestionState(question);
    if (state === "withdrawn") return rejectDecision(question.card_id, "CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    if (state === "answered") return question.answer === option
      ? { errors: null, decision: { action: "card-acked", cardId: question.card_id } }
      : rejectDecision(question.card_id, "CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    const options = cardQuestionOptionLabels(question.options) ?? [];
    if (options.length > 0 && !options.includes(option)) return rejectDecision(question.card_id, "CARD_QUESTION_OPTION_INVALID", 422, "선택지에 없는 답입니다");
    const card = (await sql<{ status: string }[]>`SELECT status FROM cards WHERE id=${question.card_id}`)[0];
    if (!card) return rejectDecision(question.card_id, "CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    return { errors: null, decision: { action: "card", cardId: question.card_id, questionId, option } };
  }
  /** 예약 key(`cq_` + 질문ID)를 다시 받았을 때. 장이 이미 내려가 있어도 질문 상태로 판정한다. */
  private async cardQuestionResendDecision(sql: RepositorySql, key: string, option: string): Promise<{ errors: PersistentReportIssue[] | null; decision: PersistentReportReplyDecision }> {
    if (!key.startsWith(CARD_QUESTION_KEY_PREFIX)) return { errors: null, decision: { action: "none" } };
    return this.cardQuestionDecision(sql, key.slice(CARD_QUESTION_KEY_PREFIX.length), option);
  }
  /**
   * After a card commit, rebuild connected boards and boards holding its old output.
   * The target relation is read after commit; no separate pre-commit connection state is stored.
   */
  async syncCard(cardId: string): Promise<void> {
    const targets = await this.connectedSessions(this.sql, cardId);
    const related = await this.sql<{session_id:string}[]>`WITH candidates AS MATERIALIZED (
      SELECT session_id,metadata FROM sessions WHERE metadata @> '[{"type":"persistent_report"}]'::jsonb
    ) SELECT session_id FROM candidates
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(metadata) AS m,
          jsonb_array_elements(m->'value'->'entries') AS e
          WHERE m->>'type'='persistent_report' AND
            (e->'card_numbers' @> jsonb_build_array((SELECT number FROM cards WHERE id=${cardId}))
              OR e->>'question_id' IN (SELECT id FROM card_questions WHERE card_id=${cardId})
              OR e->>'key' = ${CARD_ENTRY_KEY_PREFIX} || ${cardId}))`;
    for (const row of related) targets.add(row.session_id);
    for (const sessionId of targets) await this.syncBoard(sessionId);
  }
  async recordCardTimeline(cardId: string): Promise<void> {
    if (!this.appendTimeline) return;
    const card = (await this.sql<CardStateRow[]>`
      SELECT id,number,title,status,archived,blocked_kind,blocked_detail,now FROM cards WHERE id=${cardId}
    `)[0];
    if (!card || card.archived || !CARD_TIMELINE_STATUSES.has(card.status)) return;
    if (card.status === "blocked" && card.blocked_kind === "question") return;
    const status = card.status as ReportTimelineStatus;
    const detail = status === "review" || status === "blocked"
      ? clip(cardSituationText(card), 120)
      : "";
    const line: ReportTimelineLine = {
      line_key: `card:${card.id}`,
      status,
      title: clip(card.title, 60),
      detail,
      card_id: card.id,
      card_number: card.number,
    };
    for (const sessionId of await this.connectedSessions(this.sql, card.id)) {
      await this.appendTimeline?.(sessionId, { type: REPORT_TIMELINE_EVENT_TYPE, ...line });
    }
  }
  /** Activation and boot use the same full-board write as ordinary mutations. */
  async syncBoard(sessionId:string):Promise<PersistentReportResult>{return this.mutate(sessionId,async()=>null,true);}
  /** The committed metadata event is emitted by set_session_persistent as well as settings writes. */
  async acceptNodeEvents(events:readonly NodeRegistryEvent[]):Promise<void>{
    for(const event of events){
      if(event.type!=="node_session_event")continue;
      const payload=event.data.event as Record<string,unknown>|undefined;
      if(payload?.type==="metadata"&&payload.metadata_type==="persistent_session"&&typeof event.data.agentSessionId==="string")
        await this.syncBoard(event.data.agentSessionId);
    }
  }
  async syncActiveBoards(warn:(message:string)=>void):Promise<void>{
    const rows=await this.sql<ReportRow[]>`SELECT session_id,metadata,session_type FROM sessions WHERE metadata @> '[{"type":"persistent_session"}]'::jsonb`;
    for(const row of rows)if(readPersistentEnabled(row.metadata)&&row.session_type!=="llm"){
      try{await this.syncBoard(row.session_id);}catch(error){warn(`PAS board ${row.session_id} refresh failed: ${String(error)}`);}
    }
  }
  private async project(sql:RepositorySql,sessionId:string,entries:PersistentReportEntry[],dismissed:DismissedCard[],enabled:boolean){
    const cards=await readBoardCards(sql,sessionId);
    const questionRows=cards.length?await sql<BoardQuestion[]>`SELECT * FROM card_questions WHERE card_id=ANY(${sql.array(cards.map(c=>c.id))}::text[])`:[];
    const questions=await projectCardQuestionRows(sql,questionRows);
    // Acknowledgement records are per board and survive unrelated title/now edits.
    const records=dismissed.filter(d=>cards.some(c=>dismissalMatches(c,d)));
    dismissed.splice(0,dismissed.length,...records);
    const direct:PersistentReportEntry[]=[];
    for(const e of entries.filter(e=>!isServerBoardKey(e.key))){
      const states=e.card_numbers.length?await sql<{number:number;status:string}[]>`SELECT number,status FROM cards WHERE number=ANY(${sql.array(e.card_numbers)}::integer[])`:[];
      const q=e.question_id?(await sql<BoardQuestion[]>`SELECT * FROM card_questions WHERE id=${e.question_id}`)[0]:undefined;
      if(q&&(q.answer!==null||q.withdrawn_at!==null))continue;
      if(e.card_numbers.length&&states.length===new Set(e.card_numbers).size&&states.every(c=>isCardOffBoard(c.status as CardStatus)))continue;
      if(enabled&&cards.some(c=>c.number!==null&&e.card_numbers.includes(c.number)))continue;
      direct.push(e);
    }
    const calculated=cards.flatMap(c=>cardBoardEntries(c,questions,enabled,dismissed))
      .sort((a,b)=>a.updated_at.localeCompare(b.updated_at)||a.key.localeCompare(b.key));
    entries.splice(0,entries.length,...direct,...calculated);
  }
  /** 카드 C와 C의 담당 세션이 담당자로 연결된 한 단계 부모 카드에 관여한 영구 세션들. */
  private async connectedSessions(sql: RepositorySql | SqlClient, cardId: string): Promise<Set<string>> {
    return readCardBoardSessions(sql, cardId);
  }
  /** 이 세션이 카드 C의 연결 세션인가. 판에 카드 장을 올릴지 판정한다. */
  private async isBoardCard(sql: RepositorySql, sessionId: string, cardId: string): Promise<boolean> {
    return (await this.connectedSessions(sql, cardId)).has(sessionId);
  }
  private async mutate(sessionId: string, apply: (sql:RepositorySql, entries:PersistentReportEntry[],dismissed:DismissedCard[])=>Promise<PersistentReportIssue[] | null>, internal=false): Promise<PersistentReportResult> {
    const outcome = await this.sql.begin(async sql => {
      const row = (await sql<ReportRow[]>`SELECT session_id,node_id,session_type,metadata FROM sessions WHERE session_id=${sessionId} FOR UPDATE`)[0];
      const entries = readPersistentReport(row?.metadata);
      const summaries = entries.map(({key,title})=>({key,title}));
      if (!row) return {result:{ok:false,code:"SESSION_NOT_FOUND",errors:[{path:"session_id",reason:"세션이 없습니다"}],entries:summaries} as PersistentReportResult};
      if (!internal && (!readPersistentEnabled(row.metadata) || row.session_type === "llm")) return {result:{ok:false,code:"NOT_PERSISTENT",errors:[{path:"session_id",reason:"영구 에이전트 세션만 사용할 수 있습니다"}],entries:summaries} as PersistentReportResult};
      const originalDismissed=readDismissedCards(row.metadata);
      const dismissed=[...originalDismissed];
      const next = [...entries];
      await this.project(sql,sessionId,next,dismissed,readPersistentEnabled(row.metadata)&&row.session_type!=="llm");
      const errors = await apply(sql,next,dismissed);
      if (errors) return {result:{ok:false,code:"INVALID_REPORT",errors,entries:summaries} as PersistentReportResult};
      await this.project(sql,sessionId,next,dismissed,readPersistentEnabled(row.metadata)&&row.session_type!=="llm");
      const sameEntries=next.length===entries.length&&next.every((entry,i)=>sameReportEntry(entries[i]!,entry)&&entries[i]!.updated_at===entry.updated_at);
      const sameDismissed=dismissed.length===originalDismissed.length&&dismissed.every((d,i)=>{
        const old=originalDismissed[i]!;
        return d.card_id===old.card_id&&d.status===old.status&&d.blocked_kind===old.blocked_kind&&d.status_changed_at===old.status_changed_at;
      });
      const changed = !sameEntries||!sameDismissed;
      const closures = changed ? await collectQuestionClosures(sql, entries, next) : [];
      const update = changed ? await writePersistentReportTx(sql,row,next,dismissed) : undefined;
      return {result:{ok:true,changed,entries:next.map(({key,title})=>({key,title})),persistent_report:next} as PersistentReportResult,update,closures};
    });
    // Publish the transaction's own result immediately after commit, before any other await.
    if (outcome.update) await this.publish([outcome.update]);
    if (outcome.closures?.length && this.appendTimeline) {
      await this.appendTimeline(sessionId, { type: REPORT_TIMELINE_QUESTION_CLOSED_EVENT_TYPE, closures: outcome.closures });
    }
    return outcome.result;
  }
}

/** 판에서 내려간 카드 질문 장 가운데 실제로 답이나 철회로 닫힌 것만 닫힘 목록으로 만든다. */
async function collectQuestionClosures(
  sql: RepositorySql,
  before: readonly PersistentReportEntry[],
  after: readonly PersistentReportEntry[],
): Promise<ReportTimelineQuestionClosed[]> {
  const remaining = new Set(after.map(entry => entry.key));
  const dropped = before.filter(entry => entry.key.startsWith(CARD_QUESTION_KEY_PREFIX)
    && entry.question_id !== undefined && entry.card_id !== undefined && !remaining.has(entry.key));
  if (dropped.length === 0) return [];
  const rows = await sql<{ id: string; answer: string | null; withdrawn_at: Date | null }[]>`
    SELECT id,answer,withdrawn_at FROM card_questions WHERE id=ANY(${sql.array(dropped.map(entry => entry.question_id!))}::text[])
  `;
  const states = new Map(rows.map(row => [row.id, cardQuestionState(row)]));
  const closures: ReportTimelineQuestionClosed[] = [];
  for (const entry of dropped) {
    const state = states.get(entry.question_id!);
    if (state !== "answered" && state !== "withdrawn") continue;
    closures.push({ question_id: entry.question_id!, line_key: `card:${entry.card_id}`, detail: entry.context, status: state });
  }
  return closures;
}

function sameReportEntry(
  existing: PersistentReportEntry,
  next: Omit<PersistentReportEntry, "updated_at">,
): boolean {
  return existing.key === next.key
    && existing.kind === next.kind
    && existing.title === next.title
    && sameArray(existing.card_numbers, next.card_numbers)
    && existing.context === next.context
    && existing.action === next.action
    && sameArray(existing.options, next.options)
    && existing.question_id === next.question_id
    && existing.state === next.state
    && existing.answer === next.answer
    && existing.card_id === next.card_id
    && existing.card_status === next.card_status
    && existing.question_title === next.question_title
    && existing.question_text === next.question_text
    && existing.question_kind === next.question_kind
    && sameJson(existing.question_option_details, next.question_option_details)
    && sameJson(existing.question_attachments, next.question_attachments)
    && sameJson(existing.question_thread, next.question_thread)
    && existing.question_revision === next.question_revision
    && existing.question_revised_at === next.question_revised_at;
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** metadata JSONB를 다시 읽은 값과 방금 만든 값을 키 순서와 무관하게 비교한다. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  if (left !== null && typeof left === "object" && !Array.isArray(left)
    && right !== null && typeof right === "object" && !Array.isArray(right)) {
    const record = right as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(record).length
      && keys.every((key) => Object.hasOwn(record, key) && sameJson((left as Record<string, unknown>)[key], record[key]));
  }
  return false;
}

export async function writePersistentReportTx(sql: RepositorySql, row: Pick<ReportRow,"session_id"|"node_id">, entries: PersistentReportEntry[], dismissed:DismissedCard[]=[]): Promise<PersistentReportUpdate> {
  await sql`SELECT session_apply_metadata_entry(${row.session_id},${JSON.stringify({type:PERSISTENT_REPORT_METADATA_TYPE,value:{entries,dismissed_cards:dismissed}})},${PERSISTENT_REPORT_METADATA_TYPE},NOW())`;
  return {agent_session_id:row.session_id,node_id:row.node_id,persistent_report:entries};
}

export function readDismissedCards(metadata:unknown):DismissedCard[]{
  if(!Array.isArray(metadata))return [];
  const value=[...metadata].reverse().find(e=>e?.type===PERSISTENT_REPORT_METADATA_TYPE)?.value;
  return Array.isArray(value?.dismissed_cards)?value.dismissed_cards:[];
}

function rejectDecision(cardId: string, code: string, status: number, message: string): { errors: PersistentReportIssue[] | null; decision: PersistentReportReplyDecision } {
  return { errors: null, decision: { action: "reject", cardId, code, status, message } };
}

