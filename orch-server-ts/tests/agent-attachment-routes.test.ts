import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentAttachmentRegistrationInput } from "../src/attachments/agent_attachment_registration.js";
import {
  agentAttachmentRouteAuthRequirements,
  registerAgentAttachmentRoutes,
} from "../src/attachments/agent_attachment_routes.js";
import { AttachmentCommitError } from "../src/attachments/attachment_commit_service.js";

const CHECKSUM = "c".repeat(64);
const SERVICE_TOKEN = "service-token";
const PATH = "/api/attachments/agent-register";
const VALIDATE_OUTPUT_PATH = "/api/attachments/agent-output/validate";

const descriptor = {
  attachment_id: "asset-1",
  name: "report.csv",
  mime_type: "text/csv",
  byte_size: 4,
  checksum_sha256: CHECKSUM,
  width: null,
  height: null,
  preview_kind: "text",
  preview_mime_type: "text/csv",
};

function url(options: {
  name?: string;
  mimeType?: string;
  byteSize?: number;
  checksum?: string;
  cardId?: string | null;
} = {}) {
  const params = new URLSearchParams();
  params.set("name", options.name ?? "report.csv");
  params.set("mime_type", options.mimeType ?? "text/csv");
  params.set("byte_size", String(options.byteSize ?? 4));
  params.set("checksum_sha256", options.checksum ?? CHECKSUM);
  const cardId = options.cardId === undefined ? "card-1" : options.cardId;
  if (cardId !== null) params.set("card_id", cardId);
  return `${PATH}?${params.toString()}`;
}

function producerHeaders(overrides: Record<string, string> = {}) {
  return {
    "x-soulstream-agent-session-id": "session-1",
    "x-soulstream-node-id": "node-1",
    "x-soulstream-output-command-id": "exec-1",
    ...overrides,
  };
}

function harness(options: {
  token?: string;
  environment?: string;
  register?: ReturnType<typeof vi.fn>;
  result?: unknown;
  validateSessionOutput?: ReturnType<typeof vi.fn>;
} = {}) {
  const register = options.register ?? vi.fn(async () => options.result ?? { attachment_id: "asset-1", descriptor });
  const app = Fastify();
  registerAgentAttachmentRoutes(app, {
    authBearerToken: options.token ?? SERVICE_TOKEN,
    environment: options.environment ?? "production",
    register: register as never,
    ...(options.validateSessionOutput === undefined ? {} : { validateSessionOutput: options.validateSessionOutput }),
  } as never);
  const apps = [app];
  return { app, register, validateSessionOutput: options.validateSessionOutput, apps };
}

const created: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((app) => app.close()));
});

function build(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  created.push(h.app);
  return h;
}

