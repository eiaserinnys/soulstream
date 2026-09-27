
export function getMarkdownPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 180);
}
