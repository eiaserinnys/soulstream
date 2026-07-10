import { randomUUID } from "node:crypto";

import {
  AttachmentTransportConnectionError,
  AttachmentTransportTimeoutError,
  MAX_ATTACHMENT_SIZE_BYTES,
  type AttachmentNode,
  type AttachmentRouteOptions,
  type AttachmentTransport,
  type AttachmentUploadInput,
} from "../attachments/attachment_routes.js";
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

export const ATTACHMENT_COMMAND_TIMEOUT_MS = 30_000;
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

async function sendAttachmentCommand<
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
    throw new Error("INVALID_REQUEST: 파일 크기가 잘못되었습니다");
  }
  validateCumulativeSize(expectedSize);
}

function validateCumulativeSize(size: number): void {
  if (size > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error(
      `INVALID_REQUEST: 파일이 너무 큽니다 (${Math.floor(size / 1024 / 1024)}MB > ` +
        `${MAX_ATTACHMENT_SIZE_BYTES / 1024 / 1024}MB)`,
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
