import { adminTranslation } from "../components/config/admin-translation";
import type { useTranslation } from "react-i18next";
type Translate = ReturnType<typeof useTranslation>["t"];
import type { CardItemEvidence } from "@seosoyoung/soul-ui/cards/card-types";
import { attachmentContentUrl, type ChatAttachmentItem } from "@seosoyoung/soul-ui/lib/chat-attachment-model";
import type { AttachmentReadContext } from "./card-attachment-selection";

export type AttachmentAssetLoadInput = {
  attachmentId: string;
  context: AttachmentReadContext;
  key: string;
  label: string;
};

export type AttachmentPlaceholderReference = {
  attachmentId?: string;
  context: AttachmentReadContext;
  key: string;
  label: string;
  item?: Pick<ChatAttachmentItem, "name">;
};

export type AttachmentLoadResult = {
  item: ChatAttachmentItem;
  status?: { message: string; retryable?: boolean };
};


type AttachmentDescriptor = NonNullable<CardItemEvidence["descriptor"]>;

export async function loadAttachmentAsset(
  reference: AttachmentAssetLoadInput,
  signal: AbortSignal,
  t: Translate = adminTranslation(),
): Promise<AttachmentLoadResult> {
  const metadataUrl = `/api/attachments/${encodeURIComponent(reference.attachmentId)}?${attachmentContextQuery(reference.context)}`;
  let response: Response;
  try {
    response = await fetch(metadataUrl, { credentials: "same-origin", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return failedReference(reference,undefined,undefined,t);
  }
  if (!response.ok) return failedReference(reference,response.status,undefined,t);
  const body: unknown = await response.json().catch(() => null);
  if (!isMetadataResponse(body, reference.attachmentId)) {
    return { item: unavailableItem(reference, "unavailable") };
  }
  if (body.upload_status !== "committed") {
    return { item: unavailableItem(reference, "unavailable") };
  }

  const descriptor = body.descriptor;
  const contentUrl = attachmentContentUrl(reference.attachmentId, reference.context);
  return {
    item: {
      key: reference.key,
      name: descriptor.name,
      mimeType: descriptor.mime_type,
      byteSize: descriptor.byte_size,
      previewKind: descriptor.preview_kind,
      availability: "ready",
      previewUrl: descriptor.preview_kind === "info" ? null : contentUrl,
      originalUrl: attachmentContentUrl(reference.attachmentId, reference.context, true),
      legacySources: [],
      source: {
        kind: "asset",
        attachmentId: reference.attachmentId,
        context: reference.context,
      },
    },
  };
}

export function failedReference(
  reference: AttachmentPlaceholderReference,
  status?: number,
  previewKind: "image" | "info" = "info",
  t: Translate = adminTranslation(),
): AttachmentLoadResult {
  const retryable = status === undefined || (status >= 500 && status < 600);
  return {
    item: unavailableItem(reference, status === 404 ? "missing" : "unavailable", previewKind),
    status: {
      message: retryable
        ? t("cards.attachmentLoadError")
        : status === 401 || status === 403
          ? t("cards.attachmentForbidden")
          : status === 404
            ? t("cards.attachmentMissing")
            : t("cards.attachmentUnavailable"),
      retryable,
    },
  };
}

export function unavailableItem(
  reference: AttachmentPlaceholderReference,
  availability: "missing" | "unavailable",
  previewKind: "image" | "info" = "info",
): ChatAttachmentItem {
  return {
    key: reference.key,
    name: reference.item?.name ?? (reference.label || null),
    mimeType: null,
    byteSize: null,
    previewKind,
    availability,
    previewUrl: null,
    originalUrl: null,
    legacySources: [],
    source: {
      kind: "unavailable",
      ...(reference.attachmentId ? { attachmentId: reference.attachmentId } : {}),
      context: reference.context,
    },
  };
}

export function attachmentContextQuery(context: AttachmentReadContext): string {
  const params = new URLSearchParams({ context_type: context.type });
  if (context.type !== "owner") params.set("context_id", context.id);
  return params.toString();
}

export function isMetadataResponse(
  value: unknown,
  attachmentId: string,
): value is { descriptor: AttachmentDescriptor; upload_status: "pending" | "committed" } {
  if (typeof value !== "object" || value === null || !("descriptor" in value) || !("upload_status" in value)) {
    return false;
  }
  const descriptor = value.descriptor;
  return typeof descriptor === "object" && descriptor !== null
    && "attachment_id" in descriptor && descriptor.attachment_id === attachmentId
    && "name" in descriptor && typeof descriptor.name === "string"
    && "mime_type" in descriptor && typeof descriptor.mime_type === "string"
    && "byte_size" in descriptor && typeof descriptor.byte_size === "number"
    && "preview_kind" in descriptor
    && (descriptor.preview_kind === "image" || descriptor.preview_kind === "text" || descriptor.preview_kind === "info")
    && (value.upload_status === "pending" || value.upload_status === "committed");
}
