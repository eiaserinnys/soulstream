import { expect } from 'vitest';
import { readLimitAutoResumeAt } from '../src/cards/card_limit_auto_resume.js';
import { claimableCardSessions } from '../src/cards/card_assignee.js';
import { createFolderContentSqlAdapter } from '../src/board/folder_content_sql.js';
import type { CardMachineWorld } from './card-machine-world.js';

const methods = ['createCard', 'setCardStatus', 'requestCardReview', 'resumeBlockedCardOnHumanInput',
  'askQuestion', 'answerQuestion', 'withdrawQuestion', 'addComment', 'startCardWork',
  'recordExecution', 'recordDispatch', 'blockCardForLimit', 'resumeLimitedCard',
  'resumeDispatchedCard', 'resumeVerificationCard', 'noteMissingAssignee', 'bulkSetCardStatus',
  'mergeCards', 'patchCard', 'updateUnstartedCard', 'saveExecutionSettings'] as const;
export interface DecisionObservation {
  method: string;
  command: Record<string, unknown>;
  checkedAt: number;
  actor: { kind: string; sessionId: string | null; userId: string | null; isAssignee: boolean; isAuthor: boolean };
  evidence: Record<string, unknown>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  beforeQuestions: Record<string, unknown>[];
  afterQuestions: Record<string, unknown>[];
  versionDelta: number;
  statusTimeChanged: boolean;
  result: { kind: 'success' | 'noop' | 'error'; value: unknown; statusCode: number | null; code: string | null; message: string | null };
}
// Keep raw SQL values and method parameters. No decision facts or policy are computed here.
// JSON serialization preserves timestamps as ISO strings; no IDs or clock fields are dropped.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export function observeCardDecisions(world: CardMachineWorld) {
  const records: DecisionObservation[] = [];
  const sql = world.h.sql, adapter = createFolderContentSqlAdapter(world.h.liveSql);
  const row = async (id: string | undefined) => id ? (await sql`SELECT *,status_changed_at::text AS status_time FROM cards WHERE id=${id}`)[0] ?? null : null;
  const questions = async (id: string | undefined) => id ? await sql`SELECT * FROM card_questions WHERE card_id=${id} ORDER BY asked_at,id` : [];
  for (const method of methods) {
    const service = world.cards as unknown as Record<string, (...args: any[]) => Promise<any>>;
    const original = service[method]!.bind(world.cards);
    service[method] = async (p: any, ...rest: any[]) => {
      const id = p.cardId ?? p.cardIds?.[0] ?? p.sourceCardIds?.[0];
      const before = await row(id), bq = await questions(id);
      const owner = before?.assignee_session_id ? (await sql`SELECT * FROM sessions WHERE session_id=${before.assignee_session_id}`)[0] ?? null : null;
      const actor = { kind: p.actorKind ?? 'system', sessionId: p.actorSessionId ?? null, userId: p.actorUserId ?? null,
        isAssignee: !!p.actorSessionId && p.actorSessionId === before?.assignee_session_id,
        isAuthor: !!p.actorSessionId && bq.some(q => q.id === p.questionId && q.session_id === p.actorSessionId) };
      const checkedAt = Date.now();
      const evidence: Record<string, unknown> = {
        owner,
        claimableSessions: actor.sessionId && before ? await claimableCardSessions(adapter, before.id, actor.sessionId) : [],
        dispatches: before ? await sql`SELECT * FROM card_orchestration_dispatches WHERE card_id=${before.id} ORDER BY run_id,card_id` : [],
        executionRequests: before ? await sql`SELECT * FROM card_execution_requests WHERE card_id=${before.id} ORDER BY id` : [],
      };
      if (method === 'blockCardForLimit' && owner) evidence.limitAutoResumeAt = await readLimitAutoResumeAt(adapter, owner as any);
      let value: any, thrown: any;
      try { value = await original(p, ...rest); } catch (error) { thrown = error; }
      const actualId = id ?? value?.operation?.target_id;
      const after = await row(actualId), aq = await questions(actualId);
      records.push(json({ method, command: p, checkedAt, actor, evidence, before, after,
        beforeQuestions: bq, afterQuestions: aq,
        versionDelta: Number(after?.version ?? 0) - Number(before?.version ?? 0),
        statusTimeChanged: !!before && before.status_time !== after?.status_time,
        result: { kind: thrown ? 'error' : before && Number(after?.version) === Number(before.version) && JSON.stringify(bq) === JSON.stringify(aq) ? 'noop' : 'success',
          value: value ?? null, statusCode: thrown?.statusCode ?? null, code: thrown?.code ?? null, message: thrown?.message ?? null },
      }));
      if (thrown) throw thrown;
      return value;
    };
  }
  return records;
}
/** Exact oracle comparison. Replay adapters must resolve nondeterministic bindings before calling it. */
export function compareDecisionObservation(expected: DecisionObservation, actual: DecisionObservation) {
  expect(normalizeDecisionObservation(actual), expected.method).toEqual(normalizeDecisionObservation(expected));
}

