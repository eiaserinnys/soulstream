import { createHash } from "node:crypto";
import { chmod, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AttachmentDescriptor } from "@soulstream/wire-schema/attachments";
import { createAttachmentMaterializer } from "../../src/attachments/attachment_materializer.js";
import { makeTempDir } from "../helpers/temp_dir.js";

const SESSION_ID = "session-1";
const ATTACHMENT_ID = "asset-1";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function descriptorFor(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  overrides: Partial<AttachmentDescriptor> = {},
): AttachmentDescriptor {
  return {
    attachment_id: ATTACHMENT_ID,
    name,
    mime_type: mimeType,
    byte_size: bytes.byteLength,
    checksum_sha256: sha256(bytes),
    width: null,
    height: null,
    preview_kind: mimeType.startsWith("image/") ? "image" : "info",
    preview_mime_type: null,
    ...overrides,
  };
}

function fakeFetch(
  descriptor: AttachmentDescriptor,
  bytes: Uint8Array,
  options: {
    metadata?: () => Response;
    content?: () => Response;
  } = {},
) {
  const fetchImpl = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/metadata")) {
      return options.metadata?.() ?? Response.json({ descriptor, upload_status: "committed" });
    }
    if (url.pathname.endsWith("/content")) {
      return options.content?.() ?? new Response(bytes);
    }
    throw new Error(`Unexpected attachment URL: ${url.pathname}`);
  });
  return fetchImpl;
}

async function makeMaterializer(
  fetchImpl: typeof globalThis.fetch,
  incomingDir?: string,
) {
  const root = incomingDir ?? await makeTempDir("attachment-materializer-");
  const materializer = createAttachmentMaterializer({
    incomingDir: root,
    nodeId: "node-a",
    orch: { baseUrl: "http://orch.test", headers: { authorization: "Bearer test-token" } },
    fetch: fetchImpl,
  });
  return { root, materializer };
}

const input = (
  overrides: Partial<{ sessionId: string; attachmentId: string; mode: "input" | "resolve"; deliveryId: string }> = {},
) => ({
  sessionId: SESSION_ID,
  attachmentId: ATTACHMENT_ID,
  mode: "input" as const,
  ...overrides,
});

