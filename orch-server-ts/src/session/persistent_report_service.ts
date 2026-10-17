import { readPersistentEnabled } from "@soulstream/wire-schema/persistent-session-settings";
import {
  parsePersistentReportEntry, parsePersistentReportReply, readPersistentReport,
  PERSISTENT_REPORT_KEY, PERSISTENT_REPORT_LIMIT, PERSISTENT_REPORT_METADATA_TYPE,
  type PersistentReportEntry, type PersistentReportIssue, type PersistentReportResult,
} from "@soulstream/wire-schema/persistent-report";
import type { SqlClient, RepositorySql } from "../cards/control_plane/card_types.js";

export type PersistentReportUpdate = { agent_session_id: string; node_id: string | null; persistent_report: PersistentReportEntry[] };
export type PublishPersistentReports = (updates: PersistentReportUpdate[]) => void | Promise<void>;
/** 판에서 온 답을 어떻게 처리할지 라우트에 알리는 결정. reject는 사용자에게 그대로 돌려줄 오류다. */
export type PersistentReportReplyDecision =
  | { action: "none" }
  | { action: "card"; cardId: string; questionId: string; option: string }
  | { action: "card-acked" }
  | { action: "reject"; code: string; status: number; message: string };
/** 카드 질문을 판에 올릴 때 쓰는 예약 key 접두사. `cq_` + 질문 UUID. */
export const CARD_QUESTION_KEY_PREFIX = "cq_";
type ReportRow = Record<string, unknown> & { session_id: string; node_id: string | null; metadata: unknown; session_type: string | null };
type CardQuestionRow = { card_id: string; options: string[] | null; answer: string | null; withdrawn_at: Date | null };

