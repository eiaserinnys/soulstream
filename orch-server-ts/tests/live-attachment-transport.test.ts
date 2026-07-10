import { describe, expect, it, vi } from "vitest";

import {
  AttachmentTransportConnectionError,
  AttachmentTransportTimeoutError,
  createLiveAttachmentRouteProviders,
  InMemoryNodeRegistry,
  MAX_ATTACHMENT_SIZE_BYTES,
  NodeCommandTransportError,
  NodeCommandTransportHub,
  PendingNodeCommandRejectedError,
  PendingNodeCommandTimeoutError,
  SessionCommandTransportBridge,
  type AttachmentUploadInput,
  type LiveAttachmentCommandBridge,
  type NodeCommandResponse,
  type NodeConnectionSnapshot,
  type RequestResponseNodeCommandPayload,
  type RoutedPendingSessionCommand,
} from "../src/index.js";

const nodeId = "node-attachment";
type AnyRoutedPendingCommand = RoutedPendingSessionCommand<
  RequestResponseNodeCommandPayload,
  NodeCommandResponse
>;

describe("live attachment WS transport", () => {
  it("sends start, 1MiB chunks, and finish sequentially through the node command bridge", async () => {
    const fixture = createWireFixture();
    const node = await fixture.providers.provider.getNode(nodeId);
    expect(node).not.toBeNull();

    const result = await fixture.providers.transport.uploadAttachment(
      node!,
      uploadInput([Buffer.from("hello"), Buffer.from("world")]),
    );

    expect(result).toMatchObject({
      path: "/incoming/session-a/photo.png",
      filename: "photo.png",
      size: 10,
      content_type: "image/png",
    });
    expect(fixture.sent).toEqual([
      {
        type: "upload_attachment_start",
        requestId: "attachment-upload_attachment_start-1",
        upload_id: "upload-fixed",
        session_id: "session-a",
        filename: "photo.png",
        content_type: "image/png",
        expected_size: 10,
      },
      {
        type: "upload_attachment_chunk",
        requestId: "attachment-upload_attachment_chunk-2",
        upload_id: "upload-fixed",
        chunk_index: 0,
        content_b64: Buffer.from("hello").toString("base64"),
      },
      {
        type: "upload_attachment_chunk",
        requestId: "attachment-upload_attachment_chunk-3",
        upload_id: "upload-fixed",
        chunk_index: 1,
        content_b64: Buffer.from("world").toString("base64"),
      },
      {
        type: "upload_attachment_finish",
        requestId: "attachment-upload_attachment_finish-4",
        upload_id: "upload-fixed",
      },
    ]);
  });

  it("sends legacy upload, delete, and download through the same WS command boundary", async () => {
    const fixture = createWireFixture();
    const node = await fixture.providers.provider.getNode(nodeId);
    expect(node).not.toBeNull();

    await expect(
      fixture.providers.transport.legacyUploadAttachment(node!, {
        sessionId: "session-a",
        filename: "legacy.txt",
        contentType: "text/plain",
        contentBase64: Buffer.from("legacy").toString("base64"),
      }),
    ).resolves.toMatchObject({ filename: "legacy.txt", size: 6 });
    await expect(
      fixture.providers.transport.deleteSessionAttachments(node!, "session-a"),
    ).resolves.toEqual(expect.objectContaining({ cleaned: true, files_removed: 2 }));
    await expect(
      fixture.providers.transport.downloadAttachment(
        node!,
        "/incoming/session-a/photo.png",
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        filename: "photo.png",
        content_b64: Buffer.from("image").toString("base64"),
      }),
    );

    expect(fixture.sent.map((message) => message.type)).toEqual([
      "upload_attachment",
      "delete_session_attachments",
      "download_attachment",
    ]);
    expect(fixture.sent[0]).toMatchObject({
      session_id: "session-a",
      filename: "legacy.txt",
      content_type: "text/plain",
      content_b64: Buffer.from("legacy").toString("base64"),
    });
    expect(fixture.sent[1]).toMatchObject({ session_id: "session-a" });
    expect(fixture.sent[2]).toMatchObject({
      path: "/incoming/session-a/photo.png",
    });
  });

  it("best-effort aborts after an intermediate chunk failure and preserves the node error", async () => {
    const fixture = createBridgeFixture(async (routed) => {
      const message = routed.command.message;
      fixture.sent.push(message);
      if (message.type === "upload_attachment_start") {
        return ack(routed, {
          type: "upload_attachment_start_ack",
          upload_id: "upload-fixed",
          next_chunk_index: 0,
        });
      }
      if (message.type === "upload_attachment_chunk") {
        throw new PendingNodeCommandRejectedError({
          commandType: message.type,
          requestId: routed.command.requestId,
          message: "INVALID_REQUEST: chunk rejected",
        });
      }
      return ack(routed, {
        type: "upload_attachment_abort_ack",
        upload_id: "upload-fixed",
        aborted: true,
      });
    });
    const node = await fixture.providers.provider.getNode(nodeId);

    await expect(
      fixture.providers.transport.uploadAttachment(
        node!,
        uploadInput([Buffer.from("chunk")], 5),
      ),
    ).rejects.toThrow("INVALID_REQUEST: chunk rejected");
    expect(fixture.sent.map((message) => message.type)).toEqual([
      "upload_attachment_start",
      "upload_attachment_chunk",
      "upload_attachment_abort",
    ]);
    expect(fixture.createCommand).toHaveBeenLastCalledWith(
      nodeId,
      { type: "upload_attachment_abort", upload_id: "upload-fixed" },
      { timeoutMs: 5_000 },
    );
  });

  it("does not let abort failure replace the original mid-stream failure", async () => {
    const fixture = createBridgeFixture(async (routed) => {
      const message = routed.command.message;
      fixture.sent.push(message);
      if (message.type === "upload_attachment_start") {
        return ack(routed, {
          type: "upload_attachment_start_ack",
          upload_id: "upload-fixed",
          next_chunk_index: 0,
        });
      }
      if (message.type === "upload_attachment_chunk") {
        throw new Error("original chunk failure");
      }
      throw new Error("abort failure");
    });
    const node = await fixture.providers.provider.getNode(nodeId);

    await expect(
      fixture.providers.transport.uploadAttachment(
        node!,
        uploadInput([Buffer.from("chunk")], 5),
      ),
    ).rejects.toThrow("original chunk failure");
  });

  it("preserves unsupported start errors for the route's 8MB legacy fallback gate", async () => {
    const fixture = createBridgeFixture(async (routed) => {
      fixture.sent.push(routed.command.message);
      throw new PendingNodeCommandRejectedError({
        commandType: routed.command.commandType,
        requestId: routed.command.requestId,
        message: "Unknown command: upload_attachment_start",
      });
    });
    const node = await fixture.providers.provider.getNode(nodeId);

    await expect(
      fixture.providers.transport.uploadAttachment(
        node!,
        uploadInput([Buffer.from("legacy")], 6),
      ),
    ).rejects.toThrow("Unknown command: upload_attachment_start");
    expect(fixture.sent.map((message) => message.type)).toEqual([
      "upload_attachment_start",
    ]);
  });

  it("rejects declared payloads above 100MB before creating a command", async () => {
    const fixture = createBridgeFixture(async () => {
      throw new Error("must not send");
    });
    const node = await fixture.providers.provider.getNode(nodeId);

    await expect(
      fixture.providers.transport.uploadAttachment(
        node!,
        uploadInput([], MAX_ATTACHMENT_SIZE_BYTES + 1),
      ),
    ).rejects.toThrow("INVALID_REQUEST: 파일이 너무 큽니다");
    expect(fixture.createCommand).not.toHaveBeenCalled();
  });

  it("maps command timeout to the route transport timeout error", async () => {
    const fixture = createBridgeFixture(async (routed) => {
      throw new PendingNodeCommandTimeoutError({
        commandType: routed.command.commandType,
        requestId: routed.command.requestId,
        timeoutMs: routed.command.timeoutMs,
      });
    });
    const node = await fixture.providers.provider.getNode(nodeId);

    await expect(
      fixture.providers.transport.downloadAttachment(node!, "/incoming/a.png"),
    ).rejects.toBeInstanceOf(AttachmentTransportTimeoutError);
  });

  it.each([
    new NodeCommandTransportError({
      code: "TRANSPORT_STALE",
      nodeId,
      connectionId: "stale-connection",
      message: "Node transport is stale",
    }),
    new PendingNodeCommandRejectedError({
      commandType: "download_attachment",
      requestId: "attachment-download_attachment-1",
      message: "Node disconnected: heartbeat_timeout",
    }),
  ])("maps disconnected and stale failures to retryable connection errors", async (error) => {
    const fixture = createBridgeFixture(async () => {
      throw error;
    });
    const node = await fixture.providers.provider.getNode(nodeId);

    await expect(
      fixture.providers.transport.downloadAttachment(node!, "/incoming/a.png"),
    ).rejects.toBeInstanceOf(AttachmentTransportConnectionError);
  });
});

