import { expect, test, type Download, type Page, type Request, type Response } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  installChatAttachmentReadRoutes,
  installOrdinaryChatRoutes,
  largeTextBytes,
  largeTextSize,
  legacyTextBytes,
  openAttachmentSample,
} from "./chat-attachments-fixtures";
import { chatUiSession, installChatUiRoutes, openChatUi } from "./chat-ui-fixtures";

const output = path.resolve("../../../.local/artifacts/20261017-b2-16-attachment-chat");
mkdirSync(output, { recursive: true });
const downloadTracePath = path.join(output, "download-http-trace.ndjson");

type DownloadHttpTrace = {
  method: string;
  url: string;
  requestStartedAt: number;
  responseCompletedAt: number;
  requestHeaders: { cookiePresent: boolean; authorizationPresent: boolean; range: string | null };
  status: number;
  responseHeaders: Record<string, string>;
  responseBytes: number;
};

type DownloadVerification = {
  issue: string | null;
  response: DownloadHttpTrace | null;
};

function readDownloadHttpTrace(): DownloadHttpTrace[] {
  try {
    return readFileSync(downloadTracePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as DownloadHttpTrace);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function expectedContentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function capture(page: Page, name: string, fullPage = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: path.join(output, name + ".png"),
    animations: "disabled",
    fullPage,
  });
}

async function verifyDownload(
  page: Page,
  buttonName: string,
  expected: Buffer,
  expectedFilename: string,
  requests: Awaited<ReturnType<typeof installChatAttachmentReadRoutes>>,
): Promise<DownloadVerification> {
  const requestStart = requests.length;
  const downloadTraceStart = readDownloadHttpTrace().length;
  const pageEvents: Array<{ name: string; at: number }> = [];
  const isAttachmentDownload = (url: string) => {
    const parsed = new URL(url);
    return parsed.pathname.startsWith("/api/attachments/")
      && parsed.searchParams.get("download") === "true";
  };
  const onRequest = (request: Request) => {
    if (isAttachmentDownload(request.url())) pageEvents.push({ name: `request:${request.method()}`, at: Date.now() });
  };
  const onResponse = (response: Response) => {
    if (isAttachmentDownload(response.url())) pageEvents.push({ name: `response:${response.status()}`, at: Date.now() });
  };
  const onDownload = (download: Download) => {
    if (isAttachmentDownload(download.url())) pageEvents.push({ name: `download:${download.suggestedFilename()}`, at: Date.now() });
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("download", onDownload);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: buttonName, exact: true }).click(),
  ]);
  const filename = download.suggestedFilename();
  expect(filename).toBe(expectedFilename);
  let savedPath: string | null;
  try {
    savedPath = await download.path();
  } catch (error) {
    const failure = await download.failure();
    const httpRequests = readDownloadHttpTrace().slice(downloadTraceStart);
    const relevantRequests = requests.slice(requestStart).map(request => ({
      method: request.method,
      range: request.range,
      responseStatus: request.responseStatus,
      cookieHeaderPresent: request.cookieHeaderPresent,
      authorizationHeaderPresent: request.authorizationHeaderPresent,
      headers: request.responseHeaders,
    }));
    console.info("chat attachment download trace", JSON.stringify({
      filename,
      events: httpRequests.flatMap(request => [
        { name: `request:${request.method}`, at: request.requestStartedAt },
        { name: `response:${request.status}`, at: request.responseCompletedAt },
      ]).concat(pageEvents).sort((left, right) => left.at - right.at).map(event => event.name),
      httpRequests,
      requests: relevantRequests,
      failure,
      pathError: String(error),
    }));
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("download", onDownload);
    return { issue: `${filename}: ${failure ?? String(error)}`, response: httpRequests.at(-1) ?? null };
  }
  page.off("request", onRequest);
  page.off("response", onResponse);
  page.off("download", onDownload);
  expect(savedPath).not.toBeNull();
  if (savedPath === null) throw new Error("Playwright download completed without a saved file path");
  const bytes = readFileSync(savedPath);
  expect(bytes.byteLength).toBe(expected.byteLength);
  const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  expect(sha256(bytes)).toBe(sha256(expected));
  const httpRequests = readDownloadHttpTrace().slice(downloadTraceStart);
  const downloadResponse = httpRequests.find(request => request.method === "GET"
    && new URL(request.url, "http://attachment-fixture.local").searchParams.get("download") === "true") ?? null;
  expect(downloadResponse).not.toBeNull();
  expect(downloadResponse?.status).toBe(200);
  expect(downloadResponse?.responseBytes).toBe(expected.byteLength);
  expect(downloadResponse?.responseHeaders["content-type"]).toBe("text/plain");
  expect(downloadResponse?.responseHeaders["content-length"]).toBe(String(expected.byteLength));
  expect(downloadResponse?.responseHeaders["content-disposition"]).toBe(expectedContentDisposition(expectedFilename));
  writeFileSync(path.join(output, filename), bytes);
  const timeline = httpRequests.flatMap(request => [
    { name: `request:${request.method}`, at: request.requestStartedAt },
    { name: `response:${request.status}`, at: request.responseCompletedAt },
  ]).concat(pageEvents).concat({ name: `saved:${filename}`, at: Date.now() })
    .sort((left, right) => left.at - right.at);
  console.info("chat attachment download trace", JSON.stringify({
    filename,
    events: timeline.map(event => event.name),
    httpRequests,
    pageRequests: requests.slice(requestStart).map(request => ({ method: request.method, range: request.range, responseStatus: request.responseStatus })),
    savedBytes: bytes.byteLength,
    sha256: sha256(bytes),
  }));
  return { issue: null, response: downloadResponse };
}

