import { normalizeAttachmentLegacyPath } from "../../src/attachments/attachment_read_service.js";
import type { InventoryPlanReference } from "./inventory_contract.js";

const MANAGED_NOTE_PREFIX = "[첨부 파일 로컬 경로: ";
type IdentityLocation = { readonly legacy_node_id: string; readonly normalized_path: string };
type SourceReference = Pick<InventoryPlanReference, "pointer" | "raw_url" | "raw_path">;

export function messageReferenceIsCurrent(
  payload: Record<string, unknown>, identity: IdentityLocation, reference: SourceReference,
  allowedOrigins: readonly string[],
): boolean {
  const parts = reference.pointer.split("/").slice(1).map(unescapePointer);
  if (parts[0] !== "payload") return false;
  const index = Number(parts[2]);
  const value = parts[1] === "attachments" || parts[1] === "attachment_paths"
    ? stringAt(payload[parts[1]], index)
    : parts[1] === "text" && parts[2] === "managed_path_notes" ? managedPathNotes(payload.text)[Number(parts[3])] : undefined;
  if (value === undefined || (reference.raw_url !== undefined && value !== reference.raw_url)) return false;
  const absolute = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value) || value.startsWith("//");
  let url: URL;
  try { url = new URL(value, "https://inventory-relative.invalid"); }
  catch { return matchesPath(value, identity.normalized_path, reference.raw_path); }
  if (absolute || url.pathname === "/api/attachments/files") {
    if (absolute && (reference.raw_url !== value || !isAllowedOrigin(url.origin, allowedOrigins))) return false;
    if (url.pathname !== "/api/attachments/files") return false;
    const nodes = url.searchParams.getAll("nodeId");
    const paths = url.searchParams.getAll("path");
    const path = paths[0];
    return nodes.length === 1 && paths.length === 1 && nodes[0] === identity.legacy_node_id &&
      path !== undefined && (reference.raw_path === undefined || reference.raw_path === path) &&
      normalizePath(path) === identity.normalized_path;
  }
  return matchesPath(value, identity.normalized_path, reference.raw_path);
}

function stringAt(value: unknown, index: number): string | undefined {
  const entry = Array.isArray(value) ? value[index] : undefined;
  return typeof entry === "string" ? entry : undefined;
}
function managedPathNotes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const notes: string[] = [];
  for (const line of value.split(/\r?\n/).reverse()) {
    if (!line.startsWith(MANAGED_NOTE_PREFIX) || !line.endsWith("]")) break;
    const path = line.slice(MANAGED_NOTE_PREFIX.length, -1);
    if (!path) break;
    notes.unshift(path);
  }
  return notes;
}
function matchesPath(value: string, normalizedPath: string, rawPath: string | undefined): boolean {
  return rawPath === value && normalizePath(value) === normalizedPath;
}
function normalizePath(value: string): string {
  try { return normalizeAttachmentLegacyPath(value); } catch { return ""; }
}
function isAllowedOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
  return allowedOrigins.some((allowed) => {
    try { return new URL(allowed).origin === origin; } catch { return false; }
  });
}
function unescapePointer(value: string): string { return value.replace(/~1/g, "/").replace(/~0/g, "~"); }
