import { createHash, createHmac } from "node:crypto";

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

export type R2BoardAssetStorageConfig = {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly endpoint: string;
};

type StorageConfigRecord = Readonly<Record<string, unknown>>;

const AWS_REGION = "auto";
const AWS_SERVICE = "s3";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export async function resolveLiveBoardAssetStorageFromConfig(
  config: StorageConfigRecord,
): Promise<LiveBoardAssetStorage | null> {
  const accessKeyId = nonEmptyString(config.r2_board_assets_access_key_id);
  const secretAccessKey = nonEmptyString(config.r2_board_assets_secret_access_key);
  const bucket = nonEmptyString(config.r2_board_assets_bucket);
  const endpoint = nonEmptyString(config.r2_board_assets_endpoint);
  if (
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    bucket === undefined ||
    endpoint === undefined
  ) {
    return null;
  }
  return createR2BoardAssetStorage({
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint,
  });
}

export function createR2BoardAssetStorage(
  config: R2BoardAssetStorageConfig,
): LiveBoardAssetStorage {
  return {
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
      const partCount = Math.max(1, Math.ceil(input.byteSize / input.partSize));
      return {
        uploadId,
        partSize: input.partSize,
        parts: Array.from({ length: partCount }, (_, index) => {
          const partNumber = index + 1;
          return {
            partNumber,
            uploadUrl: presign(config, {
              method: "PUT",
              storageKey: input.storageKey,
              query: { partNumber: String(partNumber), uploadId },
              expiresSeconds: input.expiresSeconds,
            }),
          };
        }),
      };
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
    createPresignedGetUrl(input) {
      return presign(config, {
        method: "GET",
        storageKey: input.storageKey,
        expiresSeconds: input.expiresSeconds,
      });
    },
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

type SignInput = {
  readonly method: string;
  readonly storageKey: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
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
  const payloadHash = sha256Hex(input.body ?? "");
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
  const authorization = [
    "AWS4-HMAC-SHA256",
    `Credential=${config.accessKeyId}/${credentialScope(date)}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
  return fetch(url, {
    method: input.method,
    headers: { ...headers, authorization },
    body: input.method === "HEAD" ? undefined : input.body,
  });
}

function objectUrl(config: R2BoardAssetStorageConfig, storageKey: string): URL {
  const url = new URL(config.endpoint);
  const prefix = url.pathname.replace(/\/+$/, "");
  const encodedKey = storageKey.split("/").map(encodeRfc3986).join("/");
  url.pathname = `${prefix}/${encodeRfc3986(config.bucket)}/${encodedKey}`;
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
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue.localeCompare(rightValue)
        : leftKey.localeCompare(rightKey),
    )
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
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
  const detail = response.status === 404 ? "" : `: ${await response.text()}`;
  throw new Error(`R2 ${operation} failed with ${response.status}${detail}`);
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