/** One comparison boundary for collection, replay and later service migrations.
 * Raw fixture values stay intact. Compare observable relationships rather than generated IDs/clocks.
 */
export function normalizeDecisionObservation(r: DecisionObservation) {
  const ids = new Map<string, string>();
  const add = (value: unknown, name: string) => { if (typeof value === 'string' && !ids.has(value)) ids.set(value, name); };
  add(r.actor.sessionId, 'actor.session');
  add(r.before?.assignee_session_id, 'previous.session');
  for (const row of [r.before, r.after]) add(row?.id, `card${[...ids.values()].filter(v => v.startsWith('card')).length + 1}`);
  for (const [i, q] of [...r.beforeQuestions, ...r.afterQuestions].entries()) add(q.id, `question${i + 1}`);
  const command = r.command;
  const stamp = (value: unknown) => value == null ? null : String(value);
  // Relations are taken only against the same row before the call (card row, or the same question row).
  // Timestamps of other rows are generated independently, so equality with them is timing, not behavior.
  type Base = Record<string, unknown> | null;
  const time = (value: unknown, key: string, base: Base) => value == null ? null
    : base && stamp(value) === stamp(base[key]) ? 'unchanged'
    : Object.values(command).some(v => stamp(v) === stamp(value)) ? 'command.time' : base ? 'new.time' : 'time';
  const session = (v: unknown) => v == null ? null : ids.get(String(v)) ?? 'other.session';
  const walk = (v: any, key = '', base: Base = null): any => {
    const previous = base ?? {};
    if (v == null) return v;
    if (key === 'now' && typeof v === 'number') return 'command.clock';
    if (Array.isArray(v)) return v.map(x => walk(x, key, base));
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, walk(value, k, base)]));
    if (/session_?id$/i.test(key) || key === 'sessionId') return session(v);
    if (/event_?id$/i.test(key) || key === 'eventId' || key === 'baseline_event_id') return v === previous[key] ? 'previous.event' : 'event';
    if (key === 'number' || key === 'card_numbers') return 'card.number';
    if (key.endsWith('position_key')) return v === previous[key] ? 'present.unchanged' : 'present.changed';
    if (/_at$/.test(key) || /At$/.test(key) || key === 'status_time' || key === 'at') return time(v, key, base);
    if (key === 'idempotencyKey' || key === 'idempotency_key') return 'command.key';
    // Any other timestamp (for example a dispatch launch deadline) is compared as a clock relation.
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) return time(v, key, base);
    if (typeof v !== 'string') return v;
    if (ids.has(v)) return ids.get(v);
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(v)) { add(v, `id${ids.size + 1}`); return ids.get(v); }
    if (/^(proof|admit|settings|bulk|merge|replacement)-\d/.test(v)) return v.split('-')[0] + '.generated';
    // Human-facing scheduled clock text carries a clock too, not a second policy result.
    // Card numbers come from a sequence, so text that quotes one is compared by role.
    return v.replace(/(?:\d+월 \d+일 )?\d{2}:\d{2}/g, '<clock>').replace(/#\d+/g, '#<card.number>');
  };
  const columns = ['status', 'blocked_kind', 'blocked_detail', 'archived', 'assignee_kind', 'assignee_session_id',
    'assignee_agent_id', 'assignee_user_id', 'limit_resume_session_id', 'limit_resume_at', 'wake_at', 'waiting_for',
    'completed_kind', 'completed_session_id', 'completed_user_id', 'completed_event_id', 'completed_at',
    'queue_position_key', 'status_changed_at', 'version', 'now'];
  const pick = (row: Record<string, unknown>) => Object.fromEntries(columns.map(k => [k, row[k]]));
  const row = (value: Record<string, unknown> | null) => value === null ? null : walk(pick(value), '', r.before ? pick(r.before) : null);
  const questionKeys = ['id', 'session_id', 'text', 'options', 'answer', 'answered_at', 'answered_by', 'withdrawn_at', 'withdrawn_by_session_id', 'withdrawal_reason'];
  const qs = (value: Record<string, unknown>[]) => value.map(q => walk(Object.fromEntries(questionKeys.map(k => [k, q[k]])), '',
    r.beforeQuestions.find(b => b.id === q.id) ?? null));
  // Full raw responses remain in the oracle; compare their public mutation contract, not duplicate snapshots.
  const value: any = r.result.value;
  const returned = value && typeof value === 'object' ? walk({
    ...(value.operation ? { operation: { operation_type: value.operation.operation_type, payload_json: value.operation.payload_json } } : {}),
    ...Object.fromEntries(Object.entries(value).filter(([k]) => !['operation', 'snapshot', 'eventId'].includes(k))),
  }) : value;
  return { method: r.method, command: walk(command), actor: { ...r.actor, sessionId: session(r.actor.sessionId) },
    evidence: walk(r.evidence), before: row(r.before), after: row(r.after), beforeQuestions: qs(r.beforeQuestions), afterQuestions: qs(r.afterQuestions),
    versionDelta: r.versionDelta, statusTimeChanged: r.statusTimeChanged,
    result: { ...r.result, message: walk(r.result.message), value: returned } };
}
