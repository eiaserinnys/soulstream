import type { FastifyReply, FastifyRequest } from "fastify";

import {
  PortableConfigDisabledError,
  PortableConfigUnavailableError,
} from "./portable_config_service.js";
import { PortableConfigTransformError } from "./portable_config_transform.js";

export function sendPortableConfigError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof PortableConfigDisabledError) {
    return reply.code(503).send({ code: error.code });
  }
  if (error instanceof PortableConfigUnavailableError) {
    request.log.warn(
      { path: error.sourcePath, cause: error.reason },
      "portable config source unavailable",
    );
    return reply.code(503).send({ code: error.code });
  }
  if (error instanceof PortableConfigTransformError) {
    return reply.code(409).send({ code: error.code });
  }
  throw error;
}
