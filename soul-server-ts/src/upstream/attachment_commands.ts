import {
  AttachmentError,
  FileNotFoundError,
  type AttachmentStore,
} from "../attachments/file_manager.js";

export interface UploadAttachmentParams {
  requestId: string;
  sessionId?: string;
  filename?: string;
  contentType?: string;
  contentB64?: string;
}

export interface StartAttachmentUploadParams {
  requestId: string;
  uploadId?: string;
  sessionId?: string;
  filename?: string;
  contentType?: string;
  expectedSize?: number;
}

export interface AppendAttachmentUploadChunkParams {
  requestId: string;
  uploadId?: string;
  chunkIndex?: number;
  contentB64?: string;
}

export interface FinishAttachmentUploadParams {
  requestId: string;
  uploadId?: string;
}

export interface AbortAttachmentUploadParams {
  requestId: string;
  uploadId?: string;
}

export interface DeleteSessionAttachmentsParams {
  requestId: string;
  sessionId?: string;
}

export interface DownloadAttachmentParams {
  requestId: string;
  path?: string;
}

export interface UploadAttachmentAck {
  type: "upload_attachment_result";
  requestId: string;
  path: string;
  filename: string;
  size: number;
  content_type: string;
}

export interface StartAttachmentUploadAck {
  type: "upload_attachment_start_ack";
  requestId: string;
  upload_id: string;
  next_chunk_index: number;
}

export interface AppendAttachmentUploadChunkAck {
  type: "upload_attachment_chunk_ack";
  requestId: string;
  upload_id: string;
  chunk_index: number;
  next_chunk_index: number;
  size: number;
}

export interface AbortAttachmentUploadAck {
  type: "upload_attachment_abort_ack";
  requestId: string;
  upload_id: string;
  aborted: boolean;
}

export interface DeleteSessionAttachmentsAck {
  type: "delete_session_attachments_result";
  requestId: string;
  cleaned: true;
  files_removed: number;
}

export interface DownloadAttachmentAck {
  type: "download_attachment_result";
  requestId: string;
  content_b64: string;
  content_type: string;
  filename: string;
  size: number;
}

export class AttachmentCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentCommandError";
  }
}

/**
 * Owns upstream attachment command semantics.
 *
 * FileAttachmentStore owns local filesystem safety. This boundary owns the
 * upstream wire adaptation around it: base64 validation/decoding, command
 * field validation, result ACK payloads, and attachment-specific error
 * normalization. Dispatcher still owns routing, requestId send gating, and
 * the generic sendError envelope.
 */
export class AttachmentCommands {
  constructor(private readonly store: AttachmentStore) {}

