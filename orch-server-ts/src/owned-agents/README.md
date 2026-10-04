# User-owned external MCP agents

The central `external_agents` and `external_agent_credentials` tables own agent identity and SHA256 key verification. The existing external ingress URL and configured token stay unchanged. Migration 117 and the migration manifest deploy together. Shared internal service credentials are never imported.

All REST routes require a current JWT user in `users`; agent and key operations only access that user's agents. No request accepts an owner email.

| Method | Route | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/owned-agents` | | `{agents,existingConnection}` |
| POST | `/api/owned-agents` | `{name}` | 201 `{agent}` |
| PATCH | `/api/owned-agents/:id` | `{name?,enabled?}` | `{agent}` |
| POST | `/api/owned-agents/:id/keys` | `{}` | 201 `{credential,token}` |
| DELETE | `/api/owned-agents/:id/keys/:keyId` | | 204 |
| POST | `/api/owned-agents/register-existing` | `{name?}` | `{agent,credential}` |

Agent fields are `id,name,ownerEmail,enabled,createdAt,updatedAt`. List agents additionally contain `keys`, whose fields are `id,createdAt,lastUsedAt,revokedAt,isExistingConnection`. `existingConnection` contains `configured,registered,canRegister`. Key issuance returns the raw token once; lists, registration, revocation and ordinary responses contain neither tokens nor verification hashes.

Existing-connection registration requires admin access and hashes the configured token in server memory. An active record owned by the same user is idempotent. Another owner or a disabled/revoked connection returns 409. Internal MCP `register_existing_mcp_agent {name?,caller_session_id?}` calls this same service after checking the transport/explicit session ID and resolving its persisted user/admin identity. It does not issue raw tokens in chat.

Each external HTTP request checks central credentials before legacy env compatibility. Unregistered legacy credentials retain the existing public tools; registered credentials additionally expose the eight recurring tools. Disabled/revoked records block env fallback. Database verification errors return 503. Recurring actor identity and execution metadata preserve the external source and registered agent ID, with the verified user's reservation ACL. External `caller_session_id` never supplies identity.

Internal recurring calls resolve owners from persisted session metadata and official caller/predecessor relations, independently of worker memory. Internal delegation keeps its actual agent/source/user_id and adds only verified owner email and external ownership evidence. Events keep the legacy credential-derived subscription IDs, isolate external subscriptions by credential, and share one store. Internal recipients list all active subscriptions; send selects exactly one recipient, preserving internal sender validation.

This PR provides backend contracts only. The existing reservations and production credentials are untouched by implementation/tests; the parent session registers the existing connection after deployment through the official route.
