import { useEffect, useState } from "react";

import type { PageApiClient } from "../page";
import { parseInlineReferences, type InlineReferenceSegment } from "./page-reference-parser";

type ResolvedReference =
  | { readonly state: "loading" }
  | { readonly state: "missing" }
  | { readonly state: "ready"; readonly pageId: string; readonly blockId?: string };

export function PageRichText({
  blockId,
  text,
  apiClient,
  onEdit,
  onOpenPage,
  onOpenBlock,
}: {
  blockId: string;
  text: string;
  apiClient: PageApiClient;
  onEdit(): void;
  onOpenPage?(pageId: string): void;
  onOpenBlock?(pageId: string, blockId: string): void;
}) {
  return (
    <div
      data-page-rich-text={blockId}
      className="min-h-8 w-full cursor-text whitespace-pre-wrap break-words py-1 text-sm leading-6 text-foreground"
      onClick={onEdit}
    >
      {parseInlineReferences(text).map((segment, index) => segment.kind === "text" ? (
        <span key={`text:${index}`}>{segment.text}</span>
      ) : (
        <ReferenceToken
          key={`${segment.kind}:${segment.value}:${index}`}
          segment={segment}
          apiClient={apiClient}
          onOpenPage={onOpenPage}
          onOpenBlock={onOpenBlock}
        />
      ))}
    </div>
  );
}

function ReferenceToken({
  segment,
  apiClient,
  onOpenPage,
  onOpenBlock,
}: {
  segment: Exclude<InlineReferenceSegment, { kind: "text" }>;
  apiClient: PageApiClient;
  onOpenPage?(pageId: string): void;
  onOpenBlock?(pageId: string, blockId: string): void;
}) {
  const [resolution, setResolution] = useState<ResolvedReference>({ state: "loading" });
  useEffect(() => {
    let active = true;
    setResolution({ state: "loading" });
    const resolve = segment.kind === "page"
      ? apiClient.searchPages(segment.value, 20).then((response) => {
          const exact = response.items.find((item) => item.title.trim().toLocaleLowerCase() === segment.value.toLocaleLowerCase());
          return exact ? { state: "ready" as const, pageId: exact.pageId } : { state: "missing" as const };
        })
      : apiClient.getBlock(segment.value).then((block) => ({
          state: "ready" as const,
          pageId: block.pageId,
          blockId: block.id,
        }));
    void resolve.then(
      (next) => { if (active) setResolution(next); },
      () => { if (active) setResolution({ state: "missing" }); },
    );
    return () => { active = false; };
  }, [apiClient, segment.kind, segment.value]);

  if (resolution.state !== "ready") {
    return (
      <span
        data-reference-kind={segment.kind}
        data-reference-value={segment.value}
        data-reference-state={resolution.state}
        className={`mx-0.5 inline-flex rounded px-1.5 text-xs font-medium ${resolution.state === "missing" ? "border border-destructive/40 text-destructive" : "bg-muted text-muted-foreground"}`}
        title={resolution.state === "missing" ? "Reference unavailable or deleted" : "Resolving reference"}
      >
        {resolution.state === "missing" ? `${segment.raw} unavailable` : segment.raw}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-reference-kind={segment.kind}
      data-reference-value={segment.value}
      data-reference-state="ready"
      className="mx-0.5 inline-flex rounded bg-primary/12 px-1.5 text-xs font-medium text-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        if (resolution.blockId) onOpenBlock?.(resolution.pageId, resolution.blockId);
        else onOpenPage?.(resolution.pageId);
      }}
    >
      {segment.kind === "page" ? segment.value : segment.raw}
    </button>
  );
}
