import type { SoulSSEEvent } from "@shared/types";
import { ATTACHMENT_PATH_NOTE_PREFIX } from "../lib/attachment-path-notes";
import type { PendingChatSend } from "./dashboard-store-types";

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((path) => rightSet.has(path));
}

function removeAttachmentPathNotes(text: string, notes: ReadonlySet<string>): string {
  const lines = text.split(/\r?\n/).filter((line) => !notes.has(line));
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

export function pendingChatSendMatchesEvent(
  pending: PendingChatSend,
  event: SoulSSEEvent,
): boolean {
  if (event.type !== "user_message" && event.type !== "intervention_sent") return false;

  const candidate = event as SoulSSEEvent & { text?: unknown; attachments?: unknown };
  if (typeof candidate.text !== "string") return false;
  if (candidate.text === pending.messageText) return true;
  if (pending.attachmentPaths.length === 0) return false;

  const eventAttachments = candidate.attachments;
  if (
    !Array.isArray(eventAttachments)
    || !eventAttachments.every((path): path is string => typeof path === "string")
    || !samePathSet(pending.attachmentPaths, eventAttachments)
  ) {
    return false;
  }

  const notes = new Set(
    pending.attachmentPaths.map((path) => `${ATTACHMENT_PATH_NOTE_PREFIX}${path}]`),
  );
  return removeAttachmentPathNotes(pending.messageText, notes)
    === removeAttachmentPathNotes(candidate.text, notes);
}
