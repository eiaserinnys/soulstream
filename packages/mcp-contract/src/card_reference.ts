/**
 * Card number references: `#412` is a card, `#412.s2` the second session attached to it.
 *
 * This file owns the notation and the one translation rule shared by both MCP servers.
 * A tool call is translated only when an identifier argument starts with `#`; every other
 * call goes straight through untouched. Resolving a number needs the database, so the
 * caller supplies `lookup`.
 */
import { errorResult, type CallToolResult } from "./result.js";

export type CardReferenceKind = "card" | "session" | "report" | "question" | "comment";
export interface ParsedCardReference { cardNumber: number; kind: CardReferenceKind; ordinal: number | null }
export type CardReferenceChild = { kind: Exclude<CardReferenceKind, "card">; ordinal: number };

const REFERENCE_PATTERN = /^#([1-9][0-9]{0,8})(?:\.([srqc])([1-9][0-9]{0,5}))?$/;
const KIND_BY_LETTER = { s: "session", r: "report", q: "question", c: "comment" } as const;
const LETTER_BY_KIND = { session: "s", report: "r", question: "q", comment: "c" } as const;

export function parseCardReference(text: string): ParsedCardReference | null {
  const match = REFERENCE_PATTERN.exec(text.trim());
  if (!match) return null;
  const letter = match[2] as keyof typeof KIND_BY_LETTER | undefined;
  return { cardNumber: Number(match[1]), kind: letter ? KIND_BY_LETTER[letter] : "card", ordinal: letter ? Number(match[3]) : null };
}

export function formatCardReference(cardNumber: number, child?: CardReferenceChild): string {
  return child ? `#${cardNumber}.${LETTER_BY_KIND[child.kind]}${child.ordinal}` : `#${cardNumber}`;
}

/**
 * Argument names that accept a reference, and what each accepts. `session_ids` is an array of
 * sessions and `assignee.session_id` is one level down. `caller_session_id` is the caller's
 * identity and is deliberately absent.
 */
export const REFERENCE_ARGUMENT_SLOTS: Readonly<Record<string, "card" | "session">> = {
  card_id: "card",
  after_card_id: "card",
  session_id: "session",
  target_session_id: "session",
  predecessor_session_id: "session",
  session_ids: "session",
  "assignee.session_id": "session",
};

export interface ResolvedCardReference { ref: string; kind: "card" | "session"; id: string; title: string }
export type CardReferenceLookupResult = ResolvedCardReference | { ref: string; error: string };
export type CardReferenceLookup = (refs: string[]) => Promise<CardReferenceLookupResult[]>;

interface ReferenceSlot { name: string; kind: "card" | "session"; path: (string | number)[]; ref: string }

function collectReferenceSlots(args: Record<string, unknown>): ReferenceSlot[] {
  const slots: ReferenceSlot[] = [];
  const add = (name: string, kind: "card" | "session", path: (string | number)[], value: unknown) => {
    if (typeof value === "string" && value.trim().startsWith("#")) slots.push({ name, kind, path, ref: value.trim() });
  };
  for (const [name, kind] of Object.entries(REFERENCE_ARGUMENT_SLOTS)) {
    const path = name.split(".");
    const value = path.length === 1 ? args[name] : (args[path[0]!] as Record<string, unknown> | null | undefined)?.[path[1]!];
    if (Array.isArray(value)) value.forEach((entry, index) => add(name, kind, [...path, index], entry));
    else add(name, kind, path, value);
  }
  return slots;
}

function replaceReferences(args: Record<string, unknown>, slots: ReferenceSlot[], ids: Map<string, string>) {
  const translated = structuredClone(args);
  for (const { path, ref } of slots) {
    let container = translated;
    for (const key of path.slice(0, -1)) container = container[key] as Record<string, unknown>;
    container[path[path.length - 1]!] = ids.get(ref);
  }
  return translated;
}

export async function callWithReferenceTranslation(
  args: Record<string, unknown>,
  lookup: CardReferenceLookup,
  call: (args: Record<string, unknown>) => Promise<CallToolResult>,
  options: { rejectReferences?: boolean } = {},
): Promise<CallToolResult> {
  const slots = collectReferenceSlots(args);
  if (slots.length === 0) return call(args);
  if (options.rejectReferences) {
    return errorResult(`지우는 도구는 번호 참조를 받지 않습니다. 전체 ID로 부릅니다. 받은 값: ${slots[0]!.ref}`);
  }
  const parsed = new Map<string, ParsedCardReference>();
  for (const { ref } of slots) {
    const reference = parseCardReference(ref);
    if (!reference) {
      return errorResult(`번호 참조 문법이 아닙니다: "${ref}". 카드는 #412, 카드에 붙은 세션은 #412.s2처럼 적습니다.`);
    }
    parsed.set(ref, reference);
  }
  for (const { name, kind, ref } of slots) {
    const found = parsed.get(ref)!.kind;
    if (found === "report" || found === "question" || found === "comment") {
      return errorResult(`보고, 질문, 커멘트 번호(${ref})를 받는 도구 인자는 없습니다.`);
    }
    if (found !== kind) {
      return errorResult(kind === "card"
        ? `${name}에는 카드 번호(#412)를 적습니다. 받은 값: ${ref}`
        : `${name}에는 카드에 붙은 세션 번호(#412.s2)를 적습니다. 받은 값: ${ref}`);
    }
  }
  const refs = [...parsed.keys()];
  const resolved = new Map<string, ResolvedCardReference>();
  try {
    const results = await lookup(refs);
    for (const ref of refs) {
      const result = results.find(entry => entry.ref === ref);
      if (!result) throw new Error(`응답에 ${ref}가 없습니다`);
      if ("error" in result) return errorResult(result.error);
      resolved.set(ref, result);
    }
  } catch (error) {
    return errorResult(`번호 참조를 해석하지 못했습니다: ${error instanceof Error ? error.message : String(error)}. 전체 ID로 다시 호출할 수 있습니다.`);
  }
  const result = await call(replaceReferences(args, slots, new Map([...resolved].map(([ref, entry]) => [ref, entry.id]))));
  const header = [...resolved.values()]
    .map(entry => `번호 참조 ${entry.ref} → ${entry.kind === "card" ? "카드" : "세션"} 「${entry.title}」`).join("\n");
  return { ...result, content: [{ type: "text", text: header }, ...result.content] };
}
