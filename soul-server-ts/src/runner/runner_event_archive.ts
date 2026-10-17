import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import type { Logger } from "pino";

import type { RunnerHostRequestClient } from "./runner_host_request_client.js";
import type { RunnerEventArchiveInput } from "./runner_child_runtime_helpers.js";

export const EVENT_ARCHIVE_HOST_DEADLINE_MS = 30_000;

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
  const name = `${input.eventType}-${digest}.${input.content.extension}`;
  const sessionDirectory = join(input.incomingFileDir, input.sessionId);
  const localPath = join(sessionDirectory, name);

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
