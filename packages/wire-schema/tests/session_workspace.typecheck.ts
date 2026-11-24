import type { SessionWorkspaceSessionDiffResponse } from "@soulstream/wire-schema/session-workspace";

const response: SessionWorkspaceSessionDiffResponse = {
  path: "src/example.ts",
  edits: [{at:"2026-01-01T00:00:00.000Z",tool:"Edit",kind:"edit",text:"@@ @@\n-old\n+new",line_numbers:false,replace_all:false}],
  unrecorded: 0,
  truncated: false,
};
// @ts-expect-error Only the four documented edit kinds are permitted.
const invalid: SessionWorkspaceSessionDiffResponse["edits"][number]["kind"] = "unknown";
void [response,invalid];
