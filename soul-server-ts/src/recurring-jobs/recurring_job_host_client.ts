import type { Logger } from "pino";

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
  constructor(private readonly config: RecurringJobHostClientConfig) {}

  async request<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(
      `${this.config.orch.baseUrl}/api/recurring-jobs/host/${encodeURIComponent(operation)}`,
      {
        method: "POST",
        headers: { ...this.config.orch.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (response.ok) return await response.json() as T;
    const detail = await readError(response);
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

async function readError(response: Response): Promise<{ code: string | null; message: string }> {
  const text = await response.text();
  if (!text) return { code: null, message: `${response.status} ${response.statusText}` };
  try {
    const parsed = JSON.parse(text) as { detail?: { error?: { code?: unknown; message?: unknown } } };
    const error = parsed.detail?.error;
    if (typeof error?.message === "string") {
      return {
        code: typeof error.code === "string" ? error.code : null,
        message: error.message,
      };
    }
  } catch {
    // Retain a bounded useful body below.
  }
  return { code: null, message: text };
}
