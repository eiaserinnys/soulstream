# Session search deployment

Expanded session search uses title metadata candidates plus an in-memory session-document bigram index, reciprocal-rank fusion, and one Jev noul rerank request. Explicit lexical search and event-history search keep their existing paths. Expanded search excludes internal `session_type = 'llm'` sessions from its A0 title list by intersecting A0 with the document index.

## Runtime configuration

Set `TYPESAFE_API_KEY` in the Orch service environment to enable Jev reranking. It is optional at startup. If absent, expanded search returns the RRF order with `relevance: null` and `search_status.search = { status: "partial", stage: "semantic", reason: "error" }`. Orch emits one startup warning. Do not place the key in a Codex child process environment.

The request payload uses `jev-latest` at `https://api.typesafe.ai/v1/systemone`. It contains the frozen N prompt and C3 cards. Requests time out after 8 seconds and are not retried. If the JSON state exceeds 50,000 UTF-8 bytes or the body exceeds 100,000 bytes, the pool is split into exactly two concurrent requests.

## Index lifecycle

The first expanded search builds the document index in Orch memory from non-LLM sessions using three flat reads: sessions, digests, and turn-summary events. It stores only each title, a whitespace-free `Uint32Array` of document code points, its bigram length, and the compact C3 card. It does not retain full request, summary, or document text.

Each expanded request refreshes only changed documents. A small changed-ID query checks new sessions, updated digests, and distinct sessions with new turn-summary events; a full `(session_id, display_name)` roster comparison detects renames and deletions. There is no inverted index, timer, persistence, or database schema. BM25 scans the stored code-point arrays once per request and uses a first-codepoint bitmap to skip irrelevant positions. It follows the Python experiment reference: Python whitespace normalization, adjacent Unicode code-point bigrams, `k1 = 1.5`, and `b = 0.75`. It selects the top 300 from the score array without copying documents; request filters reduce those to at most 100, then RRF keeps at most 50 candidates for Jev.

## Release checks

1. Set `TYPESAFE_API_KEY` in the Orch service environment through the normal configuration workflow.
2. Deploy Orch through the approved release workflow. This change adds no database migration.
3. Search a known session in expanded mode. Confirm `query_expansion` remains skipped, `session_document` is complete, and `rerank` is complete. If Jev times out or fails, confirm the result remains in RRF order with null relevance and a semantic partial status.
4. Confirm lexical search and event-history search retain their existing behavior.

The rollout operator confirms the live key and Jev connectivity. Repository tests verify the request contract and source wiring; they do not verify the deployed secret or service runtime.
