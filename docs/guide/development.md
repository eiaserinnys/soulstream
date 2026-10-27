# Development

Use package-scoped scripts from the repository root so typechecking and tests stay proportional to the surface you changed.

## Package scripts and tests

Typecheck and run unit tests for the orchestrator, worker, web dashboard, and shared UI library:

```bash
pnpm --dir orch-server-ts typecheck
pnpm --dir orch-server-ts test

pnpm --dir soul-server-ts typecheck
pnpm --dir soul-server-ts test

pnpm --dir unified-dashboard typecheck
pnpm --dir unified-dashboard test

pnpm --dir packages/soul-ui typecheck
pnpm --dir packages/soul-ui test
```

Additional worker verification scripts defined in [`soul-server-ts/package.json`](../../soul-server-ts/package.json):

```bash
pnpm --dir soul-server-ts typecheck:contracts
pnpm --dir soul-server-ts verify:bundle
pnpm --dir soul-server-ts verify:startup
```

For the standalone Expo mobile app ([`soul-app/package.json`](../../soul-app/package.json)):

```bash
npm --prefix soul-app test
```

## Playwright end-to-end tests and screenshots

Install the Playwright Chromium browser once before running browser suites in `unified-dashboard`:

```bash
pnpm --dir unified-dashboard exec playwright install chromium
```

Run the Playwright end-to-end suites:

```bash
pnpm --dir unified-dashboard test:e2e:smoke
pnpm --dir unified-dashboard test:e2e:chat-ui
pnpm --dir unified-dashboard test:e2e:pas-report
```

To regenerate the synthetic demo screenshots in `docs/screenshots/` used by the root `README.md`:

```bash
pnpm --dir unified-dashboard capture:readme
```

## Internal architecture and contract references

Detailed engineering invariants, wire contracts, and operational runbooks live under `docs/` and package READMEs:

- [MCP server and tool reference](../mcp.md): loopback internal listener, reflection levels `0` to `3`, and tool tables.
- [Bot client API](../bot-client-api.md): authenticated HTTP and SSE routes for bot clients and ephemeral LLM execution.
- [Custom views](../custom-views.md): sandbox rules, `<soul-bind>` live bindings, and iframe origin allowlists.
- [End-to-end pathmaps](../pathmaps/README.md): code-level path maps for [message-to-terminal](../pathmaps/message-to-terminal.md), [restart recovery](../pathmaps/restart-recovery.md), [runner lifecycle](../pathmaps/runner-lifecycle.md), [session deletion](../pathmaps/session-deletion.md), [delivery ledger](../pathmaps/delivery-ledger.md), [session search](../pathmaps/session-search.md), [timers inventory](../pathmaps/timers-inventory.md), and [folder and card storage](../pathmaps/folder-card-storage.md).
- [Delivery and execution invariants](../delivery-execution-invariants.md) and [runner execution invariants](../runner-execution-invariants.md): durability, outbox replay, and active turn ownership rules.
- [Task and page invariants](../task-page-invariants.md) and [task read compatibility](../task-read-compatibility.md): storage contracts for pages and legacy task compatibility.
- [External LLM ingress rollout](../external-llm-ingress-rollout.md) and [dot MCP events](../dot-mcp-events.md): orchestrator-owned external MCP connector and subscription state.
- [Recurring jobs deployment](../recurring-jobs-deployment.md) and [session search deployment](../../orch-server-ts/docs/session-search-deployment.md): operator verification and runtime setup.
- [Node and orchestrator wire contract](../../packages/wire-schema/src/README.md): JSON Schema (`upstream.schema.json`) and generated TypeScript definitions.
- [Database schema and release safety](../../packages/db-schema/README.md): PostgreSQL DDL, migration checksums, and release executor state machine.
- [Chrome extension](../../chrome-extension/README.md): Manifest V3 unpacked extension setup and API contract.
