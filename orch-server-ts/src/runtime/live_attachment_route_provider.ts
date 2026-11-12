import { randomUUID } from "node:crypto";

import {
  AttachmentRouteError,
  AttachmentTransportConnectionError,
  AttachmentTransportTimeoutError,
  MAX_ATTACHMENT_SIZE_BYTES,
  type AttachmentNode,
  type AttachmentRouteOptions,
  type AttachmentTransport,
  type AttachmentUploadInput,
} from "../attachments/attachment_routes.js";
import type {
  AttachmentSourceReadFile,
  AttachmentSourceReader,
} from "../attachments/card_attachment_source_import.js";
import {
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  type NodeCommandResponse,
  type PendingNodeCommand,
  type RequestResponseNodeCommandPayload,
} from "../node/pending_commands.js";
import type { NodeConnectionSnapshot } from "../node/registry_types.js";
import type { SessionResourceAccessProvider } from "../session/session_resource_access.js";
import {
  NodeCommandTransportError,
  type SessionCommandTransportBridge,
} from "../session/session_command_transport.js";
import type { LiveDashboardAccessProvider } from "./live_dashboard_access_provider.js";

export type LiveAttachmentRouteProviderBundle = Pick<
  AttachmentRouteOptions,
  "provider" | "accessProvider" | "transport"
>;

export type LiveAttachmentCommandRegistry = {
  readonly getConnectedNode: (nodeId: string) => NodeConnectionSnapshot | undefined;
  readonly createCommand: <
    TPayload extends RequestResponseNodeCommandPayload,
    TResponse extends NodeCommandResponse = NodeCommandResponse,
  >(
    nodeId: string,
    payload: TPayload,
    options?: { timeoutMs?: number },
  ) => PendingNodeCommand<TPayload, TResponse>;
};

export type LiveAttachmentCommandBridge = Pick<
  SessionCommandTransportBridge,
  "sendPendingCommand"
>;

export type CreateLiveAttachmentRouteProvidersOptions = {
  readonly registry: LiveAttachmentCommandRegistry;
  readonly bridge: LiveAttachmentCommandBridge;
  readonly uploadIdGenerator?: () => string;
  readonly dashboardAccessProvider: Pick<
    LiveDashboardAccessProvider,
    "resolveAccess"
  >;
  readonly sessionResourceAccessProvider: Pick<
    SessionResourceAccessProvider,
    "requireSessionAccess"
  >;
};

export function createLiveAttachmentRouteProviders(
  options: CreateLiveAttachmentRouteProvidersOptions,
): LiveAttachmentRouteProviderBundle {
  return {
    provider: {
      async getNode(nodeId) {
        return options.registry.getConnectedNode(nodeId) ?? null;
      },
    },
    accessProvider: {
      resolveAccess: options.dashboardAccessProvider.resolveAccess,
      requireSessionAccess:
        options.sessionResourceAccessProvider.requireSessionAccess,
    },
    transport: createLiveAttachmentTransport(options),
  };
}

export const ATTACHMENT_COMMAND_TIMEOUT_MS = 120_000;
export const ATTACHMENT_ABORT_TIMEOUT_MS = 5_000;

export function createLiveAttachmentTransport(
  options: Pick<
    CreateLiveAttachmentRouteProvidersOptions,
    "registry" | "bridge" | "uploadIdGenerator"
  >,
): AttachmentTransport {
  const uploadIdGenerator = options.uploadIdGenerator ?? defaultUploadIdGenerator;

  return {
    uploadAttachment: (node, input) =>
      uploadAttachment(options, uploadIdGenerator, node, input),
    legacyUploadAttachment: (node, input) =>
      sendAttachmentCommand(options, node, {
        type: "upload_attachment",
        session_id: input.sessionId,
        filename: input.filename,
        content_type: input.contentType,
        content_b64: input.contentBase64,
      }),
    deleteSessionAttachments: (node, sessionId) =>
      sendAttachmentCommand(options, node, {
        type: "delete_session_attachments",
        session_id: sessionId,
      }),
    downloadAttachment: (node, path) =>
      sendAttachmentCommand(options, node, {
        type: "download_attachment",
        path,
      }),
  };
}

/**
 * Reads a file from a connected worker's workspace so a card executed on
 * another node can import it. Unlike download_attachment, its base is not the
 * node incoming directory — the node command validates the path against the
 * union of its agents' workspace_dir.
 */
