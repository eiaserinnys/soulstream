function normalizeHeadingText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function removeOverlappingDocumentHeading(body: string, title: string): string {
  const lines = body.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim().length > 0);
  if (headingIndex < 0) return body;

  const headingMatch = lines[headingIndex].match(/^ {0,3}# (.*)$/);
  if (!headingMatch) return body;

  const heading = normalizeHeadingText(headingMatch[1]);
  const documentTitle = normalizeHeadingText(title);
  if (!heading || !documentTitle
    || !(heading === documentTitle
      || heading.startsWith(documentTitle)
      || documentTitle.startsWith(heading)
      || heading.endsWith(documentTitle)
      || documentTitle.endsWith(heading))) {
    return body;
  }

  let nextLine = headingIndex + 1;
  while (nextLine < lines.length && lines[nextLine].trim().length === 0) nextLine += 1;
  return lines.slice(nextLine).join('\n');
}
