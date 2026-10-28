export type AttachmentLinkContext =
  | { type: "owner" }
  | { type: "session" | "card" | "page" | "board_item"; id: string };

export type InternalLinkTarget =
  | { kind: "session"; sessionId: string; eventId?: string }
  | { kind: "card"; cardId: string }
  | { kind: "document"; documentId: string }
  | { kind: "folder"; folderId: string }
  | { kind: "page"; pageId: string }
  | { kind: "attachment_asset"; attachmentId: string; context: AttachmentLinkContext | null }
  | { kind: "attachment"; nodeId: string; path: string; isImage: boolean };

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const EVENT_ID_PATTERN = /^\d+$/;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function isIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && IDENTIFIER_PATTERN.test(value);
}

function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}

function findAuthorityEnd(href: string, start: number): number {
  let end = start;

  while (end < href.length && href[end] !== "/" && href[end] !== "?" && href[end] !== "#") {
    end += 1;
  }

  return end;
}

function getInternalRemainder(href: string, internalOrigins: readonly string[]): string | null {
  if (href.startsWith("/") && !href.startsWith("//")) {
    return href;
  }

  const scheme = /^(https?):\/\//i.exec(href);
  if (!scheme) {
    return null;
  }

  const authorityStart = scheme[0].length;
  const authorityEnd = findAuthorityEnd(href, authorityStart);
  const authority = href.slice(authorityStart, authorityEnd);
  if (!authority || authority.includes("@")) {
    return null;
  }

  const origin = href.slice(0, authorityEnd).toLowerCase();
  const matchesOrigin = internalOrigins.some((candidate) => normalizeOrigin(candidate) === origin);
  return matchesOrigin ? href.slice(authorityEnd) : null;
}

function parseQuery(query: string): Map<string, string> | null {
  const values = new Map<string, string>();

  for (const part of query.split("&")) {
    const equalsIndex = part.indexOf("=");
    const encodedKey = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
    const encodedValue = equalsIndex === -1 ? "" : part.slice(equalsIndex + 1);

    try {
      const key = decodeURIComponent(encodedKey.replace(/\+/g, " "));
      const value = decodeURIComponent(encodedValue.replace(/\+/g, " "));
      if (!values.has(key)) {
        values.set(key, value);
      }
    } catch {
      return null;
    }
  }

  return values;
}

function isImagePath(path: string): boolean {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const extensionStart = filename.lastIndexOf(".");
  if (extensionStart === -1) {
    return false;
  }

  return IMAGE_EXTENSIONS.has(filename.slice(extensionStart + 1).toLowerCase());
}

function attachmentLinkContext(queryValues: Map<string, string>): AttachmentLinkContext | null | undefined {
  const hasType = queryValues.has("context_type");
  const hasId = queryValues.has("context_id");
  if (!hasType && !hasId) return null;

  const type = queryValues.get("context_type");
  const id = queryValues.get("context_id");
  if (type === "owner" && !hasId) return { type: "owner" };
  if (!id?.trim()) return undefined;
  switch (type) {
    case "session":
    case "card":
    case "page":
    case "board_item":
      return { type, id };
    default:
      return undefined;
  }
}

function attachmentAssetTarget(
  attachmentId: string,
  queryValues: Map<string, string>,
): InternalLinkTarget | null {
  const context = attachmentLinkContext(queryValues);
  if (context === undefined) return null;
  return { kind: "attachment_asset", attachmentId, context };
}