export class PersistentReportService {
  constructor(private readonly sql: SqlClient, private readonly publish: PublishPersistentReports) {}
  async get(sessionId: string): Promise<PersistentReportEntry[]> {
    const row = (await this.sql<ReportRow[]>`SELECT metadata FROM sessions WHERE session_id=${sessionId}`)[0];
    return readPersistentReport(row?.metadata);
  }
  async put(sessionId: string, input: unknown): Promise<PersistentReportResult> {
    return this.mutate(sessionId, async (sql, entries) => {
      const parsed = parsePersistentReportEntry(input);
      if (!parsed.ok) return parsed.errors;
      return this.upsertEntry(sql, entries, parsed.value);
    });
  }
  /**
   * 담당이 남긴 카드 질문을 그 카드 소유 사용자의 「지금의 보고」 판에 `cq_<질문ID>` 장으로 올린다.
   * 이미 답했거나 철회한 질문, 끝난 카드는 no-op. 판이 가득 차면 errors를 돌려주고(호출자가 경고만 한다) 질문 자체는 그대로 남는다.
   */
  async putQuestion(sessionId: string, questionId: string): Promise<PersistentReportResult> {
    return this.mutate(sessionId, async (sql, entries) => {
      const question = (await sql<{ card_id: string; text: string; options: string[] | null; answer: string | null; withdrawn_at: Date | null }[]>`
        SELECT card_id,text,options,answer,withdrawn_at FROM card_questions WHERE id=${questionId}`)[0];
      if (!question) return [{ path: "question_id", reason: "질문이 없습니다" }];
      if (question.answer !== null || question.withdrawn_at !== null) return null;
      const card = (await sql<{ number: number | null; title: string; status: string }[]>`
        SELECT number,title,status FROM cards WHERE id=${question.card_id}`)[0];
      if (!card || card.status === "done" || card.status === "cancelled") return null;
      const parsed = parsePersistentReportEntry({
        key: `${CARD_QUESTION_KEY_PREFIX}${questionId}`, kind: "ask",
        title: [...card.title].slice(0, 24).join(""),
        card_numbers: card.number === null ? [] : [card.number],
        context: [...question.text].slice(0, 120).join(""),
        action: "", options: question.options ?? [], question_id: questionId,
      });
      if (!parsed.ok) return parsed.errors;
      return this.upsertEntry(sql, entries, parsed.value);
    });
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
   * 일반 장이면 지금까지처럼 장 상태만 answered로 바꾼다. 카드 질문 장 자체는 카드 답이 커밋될 때 pruneForCard가 내린다.
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
    if (question.withdrawn_at !== null) return rejectDecision("CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    if (question.answer !== null) return question.answer === option
      ? { errors: null, decision: { action: "card-acked" } }
      : rejectDecision("CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    const options = question.options ?? [];
    if (options.length > 0 && !options.includes(option)) return rejectDecision("CARD_QUESTION_OPTION_INVALID", 422, "선택지에 없는 답입니다");
    const card = (await sql<{ status: string }[]>`SELECT status FROM cards WHERE id=${question.card_id}`)[0];
    if (!card || card.status === "done" || card.status === "cancelled") return rejectDecision("CARD_QUESTION_CLOSED", 409, "이미 닫힌 질문입니다");
    return { errors: null, decision: { action: "card", cardId: question.card_id, questionId, option } };
  }
  /** 예약 key(`cq_` + 질문ID)를 다시 받았을 때. 장이 이미 내려가 있어도 질문 상태로 판정한다. */
  private async cardQuestionResendDecision(sql: RepositorySql, key: string, option: string): Promise<{ errors: PersistentReportIssue[] | null; decision: PersistentReportReplyDecision }> {
    if (!key.startsWith(CARD_QUESTION_KEY_PREFIX)) return { errors: null, decision: { action: "none" } };
    return this.cardQuestionDecision(sql, key.slice(CARD_QUESTION_KEY_PREFIX.length), option);
  }
  /** Card commit is complete. Discover without locks, then recheck each current board under its session lock. */
  async pruneForCard(cardId: string): Promise<void> {
    const targets = await this.sql<{session_id:string}[]>`WITH candidates AS MATERIALIZED (
      SELECT session_id,metadata FROM sessions WHERE metadata @> '[{"type":"persistent_report"}]'::jsonb
    ) SELECT session_id FROM candidates
      WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(metadata) AS m,
          jsonb_array_elements(m->'value'->'entries') AS e
          WHERE m->>'type'='persistent_report' AND
            (e->'card_numbers' @> jsonb_build_array((SELECT number FROM cards WHERE id=${cardId}))
              OR e->>'question_id' IN (SELECT id FROM card_questions WHERE card_id=${cardId})))`;
    for (const target of targets) {
      await this.mutate(target.session_id, async (sql, entries) => {
        const card = (await sql<{number:number | null}[]>`SELECT number FROM cards WHERE id=${cardId}`)[0];
        const questions = await sql<{id:string}[]>`SELECT id FROM card_questions WHERE card_id=${cardId}`;
        const next: PersistentReportEntry[] = [];
        for (const entry of entries) {
          const related = (card?.number != null && entry.card_numbers.includes(card.number))
            || questions.some(q=>q.id === entry.question_id);
          if (!related) { next.push(entry); continue; }
          const question = entry.question_id
            ? (await sql<{answer:string | null;withdrawn_at:Date | null}[]>`SELECT answer,withdrawn_at FROM card_questions WHERE id=${entry.question_id}`)[0]
            : undefined;
          const resolved = question?.answer != null || question?.withdrawn_at != null;
          const statuses = entry.card_numbers.length ? await sql<{number:number;status:string}[]>`SELECT number,status FROM cards WHERE number=ANY(${sql.array(entry.card_numbers)}::integer[])` : [];
          const finished = entry.card_numbers.length > 0 && statuses.length === new Set(entry.card_numbers).size && statuses.every(c=>c.status==='done'||c.status==='cancelled');
          if (!resolved && !finished) next.push(entry);
        }
        entries.splice(0,entries.length,...next);
        return null;
      });
    }
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

export async function writePersistentReportTx(sql: RepositorySql, row: Pick<ReportRow,"session_id"|"node_id">, entries: PersistentReportEntry[]): Promise<PersistentReportUpdate> {
  await sql`SELECT session_apply_metadata_entry(${row.session_id},${JSON.stringify({type:PERSISTENT_REPORT_METADATA_TYPE,value:{entries}})},${PERSISTENT_REPORT_METADATA_TYPE},NOW())`;
  return {agent_session_id:row.session_id,node_id:row.node_id,persistent_report:entries};
}

function rejectDecision(code: string, status: number, message: string): { errors: PersistentReportIssue[] | null; decision: PersistentReportReplyDecision } {
  return { errors: null, decision: { action: "reject", code, status, message } };
}

