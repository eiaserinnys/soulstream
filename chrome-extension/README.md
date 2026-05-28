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

## Release artifact

Chrome extension releases use tags that match `chrome-extension-v*`.

```bash
git tag chrome-extension-v0.0.1
git push origin chrome-extension-v0.0.1
```

Pushing that tag runs the `Release Chrome Extension` workflow. The workflow tests, typechecks, builds, packages `chrome-extension/dist`, creates a GitHub Release, and uploads a zip named like:

```text
soulstream-chrome-extension-chrome-extension-v0.0.1.zip
```

The workflow can also be run manually from GitHub Actions. Manual runs upload the same zip as a workflow artifact, but they do not create or update a GitHub Release.

To create the same zip locally:

```bash
pnpm --dir chrome-extension build
pnpm --dir chrome-extension package -- --tag chrome-extension-v0.0.1-test
```

The package step verifies that the zip contains `manifest.json` at the root, so the extracted folder can be loaded directly.

## Install from a release zip

1. Download the zip asset from the GitHub Release.
2. Unzip it.
3. Open `chrome://extensions` or `edge://extensions`.
4. Enable Developer Mode.
5. Choose Load unpacked and select the extracted folder that contains `manifest.json`.

## Context menu actions

- 북마크하기
- 북마크 + 다이제스트 포스트하기
- 레퍼런스 정리하기
- 레퍼런스 정리 + 다이제스트 포스트하기
