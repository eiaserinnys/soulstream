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

The host request deadline is 4.7 seconds and the search expander receives at most 4.2 seconds. This reserves 500 ms for the semantic SQL and navigation passes and 300 ms inside the caller's 5-second budget. The measured 3.823-second model trial leaves about 877 ms for database work. These budgets are a measured compromise, not proof that the SQL work always completes. The single request deadline remains authoritative and the API returns explicit partial status when the remaining SQL budget expires.

The full search request's remaining time after expansion, including the semantic SQL pass, has not been measured against the operational database. The 4.7-second host budget has also not been verified against the deployed caller's 5-second timeout. Preserve the single request deadline and partial status when expansion or a later SQL stage runs out of time. Do not present the direct model trial as end-to-end search latency.

## Release and runtime verification

1. Apply the session-search schema migration before serving the new search projection.
2. Point `MODEL_CATALOG_PATH` at the deployed authoritative catalog and set the preset and `low` effort above. Do not change the turn-summary model settings.
3. Start Orch through the normal service release path. Confirm its startup log has no `Search query expansion is in lexical-only mode` warning and confirm the process environment points at the readable catalog used by the resolver.
4. Confirm the service-selected catalog resolves the preset to its backend model and supports `low`. Submit a paraphrased session query; confirm `search_status.query_expansion.status` is `expanded` and the semantic SQL pass completes before the request deadline. Measure the full search latency. The source-level invocation test verifies the resolved model argument and configured reasoning-effort argument.
5. If the path or preset cannot be resolved, keep the visible partial state and correct the service configuration. Do not treat lexical-only output as completion of semantic search.

The deployment operator verifies the live environment and actual CLI execution. Source-level tests only prove resolver and invocation wiring; they do not prove that the deployed process can read the operational catalog or complete a model call within the search budget.
