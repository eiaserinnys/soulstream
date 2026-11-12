import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AttachmentStore } from "../../src/attachments/file_manager.js";
import { createAttachmentSourceReader } from "../../src/attachments/source_file_reader.js";
import {
  AttachmentCommandError,
  AttachmentCommands,
} from "../../src/upstream/attachment_commands.js";
import { createAttachmentCommandFamily } from "../../src/upstream/attachment_command_family.js";

function createStore(): AttachmentStore {
  return {
    saveFileForSession: async () => {
      throw new Error("unused");
    },
    beginFileUpload: async () => {
      throw new Error("unused");
    },
    appendFileUploadChunk: async () => {
      throw new Error("unused");
    },
    finishFileUpload: async () => {
      throw new Error("unused");
    },
    abortFileUpload: async () => true,
    cleanupSession: async () => 0,
    downloadAttachment: async () => {
      throw new Error("unused");
    },
  };
}

describe("read_attachment_source command", () => {
  let base: string;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "attachment-source-"));
    workspace = path.join(base, "workspace");
    outside = path.join(base, "outside");
    await mkdir(path.join(workspace, ".local", "tmp", "cardq"), { recursive: true });
    await mkdir(outside, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function commands(options: { maxBytes?: number; roots?: string[] } = {}) {
    const reader = createAttachmentSourceReader({
      allowedRoots: () => options.roots ?? [workspace],
      maxBytes: options.maxBytes,
    });
    return new AttachmentCommands(createStore(), reader);
  }

  it("reads an absolute path inside a workspace root", async () => {
    const file = path.join(workspace, ".local", "tmp", "cardq", "mock.png");
    await writeFile(file, Buffer.from("png-bytes"));

    const ack = await commands().readSource({ requestId: "read-1", path: file });

    expect(ack).toEqual({
      type: "read_attachment_source_result",
      requestId: "read-1",
      content_b64: Buffer.from("png-bytes").toString("base64"),
      content_type: "image/png",
      filename: "mock.png",
      size: 9,
    });
  });

  it("resolves a relative path under the allowed roots", async () => {
    const file = path.join(workspace, "notes", "report.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "hello");

    const ack = await commands().readSource({
      requestId: "read-2",
      path: path.join("notes", "report.txt"),
    });

    expect(ack.content_b64).toBe(Buffer.from("hello").toString("base64"));
    expect(ack.filename).toBe("report.txt");
    expect(ack.content_type).toBe("text/plain");
  });

  it("rejects a path outside every workspace root", async () => {
    const file = path.join(outside, "secret.txt");
    await writeFile(file, "secret");

    await expect(
      commands().readSource({ requestId: "read-3", path: file }),
    ).rejects.toThrow(/INVALID_REQUEST: 허용된 작업 폴더 밖의 파일입니다/);
  });

  it("rejects a symlink that escapes the workspace root", async () => {
    const file = path.join(outside, "secret.txt");
    await writeFile(file, "secret");
    const link = path.join(workspace, "link.txt");
    await symlink(file, link);

    await expect(
      commands().readSource({ requestId: "read-4", path: link }),
    ).rejects.toBeInstanceOf(AttachmentCommandError);
    await expect(
      commands().readSource({ requestId: "read-4", path: link }),
    ).rejects.toThrow(/허용된 작업 폴더 밖의 파일입니다/);
  });

  it("rejects a missing file", async () => {
    await expect(
      commands().readSource({
        requestId: "read-5",
        path: path.join(workspace, "missing.png"),
      }),
    ).rejects.toThrow(/NOT_FOUND: 파일이 존재하지 않습니다/);
  });

  it("rejects a file above the size cap", async () => {
    const file = path.join(workspace, "big.bin");
    await writeFile(file, Buffer.alloc(32));

    await expect(
      commands({ maxBytes: 16 }).readSource({ requestId: "read-6", path: file }),
    ).rejects.toThrow(/TOO_LARGE:/);
  });

  it("rejects a directory path", async () => {
    await expect(
      commands().readSource({
        requestId: "read-7",
        path: path.join(workspace, ".local"),
      }),
    ).rejects.toThrow(/NOT_FOUND: 파일이 존재하지 않습니다/);
  });

  it("sends the result ACK through the command family", async () => {
    const file = path.join(workspace, "ack.txt");
    await writeFile(file, "ack");
    const sent: unknown[] = [];

    const family = createAttachmentCommandFamily({
      send: async (message) => {
        sent.push(message);
      },
      attachmentCommands: commands(),
    });
    await family.read_attachment_source?.({
      type: "read_attachment_source",
      requestId: "read-8",
      path: file,
    });

    expect(sent).toEqual([
      {
        type: "read_attachment_source_result",
        requestId: "read-8",
        content_b64: Buffer.from("ack").toString("base64"),
        content_type: "text/plain",
        filename: "ack.txt",
        size: 3,
      },
    ]);
  });
});
