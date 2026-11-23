import { open } from "node:fs/promises";
import { validateWorkspacePath } from "./workspace_file_path.js";
import { inferContentType } from "../attachments/file_manager.js";

const MAX_BYTES = 25 * 1024 * 1024;
export async function readWorkspaceFile(root: string, file: string, offset = 0, length?: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) throw new Error("INVALID_REQUEST: invalid range");
  if (length !== undefined && length > MAX_BYTES) throw new Error("TOO_LARGE: requested range exceeds 25 MiB");
  const { target, info } = await validateWorkspacePath(root, file);
  if (!info) throw new Error("NOT_FOUND: file not found");
  if (length === undefined && info.size > MAX_BYTES) throw new Error("TOO_LARGE: file exceeds 25 MiB");
  const size = Math.max(0, Math.min(length ?? info.size, info.size - offset));
  const buffer = Buffer.alloc(size);
  const handle = await open(target, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, size, offset);
    return {content_b64: buffer.subarray(0, bytesRead).toString("base64"), content_type: inferContentType(target), size: info.size, offset, length: bytesRead};
  } finally { await handle.close(); }
}
