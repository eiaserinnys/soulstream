# Conversation provider path map

- Authentication and OAuth scope: `orch-server-ts/src/runtime/production_auth_guard.ts`, `orch-server-ts/src/oauth/oauth_access.ts`.
- HTTP entry and request validation: `orch-server-ts/src/conversation/conversation_routes.ts`.
- Thread lifecycle, existing-session access checks and persistent settings: `orch-server-ts/src/conversation/conversation_service.ts`.
- External-key binding and initialization receipt: `orch-server-ts/src/conversation/conversation_repository.ts`, `packages/db-schema/sql/migrations/138_conversation_bindings.sql`.
- Adoption initial-input flag and structured notice migration: `packages/db-schema/sql/migrations/139_conversation_initial_and_notices.sql`; the flag is passed by `conversation_routes.ts` and checked by `conversation_service.ts`.
- History, paging and shared visibility policy: `conversation_history.ts`, `conversation_projection.ts`, `packages/wire-schema/src/conversation_visibility.ts`. The first human input is suppressed when the adoption flag is true or the creation request contains a nonempty initial instruction.
- Live delivery: `conversation_events.ts` subscribes before reading the durable watermark, combines the live-text snapshot with queued events, and uses stored event IDs for SSE cursors. The source is `runtime/composition.ts`'s session event hub.
- Reserved internal session creation: `orch-server-ts/src/session/session_command_routes.ts`.
- Provider composition: `orch-server-ts/src/production.ts`; runtime routes and authentication inventory: `orch-server-ts/src/app.ts` and `orch-server-ts/src/contract/`.
- Thread protocol and examples: `docs/bot-client-api.md` and `orch-server-ts/tests/fixtures/conversation-v1/`.
- Message submission and receipt: `conversation_routes.ts` checks `historyBinding` (account and folder ACL) before `conversation_messages.ts` validates and reserves `(session_id, request_id)` in migration 140. The receipt retains the request hash, fixed caller, upload metadata and delivery id.
- Owned uploads and reads: `conversation_message_ports.ts` uses the existing attachment commit, node cache and legacy alias; history projection restores old path-only names in `conversation_projection.ts` and enriches new uploads from receipts in `conversation_history.ts`.
- Intervention: the facade passes the stored delivery id, caller and paths through `executeSessionIntervention` in `session_action_command_routes.ts`. The existing durable ledger owns delivery and recovery. Attachment reads verify that the requested opaque id belongs to the projected item before resolving the asset or legacy path.
