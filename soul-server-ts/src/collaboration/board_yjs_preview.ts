export function normalizeMarkdownTitle(title: string): string {
  return title.trim() || "Untitled document";
}

export function getMarkdownPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function getHtmlPreview(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}
