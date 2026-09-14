# External LLM ingress rollout

This change separates MCP authority from review attribution. Generic public MCP remains an external principal with source `llm`; a credential-bound connector route may use source `external-llm`. Both are subject to the same destructive-tool block, parent removal, and `llm` mutation actor rules.

Authenticated direct HTTP provenance is fixed by the server as well: a verified dashboard cookie becomes `browser`, and a verified dashboard JWT bearer becomes `soul-app`. In both cases the verified JWT identity replaces body-supplied attribution, so an identified user cannot evade review by submitting `source=system` or `source=llm`. Opaque service-bearer integrations retain their explicitly supplied attribution after service authentication.

## Compatibility and order

1. Run one central Haniel release through `deploy/release-manifest.json`. Migration 091 is an internal phase of that release, not a manual SQL prerequisite: Haniel builds and preflights, quiesces the exact central writer set, verifies its receipt, and lets the release executor take the advisory lock and journal the ordered migration apply. Do not run `091_system_settings.sql` directly or bypass the release executor. Its `ON CONFLICT DO NOTHING` seed never overwrites an existing policy.
2. Let the same central release start the new orchestrator before its local worker. On `eiaserinnys`, the `soulstream` repository owns both services, but `soulstream-soul-server-ts` declares `after: soulstream-orch-server`; Haniel waits for orchestrator readiness before starting the worker. Old remote workers omit `callerInfo`, so the new host preserves their legacy review values without reading the new table. This keeps the migration/code rollout non-blocking.
3. After the central authority release and its post-start verification succeed, deploy worker-only nodes one at a time with `deploy/release-manifest-worker.json`. That manifest has no migration phase. New workers send `callerInfo`, keep legacy review fields only for old-orchestrator compatibility, and replace their provisional Task values with the central host response. The enforced central release → remote workers order avoids the temporary old-host policy limitation.
4. Enable the dedicated ingress only on the connector-facing node after path, source, display name, and a distinct local bearer are present. Keep the existing tunnel upstream unchanged until the central and remote worker gates pass, so external traffic is cut over last. Other nodes leave the ingress disabled.

Code rollback does not remove `system_settings`; old code ignores the additive table and fields. Existing sessions are never reclassified or backfilled. If the policy row is missing or corrupt, new central-wire registrations fail before insert with an actionable 503 while legacy workers remain compatible during rollout.

Roll workers back before the orchestrator. A registration first committed through the central-policy wire contract must not be retried by an old worker, because old code ignores the returned central decision and could later project its provisional review state. The new orchestrator rejects that downgrade replay with `409` (fail closed); restart it on new worker code rather than changing the idempotency key. The opposite transition remains compatible: a new worker replaying a receipt first committed by legacy code receives and applies the original legacy decision without a policy reread.

## Existing OpenAI tunnel cutover

Operating inspection established that the tunnel process keeps its public registration identity/control credential separately from its local MCP upstream and extra headers. Preserve the existing public tunnel ID, public connector URL, control-plane credential, and tunnel binary. Change only the local MCP upstream to the dedicated ingress, provide the new local bearer through the service's secret mechanism, remove the obsolete caller-origin header, and restart the tunnel after the worker route is healthy.

Do not copy tunnel IDs, bearer values, or control-plane credentials into source, PR text, logs, or evidence documents. Verification should report only key presence, endpoint class, and redacted fingerprints when needed.

Claude.ai gateway construction is not part of this rollout. A future vendor-supported transport or gateway may target the same vendor-neutral `external-llm` ingress and credential boundary.

## Verification

- Confirm the policy table/seed and current version before worker rollout.
- Confirm generic `llm` and dedicated `external-llm` both reject destructive tools, discard caller parent IDs, and write `actor_kind=llm`.
- Confirm the dedicated bearer cannot authenticate the generic route and the service bearer cannot authenticate the dedicated route.
- Confirm a dedicated-ingress session stores source `external-llm`, receives the central review decision, and appears in review only after reaching a terminal state.
- Confirm tunnel public registration identifiers are unchanged after the local upstream switch without printing their values.