function createWireFixture() {
  const registry = createRegistry();
  const connectionId = registerNode(registry);
  const sent: Record<string, unknown>[] = [];
  const transports = new NodeCommandTransportHub();
  transports.attach({
    nodeId,
    connectionId,
    transport: {
      send(data) {
        const message = JSON.parse(data) as Record<string, unknown>;
        sent.push(message);
        registry.receiveNodeMessage(
          { nodeId, connectionId },
          responseFor(message),
        );
      },
    },
  });
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  return {
    registry,
    sent,
    providers: createProviders(registry, bridge),
  };
}

function createBridgeFixture(
  sendPendingCommand: (
    routed: AnyRoutedPendingCommand,
  ) => Promise<NodeCommandResponse>,
) {
  const registry = createRegistry();
  registerNode(registry);
  const createCommand = vi.spyOn(registry, "createCommand");
  const sent: Record<string, unknown>[] = [];
  const bridge: LiveAttachmentCommandBridge = {
    async sendPendingCommand<
      TPayload extends RequestResponseNodeCommandPayload,
      TResponse extends NodeCommandResponse,
    >(
      routed: RoutedPendingSessionCommand<TPayload, TResponse>,
    ): Promise<TResponse> {
      return await sendPendingCommand(
        routed as unknown as AnyRoutedPendingCommand,
      ) as TResponse;
    },
  };
  const fixture = {
    registry,
    sent,
    createCommand,
    providers: createProviders(registry, bridge),
  };
  return fixture;
}