export function createLiveAttachmentSourceReader(
  options: Pick<CreateLiveAttachmentRouteProvidersOptions, "registry" | "bridge">,
): AttachmentSourceReader {
  return async (nodeId, path) => {
    const current = options.registry.getConnectedNode(nodeId);
    if (current === undefined) throw connectionError(`Node is not connected: ${nodeId}`);
    const response = await sendAttachmentCommand(
      options,
      { nodeId, connectionId: current.connectionId },
      { type: "read_attachment_source", path },
    );
    return projectSourceReadResponse(response);
  };
}

function projectSourceReadResponse(result: unknown): AttachmentSourceReadFile {
  const object = isPlainObject(result) ? result : {};
  const contentB64 = object.content_b64;
  const filename = object.filename;
  const size = object.size;
  if (
    typeof contentB64 !== "string"
    || typeof filename !== "string"
    || typeof size !== "number"
    || !Number.isSafeInteger(size)
    || size < 0
    || size > MAX_ATTACHMENT_SIZE_BYTES
  ) {
    throw malformedSourceResponse();
  }
  const content = Buffer.from(contentB64, "base64");
  if (
    content.byteLength !== size
    || content.toString("base64").replace(/=+$/, "") !== contentB64.replace(/=+$/, "")
  ) {
    throw malformedSourceResponse();
  }
  return {
    content,
    filename,
    contentType: typeof object.content_type === "string" && object.content_type.length > 0
      ? object.content_type
      : "application/octet-stream",
    size,
  };
}

