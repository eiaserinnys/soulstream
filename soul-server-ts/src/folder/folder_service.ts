import type { Logger } from "pino";

import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import type { CardDetail, FolderSnapshot } from "../db/session_db_types.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";
import { FolderVersionConflict } from "./folder_models.js";


/** Worker facade for the single folder/card owner in orch. */
export class FolderService {
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: { orch: OrchProxyConfig; logger: Logger }) {
    this.transport = new PersistenceHostTransport(config);
  }

  async getFolder(folderId: string, options: { view?: "full" | "outline"; cardId?: string } = {}): Promise<FolderSnapshot | null> {
    try {
      return await this.request("get_folder", { folderId, ...options });
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }
  }

  async getCard(cardId: string, actorSessionId?: string): Promise<CardDetail> {
    return this.cardRequest("GET", `/api/cards/${encodeURIComponent(cardId)}`, undefined, actorSessionId);
  }

  private async cardRequest<T = Record<string, unknown>>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown, actorSessionId?: string): Promise<T> {
    const response = await this.transport.send(method, path, body, {
      headers: actorSessionId ? { "x-soulstream-agent-session-id": actorSessionId } : {},
    });
    if (!response.ok) {
      const failure = await readOrchErrorEnvelope(response);
      throw Object.assign(new Error(failure.message), { statusCode: response.status, code: failure.code });
    }
    return await response.json() as T;
  }

  private async request<T = unknown>(operation: string, input: object): Promise<T> {
    const response = await this.transport.send("POST", `/api/folders/host/${encodeURIComponent(operation)}`, snakeCaseFields(input));
    if (!response.ok) {
      const failure = await readOrchErrorEnvelope(response);
      if (response.status === 409 && isVersionConflictDetails(failure.details)) {
        throw new FolderVersionConflict(failure.details.targetKind, failure.details.targetId, failure.details.expectedVersion, failure.details.actualVersion);
      }
      const error = Object.assign(new Error(`folder host ${operation} failed: ${failure.message}`), { statusCode: response.status });
      this.config.logger.warn({ operation, status: response.status, message: failure.message }, "folder host request failed");
      throw error;
    }
    return await response.json() as T;
  }
}

function snakeCaseFields(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), child]));
}

function isVersionConflictDetails(value: Record<string, unknown> | undefined): value is {
  targetKind: "folder" | "card";
  targetId: string;
  expectedVersion: number;
  actualVersion: number;
} {
  return value !== undefined
    && (value.targetKind === "folder" || value.targetKind === "card")
    && typeof value.targetId === "string"
    && typeof value.expectedVersion === "number"
    && typeof value.actualVersion === "number";
}
