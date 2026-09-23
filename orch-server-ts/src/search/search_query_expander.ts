import {
  CodexEphemeralExecutionError,
  type CodexReasoningEffort,
  type CodexEphemeralExecutor,
} from "../llm/codex_ephemeral_executor.js";
import type {
  SearchQueryModelResolver,
} from "./search_query_model_resolver.js";

export const SEARCH_QUERY_EXPANSION_MAX_EXPRESSIONS = 3;

const queryExpansionOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["queries"],
  properties: {
    queries: {
      type: "array",
      maxItems: SEARCH_QUERY_EXPANSION_MAX_EXPRESSIONS,
      items: { type: "string" },
    },
  },
} as const;

export type ExpandedSearchQueries = {
  readonly queries: readonly string[];
  readonly latencyMs: number;
  readonly skipped: boolean;
};

export type SearchQueryExpansionTiming = {
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly modelResolutionMs: number;
  readonly executorWallMs: number;
  readonly queryParseMs: number;
  readonly totalMs: number;
  readonly status: "completed" | "failed" | "skipped";
  readonly errorCode?: string;
};

export type SearchQueryExpander = {
  readonly expand: (
    query: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<ExpandedSearchQueries>;
};

export type CreateSearchQueryExpanderOptions = {
  readonly executor: CodexEphemeralExecutor;
  readonly modelResolver: SearchQueryModelResolver;
  readonly concurrencyLimit?: number;
  readonly nowMs?: () => number;
  readonly onExpansionError?: (error: unknown) => void;
  readonly onExpansionTiming?: (timing: SearchQueryExpansionTiming) => void;
};

export function createSearchQueryExpander(
  options: CreateSearchQueryExpanderOptions,
): SearchQueryExpander {
  const nowMs = options.nowMs ?? Date.now;
  return {
    async expand(query, timeoutMs, signal) {
      const startedAt = nowMs();
      let model: ReturnType<SearchQueryModelResolver["resolve"]> | undefined;
      let modelResolutionMs = 0;
      let executorWallMs = 0;
      let queryParseMs = 0;
      let status: SearchQueryExpansionTiming["status"] = "failed";
      let errorCode: string | undefined;
      let cancelledBeforeStart = false;
      try {
        if (shouldSkipExpansion(query)) {
          status = "skipped";
          return {
            queries: [],
            latencyMs: Math.max(0, nowMs() - startedAt),
            skipped: true,
          };
        }
        if (signal?.aborted) {
          cancelledBeforeStart = true;
          throw cancelledExpansionError();
        }

        const resolutionStartedAt = nowMs();
        model = options.modelResolver.resolve();
        modelResolutionMs = Math.max(0, nowMs() - resolutionStartedAt);
        const executorStartedAt = nowMs();
        let result: Awaited<ReturnType<CodexEphemeralExecutor["generate"]>>;
        try {
          result = await options.executor.generate({
            prompt: buildQueryExpansionPrompt(query),
            model: model.model,
            reasoningEffort: model.reasoningEffort,
            outputSchema: queryExpansionOutputSchema,
            timeoutMs,
            maxAttempts: 1,
            concurrencyLimit: options.concurrencyLimit ?? 2,
            signal,
            disabledFeatures: [
              "shell_tool",
              "apps",
              "multi_agent",
              "goals",
              "remote_plugin",
            ],
            disableWebSearch: true,
          });
        } finally {
          executorWallMs = Math.max(0, nowMs() - executorStartedAt);
        }
        const queryParseStartedAt = nowMs();
        let queries: string[];
        try {
          queries = parseExpandedQueries(result.content, query);
        } finally {
          queryParseMs = Math.max(0, nowMs() - queryParseStartedAt);
        }
        status = "completed";
        return {
          queries,
          latencyMs: Math.max(0, nowMs() - startedAt),
          skipped: false,
        };
      } catch (error) {
        errorCode = error instanceof CodexEphemeralExecutionError
          ? error.code
          : "MODEL_ERROR";
        if (!cancelledBeforeStart) options.onExpansionError?.(error);
        throw error;
      } finally {
        try {
          options.onExpansionTiming?.({
            ...(model === undefined ? {} : {
              model: model.model,
              reasoningEffort: model.reasoningEffort,
            }),
            modelResolutionMs,
            executorWallMs,
            queryParseMs,
            totalMs: Math.max(0, nowMs() - startedAt),
            status,
            ...(errorCode === undefined ? {} : { errorCode }),
          });
        } catch {
          // Measurement callbacks must not affect query execution.
        }
      }
    },
  };
}

export function shouldSkipExpansion(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return true;
  if (/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(trimmed)) {
    return true;
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) return true;
  return /^[A-Za-z_$][\w$]*$/.test(trimmed);
}

function buildQueryExpansionPrompt(query: string): string {
  return [
    "검색어 재작성만 수행한다. 주어진 표현이 가리키는 대화 기록을 찾을 짧은 검색어를 최대 3개 만든다.",
    "사실이나 결과를 추측하지 말고, 고유 식별자·경로·코드 이름을 새로 만들지 않는다.",
    "도구를 사용하지 말고 JSON 스키마에 맞춰 queries만 반환한다.",
    `원문 검색어: ${JSON.stringify(query)}`,
  ].join("\n");
}

function parseExpandedQueries(content: string, originalQuery: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CodexEphemeralExecutionError(
      "CODEX_INVALID_OUTPUT",
      "Search query expansion returned invalid JSON",
      {
        attempts: 1,
        latencyMs: 0,
        spawnDurationMs: 0,
        peakConcurrentSpawns: 0,
      },
      error,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.queries)) {
    throw new CodexEphemeralExecutionError(
      "CODEX_INVALID_OUTPUT",
      "Search query expansion output must contain a queries array",
      {
        attempts: 1,
        latencyMs: 0,
        spawnDurationMs: 0,
        peakConcurrentSpawns: 0,
      },
    );
  }
  const original = normalizeForDedupe(originalQuery);
  const seen = new Set<string>([original]);
  const queries: string[] = [];
  for (const value of parsed.queries) {
    if (typeof value !== "string") continue;
    const query = value.trim().slice(0, 160);
    const key = normalizeForDedupe(query);
    if (query.length < 2 || key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= SEARCH_QUERY_EXPANSION_MAX_EXPRESSIONS) break;
  }
  if (queries.length === 0) {
    throw new CodexEphemeralExecutionError(
      "CODEX_INVALID_OUTPUT",
      "Search query expansion returned no new expressions",
      {
        attempts: 1,
        latencyMs: 0,
        spawnDurationMs: 0,
        peakConcurrentSpawns: 0,
      },
    );
  }
  return queries;
}

function normalizeForDedupe(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cancelledExpansionError(): CodexEphemeralExecutionError {
  return new CodexEphemeralExecutionError(
    "CODEX_CANCELLED",
    "Search query expansion was cancelled",
    {
      attempts: 0,
      latencyMs: 0,
      spawnDurationMs: 0,
      peakConcurrentSpawns: 0,
    },
  );
}
