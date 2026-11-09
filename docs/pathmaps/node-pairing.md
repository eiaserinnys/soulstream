# Node pairing and credentials

Scope: device-code pairing for a new participant node, the `node_credentials`
table, and the in-memory credential resolver placed in composition. Bearer
inspection wiring and node_id matching are out of scope for this chapter's
first wave; they land in P2 and must add their step here.

## Pairing flow

1. The node calls the public, unauthenticated `POST /api/node-pair/start`
   with `{node_id, company_pc}`. `orch-server-ts/src/node_credentials/pairing_routes.ts`
   forwards to `NodePairingService.start`, which validates `node_id` against
   `^[a-z0-9][a-z0-9-]{1,62}$`, rejects when 20 pairings are already pending
   (429), and returns `device_code`, `user_code` (`XXXX-XXXX`), `expires_at`,
   and `interval_secs: 3`. `start` and `poll` are listed as public in
   `nodePairingRouteAuthRequirements`, so the production auth guard does not
   require a bearer.
2. The node polls `POST /api/node-pair/poll` with `device_code`. Until an
   operator approves, the response is `{status: "pending"}`. Missing, expired,
   or already-consumed codes return 404. Pending pairings live in orchestrator
   memory only; a restart losing them is intended. Each entry carries its own
   `unref`'d TTL timer, so an approved-but-never-polled token is dropped from
   memory when the ten minutes elapse, without waiting for the next request.
3. An operator approves with the internal MCP tool `approve_node_pairing`.
   The service normalizes the user code (case, hyphen, whitespace), re-approves
   idempotently with the same result (concurrent approvals of one code share a
   single in-flight attempt, and a failed attempt stays retryable), and refuses
   with 409 when the node id
   already has an active credential (`node_credentials`), is connected to this
   orchestrator (`NodeSnapshotService.getNode`), or appears in the stored node
   inventory (`soulstream_node_heartbeats`, written by the soul-server
   schedule dispatcher). The error message names the source that matched.
4. Approval generates a 32-byte base64url token, stores only its SHA-256 in
   `node_credentials`, and marks the pairing approved. The first poll after
   approval returns `{status: "approved", node_id, company_pc, token}` and
   drops the token from memory; later polls return 404. The approved entry is
   kept until the original 10-minute TTL so re-approval stays idempotent.

## Credential store and resolver

`orch-server-ts/src/node_credentials/credential_store.ts` implements
`NodeCredentialResolver`. `initialize()` loads active rows once at startup into
a `sha256(token) -> NodePrincipal` map; `resolve` is synchronous and reads only
that map. If the startup read fails, the store stays closed and `resolve`
returns null for every token (the existing shared-token path is unaffected).
`revokeCredential` updates the map and notifies `onRevoked` listeners after the
row is marked revoked.

`list_node_credentials` and `revoke_node_credential` expose only credential
metadata; tokens, device codes, and hashes never appear in tool responses or
logs.

`orch-server-ts/src/production.ts` builds `SqlNodeCredentialRepository` on the
live SQL resolver, initializes the store, and passes the same `NodePairingService`
to `nodePairRoutes` (public routes) and `mcpHostRoutes.nodePairing` (admin
tools). There is no global singleton; the resolver instance lives in the
composition root.

## Tables and files

| Item | Location |
| --- | --- |
| Table `node_credentials` + partial unique active index | `packages/db-schema/sql/migrations/150_node_credentials.sql` |
| Manifest and mirror | `packages/db-schema/migration-manifest.json`, `packages/db-schema/sql/schema.sql` |
| Public routes | `orch-server-ts/src/node_credentials/pairing_routes.ts` |
| Pairing service | `orch-server-ts/src/node_credentials/pairing_service.ts` |
| Store and repository | `orch-server-ts/src/node_credentials/credential_store.ts`, `credential_repository.ts` |
| MCP contract | `packages/mcp-contract/src/node_pairing_tools.ts` |
| MCP handlers | `orch-server-ts/src/mcp/node_pairing_handlers.ts` |
| soul-server forwarding | `soul-server-ts/src/mcp/tools/node_pairing.ts` |
