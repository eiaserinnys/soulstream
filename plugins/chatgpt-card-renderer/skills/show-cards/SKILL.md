---
name: show-soulstream-cards
description: Display previously retrieved Soulstream work cards in a read-only card view using the separate renderer plugin.
---

# Show Soulstream cards

For an automatically synchronized view, prefer the existing authenticated Soulstream connection's `show_live_card_view` tool when available. No input card array is needed. Pass `folder_id` only when the user requested a particular folder, and a maximum `limit` of 100. The widget refreshes through `list_live_cards` on that same connection. A tool result is not evidence that the UI was delivered: report any host rendering failure honestly. Do not send a backend token to the standalone renderer.

If only the standalone snapshot renderer is connected:

1. Identify the folder or bounded card set requested by the user. Use the existing connected Soulstream read tools to retrieve it. Discover currently available tool names rather than assuming a legacy task API exists.
2. If retrieval fails or access is denied, report that error. Never invent cards, change access, or substitute demo data.
3. Confirm the renderer destination is trusted and the requested sharing is authorized. Card fields pass through its server; it does not inherit Soulstream credentials.
4. Copy the exact ID, title, and status from the retrieved data into `render_soulstream_cards`. Include assignee and update time only when available and needed. Map unsupported statuses to `unknown`; do not guess status meanings. Pass no requests, briefs, reports, tokens, or session history.
5. Send at most 100 cards. Explain any selection or batch boundary. The renderer count covers supplied cards only.
6. Treat the result as a read-only snapshot. The filter changes only this snapshot. To refresh, retrieve through Soulstream again and make a new rendering call.

If this renderer tool is not connected, explain the missing setup and show a concise text summary instead. A local preview is not a ChatGPT-installed widget. Never deploy a service, configure credentials, or edit Soulstream as part of merely displaying cards.
