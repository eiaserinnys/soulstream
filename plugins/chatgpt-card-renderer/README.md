# Soulstream card renderer plugin

A standalone, read-only MCP Apps renderer. **Soulstream's backend stays unchanged.** This folder is a prototype, not a deployed or installed ChatGPT plugin.

## Architecture

1. ChatGPT reads cards through the user's existing, authorized Soulstream MCP connection.
2. ChatGPT copies only the card fields into this plugin's `render_soulstream_cards` tool.
3. This plugin returns structured data and its own HTML UI resource.
4. ChatGPT displays that resource in an iframe.

The renderer never calls Soulstream, inherits no OAuth token, stores no card data, and has no mutation tools. It owns presentation only. This is the official [decoupled data-tool → render-tool pattern](https://developers.openai.com/plugins/build/chatgpt-ui#separate-data-processing-from-ui-rendering), applied across two connected MCP servers. Cross-plugin orchestration and iframe rendering still need an end-to-end ChatGPT check.

The widget displays Korean status badges, optional assignees/update times, light/dark styles, and a local status filter. It shows a snapshot supplied through the conversation, not an independently verified or automatically synchronized backend view. Statuses are `todo`, `queued`, `blocked`, `running`, `review`, `done`, `cancelled`, and `unknown`.

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

The server code does not implement production OAuth, TLS, rate limiting, or persistence. A development endpoint must not be mistaken for an authenticated production service. A separate direct-to-Soulstream bridge is possible later, but would require its own approved authentication/authorization; this prototype intentionally avoids that.

## Data contract and privacy

`render_soulstream_cards` accepts `{ cards: [...] }`, at most 100 cards. Each card has `id`, `title`, `status`, optional `assignee` and optional ISO `updatedAt` (or null). Defaults for missing assignee/date are empty/null. Unknown extra card fields are rejected. No original request text, reports, briefs, credentials, or session history should be passed. String lengths and array sizes are bounded; the HTTP boundary also limits request bodies to 128 KiB.

Card fields are transmitted to the **renderer operator**, even though that service does not query Soulstream. Use a trusted destination and obtain appropriate permission before sending private data. The code itself does not log or persist request bodies; infrastructure can, so its configuration matters. Model-passed values are untrusted, schema-validated, and rendered with `textContent`. This renderer cannot cryptographically establish their provenance.

`total` counts only the cards supplied to the renderer; it is not a claim about the whole Soulstream board. For more than 100 cards, select an intentional subset or separate batches, preserving their real IDs and titles. `normalizeCards` is an optional local projection helper for the current `{ cards: [...] }` response shape; the renderer does not invoke it to access any backend.

## Validation

Automated tests cover projection/minimization, unknown values, malformed and empty data, real in-memory MCP tool discovery/resource read/call, rejection of extra fields and oversized batches, safe DOM rendering, repeated filters, empty/error states, generated-HTML consistency, plugin metadata and HTTP routes/body limits. `npm run typecheck` validates the source.

Not verified here: a real authenticated Soulstream→ChatGPT→renderer flow or browser visual QA. No production files, authentication settings, or deployment configuration are changed by this folder. No production service is started by package installation.

## References

- [MCP server/UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)
- [Separate data processing from UI rendering](https://developers.openai.com/plugins/build/chatgpt-ui#separate-data-processing-from-ui-rendering)
- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Soulstream card tool](https://github.com/eiaserinnys/soulstream/blob/main/soul-server-ts/src/mcp/tools/card_tools.ts)

No OpenAI API key is needed; this is an MCP UI server, not a model API client.
