/**
 * FileAttachmentPreview - 파일 첨부 미리보기 카드
 *
 * 이미지: object URL 기반 썸네일
 * 비이미지: mime-type 기반 아이콘 + 파일명
 * 업로드 중: 반투명 오버레이 + 스피너
 * 에러: 빨간 오버레이 + 에러 아이콘
 * X 버튼으로 개별 취소
 */

import { useEffect, useState } from "react";
import {Dialog,DialogPopup,DialogTitle} from "./ui/dialog";
import type { ChatAttachmentItem } from "../lib/chat-attachment-model";
import { formatFileSize } from "../lib/format-file-size";

interface LocalFileAttachmentPreviewProps {
  initialImageOpen?: boolean;
  file: File;
  status: "uploading" | "done" | "error";
  onRemove: () => void;
}

export type FileAttachmentPreviewProps =
  | (LocalFileAttachmentPreviewProps & { variant?: "tile" })
  | (LocalFileAttachmentPreviewProps & {
    variant: "chip";
    onOpen: (file: File, trigger: HTMLButtonElement) => void;
  })
  | {
    variant: "row";
    item: ChatAttachmentItem;
    index: number;
    onOpen: (item: ChatAttachmentItem, trigger: HTMLButtonElement) => void;
  };

function getFileTypeIcon(file: File): string {
  const { type } = file;
  if (type === "application/pdf") return "PDF";
  if (type.startsWith("text/")) return "TXT";
  if (
    type === "application/msword" ||
    type.startsWith("application/vnd.openxmlformats-officedocument.wordprocessingml")
  )
    return "DOC";
  if (
    type.startsWith("application/vnd.openxmlformats-officedocument.spreadsheetml") ||
    type === "application/vnd.ms-excel"
  )
    return "XLS";
  if (
    type.startsWith("application/vnd.openxmlformats-officedocument.presentationml") ||
    type === "application/vnd.ms-powerpoint"
  )
    return "PPT";
  if (type === "application/zip" || type === "application/x-zip-compressed") return "ZIP";
  return "FILE";
}

interface ImagePreviewProps {
  initialOpen?: boolean;
  file: File;
}

function ImagePreview({ file, initialOpen = false }: ImagePreviewProps) {
  const [open,setOpen]=useState(initialOpen);
  const [objectUrl,setObjectUrl]=useState<string>();

  useEffect(() => {
    const url=URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <><img
      role="button" tabIndex={0} onClick={()=>setOpen(true)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();setOpen(true);}}}
      src={objectUrl}
      alt={file.name}
      className="w-full h-full object-cover rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
    /><Dialog open={open} onOpenChange={setOpen}><DialogPopup className="image-viewer-popup"><DialogTitle className="sr-only">{file.name}</DialogTitle><img src={objectUrl} alt={file.name} className="max-w-full object-contain"/></DialogPopup></Dialog></>
  );
}

export function FileTypeIcon({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 w-full h-full px-1">
      {/* File icon SVG */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-muted-foreground/60"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="text-xs font-bold text-muted-foreground/60 uppercase tracking-wide">
        {label}
      </span>
    </div>
  );
}

export function FileAttachmentPreview(props: FileAttachmentPreviewProps) {
  if (props.variant === "row") {
    return <RemoteAttachmentRow {...props} />;
  }
  if (props.variant === "chip") {
    return <LocalAttachmentChip {...props} />;
  }

  const { initialImageOpen, file, status, onRemove } = props;
  const isImage = file.type.startsWith("image/");
  const fileTypeLabel = isImage ? "" : getFileTypeIcon(file);

  const truncatedName = file.name.length > 18
    ? file.name.slice(0, 15) + "…"
    : file.name;

  return (
    <div
      className="relative shrink-0 w-20 h-20 rounded border border-border bg-muted overflow-hidden"
      title={file.name}
    >
      {/* Content */}
      {isImage ? (
        <ImagePreview initialOpen={initialImageOpen} file={file} />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-0.5 p-1">
          <FileTypeIcon label={fileTypeLabel} />
          <span className="text-xs text-muted-foreground/50 w-full text-center truncate px-1">
            {truncatedName}
          </span>
        </div>
      )}

      {/* Uploading overlay */}
      {status === "uploading" && (
        <div className="absolute inset-0 bg-background/70 flex items-center justify-center rounded">
          {/* Spinner */}
          <svg
            className="w-5 h-5 animate-spin text-foreground/60"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
            />
          </svg>
        </div>
      )}

      {/* Error overlay */}
      {status === "error" && (
        <div className="absolute inset-0 bg-accent-red/30 flex items-center justify-center rounded">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent-red"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
      )}

      {/* X button */}
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-background/80 border border-border flex items-center justify-center hover:bg-background transition-colors"
        aria-label="Remove file"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-foreground/70"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

function LocalAttachmentChip({ file, status, onOpen, onRemove }: LocalFileAttachmentPreviewProps & {
  variant: "chip";
  onOpen: (file: File, trigger: HTMLButtonElement) => void;
}) {
  const statusText = status === "uploading" ? "업로드 중" : status === "error" ? "업로드 실패" : null;
  const metadata = [getFileTypeIcon(file), formatFileSize(file.size), statusText].filter(Boolean).join(" · ");

  return (
    <div className="flex max-w-full min-w-0 items-center gap-2 rounded border border-border bg-muted p-2" data-chat-attachment-chip>
      <button
        type="button"
        data-chat-attachment-chip-view
        onClick={event => onOpen(file, event.currentTarget)}
        title={file.name}
        className="flex min-w-0 flex-1 items-center gap-2 text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="chat-image-filename chat-attachment-name min-w-0 flex-1" title={file.name}>{file.name}</span>
        <span className="chat-image-metadata shrink-0">{metadata}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-full border border-border bg-background/80 p-1 outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        aria-label="Remove file"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-foreground/70"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

function RemoteAttachmentRow({ item, index, onOpen }: Extract<FileAttachmentPreviewProps, { variant: "row" }>) {
  const name = item.name ?? "첨부 파일";
  const availabilityText = item.availability === "missing"
    ? "찾을 수 없음"
    : item.availability === "unavailable"
      ? "사용 불가"
      : item.availability === "unresolved"
        ? "확인 불가"
        : null;
  const metadata = availabilityText ?? (item.byteSize === null ? null : formatFileSize(item.byteSize));

  return (
    <button
      type="button"
      data-chat-attachment-index={index}
      data-chat-attachment-key={item.key}
      title={name}
      aria-label={name}
      onClick={event => onOpen(item, event.currentTarget)}
      className="chat-attachment-row flex w-full min-w-0 items-center gap-3 border border-border bg-muted p-2 text-left text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="chat-image-filename chat-attachment-name min-w-0 flex-1" title={name}>{name}</span>
      {metadata && <span className="chat-image-metadata shrink-0">{metadata}</span>}
    </button>
  );
}
