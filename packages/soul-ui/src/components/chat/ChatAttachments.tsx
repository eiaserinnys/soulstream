import { useId } from "react";
import { FileAttachmentPreview } from "../FileAttachmentPreview";
import { ChatImageAttachments } from "./ChatImageAttachments";
import {
  isSafeRasterPreviewMimeType,
  type ChatAttachmentItem,
} from "../../lib/chat-attachment-model";
import type { ChatImageItem, ChatImageMetadata, ChatImageRole } from "../../lib/chat-markdown-images";

const EMPTY_METADATA: Record<string, ChatImageMetadata> = {};
const IGNORE_METADATA = () => {};

export function ChatAttachments({
  items,
  role,
  onOpen,
}: {
  items: ChatAttachmentItem[];
  role: ChatImageRole;
  onOpen(index: number, trigger: HTMLElement): void;
}) {
  const runId = useId();
  const displayItems = uniqueItems(items);
  const imageIndexes = displayItems
    .filter(({ item }) => isImageGridItem(item))
    .map(({ index }) => index);
  const gallery = items.map(toChatImageItem);
  const fileItems = displayItems.filter(({ item }) => !isImageGridItem(item));

  return (
    <>
      <ChatImageAttachments
        gallery={gallery}
        galleryIndexes={imageIndexes}
        role={role}
        runId={runId}
        metadataByImage={EMPTY_METADATA}
        onMetadata={IGNORE_METADATA}
        onOpen={onOpen}
        openFailedImage
      />
      {fileItems.length > 0 && (
        <div
          className="chat-image-run flex flex-col gap-2"
          data-chat-image-role={role}
          data-chat-attachment-rows
        >
          {fileItems.map(({ item, index }) => (
            <FileAttachmentPreview
              key={item.key}
              variant="row"
              item={item}
              index={index}
              onOpen={(_opened, trigger) => onOpen(index, trigger)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function isImageGridItem(item: ChatAttachmentItem): boolean {
  return item.previewKind === "image"
    && item.availability === "ready"
    && item.previewUrl !== null
    && isSafeRasterPreviewMimeType(item.mimeType);
}

function uniqueItems(items: ChatAttachmentItem[]): Array<{ item: ChatAttachmentItem; index: number }> {
  const keys = new Set<string>();
  return items.flatMap((item, index) => {
    if (keys.has(item.key)) return [];
    keys.add(item.key);
    return [{ item, index }];
  });
}

function toChatImageItem(item: ChatAttachmentItem): ChatImageItem {
  return {
    id: item.key,
    src: item.previewUrl ?? "",
    alt: item.name ?? "",
    ...(item.name === null ? {} : { filename: item.name }),
    ...(item.mimeType === null ? {} : { mimeType: item.mimeType }),
    ...(item.byteSize === null ? {} : { bytes: item.byteSize }),
  };
}
