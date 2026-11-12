import type { AttachmentDescriptor } from "./attachments.js";

export type CardQuestionKind = "choice" | "request";
export type CardQuestionOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};
export type CardQuestionAttachmentInput = {
  type: "image" | "link";
  label: string;
} & ({ attachment_id: string; url?: never } | { url: string; attachment_id?: never });
export type CardQuestionAttachment = {
  type: "image" | "link";
  label: string;
  url: string;
  attachment_id?: string;
  descriptor?: AttachmentDescriptor;
  read_context?: { type: "card"; id: string };
  previewUrl?: string | null;
  originalUrl?: string;
  availability?: "missing" | "unavailable";
};
export type CardQuestionThreadEntry = {
  id: string;
  question_id: string;
  author_kind: "user" | "agent";
  body: string;
  created_at: string;
  session_id: string | null;
};

/**
 * DB options 한 칸(옛 string[] 또는 새 객체[])을 한 꼴로 읽는다.
 * 문자열은 label만 있는 선택지로 읽고 description/recommended를 추정하지 않는다.
 */
export function normalizeCardQuestionOptions(value: unknown): CardQuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: CardQuestionOption[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      options.push({ label: entry });
      continue;
    }
    if (!isRecord(entry) || typeof entry.label !== "string") continue;
    options.push({
      label: entry.label,
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(entry.recommended === true ? { recommended: true } : {}),
    });
  }
  return options;
}

/** 기존 DTO options에 내보내는 label 배열. options가 NULL이면 NULL을 유지한다. */
export function cardQuestionOptionLabels(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return normalizeCardQuestionOptions(value).map((option) => option.label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
