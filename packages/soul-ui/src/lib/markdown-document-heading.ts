/** 본문 맨 앞의 ATX H1이 문서 제목과 겹치면 그 줄을 뺀 본문을, 아니면 본문 그대로를 돌려준다. */
export function removeOverlappingDocumentHeading(body: string, title: string): string {
  const lines = body.split(/\r?\n/);
  const headingLineIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headingLineIndex === -1) return body;

  const headingMatch = /^ {0,3}# (.*)$/.exec(lines[headingLineIndex]);
  if (!headingMatch) return body;

  const heading = headingMatch[1].trim().replace(/\s+/g, " ");
  const normalizedTitle = title.trim().replace(/\s+/g, " ");
  if (!heading || !normalizedTitle) return body;

  const overlaps =
    heading === normalizedTitle ||
    heading.startsWith(normalizedTitle) ||
    normalizedTitle.startsWith(heading) ||
    heading.endsWith(normalizedTitle) ||
    normalizedTitle.endsWith(heading);
  if (!overlaps) return body;

  let contentStart = headingLineIndex + 1;
  while (contentStart < lines.length && lines[contentStart].trim().length === 0) {
    contentStart += 1;
  }
  return lines.slice(contentStart).join("\n");
}
