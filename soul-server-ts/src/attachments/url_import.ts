import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_IMPORTED_ATTACHMENT_SIZE = 5 * 1024 ** 3;
export interface ImportSessionFileParams {
  uploadId: string;
  sessionId: string;
  filename: string;
  contentType?: string;
  expectedSize: number;
  downloadUrl: string;
}

export function validateR2DownloadUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
    || !/^[a-f0-9]{32}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com$/i.test(url.hostname)) {
    throw new Error("첨부 다운로드는 HTTPS R2 URL만 허용합니다");
  }
}

/** The caller owns filename/session validation and the abort controller. */
export async function streamR2Attachment(input: {
  downloadUrl: string; expectedSize: number; tempPath: string;
  finalPath: string; signal: AbortSignal;
}): Promise<void> {
  validateR2DownloadUrl(input.downloadUrl);
  let received = 0;
  try {
    const response = await fetch(input.downloadUrl, { redirect: "error", signal: input.signal });
    if (!response.ok || !response.body) throw new Error(`R2 첨부 다운로드 실패 (${response.status})`);
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > input.expectedSize ? new Error("첨부 크기가 예상 크기를 초과합니다") : null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter, createWriteStream(input.tempPath, { flags: "wx" }),
      { signal: input.signal },
    );
    if ((await stat(input.tempPath)).size !== input.expectedSize) {
      throw new Error("첨부 크기가 예상 크기와 다릅니다");
    }
    input.signal.throwIfAborted();
    await rename(input.tempPath, input.finalPath);
  } finally {
    await rm(input.tempPath, { force: true }).catch(() => undefined);
  }
}
