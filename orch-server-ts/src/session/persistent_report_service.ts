import { readPersistentEnabled } from "@soulstream/wire-schema/persistent-session-settings";
import {
  parsePersistentReportEntry, parsePersistentReportReply, readPersistentReport,
  CARD_ENTRY_KEY_PREFIX, CARD_QUESTION_KEY_PREFIX,
  PERSISTENT_REPORT_KEY, PERSISTENT_REPORT_LIMIT, PERSISTENT_REPORT_METADATA_TYPE,
  type PersistentReportEntry, type PersistentReportIssue, type PersistentReportResult,
  type ReportTimelineLine, type ReportTimelineStatus,
} from "@soulstream/wire-schema/persistent-report";
import type { SqlClient, RepositorySql } from "../cards/control_plane/card_types.js";
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
type ConnectedSessionRow = { session_id: string; session_type: string | null; metadata: unknown };
type CardQuestionRow = { card_id: string; options: string[] | null; answer: string | null; withdrawn_at: Date | null };
type CardStateRow = { id: string; number: number | null; title: string; status: string; archived: boolean; blocked_kind: string | null; blocked_detail: string | null; now: { text?: string; turn?: string; ask?: string | null } | null };
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
      return this.upsertEntry(sql, entries, parsed.value);
    });
    const key = input !== null && typeof input === "object" && "key" in input
      && typeof (input as { key: unknown }).key === "string"
      ? (input as { key: string }).key
      : undefined;
    if (result.ok && result.changed && key !== undefined) {
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
          await this.appendTimeline(sessionId, line);
        }
        await this.onPosted?.({ sessionId, entry });
      }
    }
    return result;
  }
  /**
   * 담당이 남긴 카드 질문을 그 카드 소유 사용자의 「지금의 보고」 판에 `cq_<질문ID>` 장으로 올린다.
   * 이미 답했거나 철회한 질문, 끝난 카드는 no-op. 판이 가득 차면 errors를 돌려주고(호출자가 경고만 한다) 질문 자체는 그대로 남는다.
   */
  async putQuestion(sessionId: string, questionId: string): Promise<PersistentReportResult> {
    let timelineLine: ReportTimelineLine | undefined;
    const result = await this.mutate(sessionId, async (sql, entries) => {
      const question = (await sql<{ card_id: string; text: string; options: string[] | null; answer: string | null; withdrawn_at: Date | null }[]>`
        SELECT card_id,text,options,answer,withdrawn_at FROM card_questions WHERE id=${questionId}`)[0];
      if (!question) return [{ path: "question_id", reason: "질문이 없습니다" }];
      if (question.answer !== null || question.withdrawn_at !== null) return null;
      const card = (await sql<{ number: number | null; title: string; status: string }[]>`
        SELECT number,title,status FROM cards WHERE id=${question.card_id}`)[0];
      if (!card || card.status === "done" || card.status === "cancelled") return null;
      timelineLine = {
        line_key: `card:${question.card_id}`,
        status: "question",
        title: clip(card.title, 60),
        detail: clip(question.text, 120),
        card_id: question.card_id,
        card_number: card.number,
      };
      const parsed = parsePersistentReportEntry({
        key: `${CARD_QUESTION_KEY_PREFIX}${questionId}`, kind: "ask",
        title: clip(card.title, 24),
        card_numbers: card.number === null ? [] : [card.number],
        context: clip(question.text, 120),
        action: "", options: question.options ?? [], question_id: questionId,
      });
      if (!parsed.ok) return parsed.errors;
      return this.upsertEntry(sql, entries, { ...parsed.value, card_id: question.card_id, card_status: card.status });
    });
    if (result.ok && result.changed && timelineLine) await this.appendTimeline?.(sessionId, timelineLine);
    return result;
  }
  private async upsertEntry(sql: RepositorySql, entries: PersistentReportEntry[], entry: Omit<PersistentReportEntry, "updated_at">): Promise<PersistentReportIssue[] | null> {
    const cards = entry.card_numbers.length ? await sql<{ number: number; id: string }[]>`SELECT number,id FROM cards WHERE number=ANY(${sql.array(entry.card_numbers)}::integer[])` : [];
    if (cards.length !== new Set(entry.card_numbers).size) return [{ path: "card_numbers", reason: "없는 카드 번호가 있습니다" }];
    if (entry.question_id) {
      const q = (await sql<{ card_id: string }[]>`SELECT card_id FROM card_questions WHERE id=${entry.question_id}`)[0];
      if (!q || (cards.length > 0 && !cards.some(c => c.id === q.card_id))) return [{ path: "question_id", reason: "질문이 없거나 묶인 카드에 속하지 않습니다" }];
    }
    const index = entries.findIndex(e => e.key === entry.key);
    if (index < 0 && entries.length >= PERSISTENT_REPORT_LIMIT) return [{ path: "entries", reason: "장은 12개까지입니다" }];
    if (index >= 0 && sameReportEntry(entries[index]!, entry)) return null;
    const stored = { ...entry, updated_at: new Date().toISOString() };
    if (index < 0) entries.push(stored); else entries[index] = stored;
    return null;
  }
  async remove(sessionId: string, key: string): Promise<PersistentReportResult> {
    return this.mutate(sessionId, async (_sql, entries) => {
      if (typeof key !== "string" || !PERSISTENT_REPORT_KEY.test(key)) return [{ path: "key", reason: "올바른 장 key가 필요합니다" }];
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
    if (question.withdrawn_at !== null) return rejectDecision(question.card_id, "CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    if (question.answer !== null) return question.answer === option
      ? { errors: null, decision: { action: "card-acked", cardId: question.card_id } }
      : rejectDecision(question.card_id, "CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    const options = question.options ?? [];
    if (options.length > 0 && !options.includes(option)) return rejectDecision(question.card_id, "CARD_QUESTION_OPTION_INVALID", 422, "선택지에 없는 답입니다");
    const card = (await sql<{ status: string }[]>`SELECT status FROM cards WHERE id=${question.card_id}`)[0];
    if (!card || card.status === "done" || card.status === "cancelled") return rejectDecision(question.card_id, "CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    return { errors: null, decision: { action: "card", cardId: question.card_id, questionId, option } };
  }
  /** 예약 key(`cq_` + 질문ID)를 다시 받았을 때. 장이 이미 내려가 있어도 질문 상태로 판정한다. */
  private async cardQuestionResendDecision(sql: RepositorySql, key: string, option: string): Promise<{ errors: PersistentReportIssue[] | null; decision: PersistentReportReplyDecision }> {
    if (!key.startsWith(CARD_QUESTION_KEY_PREFIX)) return { errors: null, decision: { action: "none" } };
    return this.cardQuestionDecision(sql, key.slice(CARD_QUESTION_KEY_PREFIX.length), option);
  }
  /**
   * Card commit is complete. Align the server-owned card entries on every connected board, and with scanBoards on every board
   * that holds an entry for this card. The board scan reads every session's metadata (about 0.5s on the live DB), so the
   * caller asks for it only when entries outside the connected boards can change: question asked/answered/withdrawn or card finished.
   */
  async syncCard(cardId: string, options: { scanBoards: boolean } = { scanBoards: true }): Promise<void> {
    const targets = await this.connectedSessions(this.sql, cardId);
    if (!options.scanBoards) {
      for (const sessionId of targets) await this.mutate(sessionId, (sql, entries) => this.syncCardOnBoard(sql, entries, cardId, sessionId));
      return;
    }
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
    for (const sessionId of targets) await this.mutate(sessionId, (sql, entries) => this.syncCardOnBoard(sql, entries, cardId, sessionId));
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
      await this.appendTimeline?.(sessionId, line);
    }
  }
  /** 판 하나에서 카드 C의 장을 규칙대로 맞춘다. 바뀐 것이 없으면 mutate가 publish하지 않는다. */
  private async syncCardOnBoard(sql: RepositorySql, entries: PersistentReportEntry[], cardId: string, sessionId: string): Promise<PersistentReportIssue[] | null> {
    const card = (await sql<CardStateRow[]>`SELECT id,number,title,status,archived,blocked_kind,blocked_detail,now FROM cards WHERE id=${cardId}`)[0];
    if (!card) return null;
    const questions = await sql<{id:string;answer:string|null;withdrawn_at:Date|null}[]>`SELECT id,answer,withdrawn_at FROM card_questions WHERE card_id=${cardId}`;
    const questionIds = new Set(questions.map(question=>question.id));
    const next: PersistentReportEntry[] = [];
    for (const entry of entries) {
      const related = (card.number !== null && entry.card_numbers.includes(card.number))
        || (entry.question_id !== undefined && questionIds.has(entry.question_id));
      if (!related) { next.push(entry); continue; }
      const question = entry.question_id === undefined ? undefined : questions.find(q=>q.id === entry.question_id);
      const resolved = question !== undefined && (question.answer !== null || question.withdrawn_at !== null);
      const statuses = entry.card_numbers.length ? await sql<{number:number;status:string}[]>`SELECT number,status FROM cards WHERE number=ANY(${sql.array(entry.card_numbers)}::integer[])` : [];
      const finished = entry.card_numbers.length > 0 && statuses.length === new Set(entry.card_numbers).size && statuses.every(c=>c.status==='done'||c.status==='cancelled');
      if (resolved || finished) continue;
      if (entry.key.startsWith(CARD_QUESTION_KEY_PREFIX) && entry.question_id !== undefined && questionIds.has(entry.question_id)) {
        const title = clip(card.title,24);
        next.push(entry.title === title && entry.card_id === card.id && entry.card_status === card.status
          ? entry : { ...entry, title, card_id: card.id, card_status: card.status, updated_at: new Date().toISOString() });
      } else next.push(entry);
    }
    const connected = await this.isBoardCard(sql, sessionId, cardId);
    if (connected) {
      for (let i = next.length - 1; i >= 0; i--) {
        const entry = next[i]!;
        if (entry.key.startsWith(CARD_QUESTION_KEY_PREFIX) || entry.key.startsWith(CARD_ENTRY_KEY_PREFIX)) continue;
        if (card.number !== null && entry.card_numbers.includes(card.number)) next.splice(i,1);
      }
    }
    const openQuestion = questions.some(question=>question.answer === null && question.withdrawn_at === null);
    const wantsState = connected && !openQuestion && !card.archived && (card.status === "review" || card.status === "blocked");
    const key = `${CARD_ENTRY_KEY_PREFIX}${card.id}`;
    const index = next.findIndex(entry=>entry.key === key);
    if (wantsState) {
      const text = cardSituationText(card);
      const desired: Omit<PersistentReportEntry,"updated_at"> = { key, kind: "see", title: clip(card.title,24),
        card_numbers: card.number === null ? [] : [card.number], context: clip(text,120), action: "", options: [],
        state: "open", answer: "", card_id: card.id, card_status: card.status };
      if (index >= 0) {
        if (!sameCardEntry(next[index]!, desired)) next[index] = { ...desired, updated_at: new Date().toISOString() };
      } else if (next.length >= PERSISTENT_REPORT_LIMIT) {
        console.warn(`카드 장을 올리지 못했습니다(카드 ${card.id}): 판이 ${PERSISTENT_REPORT_LIMIT}장입니다`);
      } else next.push({ ...desired, updated_at: new Date().toISOString() });
    } else if (index >= 0) next.splice(index,1);
    entries.splice(0,entries.length,...next);
    return null;
  }
  /** 카드 C와 C의 담당 세션이 담당자로 연결된 한 단계 부모 카드에 관여한 영구 세션들. */
  private async connectedSessions(sql: RepositorySql | SqlClient, cardId: string): Promise<Set<string>> {
    // Collect the related card IDs first, then find their actors by primary key; an EXISTS over sessions scans the whole table.
    const rows = await sql<ConnectedSessionRow[]>`WITH card_ids AS MATERIALIZED (
        SELECT id FROM cards WHERE id=${cardId}
        UNION SELECT id FROM cards WHERE assignee_session_id=(SELECT created_session_id FROM cards WHERE id=${cardId}) AND id<>${cardId}
      ), actor_sessions AS (
        SELECT created_session_id AS session_id FROM cards WHERE id IN (SELECT id FROM card_ids) AND created_session_id IS NOT NULL
        UNION SELECT actor_session_id FROM folder_operations WHERE target_kind='card' AND target_id IN (SELECT id FROM card_ids)
          AND operation_type IN ('create_card','execute_card','add_card_comment') AND actor_session_id IS NOT NULL
      )
      SELECT s.session_id,s.session_type,s.metadata FROM sessions s
      WHERE s.session_id IN (SELECT session_id FROM actor_sessions)`;
    return new Set(rows.filter(row=>row.session_type !== "llm" && readPersistentEnabled(row.metadata)).map(row=>row.session_id));
  }
  /** 이 세션이 카드 C의 연결 세션인가. 판에 카드 장을 올릴지 판정한다. */
  private async isBoardCard(sql: RepositorySql, sessionId: string, cardId: string): Promise<boolean> {
    return (await this.connectedSessions(sql, cardId)).has(sessionId);
  }
  private async mutate(sessionId: string, apply: (sql:RepositorySql, entries:PersistentReportEntry[])=>Promise<PersistentReportIssue[] | null>): Promise<PersistentReportResult> {
    const outcome = await this.sql.begin(async sql => {
      const row = (await sql<ReportRow[]>`SELECT session_id,node_id,session_type,metadata FROM sessions WHERE session_id=${sessionId} FOR UPDATE`)[0];
      const entries = readPersistentReport(row?.metadata);
      const summaries = entries.map(({key,title})=>({key,title}));
      if (!row) return {result:{ok:false,code:"SESSION_NOT_FOUND",errors:[{path:"session_id",reason:"세션이 없습니다"}],entries:summaries} as PersistentReportResult};
      if (!readPersistentEnabled(row.metadata) || row.session_type === "llm") return {result:{ok:false,code:"NOT_PERSISTENT",errors:[{path:"session_id",reason:"영구 에이전트 세션만 사용할 수 있습니다"}],entries:summaries} as PersistentReportResult};
      const next = [...entries];
      const errors = await apply(sql,next);
      if (errors) return {result:{ok:false,code:"INVALID_REPORT",errors,entries:summaries} as PersistentReportResult};
      const changed = JSON.stringify(next) !== JSON.stringify(entries);
      const update = changed ? await writePersistentReportTx(sql,row,next) : undefined;
      return {result:{ok:true,changed,entries:next.map(({key,title})=>({key,title})),persistent_report:next} as PersistentReportResult,update};
    });
    // Publish the transaction's own result immediately after commit, before any other await.
    if (outcome.update) await this.publish([outcome.update]);
    return outcome.result;
  }
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
    && existing.card_status === next.card_status;
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function writePersistentReportTx(sql: RepositorySql, row: Pick<ReportRow,"session_id"|"node_id">, entries: PersistentReportEntry[]): Promise<PersistentReportUpdate> {
  await sql`SELECT session_apply_metadata_entry(${row.session_id},${JSON.stringify({type:PERSISTENT_REPORT_METADATA_TYPE,value:{entries}})},${PERSISTENT_REPORT_METADATA_TYPE},NOW())`;
  return {agent_session_id:row.session_id,node_id:row.node_id,persistent_report:entries};
}

function cardSituationText(card: Pick<CardStateRow, "now" | "blocked_detail">): string {
  return (card.now?.turn === "user" && card.now.ask ? card.now.ask : card.now?.text)
    || card.blocked_detail
    || "";
}

/** 길이가 바뀌는 글은 말줄임으로 끊는다. 코드포인트로 max를 넘으면 앞 max-1자 + 「…」, 아니면 원문. */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : text;
}

/** 서버가 쓰는 카드 장의 칸이 지금 카드 값과 같은가. 같으면 updated_at을 건드리지 않는다. */
function sameCardEntry(existing: PersistentReportEntry, desired: Omit<PersistentReportEntry,"updated_at">): boolean {
  return existing.kind === desired.kind && existing.title === desired.title
    && JSON.stringify(existing.card_numbers) === JSON.stringify(desired.card_numbers)
    && existing.context === desired.context && existing.action === desired.action
    && existing.options.length === 0 && existing.state === "open" && existing.answer === ""
    && existing.question_id === undefined && existing.card_id === desired.card_id
    && existing.card_status === desired.card_status;
}

function rejectDecision(cardId: string, code: string, status: number, message: string): { errors: PersistentReportIssue[] | null; decision: PersistentReportReplyDecision } {
  return { errors: null, decision: { action: "reject", cardId, code, status, message } };
}

