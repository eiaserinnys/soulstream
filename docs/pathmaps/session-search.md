# Session search

## Request path

`GET /cogito/search` enters `cogito_routes.ts`. Requests with `include_session_results=true` and no explicit lexical mode use expanded search; `session_search_mode=lexical` keeps the metadata-only session path. Event-history requests without session results keep the existing event-search path.

Expanded search in `live_cogito_search_provider.ts` obtains A0 from the same metadata candidate function used by lexical mode. It removes A0 session IDs absent from the document index, which excludes internal LLM sessions, then queries the document index for the top 300 bigram BM25 candidates. The metadata SQL used for A0 and lexical mode is unchanged.

`live_session_document_search.ts` applies folder, node, status, backend, and updated-after filters to the document candidates and hydrates the session and task fields. Its cold build uses flat session, digest, and turn-summary reads. The in-memory index stores each title, a whitespace-free `Uint32Array` of document code points, bigram length, and C3 card. Each request refreshes only changed IDs from created sessions, updated digests, new turn-summary events, and a full name-roster comparison for renames and deletions. BM25 linearly scans the code points once, using a first-codepoint bitmap to skip irrelevant positions; it does not retain an inverted index or full request/summary text.

The provider fuses the filtered A0 list and the top 100 filtered document candidates with RRF (`k=60`), retaining 50 candidates. `jev_session_reranker.ts` sends their C3 cards to Jev. Successful scores order the response by relevance, with RRF as the tie-breaker. All expanded hits use the C3 card summary as the excerpt, falling back to its cleaned first request; if both are absent, the existing excerpt remains. The excerpt and `best_match.excerpt` share the same value, clipped to 160 Unicode code points; `evidence` is unchanged.

Session results expose `created_at` and `updated_at` as ISO timestamp strings.

## Failure and response

Jev completes in one request unless the fixed payload limits require two concurrent batches. There are no retries. Missing key, malformed response, or request failure returns RRF order with null relevance and a partial semantic search status (`timeout` or `error`). The index reports its own partial source status if refresh or candidate filtering fails.

The response retains `query_expansion: { status: "skipped", latency_ms: 0 }`; `original_body` and `semantic_body` remain deferred. `session_document` and `rerank` report the new stages. The dashboard session row keeps its existing session label and excerpt; `best_match.match_source` is carried in the response but does not select a new UI label in this PR.
