import { useMemo } from "react";

export const CUSTOM_VIEW_FRAME_ORIGINS = [
  "https://pages.eiaserinnys.me",
] as const;

export const CUSTOM_VIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "img-src data: https:",
  `frame-src ${CUSTOM_VIEW_FRAME_ORIGINS.join(" ")}`,
].join("; ") + ";";

export interface CustomViewBindingRecord {
  title?: string | null;
  status?: string | null;
  completed?: number | string | null;
  total?: number | string | null;
}

export interface CustomViewBindingData {
  taskItems: Record<string, CustomViewBindingRecord>;
  tasks: Record<string, CustomViewBindingRecord>;
  sessions: Record<string, CustomViewBindingRecord>;
}

const EMPTY_BINDINGS: CustomViewBindingData = {
  taskItems: {},
  tasks: {},
  sessions: {},
};

const SOUL_BIND_RE = /<soul-bind\b([^>]*)>\s*<\/soul-bind>/gi;
const ATTRIBUTE_RE = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseAttributes(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE_RE)) {
    result[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return result;
}

function bindingValue(
  attrs: Record<string, string>,
  data: CustomViewBindingData,
): string {
  const id = attrs.id;
  const field = attrs.field;
  if (!id || !field) return "";

  if (attrs.kind === "task-item") {
    if (field !== "status" && field !== "title") return "";
    return stringifyBinding(data.taskItems[id]?.[field]);
  }
  if (attrs.kind === "task") {
    if (field !== "completed" && field !== "total") return "";
    return stringifyBinding(data.tasks[id]?.[field]);
  }
  if (attrs.kind === "session") {
    if (field !== "status" && field !== "title") return "";
    return stringifyBinding(data.sessions[id]?.[field]);
  }
  return "";
}

function stringifyBinding(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value;
  return "";
}

export function renderCustomViewFragment(
  html: string,
  data: CustomViewBindingData = EMPTY_BINDINGS,
): string {
  return html.replace(SOUL_BIND_RE, (_match, rawAttrs: string) => {
    const attrs = parseAttributes(rawAttrs);
    return escapeHtml(bindingValue(attrs, data));
  });
}

function cspMeta(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(CUSTOM_VIEW_CSP)}">`;
}

export function renderCustomViewSrcDoc(
  html: string,
  data: CustomViewBindingData = EMPTY_BINDINGS,
): string {
  const fragment = renderCustomViewFragment(html, data);
  const meta = cspMeta();
  if (/<head[\s>]/i.test(fragment)) {
    return fragment.replace(/<head([^>]*)>/i, `<head$1><meta charset="utf-8">${meta}`);
  }
  if (/<html[\s>]/i.test(fragment)) {
    return fragment.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${meta}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${meta}</head><body>${fragment}</body></html>`;
}

export function CustomViewIframe({
  html,
  bindings,
  title,
  className,
}: {
  html: string;
  bindings?: CustomViewBindingData;
  title: string;
  className?: string;
}) {
  const srcDoc = useMemo(
    () => renderCustomViewSrcDoc(html, bindings ?? EMPTY_BINDINGS),
    [bindings, html],
  );
  return (
    <iframe
      data-testid="custom-view-iframe"
      title={title}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className={className}
    />
  );
}
