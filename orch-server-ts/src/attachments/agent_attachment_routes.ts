import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { verifyServiceBearerAuthorization } from "../auth/service_bearer.js";
import type {
  AgentAttachmentRegistration,
  AgentAttachmentRegistrationInput,
} from "./agent_attachment_registration.js";
import { bindAttachmentReadAbortSignal } from "./attachment_read_routes.js";
import type { TrustedAttachmentProducer } from "../cards/card_attachment_policy.js";

export type SessionOutputAttachmentValidation = (input: {
  readonly producer: TrustedAttachmentProducer;
  readonly attachmentIds: readonly string[];
}) => Promise<{ readonly attachment_ids: string[] }>;

export type AgentAttachmentRouteOptions = {
  readonly authBearerToken: string;
  readonly environment: string;
  readonly register: AgentAttachmentRegistration;
  readonly validateSessionOutput?: SessionOutputAttachmentValidation;
};

export const agentAttachmentRouteAuthRequirements = {
  "POST /api/attachments/agent-register": true,
  "POST /api/attachments/agent-output/validate": true,
} as const;

const REGISTER_PATH = "/api/attachments/agent-register";
const VALIDATE_OUTPUT_PATH = "/api/attachments/agent-output/validate";
const MAX_ATTACHMENT_BYTES = 104857600;
const SESSION_HEADER = "x-soulstream-agent-session-id";
const NODE_HEADER = "x-soulstream-node-id";
const COMMAND_HEADER = "x-soulstream-output-command-id";
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/i;

class AgentAttachmentRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.name = "AgentAttachmentRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function registerAgentAttachmentRoutes(
  app: FastifyInstance,
  options: AgentAttachmentRouteOptions,
): void {
  void app.register(async (instance) => {
    instance.addContentTypeParser(
      "application/octet-stream",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    instance.addHook("onRequest", async (request, reply) => {
      const authorization = verifyServiceBearerAuthorization(
        request.headers.authorization,
        options.authBearerToken,
        options.environment,
      );
      if (!authorization.ok) {
        return reply.code(authorization.statusCode).send({
          code: authorization.statusCode === 503 ? "ATTACHMENT_AUTH_UNAVAILABLE" : "ATTACHMENT_UNAUTHORIZED",
          detail: "첨부 등록에는 서비스 인증이 필요합니다.",
        });
      }
    });

    instance.post(
      REGISTER_PATH,
      { bodyLimit: MAX_ATTACHMENT_BYTES },
      async (request, reply) => {
        let parsed: RegistrationRequest;
        try {
          parsed = parseRegistrationRequest(request);
        } catch (error) {
          return fail(reply, error);
        }

        const controller = bindAttachmentReadAbortSignal(request, reply);
        try {
          const body = readBody(request);
          if (body.byteLength > MAX_ATTACHMENT_BYTES) {
            throw new AgentAttachmentRequestError("ATTACHMENT_TOO_LARGE", 413, "첨부 파일이 너무 큽니다.");
          }
          if (body.byteLength !== parsed.byteSize) {
            throw new AgentAttachmentRequestError(
              "ATTACHMENT_SIZE_MISMATCH",
              422,
              "요청 본문 크기가 byte_size와 다릅니다.",
            );
          }

          const input: AgentAttachmentRegistrationInput = {
            producer: parsed.producer,
            targetScope: parsed.targetScope,
            name: parsed.name,
            mimeType: parsed.mimeType,
            byteSize: parsed.byteSize,
            checksumSha256: parsed.checksumSha256,
            body,
            signal: controller.abort.signal,
          };
          const result = await options.register(input);
          return reply.code(200).send(result);
        } catch (error) {
          return fail(reply, error);
        } finally {
          controller.cleanup();
        }
      },
    );

    instance.post(VALIDATE_OUTPUT_PATH, async (request, reply) => {
      if (options.validateSessionOutput === undefined) {
        return reply.code(503).send({
          code: "ATTACHMENT_VALIDATION_UNAVAILABLE",
          detail: "세션 출력 첨부 검증을 사용할 수 없습니다.",
        });
      }

      let parsed: OutputValidationRequest;
      try {
        parsed = parseOutputValidationRequest(request);
      } catch (error) {
        return fail(reply, error);
      }

      try {
        const result = await options.validateSessionOutput({
          producer: parsed.producer,
          attachmentIds: parsed.attachmentIds,
        });
        return reply.code(200).send({ attachment_ids: result.attachment_ids });
      } catch (error) {
        return fail(reply, error);
      }
    });
  });
}

type OutputValidationRequest = {
  readonly producer: TrustedAttachmentProducer;
  readonly attachmentIds: readonly string[];
};

function parseOutputValidationRequest(request: FastifyRequest): OutputValidationRequest {
  const producer = {
    sessionId: requiredOutputHeader(request.headers[SESSION_HEADER]),
    nodeId: requiredOutputHeader(request.headers[NODE_HEADER]),
    outputCommandId: requiredOutputHeader(request.headers[COMMAND_HEADER]),
  };
  const body = request.body;
  if (
    typeof body !== "object"
    || body === null
    || Array.isArray(body)
    || Object.keys(body).length !== 1
    || !Object.hasOwn(body, "attachment_ids")
  ) {
    throw invalidOutput("본문은 attachment_ids만 포함해야 합니다.");
  }

  const attachmentIds = (body as { attachment_ids?: unknown }).attachment_ids;
  if (
    !Array.isArray(attachmentIds)
    || attachmentIds.length === 0
    || attachmentIds.some((attachmentId) => typeof attachmentId !== "string" || attachmentId.length === 0)
  ) {
    throw invalidOutput("비어 있지 않은 attachment_ids가 필요합니다.");
  }

  return { producer, attachmentIds };
}

function requiredOutputHeader(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string" || header.trim().length === 0) {
    throw invalidOutput("세션 출력 생산 헤더가 필요합니다.");
  }
  return header.trim();
}

