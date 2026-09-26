import type { Logger } from "pino";

import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
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
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {
    this.transport = new PersistenceHostTransport(config);
  }

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
    const response = await this.transport.send(
      "POST",
      `/api/folder-project-identities/host/${encodeURIComponent(operation)}`,
      body,
    );
    if (!response.ok) {
      const detail = await readOrchErrorEnvelope(response);
      this.config.logger.warn(
        { operation, status: response.status, message: detail.message },
        "folder project identity host request failed",
      );
      throw new Error(`folder project identity host ${operation} failed: ${detail.message}`);
    }
    return await response.json() as FolderProjectHostResult;
  }
}

function systemMutation(idempotencyKey: string) {
  return { actor_kind: "system", idempotency_key: idempotencyKey };
}
