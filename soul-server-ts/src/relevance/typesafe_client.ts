const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 180_000;

const SCORE_LEVELS = [
  "무관 — 이 요청과 관계없다",
  "참고 — 있으면 약간 도움",
  "유관 — 처리 과정에 실제로 쓰인다",
  "필수 — 없으면 요청 처리가 틀리거나 누락된다",
];

const AGENT =
  "seosoyoung (서소영) — 슬랙·소울스트림에서 디렉터 김주복의 개발 지원·내러티브 잡무를 처리하는 에이전트";
const NODE = "eias-linegames (Windows)";
const CALLER = "디렉터 김주복";

export interface RelevanceItem {
  key: string;
  text: string;
}

export interface RankByRelevanceInput {
  query: string;
  items: RelevanceItem[];
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RelevanceScore {
  key: string;
  score: number;
}

interface TypesafeResponse {
  answers?: Record<string, { score?: unknown } | undefined>;
}

export async function rankByRelevance({
  query,
  items,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: RankByRelevanceInput): Promise<RelevanceScore[]> {
  const state = {
    agent: AGENT,
    node: NODE,
    caller: CALLER,
    first_request: query,
    candidates: items,
  };
  const questions = Object.fromEntries(items.map(({ key, text }) => [
    key,
    {
      type: "score",
      instructions: `first_request 처리에 대한 아래 지식 카드의 유관도.\n카드: ${text}`,
      criteria: SCORE_LEVELS,
    },
  ]));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(TYPESAFE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, state, questions }),
        signal: controller.signal,
      });
    } catch {
      throw new Error("Typesafe API request failed");
    }

    if (!response.ok) {
      throw new Error(`Typesafe API request failed (${response.status})`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error("Typesafe API returned invalid JSON");
    }
    const answers = typeof data === "object" && data !== null
      ? (data as TypesafeResponse).answers
      : undefined;

    return items
      .map(({ key }) => {
        const score = answers?.[key]?.score;
        return { key, score: typeof score === "number" ? score / (SCORE_LEVELS.length - 1) : 0 };
      })
      .sort((left, right) => right.score - left.score);
  } finally {
    clearTimeout(timer);
  }
}
