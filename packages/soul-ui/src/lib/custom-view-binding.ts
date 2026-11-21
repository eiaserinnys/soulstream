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
