export type InlineReferenceSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "page" | "block"; readonly value: string; readonly raw: string };

export interface ReferenceTrigger {
  readonly kind: "page" | "block";
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

const TOKEN = /\[\[([^\]\n]+)\]\]|\(\(([^)\n]+)\)\)/g;

export function parseInlineReferences(text: string): InlineReferenceSegment[] {
  const segments: InlineReferenceSegment[] = [];
  let offset = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    const raw = match[0];
    const value = (match[1] ?? match[2] ?? "").trim();
    if (!value) continue;
    if (start > offset) appendText(segments, text.slice(offset, start));
    segments.push({ kind: match[1] === undefined ? "block" : "page", value, raw });
    offset = start + raw.length;
  }
  if (offset < text.length) appendText(segments, text.slice(offset));
  if (segments.length === 0) return [{ kind: "text", text }];
  return segments;
}

export function findReferenceTrigger(text: string, caret: number): ReferenceTrigger | null {
  const prefix = text.slice(0, caret);
  const candidates = [
    triggerCandidate(prefix, "[[", "]]", "page"),
    triggerCandidate(prefix, "((", "))", "block"),
  ].filter((candidate): candidate is ReferenceTrigger => candidate !== null);
  return candidates.sort((left, right) => right.start - left.start)[0] ?? null;
}

export function replaceReferenceTrigger(
  text: string,
  trigger: ReferenceTrigger,
  replacement: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${replacement}${text.slice(trigger.end)}`;
  return { text: next, caret: trigger.start + replacement.length };
}

function triggerCandidate(
  prefix: string,
  open: "[[" | "((",
  close: "]]" | "))",
  kind: ReferenceTrigger["kind"],
): ReferenceTrigger | null {
  const start = prefix.lastIndexOf(open);
  if (start < 0 || prefix.indexOf(close, start + open.length) >= 0) return null;
  const query = prefix.slice(start + open.length);
  if (query.includes("\n")) return null;
  return { kind, start, end: prefix.length, query };
}

function appendText(segments: InlineReferenceSegment[], text: string): void {
  const previous = segments.at(-1);
  if (previous?.kind === "text") {
    segments[segments.length - 1] = { kind: "text", text: previous.text + text };
  } else {
    segments.push({ kind: "text", text });
  }
}
