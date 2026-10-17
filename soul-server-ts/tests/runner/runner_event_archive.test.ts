import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import type { EventArchiveContent } from "../../src/db/event_payload_truncation.js";
import { archiveRunnerEvent } from "../../src/runner/runner_event_archive.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true }),
  ));
});

describe("archiveRunnerEvent", () => {
  it("writes the original file and sends only its path, name, and MIME type to the host", async () => {
    const incomingFileDir = await mkdtemp(join(tmpdir(), "soulstream-event-archive-"));
    directories.push(incomingFileDir);
    const body = "private full tool result\n";
    const digest = createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
    const name = "도구 결과 전문.txt";
    const localPath = join(incomingFileDir, "session-a", `tool_result-${digest}.txt`);
    const descriptor = {
      attachment_id: "attachment-1",
      name,
      mime_type: "text/plain",
      byte_size: Buffer.byteLength(body, "utf8"),
      checksum_sha256: "a".repeat(64),
      width: null,
      height: null,
      preview_kind: "text",
      preview_mime_type: "text/plain",
    } satisfies AttachmentDescriptor;
    const hostCall = vi.fn(async () => descriptor);
    const content: EventArchiveContent = {
      body,
      mimeType: "text/plain",
      extension: "txt",
    };

    await expect(archiveRunnerEvent({
      incomingFileDir,
      sessionId: "session-a",
      eventType: "tool_result",
      content,
      activeExecutionCommandId: "command-1",
      host: { call: hostCall } as never,
      logger: { warn: vi.fn() } as never,
    })).resolves.toEqual(descriptor);

    expect(await readFile(localPath, "utf8")).toBe(body);
    expect(hostCall).toHaveBeenCalledWith(
      "event_archive",
      "register",
      [localPath, name, "text/plain"],
      { timeoutMs: 30_000, deadlineMs: 30_000, attempts: 1 },
    );
    expect(JSON.stringify(hostCall.mock.calls[0]?.[2])).not.toContain(body);
  });

  it("returns null without registering when incoming storage or an active execution is absent", async () => {
    const hostCall = vi.fn();
    const logger = { warn: vi.fn() } as never;
    const common = {
      sessionId: "session-a",
      eventType: "tool_result",
      content: { body: "payload", mimeType: "text/plain", extension: "txt" },
      host: { call: hostCall } as never,
      logger,
    };

    await expect(archiveRunnerEvent({ ...common, activeExecutionCommandId: "command-1" }))
      .resolves.toBeNull();
    const incomingFileDir = await mkdtemp(join(tmpdir(), "soulstream-event-archive-"));
    directories.push(incomingFileDir);
    await expect(archiveRunnerEvent({ ...common, incomingFileDir }))
      .resolves.toBeNull();
    expect(hostCall).not.toHaveBeenCalled();
  });

  it.each(["host error", "host deadline"])("returns null and logs no body on %s", async (failure) => {
    const incomingFileDir = await mkdtemp(join(tmpdir(), "soulstream-event-archive-"));
    directories.push(incomingFileDir);
    const body = "do not put this body in logs";
    const warning = vi.fn();
    const hostCall = vi.fn(async () => { throw new Error(failure); });

    await expect(archiveRunnerEvent({
      incomingFileDir,
      sessionId: "session-a",
      eventType: "tool_result",
      content: { body, mimeType: "text/plain", extension: "txt" },
      activeExecutionCommandId: "command-1",
      host: { call: hostCall } as never,
      logger: { warn: warning } as never,
    })).resolves.toBeNull();

    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(body);
  });

  it("returns null and warns when writing the archive file fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "soulstream-event-archive-"));
    directories.push(directory);
    const occupiedPath = join(directory, "not-a-directory");
    await writeFile(occupiedPath, "file");
    const warning = vi.fn();
    const hostCall = vi.fn();

    await expect(archiveRunnerEvent({
      incomingFileDir: occupiedPath,
      sessionId: "session-a",
      eventType: "tool_result",
      content: { body: "private bytes", mimeType: "text/plain", extension: "txt" },
      activeExecutionCommandId: "command-1",
      host: { call: hostCall } as never,
      logger: { warn: warning } as never,
    })).resolves.toBeNull();

    expect(warning).toHaveBeenCalledOnce();
    expect(hostCall).not.toHaveBeenCalled();
  });
});
