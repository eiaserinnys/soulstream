# Soulstream card renderer plugin

A read-only MCP Apps card UI, with two modes: an authenticated **live view** served through Soulstream's existing MCP, and the standalone snapshot renderer retained for development. Source availability does not mean the new live tools are deployed or registered.

## Live architecture

1. Call `show_live_card_view` on the existing authenticated Soulstream MCP connection. No card array is needed. Optional `folder_id` scopes the view; omitted means all cards visible through that existing connection. `limit` defaults to 100 and cannot exceed 100.
2. The thin registration in `soul-server-ts/src/mcp/tools/live_card_view.ts` reads through the same guarded MCP server, caller request context, and `FolderService.listCards` path used by `list_cards`. It neither copies tokens nor creates new permissions.
3. Soulstream returns the actual card projection and the plugin-owned HTML as `ui://soulstream/live-cards-v2.html`.
4. The iframe calls `list_live_cards` through the same host MCP bridge for manual and 30-second automatic refresh. It never calls the backend directly and never receives credentials.

Presentation and the dependency-free card projection remain in this plugin folder. The small Soulstream registration is required because only the authenticated source can safely perform repeated reads. The standalone public snapshot renderer does **not** gain private backend access.

The widget shows Korean status badges, optional assignees/update times, last successful sync time, and a local status filter. Hidden documents pause polling; visibility restores a refresh. Only one refresh is in flight. A new model-supplied view invalidates old in-flight results. Requests time out after 10 seconds. Teardown removes timers/listeners and clears data. A failed refresh is shown as an error, never converted to an empty-success response; stale data is labeled, and known authorization failures clear it.

A query returns at most 100 cards but reports the full returned-source count and truncation. It is not a streaming subscription. Backend retrieval currently uses the existing unpaginated card-list API. UI visibility notifications depend on the host correctly marking hidden frames.

## Deploy/retest checklist (not performed by these files)

- Run the plugin tests/typecheck and relevant Soulstream MCP tests/build.
- Deploy the reviewed Soulstream MCP build through the existing authorized release flow. The standalone renderer service alone cannot activate the live tools.
- Refresh the existing connection's tool/resource metadata. The new URI prevents reuse of the previous snapshot HTML cache key.
- Discover `show_live_card_view` and call it without an input card array, optionally with an authorized folder ID.
- Confirm real initial cards, manual refresh, periodic refresh, permission failure, and close behavior in normal ChatGPT and dot separately. A successful tool call does not prove dot delivered the iframe.
- Keep existing transport authentication and folder ACLs unchanged. No token export, anonymous backend proxy, or new access grant is required by this integration.

## Standalone snapshot mode

