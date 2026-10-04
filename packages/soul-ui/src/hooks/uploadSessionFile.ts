import {orchestratorFetch} from "../lib/orchestrator-connection";
const LARGE_FILE_THRESHOLD = 64 * 1024 ** 2;
const MAX_FILE_SIZE = 5 * 1024 ** 3;
const PART_SIZE = 16 * 1024 ** 2;
interface UploadInput {
  file: File; uploadUrl: string; sessionId: string; folderId?: string | null; signal: AbortSignal;
}
interface MultipartInit {
  ticket: string; partSize: number;
  parts: { partNumber: number; uploadUrl: string }[];
}
function multipartUrl(uploadUrl: string, action: string) {
  const [path, query] = uploadUrl.split("?");
  return `${path}/multipart/${action}${query ? `?${query}` : ""}`;
}
async function jsonResponse(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.detail ?? `첨부 업로드 실패 (${response.status})`);
  if (!data) throw new Error("첨부 서버 응답이 올바르지 않습니다");
  return data;
}
function attachmentPath(data: { path?: unknown; file_path?: unknown }): string {
  const path = data.path ?? data.file_path;
  if (typeof path !== "string" || !path) throw new Error("첨부 서버 응답에 파일 경로가 없습니다");
  return path;
}
export async function uploadSessionFile(input: UploadInput): Promise<string> {
  const { file, uploadUrl, sessionId, signal, folderId } = input;
  if (file.size > MAX_FILE_SIZE) throw new Error("파일당 최대 5GiB까지 첨부할 수 있습니다");
  if (file.size < LARGE_FILE_THRESHOLD) {
    const form = new FormData();
    form.append("file", file);
    form.append("session_id", sessionId);
    return attachmentPath(await jsonResponse(await orchestratorFetch(fetch,uploadUrl, { method: "POST", body: form, signal })));
  }
  let init: MultipartInit | undefined;
  const partsController = new AbortController();
  const partSignal = AbortSignal.any([signal, partsController.signal]);
  const post = (action: string, body: unknown, requestSignal: AbortSignal) => orchestratorFetch(fetch,multipartUrl(uploadUrl, action), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: requestSignal,
  });
  try {
    init = await jsonResponse(await post("init", { session_id: sessionId, filename: file.name,
      size: file.size, content_type: file.type || "application/octet-stream",
      ...(folderId ? { folder_id: folderId } : {}) }, signal)) as MultipartInit;
    if (init.partSize !== PART_SIZE || init.parts.length !== Math.ceil(file.size / PART_SIZE)) {
      throw new Error("첨부 서버의 분할 업로드 응답이 올바르지 않습니다");
    }
    const completed: { partNumber: number; etag: string }[] = new Array(init.parts.length);
    let next = 0;
    async function putParts() {
      while (next < init!.parts.length) {
        partSignal.throwIfAborted();
        const index = next++;
        const part = init!.parts[index]!;
        const start = index * PART_SIZE;
        const response = await orchestratorFetch(fetch,part.uploadUrl, { method: "PUT",
          body: file.slice(start, Math.min(start + PART_SIZE, file.size)), signal: partSignal });
        if (!response.ok) throw new Error(`첨부 part 업로드 실패 (${response.status})`);
        const etag = response.headers.get("ETag");
        if (!etag) throw new Error("첨부 업로드 ETag를 읽을 수 없습니다. R2 CORS 설정을 확인해 주세요");
        completed[index] = { partNumber: part.partNumber, etag };
      }
    }
    await Promise.all([putParts(), putParts()]);
    return attachmentPath(await jsonResponse(await post("complete", { ticket: init.ticket, parts: completed }, signal)));
  } catch (error) {
    partsController.abort();
    if (init?.ticket) await post("abort", { ticket: init.ticket }, AbortSignal.timeout(5000)).catch(() => undefined);
    throw error;
  }
}
