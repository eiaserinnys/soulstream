export interface InlineSegmentRange {
  start: number;
  end: number;
}

export type InlineNavigationTarget =
  | { kind: "page"; pageId?: string; title: string }
  | { kind: "block"; blockId: string };

interface InlineSegmentBase {
  text: string;
  range?: InlineSegmentRange;
}

export interface InlineTextSegment extends InlineSegmentBase {
  kind: "text";
}

export interface InlinePageRefSegment extends InlineSegmentBase {
  kind: "pageRef";
  sourceText: string;
  pageTitle: string;
  pageId?: string;
  navigation: { kind: "page"; pageId?: string; title: string };
}

export interface InlineBlockRefSegment extends InlineSegmentBase {
  kind: "blockRef";
  sourceText: string;
  blockId: string;
  navigation: { kind: "block"; blockId: string };
}

export type InlineSegment =
  | InlineTextSegment
  | InlinePageRefSegment
  | InlineBlockRefSegment;

/**
 * Parse framework-independent [[page]] and ((block)) reference tokens.
 *
 * This preserves the Serendipity inlineRefs contract, including UTF-16 source
 * offsets and treating an unmatched opening token as plain text.
 */
export function parseInlineRefs(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let position = 0;

  while (position < text.length) {
    const pageStart = text.indexOf("[[", position);
    const blockStart = text.indexOf("((", position);
    const next = earliestToken(pageStart, blockStart);

    if (!next) {
      pushTextSegment(segments, text.slice(position), position, text.length);
      break;
    }

    if (next.start > position) {
      pushTextSegment(segments, text.slice(position, next.start), position, next.start);
    }

    const close = text.indexOf(next.closeToken, next.start + 2);
    if (close === -1) {
      pushTextSegment(segments, text.slice(next.start), next.start, text.length);
      break;
    }

    const innerText = text.slice(next.start + 2, close);
    const end = close + 2;
    if (next.kind === "pageRef") {
      segments.push({
        kind: "pageRef",
        text: innerText,
        sourceText: text.slice(next.start, end),
        pageTitle: innerText,
        navigation: { kind: "page", title: innerText },
        range: { start: next.start, end },
      });
    } else {
      segments.push({
        kind: "blockRef",
        text: innerText,
        sourceText: text.slice(next.start, end),
        blockId: innerText,
        navigation: { kind: "block", blockId: innerText },
        range: { start: next.start, end },
      });
    }
    position = end;
  }

  return segments;
}

export function serializeInlineSegments(segments: readonly InlineSegment[]): string {
  return segments
    .map((segment) => segment.kind === "text" ? segment.text : segment.sourceText)
    .join("");
}

function earliestToken(
  pageStart: number,
  blockStart: number,
): { kind: "pageRef" | "blockRef"; start: number; closeToken: string } | null {
  if (pageStart === -1 && blockStart === -1) {
    return null;
  }
  if (pageStart !== -1 && (blockStart === -1 || pageStart < blockStart)) {
    return { kind: "pageRef", start: pageStart, closeToken: "]]" };
  }
  return { kind: "blockRef", start: blockStart, closeToken: "))" };
}

function pushTextSegment(
  segments: InlineSegment[],
  text: string,
  start: number,
  end: number,
): void {
  if (text.length > 0) {
    segments.push({ kind: "text", text, range: { start, end } });
  }
}
