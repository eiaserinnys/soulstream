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