/** href가 이 서버의 내부 주소면 대상을, 아니면 null을 돌려준다. */
export function classifyInternalLink(
  href: string,
  internalOrigins: readonly string[],
): InternalLinkTarget | null {
  const trimmedHref = href.trim();
  if (!trimmedHref) {
    return null;
  }

  const remainder = getInternalRemainder(trimmedHref, internalOrigins);
  if (remainder === null) {
    return null;
  }

  const fragmentIndex = remainder.indexOf("#");
  const withoutFragment = fragmentIndex === -1 ? remainder : remainder.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf("?");
  const path = queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : withoutFragment.slice(queryIndex + 1);
  const queryValues = parseQuery(query);
  if (queryValues === null) {
    return null;
  }

  if (path === "" || path === "/") {
    const sessionId = queryValues.get("session");
    if (sessionId && isIdentifier(sessionId)) {
      const eventId = queryValues.get("event");
      return eventId && EVENT_ID_PATTERN.test(eventId)
        ? { kind: "session", sessionId, eventId }
        : { kind: "session", sessionId };
    }

    const cardId = queryValues.get("card");
    if (cardId && isIdentifier(cardId)) {
      return { kind: "card", cardId };
    }

    const documentId = queryValues.get("document");
    if (documentId && isIdentifier(documentId)) {
      return { kind: "document", documentId };
    }

    const folderId = queryValues.get("folder");
    if (folderId && isIdentifier(folderId)) {
      return { kind: "folder", folderId };
    }

    const pageId = queryValues.get("page");
    if (pageId && isIdentifier(pageId)) {
      return { kind: "page", pageId };
    }

    const attachmentId = queryValues.get("attachment");
    if (attachmentId && isIdentifier(attachmentId)) {
      return attachmentAssetTarget(attachmentId, queryValues);
    }

    return null;
  }

  const documentPrefix = "/api/markdown-documents/";
  if (path.startsWith(documentPrefix)) {
    const encodedDocumentId = path.slice(documentPrefix.length);
    if (!encodedDocumentId || encodedDocumentId.includes("/")) {
      return null;
    }

    try {
      const documentId = decodeURIComponent(encodedDocumentId);
      return isIdentifier(documentId) ? { kind: "document", documentId } : null;
    } catch {
      return null;
    }
  }

  if (path === "/api/attachments/files") {
    const nodeId = queryValues.get("nodeId");
    const attachmentPath = queryValues.get("path");
    if (!nodeId || !isIdentifier(nodeId) || !attachmentPath) {
      return null;
    }

    return {
      kind: "attachment",
      nodeId,
      path: attachmentPath,
      isImage: isImagePath(attachmentPath),
    };
  }

  const attachmentPrefix = "/api/attachments/";
  const contentSuffix = "/content";
  if (path.startsWith(attachmentPrefix) && path.endsWith(contentSuffix)) {
    const encodedAttachmentId = path.slice(attachmentPrefix.length, -contentSuffix.length);
    if (!encodedAttachmentId || encodedAttachmentId.includes("/") || queryValues.get("download") === "true") {
      return null;
    }
    try {
      const attachmentId = decodeURIComponent(encodedAttachmentId);
      if (!attachmentId || attachmentId.includes("/")) return null;
      return attachmentAssetTarget(attachmentId, queryValues);
    } catch {
      return null;
    }
  }

  return null;
}

/** 화면 주소가 있는 대상의 정본 상대 주소. attachment는 null. */
export function internalLinkPath(target: InternalLinkTarget): string | null {
  switch (target.kind) {
    case "session": {
      const event = target.eventId === undefined ? "" : `&event=${encodeURIComponent(target.eventId)}`;
      return `/?session=${encodeURIComponent(target.sessionId)}${event}`;
    }
    case "card":
      return `/?card=${encodeURIComponent(target.cardId)}`;
    case "document":
      return `/?document=${encodeURIComponent(target.documentId)}`;
    case "folder":
      return `/?folder=${encodeURIComponent(target.folderId)}`;
    case "page":
      return `/?page=${encodeURIComponent(target.pageId)}`;
    case "attachment_asset": {
      const params = [`attachment=${encodeURIComponent(target.attachmentId)}`];
      if (target.context) {
        params.push(`context_type=${encodeURIComponent(target.context.type)}`);
        if (target.context.type !== "owner") {
          params.push(`context_id=${encodeURIComponent(target.context.id)}`);
        }
      }
      return `/?${params.join("&")}`;
    }
    case "attachment":
      return null;
  }
}