test("connected sample deduplicates Markdown images and supports mixed attachment navigation, preview and save", async ({ page }) => {
  const errors: string[] = [];
  const downloadIssues: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const requests = await installChatAttachmentReadRoutes(page);
  const sample = await openAttachmentSample(page, 1440, "light");
  const userRow = sample.locator('[data-tree-node-id="connected-default-user"]');

  await expect(userRow.locator('img[src*="/api/attachments/review-user-image/content"]')).toHaveCount(1);
  await expect(userRow.locator('img[src="https://images.example/ordinary.png"]')).toHaveCount(1);
  await expect(userRow.locator("[data-chat-attachment-rows] [data-chat-attachment-index]")).toHaveCount(2);
  await expect(sample.locator('[data-tree-node-id="connected-textless-output"] [data-chat-attachment-rows]')).toBeVisible();
  await expect(sample.locator('[data-tree-node-id="connected-manuscript-user"] [data-chat-image-role="user"]')).toBeVisible();
  await expect(sample.locator('[data-tree-node-id="connected-manuscript-output"] [data-chat-attachment-rows]')).toBeVisible();

  const richUi = sample.locator('[data-tree-node-id="connected-rich-output"] [data-slot="chat-ui"]');
  await expect(richUi).toBeVisible();
  await richUi.getByRole("checkbox", { name: "연간 결제 (20% 할인)", exact: true }).check();
  await expect(richUi).toContainText("185,600원/월");
  await capture(page, "sample-wide-light");

  const draft = sample.locator('textarea[data-slot="chat-input-body"]').first();
  await draft.fill("모달을 닫아도 유지할 초안");
  const imageTrigger = userRow.getByRole("button", { name: "이미지 확대: 사용자 이미지.png", exact: true });
  await imageTrigger.scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await imageTrigger.click();
  const dialog = page.locator(".chat-image-viewer-popup");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "사용자 이미지.png", exact: true })).toBeVisible();
  await capture(page, "sample-wide-light-modal");

  await dialog.getByRole("button", { name: "다음 첨부", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "누락 이미지.png", exact: true })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("이미지를 불러오지 못했습니다.");
  await dialog.getByRole("button", { name: "다음 첨부", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "자료.zip", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "다음 첨부", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "참고.txt", exact: true })).toBeVisible();
  await expect(dialog.locator("pre")).toContainText("Legacy note 1234567");
  const legacyRequests = requests.filter(request => new URL(request.url).pathname === "/api/attachments/files");
  const legacyPreview = legacyRequests.find(request => {
    const url = new URL(request.url);
    return url.searchParams.get("path") === "/incoming/참고.txt"
      && url.searchParams.get("context_type") === "session"
      && url.searchParams.get("context_id") === "attachment-review-connected"
      && request.range === "bytes=0-19";
  });
  expect(legacyPreview).toBeDefined();
  expect(legacyPreview?.responseHeaders?.["content-type"]).toBe("text/plain");
  expect(legacyPreview?.responseHeaders?.["content-length"]).toBe("20");
  expect(legacyPreview?.responseHeaders?.["content-range"]).toBe("bytes 0-19/20");
  await capture(page, "sample-wide-light-modal-legacy");
  const legacyDownload = await verifyDownload(page, "원본 저장", legacyTextBytes, "참고.txt", requests);
  if (legacyDownload.issue !== null) downloadIssues.push(legacyDownload.issue);
  const legacyFullResponse = legacyDownload.response;

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(imageTrigger).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  await expect(draft).toHaveValue("모달을 닫아도 유지할 초안");

  const largeRow = sample.locator('[data-tree-node-id="connected-large-text"]');
  const largeButton = largeRow.getByRole("button", { name: "큰_텍스트.txt", exact: true });
  await largeButton.click();
  const largeDialog = page.locator(".chat-image-viewer-popup");
  await expect(largeDialog.locator("pre")).toBeVisible();
  await expect(largeDialog.getByRole("status")).toHaveText("파일이 커서 앞부분만 표시합니다.");
  const preview = largeDialog.locator("pre");
  expect(await preview.evaluate(element => element.textContent?.length)).toBe(1_048_576);
  expect((await preview.textContent())?.startsWith("A".repeat(64))).toBe(true);
  const largeDownload = await verifyDownload(page, "원본 저장", largeTextBytes, "큰_텍스트.txt", requests);
  if (largeDownload.issue !== null) downloadIssues.push(largeDownload.issue);
  const largeRange = requests.find(request => request.url.includes("/api/attachments/review-large-text/content")
    && request.range === "bytes=0-1048575");
  expect(largeRange).toBeDefined();
  expect(largeRange?.responseHeaders?.["content-type"]).toBe("text/plain");
  expect(largeRange?.responseHeaders?.["content-length"]).toBe("1048576");
  expect(largeRange?.responseHeaders?.["content-range"]).toBe("bytes 0-1048575/1048586");
  expect(requests.some(request => request.url.includes("/api/attachments/review-large-text/content")
    && request.method === "HEAD"
    && new URL(request.url).searchParams.get("download") === "true")).toBe(true);
  const largeFullResponse = largeDownload.response;
  expect(largeFullResponse?.method).toBe("GET");
  expect(largeFullResponse?.status).toBe(200);
  expect(largeFullResponse?.responseBytes).toBe(largeTextSize);
  expect(largeFullResponse?.responseHeaders["content-type"]).toBe("text/plain");
  expect(largeFullResponse?.responseHeaders["content-length"]).toBe(String(largeTextSize));
  const legacyResponse = legacyFullResponse;
  expect(legacyResponse?.method).toBe("GET");
  expect(legacyResponse?.status).toBe(200);
  expect(legacyResponse?.responseBytes).toBe(legacyTextBytes.byteLength);
  expect(legacyResponse?.responseHeaders["content-type"]).toBe("text/plain");
  expect(legacyResponse?.responseHeaders["content-length"]).toBe("20");
  expect(legacyResponse?.responseHeaders["content-disposition"])
    .toBe('attachment; filename="__.txt"; filename*=UTF-8\'\'%EC%B0%B8%EA%B3%A0.txt');
  expect(largeFullResponse?.responseHeaders["content-disposition"])
    .toBe('attachment; filename="_____.txt"; filename*=UTF-8\'\'%ED%81%B0_%ED%85%8D%EC%8A%A4%ED%8A%B8.txt');
  await page.keyboard.press("Escape");
  await expect(largeDialog).toBeHidden();
  expect(errors).toEqual([]);
  expect(downloadIssues).toEqual([]);
});