describe("agent attachment registration route", () => {
  it("accepts a valid service bearer without any user cookie", async () => {
    const { app, register } = build();
    const response = await app.inject({
      method: "POST",
      url: url(),
      headers: {
        ...producerHeaders(),
        authorization: `Bearer ${SERVICE_TOKEN}`,
        cookie: "soulstream_session=not-a-service-token",
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ attachment_id: "asset-1", descriptor });
    expect(register).toHaveBeenCalledOnce();
    const input = register.mock.calls[0]![0] as AgentAttachmentRegistrationInput;
    expect(input.producer).toEqual({ sessionId: "session-1", nodeId: "node-1", outputCommandId: "exec-1" });
    expect(input.targetScope).toEqual({ type: "card", id: "card-1" });
    expect(input.name).toBe("report.csv");
    expect(input.mimeType).toBe("text/csv");
    expect(input.byteSize).toBe(4);
    expect(input.checksumSha256).toBe(CHECKSUM);
    expect(Array.from(input.body)).toEqual([1, 2, 3, 4]);
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it("decodes a UTF-8 attachment name", async () => {
    const { app, register } = build();
    const response = await app.inject({
      method: "POST",
      url: url({ name: "보고서.csv" }),
      headers: { ...producerHeaders(), authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/octet-stream" },
      payload: Buffer.from("csv!"),
    });

    expect(response.statusCode).toBe(200);
    expect((register.mock.calls[0]![0] as AgentAttachmentRegistrationInput).name).toBe("보고서.csv");
  });

  it("registers without a card scope when card_id is omitted", async () => {
    const { app, register } = build();
    const response = await app.inject({
      method: "POST",
      url: url({ cardId: null }),
      headers: { ...producerHeaders(), authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(response.statusCode).toBe(200);
    expect((register.mock.calls[0]![0] as AgentAttachmentRegistrationInput).targetScope).toBeNull();
  });

  it("accepts a zero-byte attachment", async () => {
    const { app, register } = build({
      result: { attachment_id: "asset-0", descriptor: { ...descriptor, byte_size: 0 } },
    });
    const response = await app.inject({
      method: "POST",
      url: url({ byteSize: 0, name: "empty.txt", mimeType: "text/plain" }),
      headers: { ...producerHeaders(), authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(0),
    });

    expect(response.statusCode).toBe(200);
    expect((register.mock.calls[0]![0] as AgentAttachmentRegistrationInput).body.byteLength).toBe(0);
  });

  it("rejects a cookie or dashboard JWT without the service bearer", async () => {
    const { app, register } = build();
    const cookieOnly = await app.inject({
      method: "POST",
      url: url(),
      headers: { ...producerHeaders(), cookie: "soulstream_session=dashboard.jwt.value", "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });
    const jwtBearer = await app.inject({
      method: "POST",
      url: url(),
      headers: { ...producerHeaders(), authorization: "Bearer dashboard.jwt.value", "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(cookieOnly.statusCode).toBe(401);
    expect(jwtBearer.statusCode).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects a wrong service bearer", async () => {
    const { app, register } = build();
    const response = await app.inject({
      method: "POST",
      url: url(),
      headers: { ...producerHeaders(), authorization: "Bearer other-token", "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(response.statusCode).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("reports an unavailable authentication configuration in production", async () => {
    const { app, register } = build({ token: "" });
    const response = await app.inject({
      method: "POST",
      url: url(),
      headers: { ...producerHeaders(), "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(response.statusCode).toBe(503);
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects an invalid registration request before calling the service", async () => {
    const { app, register } = build();
    const missingProducer = await app.inject({
      method: "POST",
      url: url(),
      headers: {
        "x-soulstream-node-id": "node-1",
        "x-soulstream-output-command-id": "exec-1",
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from([1, 2, 3, 4]),
    });
    const badChecksum = await app.inject({
      method: "POST",
      url: url({ checksum: "zz" }),
      headers: { ...producerHeaders(), authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(missingProducer.statusCode).toBe(422);
    expect(missingProducer.json()).toMatchObject({ code: "ATTACHMENT_INVALID_REGISTRATION" });
    expect(badChecksum.statusCode).toBe(422);
    expect(badChecksum.json()).toMatchObject({ code: "ATTACHMENT_INVALID_REGISTRATION" });
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared attachment without buffering the payload", async () => {
    const { app, register } = build();
    const response = await app.inject({
      method: "POST",
      url: url({ byteSize: 104857600 + 1 }),
      headers: { ...producerHeaders(), authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/octet-stream" },
      payload: Buffer.from([1]),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    expect(register).not.toHaveBeenCalled();
  });

  it("rejects a body whose length differs from the declared byte_size", async () => {
    const { app, register } = build();
    const response = await app.inject({
      method: "POST",
      url: url({ byteSize: 8 }),
      headers: { ...producerHeaders(), authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "ATTACHMENT_SIZE_MISMATCH" });
    expect(register).not.toHaveBeenCalled();
  });

  it("maps a commit failure to its own code and status", async () => {
    const failure = new AttachmentCommitError("storage_unavailable", 503, "storage down");
    const register = vi.fn(async () => {
      throw failure;
    });
    const { app } = build({ register });
    const response = await app.inject({
      method: "POST",
      url: url(),
      headers: { ...producerHeaders(), authorization: `Bearer ${SERVICE_TOKEN}`, "content-type": "application/octet-stream" },
      payload: Buffer.from([1, 2, 3, 4]),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "storage_unavailable" });
  });

  it("validates output attachment IDs using the trusted producer headers", async () => {
    const validateSessionOutput = vi.fn(async () => ({ attachment_ids: ["asset-1"] }));
    const { app } = build({ validateSessionOutput });
    const response = await app.inject({
      method: "POST",
      url: VALIDATE_OUTPUT_PATH,
      headers: {
        ...producerHeaders(),
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { attachment_ids: ["asset-1", "asset-1"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ attachment_ids: ["asset-1"] });
    expect(validateSessionOutput).toHaveBeenCalledOnce();
    expect(validateSessionOutput).toHaveBeenCalledWith({
      producer: { sessionId: "session-1", nodeId: "node-1", outputCommandId: "exec-1" },
      attachmentIds: ["asset-1", "asset-1"],
    });
  });

  it("rejects malformed or body-forged output validation requests", async () => {
    const validateSessionOutput = vi.fn(async () => ({ attachment_ids: ["asset-1"] }));
    const { app } = build({ validateSessionOutput });
    const request = (
      payload: { attachment_ids?: string[]; session_id?: string },
      headers: Record<string, string> = producerHeaders(),
    ) => app.inject({
      method: "POST",
      url: VALIDATE_OUTPUT_PATH,
      headers: {
        ...headers,
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      payload,
    });
    const [empty, emptyId, forgedProducer, missingProducerHeader] = await Promise.all([
      request({ attachment_ids: [] }),
      request({ attachment_ids: [""] }),
      request({ attachment_ids: ["asset-1"], session_id: "other-session" }),
      request({ attachment_ids: ["asset-1"] }, {
        "x-soulstream-agent-session-id": "session-1",
        "x-soulstream-node-id": "node-1",
      }),
    ]);

    for (const response of [empty, emptyId, forgedProducer, missingProducerHeader]) {
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: "ATTACHMENT_INVALID_OUTPUT" });
    }
    expect(validateSessionOutput).not.toHaveBeenCalled();
  });

  it("does not accept output attachments when validation is unconfigured", async () => {
    const { app } = build();
    const response = await app.inject({
      method: "POST",
      url: VALIDATE_OUTPUT_PATH,
      headers: {
        ...producerHeaders(),
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { attachment_ids: ["asset-1"] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "ATTACHMENT_VALIDATION_UNAVAILABLE" });
  });

  it("preserves validation policy status and error code", async () => {
    const validateSessionOutput = vi.fn(async () => {
      throw Object.assign(new Error("producer mismatch"), {
        statusCode: 403,
        code: "ATTACHMENT_PRODUCER_MISMATCH",
      });
    });
    const { app } = build({ validateSessionOutput });
    const response = await app.inject({
      method: "POST",
      url: VALIDATE_OUTPUT_PATH,
      headers: {
        ...producerHeaders(),
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      payload: { attachment_ids: ["asset-1"] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ATTACHMENT_PRODUCER_MISMATCH" });
  });

  it("declares its service-bearer auth requirement", () => {
    expect(agentAttachmentRouteAuthRequirements).toEqual({
      "POST /api/attachments/agent-register": true,
      "POST /api/attachments/agent-output/validate": true,
    });
  });
});
