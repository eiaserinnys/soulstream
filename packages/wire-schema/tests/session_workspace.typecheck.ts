import type { SessionWorkspaceResponse, SessionWorkspaceSessionDiffResponse } from "@soulstream/wire-schema/session-workspace";

const response: SessionWorkspaceSessionDiffResponse = {
  path: "src/example.ts",
  edits: [{at:"2026-01-01T00:00:00.000Z",tool:"Edit",kind:"edit",text:"@@ @@\n-old\n+new",line_numbers:false,replace_all:false}],
  unrecorded: 0,
  truncated: false,
};
// @ts-expect-error Only the four documented edit kinds are permitted.
const invalid: SessionWorkspaceSessionDiffResponse["edits"][number]["kind"] = "unknown";
const file: SessionWorkspaceResponse["files"][number] = {
  path: "src/example.ts", git_status: null, orig_path: null, added: null, deleted: null, session_added: 3, session_deleted: null,
  size: null, wrote: true, read: false, committed: true, last_activity_at: null,
};
// @ts-expect-error Session line counts must be present, null or a number.
const missing: SessionWorkspaceResponse["files"][number] = { ...file, session_added: undefined };
void [response,invalid,file,missing];
