# Node pairing and credentials

Scope: device-code pairing for a new participant node, the `node_credentials`
table, the in-memory credential resolver placed in composition, and the P2
bearer propagation that lets those tokens authenticate service routes and node
websockets. The shared service bearer token keeps every behaviour it had before
P2.

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

## Bearer propagation (P2)

`verifyServiceBearerAuthorization(authorization, options)` takes its
configuration as an options object: `configuredToken`, an optional
`environment` (default `production`), and a required nullable
`nodeCredentials` resolver. Order of decisions:

1. Empty `configuredToken`: 503 `not_configured` in production, development
   bypass otherwise.
2. Missing or malformed header: 401.
3. Token equal to the shared service token: accepted with no principal.
4. Otherwise `nodeCredentials?.resolve(token)`: a principal is accepted with
   `{ ok: true, principal }`; anything else is 401 `invalid`.

Every service route option type carries a required
`nodeCredentials: NodeCredentialResolver | null` next to `authBearerToken`, and
the same resolver is passed to the node WS, control WS, socket auth and page
Yjs auth. `null` is written only by tests and non-production composition;
`tests/node-credential-composition-contract.test.ts` fails the build if the
literal appears under `orch-server-ts/src` or `soul-server-ts/src`.
`orch-server-ts/src/production.ts` creates and initializes the store before the
live provider bundle is built and passes that single instance everywhere. If
`initialize()` fails, the orchestrator only warns, every node token resolves to
null, and the shared-token paths behave exactly as before.

## Node websocket binding (P2)

- `/ws/node` keeps the principal resolved in `preValidation` on the connection.
  The first `node_register` and every later catalog refresh (`node_register`
  while registered) reject when the frame's `node_id` differs from
  `principal.node_id`: close code 1008, reason
  `node_id does not match node credential`, before any registry call.
  Connections authenticated by the shared token carry no principal and keep
  registering any node id.
- A live registration belongs to the identity that created it: `legacy` for the
  shared token, `credential_id` for a node token. A new connection registering
  a node id held by a different identity is closed with 1008 and reason
  `node_id is held by a different credential`; the live connection and its
  registry entry stay intact. The same identity reconnecting still replaces
  the old connection (`replaced_by_reconnect`).
- `/ws/node/control` `node_control_register` keeps its existing connection_id
  and `control_channel_v1` checks, then rejects a frame whose `node_id` differs
  from the connection principal with 1008 and the mismatch reason.

## Revocation (P2)

`NodeCredentialStore.revokeCredential` notifies `onRevoked` listeners after the
row is marked revoked. The orchestrator subscribes three times, once each for
`/ws/node`, `/ws/node/control` and Yjs:

- `/ws/node` and `/ws/node/control` each keep a `credential_id -> closers` set
  for their live connections and close the matching ones with 1008 and reason
  `node credential revoked`.
- `PageYjsService.closeConnectionsForCredential` closes the Yjs document
  connections whose Hocuspocus context carries the revoked `credentialId`,
  stamped by `createPageYjsAuthExtension` during `onAuthenticate`. Hocuspocus
  `Connection.close()` drops the document connection and requires a new
  authentication, so the document is no longer reachable; it does not close
  the physical WebSocket with 1008.

The next HTTP request with the revoked token resolves to null and receives 401
from `verifyServiceBearerAuthorization`.

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
