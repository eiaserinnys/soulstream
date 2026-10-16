import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttachmentReadError } from "../src/attachments/attachment_read_service.js";
import type { WorkerAttachmentReadInput } from "../src/attachments/worker_attachment_access.js";
import { createWorkerAttachmentRead } from "../src/attachments/worker_attachment_read.js";
import {
  registerWorkerAttachmentRoutes,
  workerAttachmentRouteAuthRequirements,
} from "../src/attachments/worker_attachment_routes.js";

const SERVICE_TOKEN = "service-token";
const NODE_ID = "node-a";
const METADATA_PATH = "/api/attachments/worker/attachment-a/metadata";
const CONTENT_PATH = "/api/attachments/worker/attachment-a/content";
const descriptor = {
  attachment_id: "attachment-a",
  name: "report.csv",
  mime_type: "text/csv",
  byte_size: 2,
  checksum_sha256: "c".repeat(64),
  width: null,
  height: null,
  preview_kind: "text",
  preview_mime_type: "text/csv",
};

type HarnessOptions = {
  readonly token?: string;
  readonly metadataError?: unknown;
  readonly contentError?: unknown;
};

function query(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({ session_id: "session-a", mode: "input", ...overrides });
  return `?${params.toString()}`;
}

function headers(overrides: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${SERVICE_TOKEN}`,
    "x-soulstream-node-id": NODE_ID,
    ...overrides,
  };
}

function harness(options: HarnessOptions = {}) {
  const contentSignals: Array<AbortSignal | undefined> = [];
  const metadata = vi.fn(async (input: WorkerAttachmentReadInput) => {
    if (options.metadataError !== undefined) throw options.metadataError;
    if (input.nodeId !== NODE_ID) {
      throw new AttachmentReadError("ATTACHMENT_NODE_MISMATCH", "Attachment access denied", 403);
    }
    return { descriptor, upload_status: "committed" as const };
  });
  const content = vi.fn(async (_input: WorkerAttachmentReadInput, signal?: AbortSignal) => {
    contentSignals.push(signal);
    if (options.contentError !== undefined) throw options.contentError;
    return new Response(new Uint8Array([65, 66]), {
      status: 200,
      headers: { "content-type": "text/csv", "content-length": "2" },
    });
  });
  const service = { metadata, content } as ReturnType<typeof createWorkerAttachmentRead>;
  const app = Fastify({ logger: false });
  registerWorkerAttachmentRoutes(app, {
    authBearerToken: options.token ?? SERVICE_TOKEN,
    environment: "production",
    service,
  });
  return { app, contentSignals, metadata, content };
}

const apps: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function build(options: HarnessOptions = {}) {
  const instance = harness(options);
  apps.push(instance.app);
  return instance;
}

describe("worker attachment read routes", () => {
  it("serves metadata through a service bearer without a user cookie", async () => {
    const { app, metadata } = build();
    const response = await app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query()}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ descriptor, upload_status: "committed" });
    expect(metadata).toHaveBeenCalledWith({
      sessionId: "session-a",
      nodeId: NODE_ID,
      attachmentId: "attachment-a",
      mode: "input",
    });
  });

  it("rejects cookie and dashboard JWT authentication without the service bearer", async () => {
    const { app, metadata } = build();
    const cookieOnly = await app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query()}`,
      headers: { cookie: "soulstream_session=dashboard.jwt.value", "x-soulstream-node-id": NODE_ID },
    });
    const dashboardJwt = await app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query()}`,
      headers: headers({ authorization: "Bearer dashboard.jwt.value" }),
    });

    expect(cookieOnly.statusCode).toBe(401);
    expect(dashboardJwt.statusCode).toBe(401);
    expect(metadata).not.toHaveBeenCalled();
  });

  it("preserves unavailable service-bearer configuration status", async () => {
    const { app, metadata } = build({ token: "" });
    const response = await app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query()}`,
      headers: { "x-soulstream-node-id": NODE_ID },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "ATTACHMENT_AUTH_UNAVAILABLE" });
    expect(metadata).not.toHaveBeenCalled();
  });

  it("rejects malformed context and unapproved query fields before service access", async () => {
    const { app, metadata } = build();
    const badMode = await app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query({ mode: "preview" })}`,
      headers: headers(),
    });
    const injectedIdentity = await app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query({ ownerEmail: "owner@example.test" })}`,
      headers: headers(),
    });

    expect(badMode.statusCode).toBe(422);
    expect(badMode.json()).toMatchObject({ code: "ATTACHMENT_INVALID_CONTEXT" });
    expect(injectedIdentity.statusCode).toBe(422);
    expect(injectedIdentity.json()).toMatchObject({ code: "ATTACHMENT_INVALID_CONTEXT" });
    expect(metadata).not.toHaveBeenCalled();
  });

  it("uses the node header and preserves a service node-mismatch response", async () => {
    const { app, metadata } = build();
    const response = await app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query()}`,
      headers: headers({ "x-soulstream-node-id": "node-b" }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ATTACHMENT_NODE_MISMATCH" });
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-b" }));
  });

  it("preserves domain error code and status, and maps unknown failures to 500", async () => {
    const pending = build({
      metadataError: new AttachmentReadError("ATTACHMENT_NOT_COMMITTED", "Attachment is pending", 409),
    });
    const pendingResponse = await pending.app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query()}`,
      headers: headers(),
    });
    const unknown = build({ metadataError: new Error("internal detail") });
    const unknownResponse = await unknown.app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query()}`,
      headers: headers(),
    });

    expect(pendingResponse.statusCode).toBe(409);
    expect(pendingResponse.json()).toMatchObject({ code: "ATTACHMENT_NOT_COMMITTED" });
    expect(unknownResponse.statusCode).toBe(500);
    expect(unknownResponse.json()).toMatchObject({ code: "ATTACHMENT_READ_FAILED" });
    expect(unknownResponse.body).not.toContain("internal detail");
  });

  it("streams the original content and passes a request-close abort signal", async () => {
    const { app, content, contentSignals } = build();
    const response = await app.inject({
      method: "GET",
      url: `${CONTENT_PATH}${query({ delivery_id: "delivery-a" })}`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(Array.from(response.rawPayload)).toEqual([65, 66]);
    expect(response.headers["content-type"]).toBe("text/csv");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(content).toHaveBeenCalledWith({
      sessionId: "session-a",
      nodeId: NODE_ID,
      attachmentId: "attachment-a",
      mode: "input",
      deliveryId: "delivery-a",
    }, expect.any(AbortSignal));
    expect(contentSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it("routes metadata and content to their independent service reads", async () => {
    const { app, metadata, content } = build();
    const metadataResponse = await app.inject({
      method: "GET",
      url: `${METADATA_PATH}${query({ mode: "resolve" })}`,
      headers: headers(),
    });
    const contentResponse = await app.inject({
      method: "GET",
      url: `${CONTENT_PATH}${query({ mode: "resolve" })}`,
      headers: headers(),
    });

    expect(metadataResponse.statusCode).toBe(200);
    expect(contentResponse.statusCode).toBe(200);
    expect(metadata).toHaveBeenCalledOnce();
    expect(content).toHaveBeenCalledOnce();
  });

  it("declares both routes as service-bearer protected", () => {
    expect(workerAttachmentRouteAuthRequirements).toEqual({
      "GET /api/attachments/worker/:attachment_id/metadata": true,
      "GET /api/attachments/worker/:attachment_id/content": true,
    });
  });
});
