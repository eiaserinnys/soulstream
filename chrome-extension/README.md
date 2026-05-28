# Soulstream Page Actions Chrome Extension

MV3 unpacked extension for sending the current page to Soulstream through the existing orchestrator session API.

## Server/API contract

The extension does not add a Soulstream server endpoint. It posts a generated prompt to:

```text
POST {Soulstream URL}/api/sessions
```

This is the same route used by the unified dashboard. Authentication follows the existing orch-server policy:

- web session cookie is sent with `credentials: "include"`
- optional `Authorization: Bearer {token}` can be configured
- `nodeId`, `profile`, `folderId`, and `reasoningEffort` are optional request fields
- extension settings are stored in `chrome.storage.local`; bearer tokens are not synced

## Privacy policy

The extension sends page data only after a user clicks one of the context menu actions. It does not run background uploads.

The content script extracts URL, title, current selection, meta description, and a body candidate from `article`, `main`, `[role=main]`, or `body`. Restricted pages degrade to URL/title/selection only. Body text is capped by the configured character limit and the prompt records whether it was truncated.

## Local build

```bash
pnpm --dir chrome-extension install
pnpm --dir chrome-extension build
```

Load `chrome-extension/dist` from `chrome://extensions` with Developer Mode enabled.

## Context menu actions

- 북마크하기
- 북마크 + 다이제스트 포스트하기
- 레퍼런스 정리하기
- 레퍼런스 정리 + 다이제스트 포스트하기
