import type { SessionDocumentCard } from "./session_document_search_index.js";

const N_CONTEXT = "소울스트림은 사용자가 AI 에이전트와 진행한 작업 세션을 기록하는 시스템이다. 사용자가 예전에 진행한 세션을 다시 찾으려고 검색어를 입력했다. candidates는 후보 세션 카드다. title은 세션 제목, request는 첫 요청, summary는 진행 요약, date는 시작일, agent는 담당 에이전트다.";
const N_RULE = "각 질문은 지정한 ref의 후보 세션이 검색어가 가리키는 작업이나 대화를 한 세션인지 묻는다.";
const STATE_LIMIT_BYTES = 50_000;
const BODY_LIMIT_BYTES = 100_000;
const TIMEOUT_MS = 8_000;

export type JevSessionCandidate = {
  readonly session_id: string;
  readonly card: SessionDocumentCard;
};

export type JevRerankOutcome =
  | {
    readonly status: "complete";
    readonly scores: ReadonlyMap<string, number>;
    readonly latencyMs: number;
  }
  | {
    readonly status: "partial";
    readonly reason: "timeout" | "error";
    readonly scores: null;
    readonly latencyMs: number;
  };

export type JevPayload = {
  readonly model: "jev-latest";
  readonly state: string;
  readonly questions: Record<string, {
    readonly type: "noul";
    readonly instructions: string;
    readonly criteria: { readonly true: string; readonly false: string };
  }>;
};

export function buildJevPayload(query: string, candidates: readonly JevSessionCandidate[]): {
  readonly payload: JevPayload;
  readonly candidateIds: readonly string[];
} {
  const questions: JevPayload["questions"] = {};
  const cards = candidates.map((candidate, index) => {
    const ref = `c${index}`;
    questions[ref] = {
      type: "noul",
      instructions: `대상 ${ref}: 검색어가 가리키는 세션인가`,
      criteria: { true: "해당함", false: "해당하지 않음" },
    };
    return { ref, ...candidate.card };
  });
  return {
    payload: {
      model: "jev-latest",
      state: JSON.stringify({ context: N_CONTEXT, rule: N_RULE, query, candidates: cards }),
      questions,
    },
    candidateIds: candidates.map((candidate) => candidate.session_id),
  };
}

export async function rerankSessionDocuments(
  apiKey: string | null,
  query: string,
  candidates: readonly JevSessionCandidate[],
  options: {
    readonly fetcher?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly timeoutSignal?: () => AbortSignal;
  } = {},
): Promise<JevRerankOutcome> {
  const startedAt = Date.now();
  if (candidates.length === 0 && apiKey) {
    return {
      status: "complete",
      scores: new Map(),
      latencyMs: 0,
    };
  }
  if (!apiKey) {
    return { status: "partial", reason: "error", scores: null, latencyMs: 0 };
  }
  const fetcher = options.fetcher ?? fetch;
  const built = buildJevPayload(query, candidates);
  const singleBody = JSON.stringify(built.payload);
  const batches = utf8Length(built.payload.state) <= STATE_LIMIT_BYTES && utf8Length(singleBody) <= BODY_LIMIT_BYTES
    ? [candidates]
    : [candidates.slice(0, Math.ceil(candidates.length / 2)), candidates.slice(Math.ceil(candidates.length / 2))];
  const timeoutSignal = options.timeoutSignal?.() ?? AbortSignal.timeout(TIMEOUT_MS);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    const results = await Promise.all(batches.map(async (batch) => {
      const payload = buildJevPayload(query, batch).payload;
      if (utf8Length(payload.state) > STATE_LIMIT_BYTES || utf8Length(JSON.stringify(payload)) > BODY_LIMIT_BYTES) {
        throw new Error("Jev payload exceeds its fixed size limit");
      }
      const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: combinedSignal,
      });
      if (!response.ok) throw new Error(`Jev request returned HTTP ${response.status}`);
      const body = await response.json() as { answers?: Record<string, { noul?: unknown }> };
      const answers = body.answers;
      if (!answers) throw new Error("Jev response has no answers");
      const scores = new Map<string, number>();
      batch.forEach((candidate, index) => {
        const score = answers[`c${index}`]?.noul;
        if (typeof score !== "number" || !Number.isFinite(score)) throw new Error("Jev response is missing a noul score");
        scores.set(candidate.session_id, score);
      });
      return scores;
    }));
    const scores = new Map<string, number>();
    for (const result of results) for (const [id, score] of result) scores.set(id, score);
    return { status: "complete", scores, latencyMs: Math.max(0, Date.now() - startedAt) };
  } catch (error) {
    const timeout = combinedSignal.aborted && (timeoutSignal.aborted || timeoutSignal.reason instanceof DOMException && timeoutSignal.reason.name === "TimeoutError");
    return {
      status: "partial",
      reason: timeout ? "timeout" : "error",
      scores: null,
      latencyMs: Math.max(0, Date.now() - startedAt),
    };
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