async function expectNoTemps(directory: string): Promise<void> {
  const names = await readdir(directory);
  expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

describe("createAttachmentMaterializer", () => {
  it("streams a verified miss into the session cache using the worker read contract", async () => {
    const bytes = Buffer.from("attachment bytes");
    const descriptor = descriptorFor("report.txt", "text/plain", bytes);
    const fetchImpl = fakeFetch(descriptor, bytes);
    const { root, materializer } = await makeMaterializer(fetchImpl);
    const controller = new AbortController();
    const result = await materializer.materialize(
      input({ mode: "resolve", deliveryId: "delivery-1" }),
      controller.signal,
    );

    expect(result).toMatchObject({ attachment_id: ATTACHMENT_ID, descriptor });
    expect(result.local_path).toBe(join(root, SESSION_ID, "assets", ATTACHMENT_ID, "report.txt"));
    await expect(readFile(result.local_path)).resolves.toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [requestUrl, init] of fetchImpl.mock.calls) {
      const url = new URL(String(requestUrl));
      expect(url.origin).toBe("http://orch.test");
      expect(url.search).toBe("?session_id=session-1&mode=resolve&delivery_id=delivery-1");
      expect(init).toMatchObject({
        method: "GET",
        headers: { authorization: "Bearer test-token", "x-soulstream-node-id": "node-a" },
        redirect: "error",
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).not.toBe(controller.signal);
    }
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/api/attachments/worker/${ATTACHMENT_ID}/metadata`,
      `/api/attachments/worker/${ATTACHMENT_ID}/content`,
    ]);
  });

  it("checks metadata every time, reuses verified cache, and replaces corruption", async () => {
    const bytes = Buffer.from("cache hit");
    const descriptor = descriptorFor("cache.txt", "text/plain", bytes);
    const fetchImpl = fakeFetch(descriptor, bytes);
    const { materializer } = await makeMaterializer(fetchImpl);
    const first = await materializer.materialize(input());
    const second = await materializer.materialize(input());
    expect(second.local_path).toBe(first.local_path);
    await rm(first.local_path);
    await materializer.materialize(input());
    await writeFile(first.local_path, "corrupt bytes");
    const repaired = await materializer.materialize(input());
    await expect(readFile(repaired.local_path)).resolves.toEqual(bytes);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/metadata"))).toHaveLength(4);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/content"))).toHaveLength(3);
  });

  it("accepts a zero-byte source and verifies its empty SHA-256", async () => {
    const bytes = Buffer.alloc(0);
    const descriptor = descriptorFor("empty.bin", "application/octet-stream", bytes);
    const fetchImpl = fakeFetch(descriptor, bytes);
    const { materializer } = await makeMaterializer(fetchImpl);

    const result = await materializer.materialize(input());

    await expect(readFile(result.local_path)).resolves.toEqual(bytes);
  });

  it.each([
    { name: "보고서.txt", mimeType: "application/octet-stream", expected: "보고서.txt" },
    { name: "CON", mimeType: "application/octet-stream", expected: "_CON" },
    { name: ".env", mimeType: "application/octet-stream", expected: ".env" },
    { name: ".pem", mimeType: "application/octet-stream", expected: ".pem" },
    { name: "report.png#v1", mimeType: "application/octet-stream", expected: "report.png_v1" },
    { name: "photo.jpg#v1", mimeType: "image/png", expected: "photo.jpg_v1.png" },
  ])("keeps safe cache name for $name ($mimeType)", async ({ name, mimeType, expected }) => {
    const bytes = Buffer.from("opaque source");
    const descriptor = descriptorFor(name, mimeType, bytes);
    const fetchImpl = fakeFetch(descriptor, bytes);
    const { root, materializer } = await makeMaterializer(fetchImpl);

    const result = await materializer.materialize(input());

    expect(result.local_path).toBe(join(root, SESSION_ID, "assets", ATTACHMENT_ID, expected));
    expect(result.descriptor.name).toBe(name);
  });

  it.each(["", "..", "a/b", "a\\b"])(
    "rejects an unsafe attachment id %j before making an HTTP request",
    async (attachmentId) => {
      const bytes = Buffer.from("source");
      const fetchImpl = fakeFetch(descriptorFor("a.txt", "text/plain", bytes), bytes);
      const { materializer } = await makeMaterializer(fetchImpl);

      await expect(materializer.materialize(input({ attachmentId }))).rejects.toMatchObject({
        code: "ATTACHMENT_INVALID_ID",
        statusCode: 422,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("preserves central domain error code and HTTP status", async () => {
    const bytes = Buffer.from("source");
    const fetchImpl = fakeFetch(descriptorFor("a.txt", "text/plain", bytes), bytes, {
      metadata: () => Response.json({ code: "ATTACHMENT_PENDING", detail: "pending" }, { status: 409 }),
    });
    const { materializer } = await makeMaterializer(fetchImpl);

    await expect(materializer.materialize(input())).rejects.toMatchObject({
      code: "ATTACHMENT_PENDING",
      statusCode: 409,
    });
  });

  it.each([
    { field: "attachment_id", value: "other-id" },
    { field: "checksum_sha256", value: null },
    { field: "checksum_sha256", value: "not-a-hash" },
    { field: "byte_size", value: 5 * 1024 * 1024 * 1024 + 1 },
    { field: "upload_status", value: "pending" },
  ])("rejects invalid metadata $field", async ({ field, value }) => {
    const bytes = Buffer.from("source");
    const descriptor = descriptorFor("a.txt", "text/plain", bytes, { [field]: value } as Partial<AttachmentDescriptor>);
    const fetchImpl = fakeFetch(descriptor, bytes, {
      metadata: field === "upload_status"
        ? () => Response.json({ descriptor, upload_status: value })
        : undefined,
    });
    const { materializer } = await makeMaterializer(fetchImpl);

    await expect(materializer.materialize(input())).rejects.toMatchObject({
      code: "ATTACHMENT_INVALID_METADATA",
      statusCode: 500,
    });
    expect(fetchImpl.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith("/content"))).toBe(false);
  });

  it.each([
    {
      label: "short body",
      actual: Buffer.from("abc"),
      size: 4,
      checksum: sha256(Buffer.from("abc")),
    },
    {
      label: "long body",
      actual: Buffer.from("abcd"),
      size: 3,
      checksum: sha256(Buffer.from("abcd")),
    },
    {
      label: "wrong hash",
      actual: Buffer.from("abcd"),
      size: 4,
      checksum: sha256(Buffer.from("other")),
    },
  ])("removes the temporary file after a $label", async ({ actual, size, checksum }) => {
    const descriptor = descriptorFor("source.bin", "application/octet-stream", actual, {
      byte_size: size,
      checksum_sha256: checksum,
    });
    const fetchImpl = fakeFetch(descriptor, actual);
    const { root, materializer } = await makeMaterializer(fetchImpl);
    const directory = join(root, SESSION_ID, "assets", ATTACHMENT_ID);

    await expect(materializer.materialize(input())).rejects.toMatchObject({
      code: "ATTACHMENT_MATERIALIZATION_FAILED",
    });
    await expectNoTemps(directory);
  });

  it("removes a temporary file when the content stream fails", async () => {
    const bytes = Buffer.from("source bytes");
    const descriptor = descriptorFor("source.bin", "application/octet-stream", bytes);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 3));
        controller.error(new Error("simulated transfer interruption"));
      },
    });
    const fetchImpl = fakeFetch(descriptor, bytes, { content: () => new Response(body) });
    const { root, materializer } = await makeMaterializer(fetchImpl);
    const directory = join(root, SESSION_ID, "assets", ATTACHMENT_ID);

    await expect(materializer.materialize(input())).rejects.toMatchObject({
      code: "ATTACHMENT_MATERIALIZATION_FAILED",
    });
    await expectNoTemps(directory);
  });

  it("returns no cache path when the cache directory is not writable", async () => {
    const root = await makeTempDir("attachment-materializer-readonly-");
    const bytes = Buffer.from("source");
    const fetchImpl = fakeFetch(descriptorFor("source.txt", "text/plain", bytes), bytes);
    const { materializer } = await makeMaterializer(fetchImpl, root);
    await chmod(root, 0o500);

    try {
      await expect(materializer.materialize(input())).rejects.toMatchObject({
        code: "ATTACHMENT_MATERIALIZATION_FAILED",
        statusCode: 500,
      });
      expect(fetchImpl.mock.calls.some(([url]) => new URL(String(url)).pathname.endsWith("/content"))).toBe(false);
    } finally {
      await chmod(root, 0o700);
    }
  });

});
