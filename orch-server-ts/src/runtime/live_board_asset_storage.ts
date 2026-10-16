import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
export type LiveBoardAssetUploadPart = {
  readonly partNumber: number;
  readonly uploadUrl: string;
};

export type LiveBoardAssetMultipartUpload = {
  readonly uploadId: string;
  readonly partSize: number;
  readonly parts: readonly LiveBoardAssetUploadPart[];
};

export type LiveBoardAssetCompletedPart = {
  readonly partNumber: number;
  readonly etag: string;
};

export type LiveBoardAssetObjectHead = {
  readonly byteSize: number;
  readonly mimeType?: string | null;
};

export type LiveBoardAssetStorage = {
  readonly createPresignedPutUrl: (input: {
    readonly storageKey: string;
    readonly mimeType: string;
    readonly expiresSeconds: number;
  }) => Promise<string> | string;
  readonly createMultipartUpload: (input: {
    readonly storageKey: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly partSize: number;
    readonly expiresSeconds: number;
  }) => Promise<LiveBoardAssetMultipartUpload> | LiveBoardAssetMultipartUpload;
  readonly completeMultipartUpload: (input: {
    readonly storageKey: string;
    readonly uploadId: string;
    readonly parts: readonly LiveBoardAssetCompletedPart[];
  }) => Promise<void> | void;
  readonly headObject: (input: {
    readonly storageKey: string;
  }) => Promise<LiveBoardAssetObjectHead> | LiveBoardAssetObjectHead;
  readonly createPresignedGetUrl: (input: {
    readonly storageKey: string;
    readonly expiresSeconds: number;
  }) => Promise<string> | string;
};

export type AttachmentR2Storage = LiveBoardAssetStorage & {
  deleteObject(input: { storageKey: string }): Promise<void>;
  abortMultipartUpload(input: { storageKey: string; uploadId: string }): Promise<void>;
};

