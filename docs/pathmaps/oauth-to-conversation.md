# Conversation provider path map

- HTTP entry and request validation: `orch-server-ts/src/conversation/conversation_routes.ts`.
- Thread lifecycle, existing-session access checks and persistent settings: `orch-server-ts/src/conversation/conversation_service.ts`.
- External-key binding and initialization receipt: `orch-server-ts/src/conversation/conversation_repository.ts`, `packages/db-schema/sql/migrations/138_conversation_bindings.sql`.
- Reserved internal session creation: `orch-server-ts/src/session/session_command_routes.ts`.
- Provider composition: `orch-server-ts/src/production.ts`; runtime routes and authentication inventory: `orch-server-ts/src/app.ts` and `orch-server-ts/src/contract/`.
- Thread protocol and examples: `docs/bot-client-api.md` and `orch-server-ts/tests/fixtures/conversation-v1/`.
