interface ExtractRequest {
  type: "SOULSTREAM_EXTRACT_PAGE";
  selectionText?: string;
  includeBody?: boolean;
  bodyCharLimit?: number;
}

interface ExtractResponse {
  ok: boolean;
  page?: {
    url: string;
    title: string;
    selectionText: string;
    metaDescription: string;
    bodyText: string;
    bodyTruncated: boolean;
    bodyCharLimit: number;
    extractionStatus: "complete" | "partial";
  };
  error?: string;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isExtractRequest(message)) return false;
  try {
    sendResponse({ ok: true, page: extractPage(message) } satisfies ExtractResponse);
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Page extraction failed",
    } satisfies ExtractResponse);
  }
  return true;
});

function isExtractRequest(message: unknown): message is ExtractRequest {
  return typeof message === "object"
    && message !== null
    && (message as { type?: unknown }).type === "SOULSTREAM_EXTRACT_PAGE";
}

function extractPage(request: ExtractRequest): ExtractResponse["page"] {
  const bodyLimit = normalizeLimit(request.bodyCharLimit);
  const selectionText = normalizeText(request.selectionText) || normalizeText(window.getSelection()?.toString());
  const body = request.includeBody === false ? "" : extractBodyCandidate();
  const truncatedBody = truncate(body, bodyLimit);
  const metaDescription = firstMetaContent([
    "meta[name='description']",
    "meta[property='og:description']",
    "meta[name='twitter:description']",
  ]);

  return {
    url: document.location.href,
    title: normalizeText(document.title) || firstMetaContent(["meta[property='og:title']"]),
    selectionText,
    metaDescription,
    bodyText: truncatedBody.text,
    bodyTruncated: truncatedBody.truncated,
    bodyCharLimit: bodyLimit,
    extractionStatus: body || selectionText || metaDescription ? "complete" : "partial",
  };
}

function extractBodyCandidate(): string {
  const root = document.querySelector("article")
    ?? document.querySelector("main")
    ?? document.querySelector("[role='main']")
    ?? document.body;
  if (!root) return "";

  const clone = root.cloneNode(true);
  if (!(clone instanceof HTMLElement)) return normalizeText(root.textContent);

  clone.querySelectorAll("script, style, noscript, nav, footer, header, aside, iframe").forEach((node) => node.remove());
  return normalizeText(clone.innerText || clone.textContent);
}

function firstMetaContent(selectors: string[]): string {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const content = node instanceof HTMLMetaElement ? node.content : "";
    if (content.trim()) return normalizeText(content);
  }
  return "";
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 12_000;
  if (parsed < 0) return 0;
  if (parsed > 50_000) return 50_000;
  return Math.floor(parsed);
}

function truncate(value: string, limit: number): { text: string; truncated: boolean } {
  if (limit <= 0) return { text: "", truncated: value.length > 0 };
  if (value.length <= limit) return { text: value, truncated: false };
  return { text: value.slice(0, limit), truncated: true };
}
