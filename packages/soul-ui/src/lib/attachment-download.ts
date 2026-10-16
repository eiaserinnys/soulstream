export class AttachmentDownloadError extends Error {
  readonly code = "ATTACHMENT_DOWNLOAD_UNAVAILABLE";

  constructor(readonly status: number | null = null) {
    super("Original attachment download is unavailable");
    this.name = "AttachmentDownloadError";
  }
}

export async function downloadAttachmentOriginal(input: {
  url: string;
  filename: string;
  signal?: AbortSignal;
}): Promise<void> {
  const target = validatedInternalAttachmentUrl(input.url);
  target.url.searchParams.set("download", "true");
  const path = `${target.url.pathname}${target.url.search}`;

  if (target.kind === "asset") {
    let response: Response;
    try {
      response = await fetch(path, {
        method: "HEAD",
        credentials: "same-origin",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new AttachmentDownloadError(0);
    }
    if (!response.ok) throw new AttachmentDownloadError(response.status);
  }

  startDownload(path, input.filename);
}

export function downloadLocalAttachmentOriginal(file: File): void {
  const objectUrl = URL.createObjectURL(file);
  try {
    startDownload(objectUrl, file.name);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

type DownloadTarget = { kind: "asset" | "legacy"; url: URL };

function validatedInternalAttachmentUrl(value: string): DownloadTarget {
  const origin = currentOrigin();
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    throw new AttachmentDownloadError();
  }
  if (url.origin !== origin || url.username || url.password || url.hash) {
    throw new AttachmentDownloadError();
  }

  const allowed = url.pathname === "/api/attachments/files"
    ? ["nodeId", "path", "context_type", "context_id", "download"]
    : ["context_type", "context_id", "download"];
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key))) {
    throw new AttachmentDownloadError();
  }
  validateReadContext(url);

  if (url.pathname === "/api/attachments/files") {
    if (!nonEmptyParam(url, "nodeId") || !nonEmptyParam(url, "path")) {
      throw new AttachmentDownloadError();
    }
    return { kind: "legacy", url };
  }
  if (/^\/api\/attachments\/[^/]+\/content$/.test(url.pathname)) {
    return { kind: "asset", url };
  }
  throw new AttachmentDownloadError();
}

function validateReadContext(url: URL): void {
  const type = url.searchParams.get("context_type");
  const id = url.searchParams.get("context_id");
  if (type === "owner" && id === null) return;
  if ((type === "session" || type === "card" || type === "page" || type === "board_item")
      && id !== null && id.length > 0) return;
  throw new AttachmentDownloadError();
}

function nonEmptyParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  return value !== null && value.length > 0 ? value : null;
}

function currentOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}

function startDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}