  async upload(params: UploadAttachmentParams): Promise<UploadAttachmentAck> {
    if (!params.contentB64) {
      throw new AttachmentCommandError("INVALID_REQUEST: content_b64 누락");
    }
    if (!params.sessionId) {
      throw new AttachmentCommandError("INVALID_REQUEST: session_id 누락");
    }

    const content = decodeBase64(params.contentB64);
    try {
      const result = await this.store.saveFileForSession({
        sessionId: params.sessionId,
        filename: params.filename || "unnamed",
        content,
        contentType: params.contentType || "application/octet-stream",
      });
      return {
        type: "upload_attachment_result",
        requestId: params.requestId,
        path: result.path,
        filename: result.filename,
        size: result.size,
        content_type: result.content_type,
      };
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw new AttachmentCommandError(`INVALID_REQUEST: ${err.message}`);
      }
      throw err;
    }
  }

  async startUpload(
    params: StartAttachmentUploadParams,
  ): Promise<StartAttachmentUploadAck> {
    if (!params.uploadId) {
      throw new AttachmentCommandError("INVALID_REQUEST: upload_id 누락");
    }
    if (!params.sessionId) {
      throw new AttachmentCommandError("INVALID_REQUEST: session_id 누락");
    }
    const expectedSize = params.expectedSize;
    if (
      expectedSize !== undefined
      && (!Number.isFinite(expectedSize) || !Number.isInteger(expectedSize) || expectedSize < 0)
    ) {
      throw new AttachmentCommandError("INVALID_REQUEST: 파일 크기가 잘못되었습니다");
    }

    try {
      const result = await this.store.beginFileUpload({
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        filename: params.filename || "unnamed",
        contentType: params.contentType || "application/octet-stream",
        expectedSize,
      });
      return {
        type: "upload_attachment_start_ack",
        requestId: params.requestId,
        upload_id: result.uploadId,
        next_chunk_index: result.next_chunk_index,
      };
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw new AttachmentCommandError(`INVALID_REQUEST: ${err.message}`);
      }
      throw err;
    }
  }

  async appendUploadChunk(
    params: AppendAttachmentUploadChunkParams,
  ): Promise<AppendAttachmentUploadChunkAck> {
    if (!params.uploadId) {
      throw new AttachmentCommandError("INVALID_REQUEST: upload_id 누락");
    }
    const chunkIndex = params.chunkIndex;
    if (typeof chunkIndex !== "number" || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new AttachmentCommandError("INVALID_REQUEST: chunk_index 누락 또는 잘못된 값");
    }
    if (!params.contentB64) {
      throw new AttachmentCommandError("INVALID_REQUEST: content_b64 누락");
    }

    const chunk = decodeBase64(params.contentB64);
    try {
      const result = await this.store.appendFileUploadChunk({
        uploadId: params.uploadId,
        chunk,
        chunkIndex,
      });
      return {
        type: "upload_attachment_chunk_ack",
        requestId: params.requestId,
        upload_id: result.uploadId,
        chunk_index: result.chunk_index,
        next_chunk_index: result.next_chunk_index,
        size: result.size,
      };
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw new AttachmentCommandError(`INVALID_REQUEST: ${err.message}`);
      }
      throw err;
    }
  }

  async finishUpload(
    params: FinishAttachmentUploadParams,
  ): Promise<UploadAttachmentAck> {
    if (!params.uploadId) {
      throw new AttachmentCommandError("INVALID_REQUEST: upload_id 누락");
    }

    try {
      const result = await this.store.finishFileUpload({ uploadId: params.uploadId });
      return {
        type: "upload_attachment_result",
        requestId: params.requestId,
        path: result.path,
        filename: result.filename,
        size: result.size,
        content_type: result.content_type,
      };
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw new AttachmentCommandError(`INVALID_REQUEST: ${err.message}`);
      }
      throw err;
    }
  }

  async abortUpload(
    params: AbortAttachmentUploadParams,
  ): Promise<AbortAttachmentUploadAck> {
    if (!params.uploadId) {
      throw new AttachmentCommandError("INVALID_REQUEST: upload_id 누락");
    }
    try {
      const aborted = await this.store.abortFileUpload({ uploadId: params.uploadId });
      return {
        type: "upload_attachment_abort_ack",
        requestId: params.requestId,
        upload_id: params.uploadId,
        aborted,
      };
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw new AttachmentCommandError(`INVALID_REQUEST: ${err.message}`);
      }
      throw err;
    }
  }

  async deleteSessionAttachments(
    params: DeleteSessionAttachmentsParams,
  ): Promise<DeleteSessionAttachmentsAck> {
    if (!params.sessionId) {
      throw new AttachmentCommandError("INVALID_REQUEST: session_id 누락");
    }

    try {
      const filesRemoved = await this.store.cleanupSession(params.sessionId);
      return {
        type: "delete_session_attachments_result",
        requestId: params.requestId,
        cleaned: true,
        files_removed: filesRemoved,
      };
    } catch (err) {
      if (err instanceof AttachmentError) {
        throw new AttachmentCommandError(`INVALID_REQUEST: ${err.message}`);
      }
      throw err;
    }
  }

  async download(params: DownloadAttachmentParams): Promise<DownloadAttachmentAck> {
    if (!params.path) {
      throw new AttachmentCommandError("INVALID_REQUEST: path 누락 또는 빈 문자열");
    }

    try {
      const result = await this.store.downloadAttachment(params.path);
      return {
        type: "download_attachment_result",
        requestId: params.requestId,
        content_b64: result.content_b64,
        content_type: result.content_type,
        filename: result.filename,
        size: result.size,
      };
    } catch (err) {
      if (err instanceof FileNotFoundError) {
        throw new AttachmentCommandError(`NOT_FOUND: ${err.message}`);
      }
      if (err instanceof AttachmentError) {
        throw new AttachmentCommandError(`INVALID_REQUEST: ${err.message}`);
      }
      throw err;
    }
  }
}

function decodeBase64(contentB64: string): Buffer {
  try {
    const content = Buffer.from(contentB64, "base64");
    if (content.toString("base64").replace(/=+$/, "") !== contentB64.replace(/=+$/, "")) {
      throw new Error("invalid base64");
    }
    return content;
  } catch (err) {
    throw new AttachmentCommandError(
      `INVALID_REQUEST: base64 디코딩 실패: ${stringifyError(err)}`,
    );
  }
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
