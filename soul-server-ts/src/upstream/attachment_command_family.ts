import {
  CommandDispatchError,
  commandRequestId,
  type CommandHandlerMap,
  type CommandLike,
  type SendFn,
} from "./command_family.js";
import {
  AttachmentCommandError,
  AttachmentCommands,
} from "./attachment_commands.js";

interface UploadAttachmentCmd extends CommandLike {
  type: "upload_attachment";
  session_id?: string;
  filename?: string;
  content_type?: string;
  content_b64?: string;
}

interface UploadAttachmentStartCmd extends CommandLike {
  type: "upload_attachment_start";
  upload_id?: string;
  session_id?: string;
  filename?: string;
  content_type?: string;
  expected_size?: number;
}

interface UploadAttachmentChunkCmd extends CommandLike {
  type: "upload_attachment_chunk";
  upload_id?: string;
  chunk_index?: number;
  content_b64?: string;
}

interface UploadAttachmentFinishCmd extends CommandLike {
  type: "upload_attachment_finish";
  upload_id?: string;
}

interface UploadAttachmentAbortCmd extends CommandLike {
  type: "upload_attachment_abort";
  upload_id?: string;
}

interface DeleteSessionAttachmentsCmd extends CommandLike {
  type: "delete_session_attachments";
  session_id?: string;
}

interface DownloadAttachmentCmd extends CommandLike {
  type: "download_attachment";
  path?: string;
}

interface AttachmentCommandFamilyDeps {
  send: SendFn;
  attachmentCommands: AttachmentCommands;
}

export function createAttachmentCommandFamily(
  deps: AttachmentCommandFamilyDeps,
): CommandHandlerMap {
  return {
    upload_attachment: (cmd) => handleUploadAttachment(deps, cmd as UploadAttachmentCmd),
    upload_attachment_start: (cmd) =>
      handleUploadAttachmentStart(deps, cmd as UploadAttachmentStartCmd),
    upload_attachment_chunk: (cmd) =>
      handleUploadAttachmentChunk(deps, cmd as UploadAttachmentChunkCmd),
    upload_attachment_finish: (cmd) =>
      handleUploadAttachmentFinish(deps, cmd as UploadAttachmentFinishCmd),
    upload_attachment_abort: (cmd) =>
      handleUploadAttachmentAbort(deps, cmd as UploadAttachmentAbortCmd),
    delete_session_attachments: (cmd) =>
      handleDeleteSessionAttachments(deps, cmd as DeleteSessionAttachmentsCmd),
    download_attachment: (cmd) =>
      handleDownloadAttachment(deps, cmd as DownloadAttachmentCmd),
  };
}

async function handleUploadAttachment(
  deps: AttachmentCommandFamilyDeps,
  cmd: UploadAttachmentCmd,
): Promise<void> {
  const requestId = commandRequestId(cmd);
  try {
    const ack = await deps.attachmentCommands.upload({
      requestId,
      sessionId: cmd.session_id,
      filename: cmd.filename,
      contentType: cmd.content_type,
      contentB64: cmd.content_b64,
    });
    if (requestId) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof AttachmentCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleUploadAttachmentStart(
  deps: AttachmentCommandFamilyDeps,
  cmd: UploadAttachmentStartCmd,
): Promise<void> {
  const requestId = commandRequestId(cmd);
  try {
    const ack = await deps.attachmentCommands.startUpload({
      requestId,
      uploadId: cmd.upload_id,
      sessionId: cmd.session_id,
      filename: cmd.filename,
      contentType: cmd.content_type,
      expectedSize: cmd.expected_size,
    });
    if (requestId) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof AttachmentCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleUploadAttachmentChunk(
  deps: AttachmentCommandFamilyDeps,
  cmd: UploadAttachmentChunkCmd,
): Promise<void> {
  const requestId = commandRequestId(cmd);
  try {
    const ack = await deps.attachmentCommands.appendUploadChunk({
      requestId,
      uploadId: cmd.upload_id,
      chunkIndex: cmd.chunk_index,
      contentB64: cmd.content_b64,
    });
    if (requestId) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof AttachmentCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleUploadAttachmentFinish(
  deps: AttachmentCommandFamilyDeps,
  cmd: UploadAttachmentFinishCmd,
): Promise<void> {
  const requestId = commandRequestId(cmd);
  try {
    const ack = await deps.attachmentCommands.finishUpload({
      requestId,
      uploadId: cmd.upload_id,
    });
    if (requestId) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof AttachmentCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleUploadAttachmentAbort(
  deps: AttachmentCommandFamilyDeps,
  cmd: UploadAttachmentAbortCmd,
): Promise<void> {
  const requestId = commandRequestId(cmd);
  try {
    const ack = await deps.attachmentCommands.abortUpload({
      requestId,
      uploadId: cmd.upload_id,
    });
    if (requestId) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof AttachmentCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleDeleteSessionAttachments(
  deps: AttachmentCommandFamilyDeps,
  cmd: DeleteSessionAttachmentsCmd,
): Promise<void> {
  const requestId = commandRequestId(cmd);
  try {
    const ack = await deps.attachmentCommands.deleteSessionAttachments({
      requestId,
      sessionId: cmd.session_id,
    });
    if (requestId) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof AttachmentCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

async function handleDownloadAttachment(
  deps: AttachmentCommandFamilyDeps,
  cmd: DownloadAttachmentCmd,
): Promise<void> {
  const requestId = commandRequestId(cmd);
  try {
    const ack = await deps.attachmentCommands.download({
      requestId,
      path: cmd.path,
    });
    if (requestId) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof AttachmentCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}
