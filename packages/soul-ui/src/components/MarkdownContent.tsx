import { useCallback, useEffect, useMemo, useRef, useState, type HTMLAttributes } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import {
  defaultAnchorClass,
  userBubbleAnchorClass,
  createAnchorComponent,
  markdownBlock,
  components,
  compactComponents,
  userBubbleComponents,
  compactUserBubbleComponents,
  createCopyableCodeBlock,
  createCopyableBlockquote,
} from "./markdown-components";
import { MarkdownImage } from "./MarkdownImage";
import { ChatImageAttachments, ChatImageViewer } from "./chat/ChatImageAttachments";
import type { AttachmentReadContext } from "@soulstream/wire-schema/attachments";
import type { ChatAttachmentItem } from "../lib/chat-attachment-model";
import {
  buildStructuredChatImageItems,
  createChatMarkdownImageModel,
  createChatMarkdownImageRemarkPlugin,
  contextualizeChatMarkdownImageSrc,
  type ChatImageMetadata,
  type ChatImageRole,
} from "../lib/chat-markdown-images";

interface MarkdownContentProps {
  onImageClick?(src:string,alt:string):void;
  content: string;
  compact?: boolean;
  linkTone?: "default" | "onUserBubble";
  sourceLinkComponent?: NonNullable<Components["a"]>;
  enableBlockquoteCopy?: boolean;
  codeBlockLayout?: "bounded" | "document";
  chatImages?: {
    role: ChatImageRole;
    layout?: "inline" | "gallery";
    attachmentPaths?: readonly string[];
    nodeId?: string;
    representedAttachments?: readonly ChatAttachmentItem[];
    readContext?: AttachmentReadContext;
  };
}

export function MarkdownContent({
  content,
  onImageClick,
  compact = false,
  linkTone = "default",
  sourceLinkComponent,
  enableBlockquoteCopy = false,
  codeBlockLayout = "bounded",
  chatImages,
}: MarkdownContentProps) {
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [metadataByImage, setMetadataByImage] = useState<Record<string, ChatImageMetadata>>({});
  const viewerTriggerRef = useRef<HTMLElement | null>(null);
  const viewerWasOpenRef = useRef(false);
  const attachments = useMemo(
    () => buildStructuredChatImageItems(
      chatImages?.attachmentPaths,
      chatImages?.nodeId,
      chatImages?.readContext,
      chatImages?.representedAttachments,
    ),
    [chatImages?.attachmentPaths, chatImages?.nodeId, chatImages?.readContext, chatImages?.representedAttachments],
  );
  const imageModel = useMemo(
    () => chatImages && !onImageClick
      ? createChatMarkdownImageModel(
        chatImages.role,
        attachments,
        chatImages.representedAttachments,
        chatImages.readContext,
      )
      : null,
    [attachments, chatImages?.readContext, chatImages?.representedAttachments, chatImages?.role, onImageClick],
  );
  const openViewer = useCallback((index: number, trigger: HTMLElement) => {
    viewerTriggerRef.current = trigger;
    setViewerIndex(index);
  }, []);
  const onViewerOpenChange = useCallback((open: boolean) => {
    if (!open) setViewerIndex(null);
  }, []);
  const onViewerIndexChange = useCallback((index: number) => setViewerIndex(index), []);
  const onImageMetadata = useCallback((key: string, metadata: ChatImageMetadata) => {
    setMetadataByImage(current => current[key] ? current : { ...current, [key]: metadata });
  }, []);

  useEffect(() => {
    if (viewerWasOpenRef.current && viewerIndex === null) {
      const trigger = viewerTriggerRef.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    }
    viewerWasOpenRef.current = viewerIndex !== null;
  }, [viewerIndex]);

  const remarkPlugins = useMemo(
    () => imageModel
      ? [remarkGfm, remarkBreaks, createChatMarkdownImageRemarkPlugin(imageModel, chatImages?.layout !== "inline")]
      : [remarkGfm, remarkBreaks],
    [imageModel, chatImages?.layout],
  );
  const selectedComponents = useMemo(() => {
    const baseComponents = linkTone === "onUserBubble"
      ? compact
        ? compactUserBubbleComponents
        : userBubbleComponents
      : compact
        ? compactComponents
        : components;
    const layoutComponents = { ...baseComponents, pre: createCopyableCodeBlock(compact, codeBlockLayout) };
    const imageComponents = onImageClick || chatImages?.readContext
      ? {
        ...layoutComponents,
        img: ({ src, alt }: { src?: string; alt?: string }) => {
          const imageSrc = src ? contextualizeChatMarkdownImageSrc(src, chatImages?.readContext) : src;
          return (
            <MarkdownImage
              src={imageSrc}
              alt={alt ?? ""}
              onOpen={onImageClick ? (_openedSrc, openedAlt) => onImageClick(src ?? _openedSrc, openedAlt) : undefined}
            />
          );
        },
      }
      : layoutComponents;
    const chatComponents = imageModel ? {
      ...imageComponents,
      div: ({ children, node, ...props }: HTMLAttributes<HTMLDivElement> & { node?: unknown }) => {
        void node;
        const runIdValue = (props as Record<string, unknown>)["data-chat-image-run"];
        const runId = typeof runIdValue === "string" ? runIdValue : undefined;
        const run = runId ? imageModel.runs.get(runId) : undefined;
        if (run) {
          return (
            <ChatImageAttachments
              gallery={imageModel.gallery}
              galleryIndexes={run.galleryIndexes}
              role={imageModel.role}
              runId={run.id}
              metadataByImage={metadataByImage}
              onMetadata={onImageMetadata}
              onOpen={openViewer}
            />
          );
        }
        return <div {...props} {...markdownBlock}>{children}</div>;
      },
    } : imageComponents;
    const blockquoteComponents = enableBlockquoteCopy
      ? { ...chatComponents, blockquote: createCopyableBlockquote(compact) }
      : chatComponents;
    return sourceLinkComponent
      ? { ...blockquoteComponents, a: sourceLinkComponent }
      : chatImages?.readContext
        ? { ...blockquoteComponents, a: createAnchorComponent(linkTone === "onUserBubble" ? userBubbleAnchorClass : defaultAnchorClass, chatImages.readContext) }
        : blockquoteComponents;
  }, [chatImages?.readContext, codeBlockLayout, compact, enableBlockquoteCopy, imageModel, linkTone, metadataByImage, onImageClick, onImageMetadata, openViewer, sourceLinkComponent]);

  const viewerCanOpen = imageModel !== null && viewerIndex !== null && imageModel.gallery[viewerIndex] !== undefined;

  // 감싸는 요소 없이 블록을 그대로 낸다. 공용 줄바꿈 표식은 블록마다 붙어 있어
  // (markdownBlock) 마크다운 앞뒤에 형제가 있어도 first:/last: 판정이 main과 같다.
  return (
    <>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeHighlight]}
        components={selectedComponents}
      >
        {content}
      </ReactMarkdown>
      {imageModel && viewerCanOpen && (
        <ChatImageViewer
          gallery={imageModel.gallery}
          index={viewerIndex!}
          metadataByImage={metadataByImage}
          onOpenChange={onViewerOpenChange}
          onIndexChange={onViewerIndexChange}
        />
      )}
    </>
  );
}
