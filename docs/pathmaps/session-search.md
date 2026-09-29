# Session search

## Request path

`GET /cogito/search` enters `cogito_routes.ts`. Requests with `include_session_results=true` and no explicit lexical mode use expanded search; `session_search_mode=lexical` keeps the metadata-only session path. Event-history requests without session results keep the existing event-search path.

Expanded search in `live_cogito_search_provider.ts` obtains A0 from the same metadata candidate function used by lexical mode. It removes A0 session IDs absent from the document index, which excludes internal LLM sessions, then queries the document index for the top 300 bigram BM25 candidates. The metadata SQL used for A0 and lexical mode is unchanged.

`live_session_document_search.ts` applies folder, node, status, backend, and updated-after filters to the document candidates and hydrates the session and task fields. It keeps the first index build in memory, refreshes timestamp changes with a short overlap, checks the complete name roster for renames and deletions, and removes deleted or newly excluded sessions.

The provider fuses the filtered A0 list and the top 100 filtered document candidates with RRF (`k=60`), retaining 50 candidates. `jev_session_reranker.ts` sends their C3 cards to Jev. Successful scores order the response by relevance, with RRF as the tie-breaker. Document-only hits use `match_source="session_document"` and an excerpt from summary, request, or title.

## Failure and response

Jev completes in one request unless the fixed payload limits require two concurrent batches. There are no retries. Missing key, malformed response, or request failure returns RRF order with null relevance and a partial semantic search status (`timeout` or `error`). The index reports its own partial source status if refresh or candidate filtering fails.

The response retains `query_expansion: { status: "skipped", latency_ms: 0 }`; `original_body` and `semantic_body` remain deferred. `session_document` and `rerank` report the new stages. The dashboard displays the returned `best_match.match_source`; this PR does not change its interface.
