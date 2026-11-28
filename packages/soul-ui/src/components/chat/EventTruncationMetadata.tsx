import { useTranslation } from "react-i18next";
import { useMemo, useState } from "react";
import type { EventTruncation } from "@soulstream/wire-schema";
import { projectChatAttachmentItems } from "../../lib/chat-attachment-model";
import { formatFileSize } from "../../lib/format-file-size";
import { AttachmentViewer } from "../AttachmentViewer";
import { ShowFullContentButton } from "./ShowFullContentButton";

export function EventTruncationMetadata({
  truncation,
  sessionId,
  eventId,
}: {
  truncation?: EventTruncation;
  sessionId?: string;
  eventId?: number;
}) {
  const { t } = useTranslation();
  const [viewer, setViewer] = useState<{ trigger: HTMLElement } | null>(null);
  const attachment = truncation?.attachment;
  const items = useMemo(() => {
    if (!attachment || !sessionId) return [];
    return projectChatAttachmentItems({
      event_id: eventId ?? 0,
      items: [{
        kind: "asset",
        descriptor: attachment,
        read_context: { type: "session", id: sessionId },
        legacy_sources: [],
      }],
    });
  }, [attachment, eventId, sessionId]);

  if (!truncation) return null;

  const size = formatFileSize(truncation.original_bytes);
  const canOpen = Boolean(attachment && sessionId);
  const prefix = canOpen ? t("ui.chat.truncatedPrefix", { size }) : undefined;
  const label = attachment === null
    ? t("ui.chat.truncatedArchiveFailed", { size })
    : canOpen
      ? t("ui.chat.openFullText")
      : t("ui.chat.truncatedSize", { size });

  return (
    <>
      <ShowFullContentButton
        loading={false}
        error={null}
        prefix={prefix}
        label={label}
        onClick={canOpen ? (event) => setViewer({ trigger: event.currentTarget }) : undefined}
      />
      <AttachmentViewer
        items={items}
        index={viewer ? 0 : null}
        onIndexChange={() => {}}
        onClose={() => setViewer(null)}
        returnFocus={viewer?.trigger}
      />
    </>
  );
}
