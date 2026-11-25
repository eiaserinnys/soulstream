import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/** If-None-Match 목록(또는 `*`)에 이 ETag가 있는지. 약한 표시(W/)는 무시하고 견준다. */
export function ifNoneMatchHit(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (value === undefined) return false;
  return value.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || trimmed.replace(/^W\//, "") === etag;
  });
}

export function sha256Etag(body: string | Buffer): string {
  return `"${createHash("sha256").update(body).digest("hex")}"`;
}

/** ETag와 Cache-Control을 달고, If-None-Match가 맞으면 본문 없이 304를 보낸다. */
export function sendWithEtag(
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    readonly etag: string;
    readonly cacheControl: string;
    readonly contentType: string;
    readonly body: string | Buffer;
  },
): FastifyReply {
  reply.header("ETag", input.etag).header("Cache-Control", input.cacheControl);
  if (ifNoneMatchHit(request.headers["if-none-match"], input.etag)) {
    return reply.code(304).send();
  }
  return reply.type(input.contentType).send(input.body);
}

export const IMMUTABLE_CACHE_CONTROL = "private, max-age=31536000, immutable";
export const PRIVATE_NO_CACHE = "private, no-cache";
