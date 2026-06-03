import { describe, expect, it, vi } from "vitest";

import {
  AttachmentError,
  FileNotFoundError,
  type AttachmentStore,
} from "../../src/attachments/file_manager.js";
import {
  AttachmentCommandError,
  AttachmentCommands,
} from "../../src/upstream/attachment_commands.js";

function createStore(overrides: Partial<AttachmentStore> = {}): AttachmentStore {
  return {
    saveFileForSession: vi.fn(async (params) => ({
      path: `/tmp/incoming/${params.sessionId}/${params.filename}`,
      filename: params.filename,
      size: params.content.length,
      content_type: params.contentType ?? "application/octet-stream",
    })),
    beginFileUpload: vi.fn(async (params) => ({
      uploadId: params.uploadId,
      next_chunk_index: 0,
    })),
    appendFileUploadChunk: vi.fn(async (params) => ({
      uploadId: params.uploadId,
      chunk_index: params.chunkIndex,
      next_chunk_index: params.chunkIndex + 1,
      size: params.chunk.length,
    })),
    finishFileUpload: vi.fn(async (params) => ({
      path: `/tmp/incoming/sess/${params.uploadId}.txt`,
      filename: `${params.uploadId}.txt`,
      size: 12,
      content_type: "text/plain",
    })),
    abortFileUpload: vi.fn(async () => true),
    cleanupSession: vi.fn(async () => 0),
    downloadAttachment: vi.fn(async () => ({
      content_b64: Buffer.from("downloaded").toString("base64"),
      content_type: "text/plain",
      filename: "note.txt",
      size: 10,
    })),
    ...overrides,
  };
}

