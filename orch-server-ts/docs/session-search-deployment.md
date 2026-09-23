# Session search deployment

Semantic query expansion is an additive search path. The original and normalized lexical queries remain available if the model path is unavailable. Product search returns `search_status.query_expansion.status = partial` in that case; clients must display the partial result state.

## Model catalog settings

The central Orch process must read the existing operational model catalog. Set these values in the Orch service environment:

```dotenv
MODEL_CATALOG_PATH=<deployed path to production-staging/config/model-catalog.yaml>
SEARCH_QUERY_EXPANSION_PRESET_ID=codex-6-luna
SEARCH_QUERY_EXPANSION_EFFORT=low
```

The `codex-6-luna` preset resolves the backend model ID from the catalog. Do not put a backend model ID in a second environment variable or copy the catalog into Orch. The catalog is parsed and resolved once when Orch starts; update the environment and restart Orch through the normal release procedure after catalog changes. A missing path, preset, or supported effort leaves expansion in an explicit configuration-error / lexical-partial state. There is no model fallback.

The production-staging catalog declares `codex-6-luna` as a Codex preset, resolves its backend model to `gpt-6-luna`, supports `low` and `max`, and declares `xhigh` as its default. Search configuration explicitly selects `low`; the catalog default is not used for this request. Turn-summary settings remain unchanged.

## Search effort measurement

On 2026-09-23, the resolver loaded the operational catalog and resolved `gpt-6-luna` with the configured effort. A query-only expansion trial for `검색 결과에서 연결된 일을 바로 열기` at `low` returned three concise variants in 3.435 seconds using the temporary verified catalog mapping. Repeating against the operational catalog returned the same kind of variants in 3.823 seconds with a 4-second trial limit; two shorter trials ended just beyond their 3.5- and 3.6-second limits. `max` and `xhigh` each timed out at 3.5 seconds. The chosen `low` effort is the best measured fit, but model latency is close to the original 4-second host budget.

Lexical product requests and MCP/event search requests keep the 4.7-second host deadline. Product requests with `include_session_results=true` and no explicit lexical mode use a separate 10-second expanded deadline; explicit `session_search_mode=expanded` follows the same budget. The query expander is capped at 8 seconds so semantic SQL, navigation, and projection remain inside that single request deadline. Abort still propagates into the model subprocess and request-owned database query. Web, app, and lab callers use cancellable requests without a shorter local timeout; a newer query or screen exit can still cancel them.

The separate budget is based on three bounded, isolated expanded trials with the production resolver's `gpt-6-luna/low` setting. Their full provider times were 6.815, 6.049, and 5.474 seconds; executor wall times were 5.487, 4.741, and 3.844 seconds. The fixture contained 2,500 synthetic sessions, 9,997 events, and 139,962 postings, not production data. In the recovery trial two generated expressions retrieved the target at candidate rank 1; in each post-fix trial one did. The recovery trial's final projection rank was 50, while the two post-fix projections placed it at rank 1. Other generated expressions did not retrieve it. The old five-run report was not recoverable, so its success rate remains unverified. This sample supports a bounded expanded path but does not prove production reliability or meet the former 4.7-second final-result target. Keep lexical first paint separate from final semantic completion and report partial status on timeout or model failure. MCP/event and lexical deadlines remain 4.7 seconds.

## Release and runtime verification

1. Apply the session-search schema migration before serving the new search projection.
2. Point `MODEL_CATALOG_PATH` at the deployed authoritative catalog and set the preset and `low` effort above. Do not change the turn-summary model settings.
3. Start Orch through the normal service release path. Confirm its startup log has no `Search query expansion is in lexical-only mode` warning and confirm the process environment points at the readable catalog used by the resolver.
4. Confirm the service-selected catalog resolves the preset to its backend model and supports `low`. Submit a paraphrased session query; confirm `search_status.query_expansion.status` is `expanded` and the semantic SQL pass completes before the 10-second expanded request deadline. Measure the full search latency separately from lexical first paint. The source-level invocation test verifies the resolved model argument and configured reasoning-effort argument.
5. If the path or preset cannot be resolved, keep the visible partial state and correct the service configuration. Do not treat lexical-only output as completion of semantic search.

The deployment operator verifies the live environment and actual CLI execution. Source-level tests only prove resolver and invocation wiring; they do not prove that the deployed process can read the operational catalog or complete a model call within the search budget.