export type R2ObjectStorage = AttachmentR2Storage & {
  createMultipartPartUrls(input: {
    readonly storageKey: string;
    readonly uploadId: string;
    readonly byteSize: number;
    readonly partSize: number;
    readonly expiresSeconds: number;
  }): LiveBoardAssetMultipartUpload;
  putObject(input: {
    readonly storageKey: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly checksumSha256: string;
    readonly body: Uint8Array | AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  openObject(input: {
    readonly storageKey: string;
    readonly method?: "GET" | "HEAD";
    readonly range?: string;
    readonly signal?: AbortSignal;
  }): Promise<Response>;
};

export class R2StorageRequestError extends Error {
  constructor(readonly operation: string, readonly status: number) {
    super(`R2 ${operation} failed with status ${status}`);
    this.name = "R2StorageRequestError";
  }
}

export class R2ObjectIntegrityError extends Error {
  constructor(readonly reason: "size" | "checksum") {
    super(`R2 object ${reason} mismatch`);
    this.name = "R2ObjectIntegrityError";
  }
}

export type R2BoardAssetStorageConfig = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly endpoint: string;
};

const AWS_REGION = "auto";
const AWS_SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export async function checkR2Bucket(config: R2BoardAssetStorageConfig): Promise<void> {
  const response = await signedFetch(config, { method: "HEAD", storageKey: "", signal: AbortSignal.timeout(15_000) });
  await assertR2Ok(response, "head bucket");
}

export function createR2BoardAssetStorage(
  config: R2BoardAssetStorageConfig,
): R2ObjectStorage {
  return {
    async deleteObject(input) {
      await assertR2Ok(await signedFetch(config, { method: "DELETE", storageKey: input.storageKey }), "delete object");
    },
    async abortMultipartUpload(input) {
      await assertR2Ok(await signedFetch(config, { method: "DELETE", storageKey: input.storageKey,
        query: { uploadId: input.uploadId } }), "abort multipart upload");
    },
    createPresignedPutUrl(input) {
      return presign(config, {
        method: "PUT",
        storageKey: input.storageKey,
        headers: { "content-type": input.mimeType },
        expiresSeconds: input.expiresSeconds,
      });
    },
    async createMultipartUpload(input) {
      const response = await signedFetch(config, {
        method: "POST",
        storageKey: input.storageKey,
        query: { uploads: "" },
        headers: { "content-type": input.mimeType },
        body: "",
      });
      await assertR2Ok(response, "create multipart upload");
      const uploadId = uploadIdFromXml(await response.text());
      return createMultipartPartUrls(config, {
        ...input,
        uploadId,
      });
    },
    createMultipartPartUrls(input) {
      return createMultipartPartUrls(config, input);
    },
    async putObject(input) {
      const checksumSha256 = normalizeChecksum(input.checksumSha256);
      let body: string | Uint8Array | Readable;
      let duplex: "half" | undefined;
      if (input.body instanceof Uint8Array) {
        if (input.body.byteLength !== input.byteSize) throw new R2ObjectIntegrityError("size");
        if (sha256Bytes(input.body) !== checksumSha256) throw new R2ObjectIntegrityError("checksum");
        body = Buffer.from(input.body);
      } else {
        body = Readable.from(validateUploadBody(input.body, input.byteSize, checksumSha256));
        duplex = "half";
      }
      await assertR2Ok(await signedFetch(config, {
        method: "PUT",
        storageKey: input.storageKey,
        headers: {
          "content-type": input.mimeType,
          "content-length": String(input.byteSize),
          "if-none-match": "*",
        },
        body,
        payloadSha256: checksumSha256,
        duplex,
        signal: input.signal,
      }), "put object");
    },
    async completeMultipartUpload(input) {
      const body = completeMultipartXml(input.parts);
      const response = await signedFetch(config, {
        method: "POST",
        storageKey: input.storageKey,
        query: { uploadId: input.uploadId },
        headers: { "content-type": "application/xml" },
        body,
      });
      await assertR2Ok(response, "complete multipart upload");
    },
    async headObject(input) {
      const response = await signedFetch(config, {
        method: "HEAD",
        storageKey: input.storageKey,
      });
      await assertR2Ok(response, "head object");
      const contentLength = response.headers.get("content-length");
      const byteSize = contentLength === null ? NaN : Number(contentLength);
      if (!Number.isFinite(byteSize)) {
        throw new Error("R2 head object did not return content-length");
      }
      return {
        byteSize,
        mimeType: response.headers.get("content-type"),
      };
    },
    openObject(input) {
      return signedFetch(config, {
        method: input.method ?? "GET",
        storageKey: input.storageKey,
        headers: input.range === undefined ? undefined : { range: input.range },
        signal: input.signal,
      });
    },
    createPresignedGetUrl(input) {
      return presign(config, {
        method: "GET",
        storageKey: input.storageKey,
        expiresSeconds: input.expiresSeconds,
      });
    },
  };
}

type SignInput = {
  readonly method: string;
  readonly storageKey: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | Readable;
  readonly payloadSha256?: string;
  readonly duplex?: "half";
  readonly signal?: AbortSignal;
};
type PresignInput = SignInput & {
  readonly expiresSeconds: number;
};

function presign(config: R2BoardAssetStorageConfig, input: PresignInput): string {
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const date = amzDate.slice(0, 8);
  const url = objectUrl(config, input.storageKey);
  const headers = canonicalHeaderMap(url, input.headers);
  const signedHeaders = Object.keys(headers).sort().join(";");
  const query = {
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": UNSIGNED_PAYLOAD,
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope(date)}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQuery(query),
    canonicalHeaders(headers),
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const signature = signString(config.secretAccessKey, date, stringToSign(
    amzDate,
    date,
    canonicalRequest,
  ));
  url.search = canonicalQuery({ ...query, "X-Amz-Signature": signature });
  return url.toString();
}

async function signedFetch(
  config: R2BoardAssetStorageConfig,
  input: SignInput,
): Promise<Response> {
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const date = amzDate.slice(0, 8);
  const url = objectUrl(config, input.storageKey);
  url.search = canonicalQuery(input.query ?? {});
  const payloadHash = input.payloadSha256 ?? (input.body === undefined
    ? sha256Hex("")
    : typeof input.body === "string"
      ? sha256Hex(input.body)
      : input.body instanceof Uint8Array
        ? sha256Bytes(input.body)
        : null);
  if (payloadHash === null) throw new Error("R2 streamed requests require a known payload SHA-256");
  const headers = canonicalHeaderMap(url, {
    ...input.headers,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  });
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQuery(input.query ?? {}),
    canonicalHeaders(headers),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const signature = signString(config.secretAccessKey, date, stringToSign(
    amzDate,
    date,
    canonicalRequest,
  ));
  const authorization = "AWS4-HMAC-SHA256 " + [
    `Credential=${config.accessKeyId}/${credentialScope(date)}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
  const request: RequestInit & { duplex?: "half" } = {
    method: input.method,
    // Ask for the stored bytes as-is. fetch otherwise advertises gzip, R2 then
    // compresses text objects and drops content-length, which breaks size checks
    // and byte-exact reads. Left unsigned so an edge rewrite cannot break SigV4.
    headers: { ...headers, authorization, "accept-encoding": "identity" },
    redirect: "error",
    signal: input.signal,
  };
  if (input.method !== "HEAD" && input.body !== undefined) {
    request.body = input.body as unknown as NonNullable<RequestInit["body"]>;
  }
  if (input.duplex !== undefined) request.duplex = input.duplex;
  return fetch(url, request);
}

function createMultipartPartUrls(
  config: R2BoardAssetStorageConfig,
  input: {
    readonly storageKey: string;
    readonly uploadId: string;
    readonly byteSize: number;
    readonly partSize: number;
    readonly expiresSeconds: number;
  },
): LiveBoardAssetMultipartUpload {
  const partCount = Math.max(1, Math.ceil(input.byteSize / input.partSize));
  return {
    uploadId: input.uploadId,
    partSize: input.partSize,
    parts: Array.from({ length: partCount }, (_, index) => {
      const partNumber = index + 1;
      return {
        partNumber,
        uploadUrl: presign(config, {
          method: "PUT",
          storageKey: input.storageKey,
          query: { partNumber: String(partNumber), uploadId: input.uploadId },
          expiresSeconds: input.expiresSeconds,
        }),
      };
    }),
  };
}

async function* validateUploadBody(
  body: AsyncIterable<Uint8Array>,
  expectedByteSize: number,
  expectedChecksum: string,
): AsyncGenerator<Uint8Array> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) throw new R2ObjectIntegrityError("size");
    if (chunk.byteLength === 0) continue;
    byteSize += chunk.byteLength;
    if (byteSize > expectedByteSize) throw new R2ObjectIntegrityError("size");
    hash.update(chunk);
    yield chunk;
  }
  if (byteSize !== expectedByteSize) throw new R2ObjectIntegrityError("size");
  if (hash.digest("hex") !== expectedChecksum) throw new R2ObjectIntegrityError("checksum");
}

function normalizeChecksum(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new R2ObjectIntegrityError("checksum");
  return normalized;
}

const sha256Bytes = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

function objectUrl(config: R2BoardAssetStorageConfig, storageKey: string): URL {
  const url = new URL(config.endpoint);
  const prefix = url.pathname.replace(/\/+$/, "");
  const encodedKey = storageKey.split("/").map(encodeRfc3986).join("/");
  url.pathname = `${prefix}/${encodeRfc3986(config.bucket)}${storageKey ? `/${encodedKey}` : ""}`;
  url.search = "";
  return url;
}

function canonicalHeaderMap(
  url: URL,
  headers: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const map: Record<string, string> = { host: url.host };
  for (const [key, value] of Object.entries(headers)) {
    map[key.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  return map;
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}`)
    .join("\n") + "\n";
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.entries(query)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    // SigV4 orders encoded ASCII bytes, independent of locale or letter case.
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const left = leftKey === rightKey ? leftValue : leftKey;
      const right = leftKey === rightKey ? rightValue : rightKey;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function credentialScope(date: string): string {
  return `${date}/${AWS_REGION}/${AWS_SERVICE}/aws4_request`;
}

function stringToSign(
  amzDate: string,
  date: string,
  canonicalRequest: string,
): string {
  return [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope(date),
    sha256Hex(canonicalRequest),
  ].join("\n");
}

function signString(secretAccessKey: string, date: string, value: string): string {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, AWS_REGION);
  const serviceKey = hmac(regionKey, AWS_SERVICE);
  const signingKey = hmac(serviceKey, "aws4_request");
  return hmac(signingKey, value).toString("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function assertR2Ok(response: Response, operation: string): Promise<void> {
  if (response.ok) return;
  throw new R2StorageRequestError(operation, response.status);
}

function uploadIdFromXml(xml: string): string {
  const match = xml.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (match?.[1] === undefined || match[1].length === 0) {
    throw new Error("R2 create multipart upload did not return UploadId");
  }
  return decodeXml(match[1]);
}

function completeMultipartXml(
  parts: readonly LiveBoardAssetCompletedPart[],
): string {
  const partXml = [...parts]
    .sort((left, right) => left.partNumber - right.partNumber)
    .map(
      (part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
    )
    .join("");
  return `<CompleteMultipartUpload>${partXml}</CompleteMultipartUpload>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}