function malformedSourceResponse(): AttachmentRouteError {
  return new AttachmentRouteError(
    "MALFORMED_ATTACHMENT_SOURCE_RESPONSE",
    "Node returned malformed attachment source response",
    502,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function uploadAttachment(
  options: Pick<CreateLiveAttachmentRouteProvidersOptions, "registry" | "bridge">,
  uploadIdGenerator: () => string,
  node: AttachmentNode,
  input: AttachmentUploadInput,
): Promise<NodeCommandResponse> {
  validateExpectedSize(input.expectedSize);
  const uploadId = uploadIdGenerator();
  if (uploadId.length === 0) {
    throw new Error("Attachment upload id generator returned an empty id");
  }

  let started = false;
  let totalSize = 0;
  try {
    await sendAttachmentCommand(options, node, {
      type: "upload_attachment_start",
      upload_id: uploadId,
      session_id: input.sessionId,
      filename: input.filename,
      content_type: input.contentType,
      expected_size: input.expectedSize,
    });
    started = true;

    let chunkIndex = 0;
    for await (const chunk of input.chunks) {
      if (chunk.length === 0) continue;
      totalSize += chunk.length;
      validateCumulativeSize(totalSize);
      await sendAttachmentCommand(options, node, {
        type: "upload_attachment_chunk",
        upload_id: uploadId,
        chunk_index: chunkIndex,
        content_b64: chunk.toString("base64"),
      });
      chunkIndex += 1;
    }

    return await sendAttachmentCommand(options, node, {
      type: "upload_attachment_finish",
      upload_id: uploadId,
    });
  } catch (error) {
    if (started) {
      await abortUploadBestEffort(options, node, uploadId);
    }
    throw error;
  }
}

async function abortUploadBestEffort(
  options: Pick<CreateLiveAttachmentRouteProvidersOptions, "registry" | "bridge">,
  node: AttachmentNode,
  uploadId: string,
): Promise<void> {
  try {
    await sendAttachmentCommand(
      options,
      node,
      { type: "upload_attachment_abort", upload_id: uploadId },
      ATTACHMENT_ABORT_TIMEOUT_MS,
    );
  } catch {
    // Preserve the original upload failure. Abort only cleans the node temp file.
  }
}

export async function sendAttachmentCommand<
  TPayload extends RequestResponseNodeCommandPayload,
  TResponse extends NodeCommandResponse = NodeCommandResponse,
>(
  options: Pick<CreateLiveAttachmentRouteProvidersOptions, "registry" | "bridge">,
  node: AttachmentNode,
  payload: TPayload,
  timeoutMs = ATTACHMENT_COMMAND_TIMEOUT_MS,
): Promise<TResponse> {
  try {
    const connectedNode = requireCurrentConnection(options.registry, node);
    const command = options.registry.createCommand<TPayload, TResponse>(
      connectedNode.nodeId,
      payload,
      { timeoutMs },
    );
    return await options.bridge.sendPendingCommand({
      node: connectedNode,
      command,
    });
  } catch (error) {
    throw mapAttachmentCommandError(error);
  }
}

function requireCurrentConnection(
  registry: LiveAttachmentCommandRegistry,
  node: AttachmentNode,
): NodeConnectionSnapshot {
  const nodeId = typeof node.nodeId === "string" ? node.nodeId : node.id;
  const connectionId = node.connectionId;
  if (
    typeof nodeId !== "string" ||
    nodeId.length === 0 ||
    typeof connectionId !== "string" ||
    connectionId.length === 0
  ) {
    throw connectionError("Attachment target is not a connected node snapshot");
  }

  const current = registry.getConnectedNode(nodeId);
  if (current === undefined) {
    throw connectionError(`Node is not connected: ${nodeId}`);
  }
  if (current.connectionId !== connectionId) {
    throw connectionError(`Node transport is stale: ${nodeId}/${connectionId}`);
  }
  return current;
}

function mapAttachmentCommandError(error: unknown): unknown {
  if (
    error instanceof AttachmentTransportConnectionError ||
    error instanceof AttachmentTransportTimeoutError
  ) {
    return error;
  }
  if (error instanceof PendingNodeCommandRejectedError) {
    const invalidRequest = /^INVALID_REQUEST:\s*(.*)$/s.exec(error.message);
    if (invalidRequest) {
      return new AttachmentRouteError(
        "INVALID_ATTACHMENT_REQUEST",
        invalidRequest[1] ?? error.message,
        400,
      );
    }
    if (error.commandType === "download_attachment") {
      const notFound = /^NOT_FOUND:\s*(.*)$/s.exec(error.message);
      if (notFound) {
        return new AttachmentRouteError(
          "ATTACHMENT_NOT_FOUND",
          notFound[1] ?? error.message,
          404,
        );
      }
    }
    if (error.commandType === "read_attachment_source") {
      const notFound = /^NOT_FOUND:\s*(.*)$/s.exec(error.message);
      if (notFound) {
        return new AttachmentRouteError(
          "ATTACHMENT_NOT_FOUND",
          notFound[1] ?? error.message,
          404,
        );
      }
      const tooLarge = /^TOO_LARGE:\s*(.*)$/s.exec(error.message);
      if (tooLarge) {
        return new AttachmentRouteError(
          "ATTACHMENT_TOO_LARGE",
          tooLarge[1] ?? error.message,
          413,
        );
      }
      if (error.message.startsWith("Not implemented in soul-server-ts:")) {
        return new AttachmentRouteError(
          "ATTACHMENT_SOURCE_UNSUPPORTED",
          "실행 노드가 다른 노드의 첨부를 읽는 기능을 지원하지 않습니다.",
          501,
        );
      }
    }
  }
  if (error instanceof PendingNodeCommandTimeoutError) {
    return new AttachmentTransportTimeoutError(error.message);
  }
  if (error instanceof NodeCommandTransportError || isDisconnectedError(error)) {
    return connectionError(errorMessage(error));
  }
  return error;
}

function isDisconnectedError(error: unknown): boolean {
  if (
    error instanceof PendingNodeCommandRejectedError &&
    error.message.startsWith("Node disconnected:")
  ) {
    return true;
  }
  return errorMessage(error).startsWith("node is not connected:");
}

function validateExpectedSize(expectedSize: number): void {
  if (!Number.isFinite(expectedSize) || !Number.isInteger(expectedSize) || expectedSize < 0) {
    throw new AttachmentRouteError("INVALID_ATTACHMENT_SIZE", "파일 크기가 잘못되었습니다", 400);
  }
  validateCumulativeSize(expectedSize);
}

function validateCumulativeSize(size: number): void {
  if (size > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new AttachmentRouteError(
      "ATTACHMENT_TOO_LARGE",
      `파일이 너무 큽니다 (${Math.floor(size / 1024 / 1024)}MB > ` +
        `${MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024}MB)`,
      400,
    );
  }
}

function connectionError(message: string): AttachmentTransportConnectionError {
  return new AttachmentTransportConnectionError(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultUploadIdGenerator(): string {
  return randomUUID().replaceAll("-", "");
}
