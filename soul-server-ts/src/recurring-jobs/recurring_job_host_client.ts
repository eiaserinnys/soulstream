import type { Logger } from "pino";

import { PersistenceHostTransport, readOrchErrorEnvelope } from "../control_plane/persistence_host_transport.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

export type RecurringJobHostClientConfig = {
  readonly orch: OrchProxyConfig;
  readonly logger: Logger;
};

export class RecurringJobHostClientError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RecurringJobHostClientError";
  }
}

export class RecurringJobHostClient {
  private readonly transport: PersistenceHostTransport;

  constructor(private readonly config: RecurringJobHostClientConfig) {
    this.transport = new PersistenceHostTransport(config);
  }

  async request<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.transport.send(
      "POST",
      `/api/recurring-jobs/host/${encodeURIComponent(operation)}`,
      body,
    );
    if (response.ok) return await response.json() as T;
    const detail = await readOrchErrorEnvelope(response);
    this.config.logger.warn(
      { operation, status: response.status, code: detail.code, message: detail.message },
      "recurring job host request failed",
    );
    throw new RecurringJobHostClientError(
      detail.code,
      response.status,
      `recurring job host ${operation} failed: ${detail.message}`,
    );
  }
}
