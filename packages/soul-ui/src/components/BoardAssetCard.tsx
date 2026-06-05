import { Download, File, ImageIcon, Music, Video } from "lucide-react";

import { cn } from "../lib/cn";

export interface BoardAssetCardProps {
  fileName: string;
  mimeType: string;
  byteSize?: number;
  signedUrl?: string;
  sourceUrl?: string;
  uploadProgress?: number;
  uploadState?: "uploading" | "error";
  errorMessage?: string;
}

function formatByteSize(value: number | undefined): string {
  if (!value || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function assetKind(mimeType: string): "image" | "audio" | "video" | "file" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "file";
}

function KindIcon({ kind }: { kind: ReturnType<typeof assetKind> }) {
  if (kind === "image") return <ImageIcon className="h-4 w-4 shrink-0 text-primary" />;
  if (kind === "audio") return <Music className="h-4 w-4 shrink-0 text-primary" />;
  if (kind === "video") return <Video className="h-4 w-4 shrink-0 text-primary" />;
  return <File className="h-4 w-4 shrink-0 text-primary" />;
}

export function BoardAssetCard({
  fileName,
  mimeType,
  byteSize,
  signedUrl,
  sourceUrl,
  uploadProgress,
  uploadState,
  errorMessage,
}: BoardAssetCardProps) {
  const kind = assetKind(mimeType);
  const mediaUrl = sourceUrl ?? signedUrl;
  const progress = Math.max(0, Math.min(100, uploadProgress ?? 0));
  const sizeText = formatByteSize(byteSize);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/60 pb-2">
        <KindIcon kind={kind} />
        <div className="min-w-0 flex-1">
          <div data-testid="board-asset-title" className="truncate text-sm font-medium">
            {fileName}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {[mimeType, sizeText].filter(Boolean).join(" · ")}
          </div>
        </div>
        {signedUrl && (
          <a
            href={signedUrl}
            download={fileName}
            title="Download"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <Download className="h-3.5 w-3.5" />
            <span className="sr-only">Download</span>
          </a>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-border/70 bg-muted/40">
        {kind === "image" && mediaUrl && (
          <img
            data-testid="board-asset-image"
            src={mediaUrl}
            alt={fileName}
            className="h-full w-full object-contain"
            draggable={false}
            onPointerDown={(event) => event.stopPropagation()}
          />
        )}
        {kind === "audio" && mediaUrl && (
          <div className="flex h-full items-center px-3" onPointerDown={(event) => event.stopPropagation()}>
            <audio data-testid="board-asset-audio" controls preload="metadata" src={mediaUrl} className="w-full" />
          </div>
        )}
        {kind === "video" && mediaUrl && (
          <video
            data-testid="board-asset-video"
            controls
            preload="metadata"
            src={mediaUrl}
            className="h-full w-full bg-black object-contain"
            onPointerDown={(event) => event.stopPropagation()}
          />
        )}
        {(kind === "file" || !mediaUrl) && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground">
            <KindIcon kind={kind} />
            <span className="line-clamp-2 break-words">{uploadState === "uploading" ? "Uploading" : fileName}</span>
          </div>
        )}
        {uploadState && (
          <div className={cn(
            "absolute inset-x-2 bottom-2 rounded border border-border bg-background/95 p-2 shadow-sm",
            uploadState === "error" && "border-destructive/50",
          )}>
            <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{uploadState === "error" ? "Upload failed" : "Uploading"}</span>
              {uploadState === "uploading" && <span>{Math.round(progress)}%</span>}
            </div>
            {uploadState === "uploading" ? (
              <div className="h-1.5 overflow-hidden rounded bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
              </div>
            ) : (
              <div className="line-clamp-2 text-[11px] text-destructive">{errorMessage}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
