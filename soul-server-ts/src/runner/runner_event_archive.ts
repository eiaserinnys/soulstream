import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import type { Logger } from "pino";

import type { RunnerHostRequestClient } from "./runner_host_request_client.js";
import type { RunnerEventArchiveInput } from "./runner_child_runtime_helpers.js";

export const EVENT_ARCHIVE_HOST_DEADLINE_MS = 30_000;

// The attachment name is what people see in the viewer title, so it says
// what the text is instead of exposing the event type and hash.
const ARCHIVE_LABELS: Record<string, string> = {
  tool_result: "도구 결과",
  tool_start: "도구 입력",
  assistant_message: "응답",
  thinking: "생각",
};

export function eventArchiveDisplayName(eventType: string, extension: string): string {
  return `${ARCHIVE_LABELS[eventType] ?? "이벤트"} 전문.${extension}`;
}

export async function archiveRunnerEvent(
  input: RunnerEventArchiveInput & {
    incomingFileDir?: string;
    sessionId: string;
    activeExecutionCommandId?: string;
    host: Pick<RunnerHostRequestClient, "call">;
    logger: Pick<Logger, "warn">;
  },
): Promise<AttachmentDescriptor | null> {
  if (!input.incomingFileDir || !input.activeExecutionCommandId) return null;

  const digest = createHash("sha256")
    .update(input.content.body, "utf8")
    .digest("hex")
    .slice(0, 16);
  const fileName = `${input.eventType}-${digest}.${input.content.extension}`;
  const name = eventArchiveDisplayName(input.eventType, input.content.extension);
  const sessionDirectory = join(input.incomingFileDir, input.sessionId);
  const localPath = join(sessionDirectory, fileName);

  try {
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(localPath, input.content.body, { encoding: "utf8", mode: 0o600 });
    return await input.host.call(
      "event_archive",
      "register",
      [localPath, name, input.content.mimeType],
      {
        timeoutMs: EVENT_ARCHIVE_HOST_DEADLINE_MS,
        deadlineMs: EVENT_ARCHIVE_HOST_DEADLINE_MS,
        attempts: 1,
      },
    ) as AttachmentDescriptor;
  } catch (error) {
    input.logger.warn(
      { err: error, sessionId: input.sessionId, eventType: input.eventType, name },
      "Runner event archive failed",
    );
    return null;
  }
}
