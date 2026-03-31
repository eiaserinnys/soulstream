/**
 * FileAttachmentPreview - 파일 첨부 미리보기 카드
 *
 * 이미지: object URL 기반 썸네일
 * 비이미지: mime-type 기반 아이콘 + 파일명
 * 업로드 중: 반투명 오버레이 + 스피너
 * 에러: 빨간 오버레이 + 에러 아이콘
 * X 버튼으로 개별 취소
 */

import { useEffect, useMemo } from "react";

export interface FileAttachmentPreviewProps {
  file: File;
  status: "uploading" | "done" | "error";
  onRemove: () => void;
}

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
  file: File;
}

function ImagePreview({ file }: ImagePreviewProps) {
  const objectUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  return (
    <img
      src={objectUrl}
      alt={file.name}
      className="w-full h-full object-cover rounded"
    />
  );
}

function FileTypeIcon({ label }: { label: string }) {
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
      <span className="text-[9px] font-bold text-muted-foreground/60 uppercase tracking-wide">
        {label}
      </span>
    </div>
  );
}

export function FileAttachmentPreview({
  file,
  status,
  onRemove,
}: FileAttachmentPreviewProps) {
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
        <ImagePreview file={file} />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-0.5 p-1">
          <FileTypeIcon label={fileTypeLabel} />
          <span className="text-[9px] text-muted-foreground/50 w-full text-center truncate px-1 leading-tight">
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
