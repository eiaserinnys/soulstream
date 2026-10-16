import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  AttachmentUploadHttpError, readUploadChecksum, readUploadId, readUploadMode, sendUploadFailure,
} from "../src/attachments/attachment_upload_http.js";
import { parseMultipartForm, registerMultipartFormParser } from "../src/http/multipart_form.js";

const MASKED = "첨부 저장에 실패했습니다";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function request(headers: Record<string, string | string[]>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}
function expectHttpError(run: () => unknown, statusCode: number, code: string): void {
  try {
    run();
    throw new Error("expected AttachmentUploadHttpError");
  } catch (error) {
    expect(error).toBeInstanceOf(AttachmentUploadHttpError);
    expect((error as AttachmentUploadHttpError).statusCode).toBe(statusCode);
    expect((error as AttachmentUploadHttpError).code).toBe(code);
  }
}

describe("attachment upload contract negotiation", () => {
  it("defaults to legacy when no header and no ticket contract", () => {
    expect(readUploadMode(request({}))).toBe("legacy");
    expect(readUploadMode(request({}), "legacy")).toBe("legacy");
  });
  it("uses the ticket contract when the header is absent", () => {
    expect(readUploadMode(request({}), "id-v1")).toBe("id-v1");
  });
  it("honours the id-v1 header", () => {
    expect(readUploadMode(request({ "x-soulstream-attachment-contract": "id-v1" }))).toBe("id-v1");
    expect(readUploadMode(request({ "x-soulstream-attachment-contract": "id-v1" }), "id-v1")).toBe("id-v1");
  });
  it("rejects an unknown or duplicated contract header", () => {
    for (const value of ["legacy", "v2", "id-v1,id-v1", ["id-v1", "id-v1"]]) {
      expectHttpError(() => readUploadMode(request({ "x-soulstream-attachment-contract": value })), 400, "invalid_upload_contract");
    }
  });
  it("conflicts when the header contradicts a legacy ticket", () => {
    expectHttpError(() => readUploadMode(request({ "x-soulstream-attachment-contract": "id-v1" }), "legacy"), 409, "upload_contract_conflict");
  });
});

describe("attachment upload input readers", () => {
  it("mints an id when absent and keeps a valid one", () => {
    expect(readUploadId(undefined)).toMatch(UUID);
    expect(readUploadId("5f8d2c1a-3b4e-4c5d-8e9f-0a1b2c3d4e5f")).toBe("5f8d2c1a-3b4e-4c5d-8e9f-0a1b2c3d4e5f");
  });
  it("rejects a malformed upload id", () => {
    for (const value of ["not-a-uuid", 42, "", null]) {
      expectHttpError(() => readUploadId(value), 400, "invalid_upload");
    }
  });
  it("normalizes an optional sha256 checksum", () => {
    expect(readUploadChecksum(undefined)).toBeUndefined();
    expect(readUploadChecksum("A".repeat(64))).toBe("a".repeat(64));
  });
  it("rejects a malformed checksum", () => {
    for (const value of ["abc", "a".repeat(63), "g".repeat(64), 5]) {
      expectHttpError(() => readUploadChecksum(value), 400, "invalid_upload");
    }
  });
});

class RouteError extends Error {
  constructor(readonly statusCode: number, readonly code: string, readonly attachmentId?: string) { super(code); }
}
class RouteDetailError extends Error {
  constructor(readonly statusCode: number, readonly code: string, readonly detail: string) { super(code); }
}

describe("sendUploadFailure", () => {
  function app() {
    const server = Fastify();
    server.post("/fail", async (request, reply) => {
      const { kind, attachmentId } = request.body as { kind: string; attachmentId?: string };
      const error = kind === "http"
        ? new AttachmentUploadHttpError(503, "cache_unavailable", "캐시를 사용할 수 없습니다")
        : kind === "route"
          ? new RouteError(409, "upload_conflict", "a2")
          : kind === "route-detail"
            ? new RouteDetailError(422, "checksum_mismatch", "체크섬 불일치")
            : new Error("boom https://r2.example/put?token=secret");
      return sendUploadFailure(reply, error, attachmentId);
    });
    return server;
  }
  async function fail(kind: string, attachmentId?: string) {
    const server = app();
    try {
      return await server.inject({ method: "POST", url: "/fail", payload: { kind, attachmentId } });
    } finally {
      await server.close();
    }
  }
  it("preserves an explicit http error and attachment id", async () => {
    const res = await fail("http", "a1");
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ detail: "캐시를 사용할 수 없습니다", code: "cache_unavailable", attachment_id: "a1" });
  });
  it("keeps a route status and code but masks the storage detail", async () => {
    const res = await fail("route");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ detail: MASKED, code: "upload_conflict", attachment_id: "a2" });
  });
  it("keeps an authored route detail", async () => {
    const res = await fail("route-detail");
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ detail: "체크섬 불일치", code: "checksum_mismatch" });
  });
  it("maps an unknown transport error to a masked 502 without leaking the url", async () => {
    const res = await fail("unknown", "a3");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ detail: MASKED, code: "storage_failed", attachment_id: "a3" });
    expect(res.body).not.toContain("r2.example");
    expect(res.body).not.toContain("token");
  });
});

function multipartBody(boundary: string, parts: Array<{ name: string; filename?: string; content: Buffer | string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) disposition += `; filename="${part.filename}"`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
function multipartRequest(body: Buffer, boundary = "b"): FastifyRequest {
  return { body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } } as unknown as FastifyRequest;
}

describe("multipart form parser for uploads", () => {
  it("distinguishes an empty file part from a missing file", () => {
    const empty = parseMultipartForm(multipartRequest(multipartBody("b", [{ name: "file", filename: "empty.bin", content: Buffer.alloc(0) }])));
    expect(empty.ok && empty.value.file.content.length).toBe(0);
    expect(empty.ok && empty.value.file.filename).toBe("empty.bin");
    const missing = parseMultipartForm(multipartRequest(multipartBody("b", [{ name: "session_id", content: "s1" }])));
    expect(missing).toEqual({ ok: false, message: "file is required", statusCode: 400 });
  });
  it("accepts a body up to 101 MiB and rejects one byte more", async () => {
    const server = Fastify();
    registerMultipartFormParser(server);
    server.post("/upload", async (request) => ({ size: (request.body as Buffer).length }));
    try {
      const atLimit = await server.inject({ method: "POST", url: "/upload", headers: { "content-type": "multipart/form-data; boundary=b" }, payload: Buffer.alloc(101 * 1024 * 1024) });
      expect(atLimit.statusCode).toBe(200);
      expect(atLimit.json()).toEqual({ size: 101 * 1024 * 1024 });
      const overLimit = await server.inject({ method: "POST", url: "/upload", headers: { "content-type": "multipart/form-data; boundary=b" }, payload: Buffer.alloc(101 * 1024 * 1024 + 1) });
      expect(overLimit.statusCode).toBe(413);
    } finally {
      await server.close();
    }
  });
});
