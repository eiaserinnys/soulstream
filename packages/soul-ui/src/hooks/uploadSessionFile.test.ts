import { afterEach, expect, it, vi } from "vitest";
import { uploadSessionFile } from "./uploadSessionFile";
afterEach(() => vi.unstubAllGlobals());
it("slices a large file into 16MiB parts, uses two PUTs, and sends only a ticket at completion", async () => {
  const slice = vi.fn((_start: number, _end: number) => new Blob(["bounded fixture"]));
  const file = { size: 64 * 1024 ** 2, name: "large.zip", type: "application/zip", slice } as unknown as File;
  let active = 0, maximum = 0;
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body });
    if (init.method === "PUT") {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return new Response(null, { headers: { ETag: '"etag"' } });
    }
    if (url.includes("/init")) return Response.json({ ticket: "ticket", partSize: 16 * 1024 ** 2,
      parts: [1, 2, 3, 4].map(partNumber => ({ partNumber, uploadUrl: `https://r2/${partNumber}` })) });
    return Response.json({ path: "/incoming/session/file.zip" });
  }));
  const path = await uploadSessionFile({ file, uploadUrl: "/api/attachments/sessions?nodeId=worker", sessionId: "session", folderId: "folder", signal: new AbortController().signal });
  expect(path).toBe("/incoming/session/file.zip");
  expect(maximum).toBe(2);
  expect(slice.mock.calls).toEqual([0, 1, 2, 3].map(i => [i * 16 * 1024 ** 2, (i + 1) * 16 * 1024 ** 2]));
  expect(JSON.parse(requests[0].body as string)).toMatchObject({ folder_id: "folder", size: file.size });
  expect(JSON.parse(requests.at(-1)!.body as string)).toEqual({ ticket: "ticket", parts: [1, 2, 3, 4].map(partNumber => ({ partNumber, etag: '"etag"' })) });
});
it("surfaces a large-file init error without falling back to the legacy endpoint", async () => {
  const fetcher = vi.fn(async () => Response.json({ detail: "워커 업데이트가 필요합니다" }, { status: 409 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(uploadSessionFile({ file: { size: 64 * 1024 ** 2, name: "file.zip", type: "application/zip" } as File,
    uploadUrl: "/api/attachments/sessions?nodeId=worker", sessionId: "session", signal: new AbortController().signal })).rejects.toThrow("워커 업데이트");
  expect(fetcher).toHaveBeenCalledOnce();
});
it("aborts the multipart on PUT failure and preserves the original error", async () => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    if (url.includes("/init")) return Response.json({ ticket: "ticket", partSize: 16 * 1024 ** 2,
      parts: [1, 2, 3, 4].map(partNumber => ({ partNumber, uploadUrl: `https://r2/${partNumber}` })) });
    if (url.includes("/abort")) throw new Error("cleanup failed");
    return new Response(null, { status: 403 });
  }));
  await expect(uploadSessionFile({ file: { size: 64 * 1024 ** 2, name: "file.zip", slice: () => new Blob(["fixture"]) } as File,
    uploadUrl: "/api/attachments/sessions?nodeId=worker", sessionId: "session", signal: new AbortController().signal })).rejects.toThrow("part 업로드 실패 (403)");
  expect(requests.at(-1)).toBe("/api/attachments/sessions/multipart/abort?nodeId=worker");
  expect(requests.some(url => url.includes("/complete"))).toBe(false);
});