describe("attachment command boundary", () => {
  it("decodes upload base64 and builds upload result ACK", async () => {
    const store = createStore();
    const commands = new AttachmentCommands(store);

    const ack = await commands.upload({
      requestId: "up-1",
      sessionId: "sess-1",
      filename: "hello.txt",
      contentType: "text/plain",
      contentB64: Buffer.from("hello").toString("base64"),
    });

    expect(store.saveFileForSession).toHaveBeenCalledWith({
      sessionId: "sess-1",
      filename: "hello.txt",
      content: Buffer.from("hello"),
      contentType: "text/plain",
    });
    expect(ack).toEqual({
      type: "upload_attachment_result",
      requestId: "up-1",
      path: "/tmp/incoming/sess-1/hello.txt",
      filename: "hello.txt",
      size: 5,
      content_type: "text/plain",
    });
  });

  it("normalizes upload validation and AttachmentStore errors", async () => {
    const commands = new AttachmentCommands(createStore());

    await expect(
      commands.upload({
        requestId: "up-bad",
        sessionId: "sess-1",
        filename: "hello.txt",
        contentB64: "not-base64!!!",
      }),
    ).rejects.toMatchObject({
      name: "AttachmentCommandError",
      message: expect.stringContaining("INVALID_REQUEST: base64 디코딩 실패"),
    });

    const store = createStore({
      saveFileForSession: vi.fn(async () => {
        throw new AttachmentError("보안상 허용되지 않는 파일 형식입니다: .env");
      }),
    });
    const failingCommands = new AttachmentCommands(store);

    await expect(
      failingCommands.upload({
        requestId: "up-denied",
        sessionId: "sess-1",
        filename: ".env",
        contentB64: Buffer.from("secret").toString("base64"),
      }),
    ).rejects.toEqual(
      new AttachmentCommandError("INVALID_REQUEST: 보안상 허용되지 않는 파일 형식입니다: .env"),
    );
  });

  it("starts a chunked upload and builds start ACK", async () => {
    const store = createStore();
    const commands = new AttachmentCommands(store);

    const ack = await commands.startUpload({
      requestId: "start-1",
      uploadId: "up-1",
      sessionId: "sess-1",
      filename: "hello.txt",
      contentType: "text/plain",
      expectedSize: 12,
    });

    expect(store.beginFileUpload).toHaveBeenCalledWith({
      uploadId: "up-1",
      sessionId: "sess-1",
      filename: "hello.txt",
      contentType: "text/plain",
      expectedSize: 12,
    });
    expect(ack).toEqual({
      type: "upload_attachment_start_ack",
      requestId: "start-1",
      upload_id: "up-1",
      next_chunk_index: 0,
    });
  });

  it("rejects invalid expected_size before creating a temp upload", async () => {
    const store = createStore();
    const commands = new AttachmentCommands(store);

    await expect(
      commands.startUpload({
        requestId: "start-invalid",
        uploadId: "up-1",
        sessionId: "sess-1",
        filename: "hello.txt",
        expectedSize: -1,
      }),
    ).rejects.toEqual(
      new AttachmentCommandError("INVALID_REQUEST: 파일 크기가 잘못되었습니다"),
    );
    expect(store.beginFileUpload).not.toHaveBeenCalled();
  });

  it("appends chunked upload content and rejects out-of-order chunks", async () => {
    const store = createStore();
    const commands = new AttachmentCommands(store);

    const ack = await commands.appendUploadChunk({
      requestId: "chunk-1",
      uploadId: "up-1",
      chunkIndex: 0,
      contentB64: Buffer.from("chunk").toString("base64"),
    });

    expect(store.appendFileUploadChunk).toHaveBeenCalledWith({
      uploadId: "up-1",
      chunkIndex: 0,
      chunk: Buffer.from("chunk"),
    });
    expect(ack).toEqual({
      type: "upload_attachment_chunk_ack",
      requestId: "chunk-1",
      upload_id: "up-1",
      chunk_index: 0,
      next_chunk_index: 1,
      size: 5,
    });

    const failingCommands = new AttachmentCommands(
      createStore({
        appendFileUploadChunk: vi.fn(async () => {
          throw new AttachmentError("chunk_index 순서가 맞지 않습니다 (2 != 1)");
        }),
      }),
    );
    await expect(
      failingCommands.appendUploadChunk({
        requestId: "bad-chunk",
        uploadId: "up-1",
        chunkIndex: 2,
        contentB64: Buffer.from("bad").toString("base64"),
      }),
    ).rejects.toEqual(
      new AttachmentCommandError("INVALID_REQUEST: chunk_index 순서가 맞지 않습니다 (2 != 1)"),
    );
  });

  it("finishes and aborts chunked uploads", async () => {
    const store = createStore();
    const commands = new AttachmentCommands(store);

    await expect(
      commands.finishUpload({ requestId: "finish-1", uploadId: "up-1" }),
    ).resolves.toEqual({
      type: "upload_attachment_result",
      requestId: "finish-1",
      path: "/tmp/incoming/sess/up-1.txt",
      filename: "up-1.txt",
      size: 12,
      content_type: "text/plain",
    });
    expect(store.finishFileUpload).toHaveBeenCalledWith({ uploadId: "up-1" });

    await expect(
      commands.abortUpload({ requestId: "abort-1", uploadId: "up-1" }),
    ).resolves.toEqual({
      type: "upload_attachment_abort_ack",
      requestId: "abort-1",
      upload_id: "up-1",
      aborted: true,
    });
    expect(store.abortFileUpload).toHaveBeenCalledWith({ uploadId: "up-1" });
  });

  it("cleans session attachments and builds delete result ACK", async () => {
    const store = createStore({
      cleanupSession: vi.fn(async () => 3),
    });
    const commands = new AttachmentCommands(store);

    const ack = await commands.deleteSessionAttachments({
      requestId: "del-1",
      sessionId: "sess-del",
    });

    expect(store.cleanupSession).toHaveBeenCalledWith("sess-del");
    expect(ack).toEqual({
      type: "delete_session_attachments_result",
      requestId: "del-1",
      cleaned: true,
      files_removed: 3,
    });
  });

  it("normalizes delete AttachmentStore validation errors", async () => {
    const store = createStore({
      cleanupSession: vi.fn(async () => {
        throw new AttachmentError("session_id가 첨부 디렉토리 밖을 가리킵니다");
      }),
    });
    const commands = new AttachmentCommands(store);

    await expect(
      commands.deleteSessionAttachments({
        requestId: "del-bad",
        sessionId: "../outside",
      }),
    ).rejects.toEqual(
      new AttachmentCommandError("INVALID_REQUEST: session_id가 첨부 디렉토리 밖을 가리킵니다"),
    );
  });

  it("downloads attachments and builds download result ACK", async () => {
    const store = createStore({
      downloadAttachment: vi.fn(async () => ({
        content_b64: Buffer.from("png-bytes").toString("base64"),
        content_type: "image/png",
        filename: "image.png",
        size: 9,
      })),
    });
    const commands = new AttachmentCommands(store);

    const ack = await commands.download({
      requestId: "dl-1",
      path: "/tmp/incoming/sess/image.png",
    });

    expect(store.downloadAttachment).toHaveBeenCalledWith("/tmp/incoming/sess/image.png");
    expect(ack).toEqual({
      type: "download_attachment_result",
      requestId: "dl-1",
      content_b64: Buffer.from("png-bytes").toString("base64"),
      content_type: "image/png",
      filename: "image.png",
      size: 9,
    });
  });

  it("normalizes download not-found and invalid-path errors", async () => {
    const missingCommands = new AttachmentCommands(
      createStore({
        downloadAttachment: vi.fn(async () => {
          throw new FileNotFoundError("파일이 존재하지 않습니다");
        }),
      }),
    );

    await expect(
      missingCommands.download({ requestId: "dl-missing", path: "/tmp/missing.txt" }),
    ).rejects.toEqual(new AttachmentCommandError("NOT_FOUND: 파일이 존재하지 않습니다"));

    const invalidCommands = new AttachmentCommands(
      createStore({
        downloadAttachment: vi.fn(async () => {
          throw new AttachmentError("path가 첨부 디렉토리 하위가 아닙니다");
        }),
      }),
    );

    await expect(
      invalidCommands.download({ requestId: "dl-bad", path: "/etc/passwd" }),
    ).rejects.toEqual(
      new AttachmentCommandError("INVALID_REQUEST: path가 첨부 디렉토리 하위가 아닙니다"),
    );
  });
});