test("connected attachment failures map correctly, retry, and keep another session's read context", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const requests = await installChatAttachmentReadRoutes(page);
  const sample = await openAttachmentSample(page, 390, "dark");
  await capture(page, "sample-narrow-dark");

  for (const [eventId, message] of [
    [401, "로그인 후 첨부를 확인할 수 있습니다."],
    [403, "첨부를 읽을 권한이 없습니다."],
    [404, "첨부를 찾을 수 없거나 읽을 수 없습니다."],
  ] as const) {
    const row = sample.locator('[data-tree-node-id="connected-error-' + eventId + '"]');
    await expect(row.getByRole("status")).toHaveText(message);
    await expect(row.getByRole("button", { name: "다시 시도", exact: true })).toHaveCount(0);
  }

  const retryRow = sample.locator('[data-tree-node-id="connected-temporary-failure"]');
  await expect(retryRow.getByRole("status")).toHaveText("첨부 정보를 불러오지 못했습니다. 다시 시도해 주세요.");
  const initial503Requests = Number(await page.locator("html").getAttribute("data-review-event-503-requests"));
  expect(initial503Requests).toBeGreaterThan(0);
  await retryRow.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect.poll(() => page.locator("html").getAttribute("data-review-event-503-requests"))
    .toBe(String(initial503Requests + 1));
  await expect(retryRow.getByRole("status")).toHaveText("첨부 정보를 불러오지 못했습니다. 다시 시도해 주세요.");

  const overlayRow = sample.locator('[data-tree-node-id="connected-overlay-output"]');
  await overlayRow.getByRole("button", { name: "선택 카드 자료.txt", exact: true }).click();
  const dialog = page.locator(".chat-image-viewer-popup");
  await expect(dialog.locator("pre")).toBeVisible();
  await expect(dialog.locator("pre")).toContainText("A");
  const overlayRequest = requests.find(request => request.url.includes("/api/attachments/review-overlay-file/content")
    && request.range !== null);
  expect(overlayRequest).toBeDefined();
  const overlayUrl = new URL(overlayRequest!.url);
  expect(overlayUrl.searchParams.get("context_type")).toBe("session");
  expect(overlayUrl.searchParams.get("context_id")).toBe("attachment-review-overlay");
  await capture(page, "sample-narrow-dark-modal");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test("actual ordinary chat sends an attachment without text", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  const h = await installOrdinaryChatRoutes(page);
  await page.goto("/?session=run-alpha-1");
  const root = page.locator('[data-slot="chat-root"]').filter({ visible: true }).first();
  await expect(root).toBeVisible();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await root.locator('input[type="file"]').setInputFiles({
    name: "실제_첨부_검수.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("attachment only"),
  });
  await expect(root.getByText("실제_첨부_검수.pdf", { exact: true })).toBeVisible();
  await expect(root.getByTestId("send-button")).toBeEnabled();
  await capture(page, "actual-ordinary-with-attachment", false);
  await root.getByTestId("send-button").click();
  await expect.poll(() => h.sends.length).toBe(1);
  expect(JSON.stringify(h.sends[0])).toContain("/fixture/메모.pdf");
  await expect(root.locator('textarea[data-slot="chat-input-body"]')).toHaveValue("");
  await expect(root.getByText("실제_첨부_검수.pdf", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("actual PAS chat sends an attachment without text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const h = await installChatUiRoutes(page, { example: "pas" });
  await page.addInitScript(() => {
    localStorage.setItem("soul-dashboard-theme", "dark");
    localStorage.setItem("ls.webglGlass", "0");
  });
  const root = await openChatUi(page, true);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await root.locator('input[type="file"]').setInputFiles({
    name: "실제_첨부_검수.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("attachment only"),
  });
  await expect(root.getByText("실제_첨부_검수.pdf", { exact: true })).toBeVisible();
  await expect(root.getByTestId("send-button")).toBeEnabled();
  await capture(page, "actual-pas-with-attachment", false);
  await root.getByTestId("send-button").click();
  await expect.poll(() => h.sends.length).toBe(1);
  expect(JSON.stringify(h.sends[0])).toContain("/fixture/메모.pdf");
  await expect(root.locator('textarea[data-slot="chat-input-body"]')).toHaveValue("");
  expect(h.errors).toEqual([]);
  expect(errors).toEqual([]);
  expect(chatUiSession).toBe("run-alpha-2");
});
