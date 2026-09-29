# Session search deployment

Expanded session search uses title metadata candidates plus an in-memory session-document bigram index, reciprocal-rank fusion, and one Jev noul rerank request. Explicit lexical search and event-history search keep their existing paths. Expanded search excludes internal `session_type = 'llm'` sessions from its A0 title list by intersecting A0 with the document index.

## Runtime configuration

Set `TYPESAFE_API_KEY` in the Orch service environment to enable Jev reranking. It is optional at startup. If absent, expanded search returns the RRF order with `relevance: null` and `search_status.search = { status: "partial", stage: "semantic", reason: "error" }`. Orch emits one startup warning. Do not place the key in a Codex child process environment.

The request payload uses `jev-latest` at `https://api.typesafe.ai/v1/systemone`. It contains the frozen N prompt and C3 cards. Requests time out after 8 seconds and are not retried. If the JSON state exceeds 50,000 UTF-8 bytes or the body exceeds 100,000 bytes, the pool is split into exactly two concurrent requests.

## Index lifecycle

The first expanded search builds the document index in Orch memory from non-LLM sessions and waits for it before returning. Each expanded search refreshes sessions changed since the overlapping timestamp watermark, updated digest highlights, and new turn-summary events. It also reads the `(session_id, display_name)` roster to detect renames and deleted sessions. The index is not persisted and has no timer or database schema.

The bigram BM25 implementation follows the Python experiment reference: Python whitespace normalization, adjacent Unicode code-point bigrams, `k1 = 1.5`, and `b = 0.75`. The index returns its top 300 candidates; request filters reduce those to at most 100, then RRF keeps at most 50 candidates for Jev.

## Release checks

1. Set `TYPESAFE_API_KEY` in the Orch service environment through the normal configuration workflow.
2. Deploy Orch through the approved release workflow. This change adds no database migration.
3. Search a known session in expanded mode. Confirm `query_expansion` remains skipped, `session_document` is complete, and `rerank` is complete. If Jev times out or fails, confirm the result remains in RRF order with null relevance and a semantic partial status.
4. Confirm lexical search and event-history search retain their existing behavior.

The rollout operator confirms the live key and Jev connectivity. Repository tests verify the request contract and source wiring; they do not verify the deployed secret or service runtime.
