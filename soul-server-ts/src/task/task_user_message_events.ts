import type { Logger } from "pino";

import { withoutSessionContextSourceMarkers } from "../context/session_context_sources.js";
import type { ContextItem } from "../context/prompt_assembler.js";
import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";

import type { CallerInfo, Task } from "./task_models.js";

export interface UserMessageEventPublisherDeps {
  logger: Logger;
  persistence?: EventPersistence;
}

export interface UserMessageEventInput {
  text: string;
  inputId?: string;
  user?: string;
  callerInfo?: CallerInfo;
  attachmentPaths?: string[];
  attachmentIds?: string[];
  attachmentBindings?: AttachmentPathBinding[];
  contextItems?: ContextItem[];
  purpose?: "cache_keepalive";
}

export function buildUserMessageEvent(input: UserMessageEventInput): Record<string, unknown> {
  const contextItems = withoutSessionContextSourceMarkers(input.contextItems);
  const event: Record<string, unknown> = {
    type: "user_message",
    user:
      input.callerInfo?.display_name ??
      input.callerInfo?.user_id ??
      input.user ??
      "unknown",
    text: input.text,
    timestamp: Date.now() / 1000,
  };
  if (input.inputId) {
    event.input_id = input.inputId;
  }
  if (input.callerInfo) {
    event.caller_info = input.callerInfo;
  }
  if (input.purpose) {
    event.purpose = input.purpose;
  }
  if (input.attachmentPaths && input.attachmentPaths.length > 0) {
    event.attachments = input.attachmentPaths;
  }
  const attachmentIds = dedupeAttachmentIds(input.attachmentIds);
  if (attachmentIds.length > 0) {
    event.attachment_ids = attachmentIds;
    event.attachment_count = inputAttachmentCount(
      input.attachmentIds,
      input.attachmentPaths,
      input.attachmentBindings,
    );
  }
  if (contextItems.length > 0) {
    event.context = contextItems;
  }
  return event;
}

export async function persistUserMessageEvent(
  task: Task,
  event: Record<string, unknown>,
  deps: UserMessageEventPublisherDeps,
): Promise<void> {
  if (!deps.persistence) {
    throw new Error("user_message durable event persistence is required");
  }
  const registrationId = task.executionRegistration?.registrationId;
  if (registrationId === undefined) {
    await deps.persistence.enqueueEvent(task.agentSessionId, event as SSEEventPayload);
    return;
  }
  await deps.persistence.enqueueEvent(
    task.agentSessionId,
    event as SSEEventPayload,
    undefined,
    registrationId,
  );
}

export async function finishUserMessageEvent(
  task: Task,
  event: Record<string, unknown>,
  deps: UserMessageEventPublisherDeps,
): Promise<void> {
  if (!deps.persistence) return;
  try {
    await deps.persistence.handleSideEffects(
      task.agentSessionId,
      event as SSEEventPayload,
      task,
    );
  } catch (err) {
    deps.logger.warn(
      { err, sessionId: task.agentSessionId },
      "user_message handleSideEffects failed",
    );
  }
}

/** Deduplicate attachment ids, preserving first-seen order. */
export function dedupeAttachmentIds(ids: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids ?? []) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

/**
 * Authoritative attachment count: unique ids plus legacy paths that no admitted
 * binding covers. A binding retires a path only when its id is one of the
 * message's ids and its path is one of the message's attachment paths.
 */
export function inputAttachmentCount(
  ids: readonly string[] | undefined,
  paths: readonly string[] | undefined,
  bindings: readonly AttachmentPathBinding[] | undefined,
): number {
  const uniqueIds = new Set<string>();
  for (const id of ids ?? []) {
    if (typeof id === "string" && id.length > 0) uniqueIds.add(id);
  }
  const uniquePaths = new Set<string>();
  for (const path of paths ?? []) {
    if (typeof path === "string" && path.length > 0) uniquePaths.add(path);
  }
  const coveredPaths = new Set<string>();
  for (const binding of bindings ?? []) {
    if (!binding || !uniqueIds.has(binding.attachment_id)) continue;
    if (!uniquePaths.has(binding.path)) continue;
    coveredPaths.add(binding.path);
  }
  return uniqueIds.size + (uniquePaths.size - coveredPaths.size);
}