function invalidOutput(message: string): AgentAttachmentRequestError {
  return new AgentAttachmentRequestError("ATTACHMENT_INVALID_OUTPUT", 422, message);
}

type RegistrationRequest = {
  readonly producer: {
    readonly sessionId: string;
    readonly nodeId: string;
    readonly outputCommandId: string;
  };
  readonly targetScope: { readonly type: "card"; readonly id: string } | null;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly checksumSha256: string;
};

function parseRegistrationRequest(request: FastifyRequest): RegistrationRequest {
  const headers = request.headers;
  const sessionId = requiredHeader(headers[SESSION_HEADER]);
  const nodeId = requiredHeader(headers[NODE_HEADER]);
  const outputCommandId = requiredHeader(headers[COMMAND_HEADER]);

  const params = new URLSearchParams(new URL(request.url, "http://internal").search);
  const name = requiredText(params.get("name"));
  const mimeType = requiredText(params.get("mime_type"));
  const byteSize = parseByteSize(params.get("byte_size"));
  const checksumSha256 = parseChecksum(params.get("checksum_sha256"));
  const cardId = params.get("card_id");
  if (cardId !== null && cardId.length === 0) {
    throw invalidRegistration("card_id가 비어 있습니다.");
  }

  return {
    producer: { sessionId, nodeId, outputCommandId },
    targetScope: cardId === null ? null : { type: "card", id: cardId },
    name,
    mimeType,
    byteSize,
    checksumSha256,
  };
}

function readBody(request: FastifyRequest): Buffer {
  const body = request.body;
  if (!Buffer.isBuffer(body)) {
    throw invalidRegistration("본문은 application/octet-stream 바이트여야 합니다.");
  }
  return body;
}

function requiredHeader(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string" || header.trim().length === 0) {
    throw invalidRegistration("필수 헤더가 없습니다.");
  }
  return header.trim();
}

function requiredText(value: string | null): string {
  if (value === null || value.length === 0) {
    throw invalidRegistration("필수 쿼리 값이 없습니다.");
  }
  return value;
}

function parseByteSize(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) {
    throw invalidRegistration("byte_size가 올바르지 않습니다.");
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > MAX_ATTACHMENT_BYTES) {
    throw new AgentAttachmentRequestError("ATTACHMENT_TOO_LARGE", 413, "첨부 파일이 너무 큽니다.");
  }
  return size;
}

function parseChecksum(value: string | null): string {
  if (value === null || !CHECKSUM_PATTERN.test(value)) {
    throw invalidRegistration("checksum_sha256이 올바르지 않습니다.");
  }
  return value.toLowerCase();
}

function invalidRegistration(message: string): AgentAttachmentRequestError {
  return new AgentAttachmentRequestError("ATTACHMENT_INVALID_REGISTRATION", 422, message);
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AgentAttachmentRequestError) {
    return reply.code(error.statusCode).send({ code: error.code, detail: error.message });
  }
  const statusCode = statusFromError(error);
  const code = codeFromError(error);
  if (statusCode !== undefined && code !== undefined) {
    return reply.code(statusCode).send({ code, detail: errorMessage(error) });
  }
  return reply.code(500).send({ code: "ATTACHMENT_REGISTRATION_FAILED", detail: "첨부 등록에 실패했습니다." });
}

function statusFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && value >= 400 && value <= 599 ? value : undefined;
}

function codeFromError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "첨부 등록에 실패했습니다.";
}
