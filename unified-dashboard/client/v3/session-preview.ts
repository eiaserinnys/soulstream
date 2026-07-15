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
