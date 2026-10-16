import type { SessionEvent } from '../api/types';
import type { PendingOptimisticEvent } from '../store/chatStore';
import { ATTACHMENT_PATH_NOTE_PREFIX } from '../utils/attachmentPathNotes';

function textOf(event: SessionEvent): string | undefined {
  const text = event.data?.text;
  return typeof text === 'string' ? text : undefined;
}

function eventAttachmentPaths(event: SessionEvent): string[] | undefined {
  const attachments = event.data?.attachments;
  if (!Array.isArray(attachments) || !attachments.every((path) => typeof path === 'string')) {
    return undefined;
  }
  return attachments;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function generatedPathNotes(paths: readonly string[], originalText?: string): Set<string> {
  const originalLines = new Set((originalText ?? '').trim().split(/\r?\n/));
  return new Set(paths
    .filter((path) => path.trim().length > 0)
    .map((path) => `${ATTACHMENT_PATH_NOTE_PREFIX}${path}]`)
    .filter((note) => !originalLines.has(note)));
}

function removeGeneratedPathNotes(text: string, notes: ReadonlySet<string>): string {
  if (notes.size === 0) return text;
  const lines = text.split(/\r?\n/);
  let removed = false;
  const remaining = lines.filter((line) => {
    if (!notes.has(line)) return true;
    removed = true;
    return false;
  });
  if (!removed) return text;
  while (remaining.at(-1) === '') remaining.pop();
  return remaining.join('\n');
}

export function removeGeneratedAttachmentPathNotes(
  text: string,
  paths: readonly string[],
  originalText?: string,
): string {
  return removeGeneratedPathNotes(text, generatedPathNotes(paths, originalText));
}

/** Match a pending user message against its durable event, including B9 path-note removal. */
export function matchesAttachmentPending(
  pending: PendingOptimisticEvent,
  event: SessionEvent,
): boolean {
  const pendingText = textOf(pending);
  const eventText = textOf(event);
  const pendingPaths = pending.attachmentItems?.map(({ path }) => path) ?? [];

  if (pendingPaths.length === 0) return pendingText === eventText;
  if (pendingText === undefined || eventText === undefined) return false;

  const eventPaths = eventAttachmentPaths(event);
  if (!eventPaths || !samePaths(pendingPaths, eventPaths)) return false;

  const pendingNodeId = pending.data?.node_id;
  const eventNodeId = event.data?.node_id;
  if (
    typeof pendingNodeId === 'string'
    && typeof eventNodeId === 'string'
    && pendingNodeId !== eventNodeId
  ) {
    return false;
  }

  const notes = generatedPathNotes(pendingPaths, pending.originalText);
  return removeGeneratedPathNotes(pendingText, notes)
    === removeGeneratedPathNotes(eventText, notes);
}
