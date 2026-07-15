import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";

export interface FolderProjectHostResult {
  id: string;
  pageId: string;
  folder: {
    id: string;
    name: string;
    sortOrder: number;
    settings: Record<string, unknown>;
    parentFolderId: string | null;
    projectPageId: string;
  };
  idempotent?: boolean;
}

export class FolderProjectIdentityHostClient {
  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {}

  async create(input: {
    name: string;
    sortOrder: number;
    parentFolderId: string | null;
    idempotencyKey: string;
  }): Promise<FolderProjectHostResult> {
    return await this.request("create", {
      name: input.name,
      sort_order: input.sortOrder,
      parent_folder_id: input.parentFolderId,
      ...systemMutation(input.idempotencyKey),
    });
  }

  async rename(input: {
    folderId: string;
    name: string;
    idempotencyKey: string;
  }): Promise<FolderProjectHostResult> {
    return await this.request("update", {
      folder_id: input.folderId,
      name: input.name,
      ...systemMutation(input.idempotencyKey),
    });
  }

  async archive(input: {
    folderId: string;
    idempotencyKey: string;
  }): Promise<FolderProjectHostResult> {
    return await this.request("archive", {
      folder_id: input.folderId,
      ...systemMutation(input.idempotencyKey),
    });
  }

  private async request(operation: string, body: unknown): Promise<FolderProjectHostResult> {
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/folder-project-identities/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      const message = await responseErrorMessage(response);
      this.config.logger.warn(
        { operation, status: response.status, message },
        "folder project identity host request failed",
      );
      throw new Error(`folder project identity host ${operation} failed: ${message}`);
    }
    return await response.json() as FolderProjectHostResult;
  }
}

function systemMutation(idempotencyKey: string) {
  return { actor_kind: "system", idempotency_key: idempotencyKey };
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`;
  try {
    const detail = (JSON.parse(text) as { detail?: { error?: { message?: unknown } } }).detail;
    if (typeof detail?.error?.message === "string") return detail.error.message;
  } catch {
    return text;
  }
  return text;
}