function createProviders(
  registry: InMemoryNodeRegistry,
  bridge: LiveAttachmentCommandBridge,
) {
  return createLiveAttachmentRouteProviders({
    registry,
    bridge,
    uploadIdGenerator: () => "upload-fixed",
    dashboardAccessProvider: {
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }),
    },
    sessionResourceAccessProvider: {
      requireSessionAccess: async () => undefined,
    },
  });
}

function createRegistry(): InMemoryNodeRegistry {
  return new InMemoryNodeRegistry({
    nowMs: () => 1_700_000_000_000,
    requestIdGenerator: ({ sequence, commandType }) =>
      `attachment-${commandType}-${sequence}`,
  });
}

function registerNode(registry: InMemoryNodeRegistry): string {
  return registry.registerNode({
    type: "node_register",
    node_id: nodeId,
    host: "127.0.0.1",
    port: 4105,
    capabilities: {},
  }).node.connectionId;
}

function uploadInput(
  values: Buffer[],
  expectedSize = values.reduce((total, value) => total + value.length, 0),
): AttachmentUploadInput {
  return {
    sessionId: "session-a",
    filename: "photo.png",
    contentType: "image/png",
    expectedSize,
    chunks: chunks(values),
  };
}

async function* chunks(values: Buffer[]): AsyncIterable<Buffer> {
  for (const value of values) yield value;
}

function ack(
  routed: AnyRoutedPendingCommand,
  response: NodeCommandResponse,
): NodeCommandResponse {
  return { ...response, requestId: routed.command.requestId };
}

function responseFor(message: Record<string, unknown>): NodeCommandResponse {
  const requestId = String(message.requestId);
  switch (message.type) {
    case "upload_attachment_start":
      return {
        type: "upload_attachment_start_ack",
        requestId,
        upload_id: "upload-fixed",
        next_chunk_index: 0,
      };
    case "upload_attachment_chunk":
      return {
        type: "upload_attachment_chunk_ack",
        requestId,
        upload_id: "upload-fixed",
        chunk_index: message.chunk_index,
        next_chunk_index: Number(message.chunk_index) + 1,
        size: 5,
      };
    case "upload_attachment_finish":
      return {
        type: "upload_attachment_result",
        requestId,
        path: "/incoming/session-a/photo.png",
        filename: "photo.png",
        size: 10,
        content_type: "image/png",
      };
    case "upload_attachment":
      return {
        type: "upload_attachment_result",
        requestId,
        path: "/incoming/session-a/legacy.txt",
        filename: "legacy.txt",
        size: 6,
        content_type: "text/plain",
      };
    case "delete_session_attachments":
      return {
        type: "delete_session_attachments_result",
        requestId,
        cleaned: true,
        files_removed: 2,
      };
    case "download_attachment":
      return {
        type: "download_attachment_result",
        requestId,
        content_b64: Buffer.from("image").toString("base64"),
        content_type: "image/png",
        filename: "photo.png",
        size: 5,
      };
    default:
      throw new Error(`unexpected command: ${String(message.type)}`);
  }
}
