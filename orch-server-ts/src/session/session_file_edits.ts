import type { SessionWorkspaceSessionDiffResponse } from "@soulstream/wire-schema/session-workspace";
import { relativePath } from "./session_file_activity.js";

type Event = { event_type: string; payload: any; created_at: Date | string };
type Edit = SessionWorkspaceSessionDiffResponse["edits"][number];
const pathOnly = new Set(["edit_file", "write_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "notebook_edit", "NotebookEdit", "edit", "write"]);
const lines = (value: string) => value === "" ? [] : value.replace(/\n$/, "").split("\n");
function whole(value: string, kind: "add" | "delete"): string {
  const parts = lines(value); const n = parts.length;
  return `${kind === "add" ? `@@ -0,0 +1,${n} @@` : `@@ -1,${n} +0,0 @@`}\n${parts.map(line => `${kind === "add" ? "+" : "-"}${line}`).join("\n")}`;
}
function editHunk(oldValue: string, newValue: string): string {
  const old = lines(oldValue), next = lines(newValue);
  let start = 0, end = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++;
  return ["@@ @@", ...old.slice(0, start).map(x => ` ${x}`), ...old.slice(start, old.length - end).map(x => `-${x}`), ...next.slice(start, next.length - end).map(x => `+${x}`), ...old.slice(old.length - end).map(x => ` ${x}`)].join("\n");
}
export function collectSessionFileEdits(root: string | null, path: string, events: readonly Event[]): SessionWorkspaceSessionDiffResponse {
  const result: SessionWorkspaceSessionDiffResponse = { path, edits: [], unrecorded: 0, truncated: false };
  const failed = new Set(events.filter(e => e.event_type === "tool_result" && e.payload?.is_error === true).map(e => e.payload.tool_use_id).filter(Boolean));
  const matches = (value: unknown) => typeof value === "string" && relativePath(root, value) === path;
  for (const event of events) {
    const p = event.payload; if (!p || typeof p !== "object") continue;
    const tool = p.tool_name; const input = p.tool_input ?? {};
    const at = new Date(event.created_at).toISOString();
    const push = (kind: Edit["kind"], text: string, line_numbers: boolean, replace_all = false) => {
      result.edits.push({at, tool, kind, text, line_numbers, replace_all});
      if (p.truncation) result.truncated = true;
    };
    if (event.event_type === "tool_start" && !failed.has(p.tool_use_id)) {
      const file = input.file_path ?? input.notebook_path ?? input.filePath ?? input.AbsolutePath ?? input.Path ?? input.TargetFile;
      if (!matches(file)) continue;
      if (tool === "Edit" && typeof input.old_string === "string" && typeof input.new_string === "string") push("edit", editHunk(input.old_string, input.new_string), false, input.replace_all === true);
      else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
        const hunks = input.edits.filter((e: any) => typeof e.old_string === "string" && typeof e.new_string === "string");
        if (hunks.length) push("edit", hunks.map((e: any) => editHunk(e.old_string, e.new_string)).join("\n"), false, hunks.some((e: any) => e.replace_all === true));
        else result.unrecorded++;
      } else if (tool === "Write" && typeof input.content === "string") push("write", whole(input.content, "add"), true);
      else if (pathOnly.has(tool) || ["Edit", "Write"].includes(tool)) { result.unrecorded++; if (p.truncation) result.truncated = true; }
    } else if (event.event_type === "tool_result" && tool === "file_change" && !p.is_error) {
      let changes: any; try { changes = JSON.parse(p.result); } catch { continue; }
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        if (!matches(change?.path) || typeof change.diff !== "string") continue;
        const kind = change.kind?.type;
        if (kind === "update") push("edit", change.diff, true);
        else if (kind === "add" || kind === "delete") push(kind, whole(change.diff, kind), true);
      }
    }
  }
  let size = result.edits.reduce((sum, e) => sum + Buffer.byteLength(e.text), 0);
  while (size > 512 * 1024 && result.edits.length) { size -= Buffer.byteLength(result.edits.shift()!.text); result.truncated = true; }
  return result;
}