`render_soulstream_cards` remains a separate renderer that accepts already-retrieved data, following the [decoupled data-tool → render-tool pattern](https://developers.openai.com/plugins/build/chatgpt-ui#separate-data-processing-from-ui-rendering). It does not fetch or auto-refresh Soulstream. Its cards pass through the renderer operator, so the destination must be trusted and sharing authorized. Empty snapshot input correctly displays no cards; use the live tool for automatic real retrieval.

## Local development

Requires Node.js 24. This folder is intentionally independent of the production pnpm workspace.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm start
```

Open http://127.0.0.1:8787/preview for **fictional example cards**. The local MCP endpoint is http://127.0.0.1:8787/mcp. The process binds to loopback by default. Use `HOST` and `PORT` only in a separately reviewed deployment. The preview route does not fetch real data.

`npm run build:widget` regenerates `src/widget-html.ts` after edits to `public/cards.html`. All HTML/CSS/JavaScript is embedded; the widget makes no network requests.

## Plugin files and installation gap

- `plugin.json`: portable plugin identity
- `mcp.json`: deliberately empty server mappings until a real endpoint is approved
- `skills/show-cards/SKILL.md`: data retrieval and rendering workflow
- `src/server.ts`: standalone streamable HTTP MCP server and local preview
- `src/card-view.ts`: strict render-only tool and HTML resource registration

A manifest alone cannot make ChatGPT run this Node server. Someone must operate the renderer endpoint. To test in ChatGPT:

1. Review and choose a trusted host for this renderer, separately from Soulstream. Deploy behind HTTPS with appropriate access control, request-size/rate limits, and no request-body logging. No hosting is provisioned by this prototype.
2. Register the real `/mcp` URL through ChatGPT's developer-mode plugin connection flow. Keep the existing Soulstream connection separate; do not copy its credentials.
3. For portable plugin packaging, replace `mcp.json`'s empty `mcpServers` object with a named entry containing `type: "streamable-http"` and the approved HTTPS `/mcp` URL. For OpenAI registered-app packaging, obtain the actual registered connection ID and configure the mapping using the current plugin tooling. No fictitious server URL or connection ID is bundled.
4. Enable both relevant connections and ask ChatGPT to retrieve a small card list, then render it. Check exact field fidelity, empty/error states, mobile layout, and access-denied retrieval behavior.

### Request boundary policy

Host and Origin are checked before reading a body or invoking MCP. By default, allowed Host values are `localhost:<listening-port>`, `127.0.0.1:<listening-port>`, and `[::1]:<listening-port>`. Present Origin values must exactly match the corresponding `http://` loopback origin at that port. Missing Origin is accepted for non-browser MCP clients; `Origin: null` and unlisted origins are rejected with HTTP 403. Duplicate Host/Origin headers are rejected.

A reviewed HTTPS deployment can set comma-separated `ALLOWED_HOSTS` (exact authorities, with port when needed) and `ALLOWED_ORIGINS` (exact origins including scheme and port, no trailing slash). Each configured list **replaces** its loopback defaults. For example, an operator may allow only the renderer's chosen public authority and separately reviewed browser client origins. Do not use wildcards or reflect arbitrary request origins. These variables configure only this server; no OS/network settings are changed. `HOST` controls the bind address and does not automatically authorize that address. Reverse proxies must preserve an explicitly allowed Host; forwarded Host/Origin headers are not trusted.

Aborted request-body reads are contained per request; the server neither crashes nor writes an error to a destroyed response. The widget acknowledges `ui/resource-teardown` with the caller's request ID and clears card state/listeners before disposal. These controls are not substitutes for authentication.

The server code does not implement production OAuth, TLS, rate limiting, or persistence. A development endpoint must not be mistaken for an authenticated production service. The live integration instead reuses the existing authenticated Soulstream MCP. Do not give this standalone service an administrator token as a shortcut.

## Data contract and privacy

`render_soulstream_cards` accepts `{ cards: [...] }`, at most 100 cards. Each card has `id`, `title`, `status`, optional `assignee` and optional ISO `updatedAt` (or null). Defaults for missing assignee/date are empty/null. Unknown extra card fields are rejected. No original request text, reports, briefs, credentials, or session history should be passed. String lengths and array sizes are bounded; the HTTP boundary also limits request bodies to 128 KiB.

Card fields are transmitted to the **renderer operator**, even though that service does not query Soulstream. Use a trusted destination and obtain appropriate permission before sending private data. The code itself does not log or persist request bodies; infrastructure can, so its configuration matters. Model-passed values are untrusted, schema-validated, and rendered with `textContent`. This renderer cannot cryptographically establish their provenance.

`total` counts only the cards supplied to the renderer; it is not a claim about the whole Soulstream board. For more than 100 cards, select an intentional subset or separate batches, preserving their real IDs and titles. `normalizeCards` is an optional local projection helper for the current `{ cards: [...] }` response shape; the renderer does not invoke it to access any backend.

## Validation

Automated tests cover projection/minimization, unknown values, malformed and empty data, real in-memory MCP tool discovery/resource read/call, rejection of extra fields and oversized batches, safe DOM rendering, repeated filters, empty/error states, generated-HTML consistency, plugin metadata and HTTP routes/body limits, aborted uploads in a child process, exact Host/Origin policy, and UI teardown/request-response ID collisions. `npm run typecheck` validates the source.

Not verified here: a deployed authenticated live-card flow in ChatGPT/dot or browser visual QA. Local tests cover the MCP adapter with injected source responses and the UI host bridge with a test DOM. The live adapter changes Soulstream MCP source registration only; authentication settings and deployment configuration are not changed. No production service is started by package installation.

## References

- [MCP server/UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)
- [Separate data processing from UI rendering](https://developers.openai.com/plugins/build/chatgpt-ui#separate-data-processing-from-ui-rendering)
- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Soulstream card tool](https://github.com/eiaserinnys/soulstream/blob/main/soul-server-ts/src/mcp/tools/card_tools.ts)

No OpenAI API key is needed; this is an MCP UI server, not a model API client.
