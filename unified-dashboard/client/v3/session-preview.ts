import {
  isPersistentInitialInstructionText,
  isSilent,
} from "../../../packages/wire-schema/src/conversation_visibility";

export const TASK_TITLE_PREVIEW_LENGTH = 120;
export const TASK_DESCRIPTION_COLLAPSE_LENGTH = 320;

export function codePointLength(value: string | null | undefined): number {
  return Array.from(value ?? "").length;
}

export function hasCodePointOverflow(
  value: string | null | undefined,
  maxLength: number,
): boolean {
  return codePointLength(value) > maxLength;
}

export function singleLinePreview(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  const codePoints = Array.from(normalized);
  if (codePoints.length <= maxLength) return normalized;
  return `${codePoints.slice(0, maxLength - 1).join("")}…`;
}

interface PreviewSource {
  readonly lastMessage?: { readonly preview?: string | null } | null;
  readonly prompt?: string | null;
}

/** 저장된 마지막 메시지 미리보기. `[SILENT]` 답과 영구 세션 첫 지시문 글은 없는 것으로 본다. */
export function visibleLastMessagePreview(session: PreviewSource): string | null | undefined {
  const preview = session.lastMessage?.preview;
  if (typeof preview === "string" && (isSilent(preview) || isPersistentInitialInstructionText(preview))) {
    return undefined;
  }
  return preview;
}

/** 목록 줄에 보일 글의 원본. 숨길 글이면 다음 대안인 prompt로 넘어가고, prompt도 첫 지시문이면 없는 것이다. */
export function visibleSessionPreview(session: PreviewSource): string | null | undefined {
  const preview = visibleLastMessagePreview(session);
  if (preview != null) return preview;
  const prompt = session.prompt;
  return typeof prompt === "string" && isPersistentInitialInstructionText(prompt) ? undefined : prompt;
}
