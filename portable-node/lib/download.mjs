import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { dirname } from "node:path";
import { Readable } from "node:stream";

export class DownloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "DownloadError";
  }
}

/**
 * 작은 JSON 요청. 설계 §1의 15초 상한을 호출자가 넘긴다.
 */
export async function fetchJson(url, { headers = {}, timeoutMs = 15000, method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, ok: response.ok, body: parsed, headers: response.headers };
}

/**
 * 파일 하나를 내려받아 sha256과 크기를 검증한다. 실패하면 대상 파일을 남기지 않는다.
 * 큰 스트림은 호출자가 stream_timeout_ms(기본 3600초)를 넘긴다.
 */
export async function downloadFile(url, destination, {
  headers = {},
  timeoutMs = 3600000,
  expectedSha256,
  expectedSize,
  onProgress,
} = {}) {
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part-${process.pid}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) {
    throw new DownloadError(`다운로드 실패 (${response.status}): ${redactUrl(url)}`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  let lastReport = 0;
  try {
    const source = Readable.fromWeb(response.body);
    const sink = createWriteStream(partial);
    for await (const chunk of source) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (onProgress && bytes - lastReport >= 25 * 1024 * 1024) {
        lastReport = bytes;
        onProgress({ bytes });
      }
      if (!sink.write(chunk)) await once(sink, "drain");
    }
    await new Promise((resolve, reject) => {
      sink.end((error) => (error ? reject(error) : resolve()));
    });
    const actual = hash.digest("hex");
    if (typeof expectedSize === "number" && bytes !== expectedSize) {
      throw new DownloadError(`크기 불일치: 기대 ${expectedSize}, 실제 ${bytes} (${redactUrl(url)})`);
    }
    if (expectedSha256 && actual !== expectedSha256) {
      throw new DownloadError(
        `sha256 불일치: 기대 ${expectedSha256}, 실제 ${actual} (${redactUrl(url)})`,
      );
    }
    await rm(destination, { force: true });
    await rename(partial, destination);
    return { sha256: actual, size: bytes };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function fileSize(path) {
  const metadata = await stat(path);
  return metadata.size;
}

export async function makeExecutable(path) {
  if (process.platform !== "win32") await chmod(path, 0o755);
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    url.search = "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value);
  }
}
