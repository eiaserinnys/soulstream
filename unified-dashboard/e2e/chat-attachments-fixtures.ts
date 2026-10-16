import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { installV3VisualQaRoutes } from "./v3-visual-fixtures";

export const largeTextSize = 1_048_586;
export const largeTextBytes = Buffer.concat([
  Buffer.alloc(1_048_576, 65),
  Buffer.from("TAIL-END!!"),
]);
export const legacyTextBytes = Buffer.from("Legacy note 1234567\n", "utf8");
export const pngBytes = readFileSync(new URL("../public/icon-192.png", import.meta.url));

export interface AttachmentRequest {
  url: string;
  method: string;
  range: string | null;
  responseStatus?: number;
  cookieHeaderPresent?: boolean;
  authorizationHeaderPresent?: boolean;
  body?: Buffer;
  responseHeaders?: Record<string, string>;
}

function assetBytes(attachmentId: string): Buffer {
  if (attachmentId.includes("image")) return pngBytes;
  if (attachmentId === "review-large-text") return largeTextBytes;
  if (attachmentId === "review-user-archive") {
    const zip = Buffer.alloc(4096);
    zip.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
    return zip;
  }
  return Buffer.alloc(4096, 65);
}

function assetMime(attachmentId: string): string {
  if (attachmentId.includes("image")) return "image/png";
  if (attachmentId === "review-user-archive") return "application/zip";
  if (attachmentId === "review-rich-file") return "application/json";
  return "text/plain";
}

function responseHeaders(mime: string, bytes: Buffer, extra: Record<string, string> = {}) {
  return {
    "accept-ranges": "bytes",
    "content-type": mime,
    "content-length": String(bytes.byteLength),
    ...extra,
  };
}

function attachmentResponseHeaders(
  mime: string,
  bytes: Buffer,
  filename: string,
  download: boolean,
  extra: Record<string, string> = {},
) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = !download && (mime === "text/plain" || mime.startsWith("image/"))
    ? "inline"
    : "attachment";
  return responseHeaders(mime, bytes, {
    "cache-control": "private, no-store",
    "content-disposition": `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "vary": "Cookie, Authorization",
    "x-content-type-options": "nosniff",
    ...extra,
  });
}

export async function installChatAttachmentReadRoutes(page: Page): Promise<AttachmentRequest[]> {
  const requests: AttachmentRequest[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        installing: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", {
      configurable: true,
      get: () => null,
    });
  });
  await page.route(/\/api\/attachments\/(?:[^/]+\/content|files)(?:\?|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const range = request.headers().range ?? null;
    const requestHeaders = await request.allHeaders();
    const record: AttachmentRequest = {
      url: request.url(),
      method: request.method(),
      range,
      cookieHeaderPresent: requestHeaders.cookie !== undefined,
      authorizationHeaderPresent: requestHeaders.authorization !== undefined,
    };
    requests.push(record);

    const fulfill = (options: Parameters<typeof route.fulfill>[0]) => {
      record.responseStatus = options.status ?? 200;
      return route.fulfill(options);
    };

    const legacy = url.pathname === "/api/attachments/files";
    const missingImage = url.pathname === "/api/attachments/review-failed-image/content";
    const inlineImage = legacy && url.searchParams.get("path")?.endsWith("inline-only.png");
    if (missingImage || (legacy && !inlineImage && url.searchParams.get("path") !== "/incoming/참고.txt")) {
      return fulfill({
        status: 404,
        headers: { "content-type": "text/plain", "content-length": "0" },
        body: "",
      });
    }

    const attachmentId = url.pathname.split("/")[3] ?? "";
    const bytes = inlineImage
      ? pngBytes
      : legacy
        ? legacyTextBytes
        : assetBytes(attachmentId);
    const mime = inlineImage ? "image/png" : legacy ? "text/plain" : assetMime(attachmentId);
    const filename = legacy
      ? url.searchParams.get("path")?.split("/").pop() ?? "attachment"
      : attachmentId === "review-large-text"
        ? "큰_텍스트.txt"
        : attachmentId + ".bin";
    const disposition = attachmentResponseHeaders(mime, bytes, filename, url.searchParams.get("download") === "true");

    if (request.method() === "HEAD") {
      record.responseHeaders = disposition;
      return fulfill({ status: 200, headers: record.responseHeaders });
    }
    if (range !== null) {
      const parsed = range.match(/^bytes=(\d+)-(\d+)$/);
      if (!parsed) return fulfill({ status: 416, body: "" });
      const start = Number(parsed[1]);
      const end = Math.min(Number(parsed[2]), bytes.byteLength - 1);
      const body = bytes.subarray(start, end + 1);
      record.body = Buffer.from(body);
      record.responseHeaders = attachmentResponseHeaders(mime, body, filename, url.searchParams.get("download") === "true", {
        "content-range": "bytes " + start + "-" + end + "/" + bytes.byteLength,
      });
      return fulfill({
        status: 206,
        headers: record.responseHeaders,
        body,
      });
    }
    record.body = Buffer.from(bytes);
    record.responseHeaders = disposition;
    return fulfill({
      status: 200,
      headers: record.responseHeaders,
      body: bytes,
    });
  });
  await page.route("**/api/auth/config", route => route.fulfill({
    json: { authEnabled: true, devModeEnabled: false },
  }));
  await page.route("**/api/auth/status", route => route.fulfill({
    json: { authenticated: true, user: { email: "qa@example.test", name: "QA", isAdmin: true } },
  }));
  await page.route("https://images.example/ordinary.png", route => route.fulfill({
    status: 200,
    headers: responseHeaders("image/png", pngBytes),
    body: pngBytes,
  }));
  await page.route("**/__review-attachment/missing.png", route => route.fulfill({
    status: 404,
    headers: { "content-type": "text/plain", "content-length": "0" },
    body: "",
  }));
  return requests;
}

export async function installOrdinaryChatRoutes(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "light");
    localStorage.setItem("ls.webglGlass", "0");
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => ({
        update: async () => undefined,
        active: null,
        installing: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(navigator.serviceWorker, "controller", {
      configurable: true,
      get: () => null,
    });
  });
  await installV3VisualQaRoutes(page, { unifiedFolderView: true });
  const sends: Record<string, unknown>[] = [];
  await page.route("**/api/attachments/sessions?*", route => route.fulfill({
    json: { path: "/fixture/메모.pdf" },
  }));
  await page.route(/\/api\/sessions\/[^/]+\/intervene$/, route => {
    sends.push(route.request().postDataJSON());
    return route.fulfill({ json: { delivered: true } });
  });
  return { sends };
}

export async function openAttachmentSample(page: Page, width: number, theme: "light" | "dark") {
  await page.setViewportSize({ width, height: 1000 });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem("soul-dashboard-theme", selectedTheme);
    localStorage.setItem("ls.webglGlass", "0");
  }, theme);
  await page.goto("/dialogues?sample=chat-attachments");
  const sample = page.getByTestId("dialogue-sample");
  await expect(sample).toBeVisible();
  await expect(sample.getByRole("region", { name: "실제 메시지 첨부 연결" })).toBeVisible();
  return sample;
}
