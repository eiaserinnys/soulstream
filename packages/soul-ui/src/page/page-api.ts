import type { BlockDto, PageDto, PageListDto } from "@soulstream/page-model";

export type PageApiErrorKind = "authentication" | "conflict" | "request" | "server" | "network";
export type { BlockDto, PageDto, PageListDto } from "@soulstream/page-model";

export class PageApiError extends Error {
  readonly name = "PageApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly kind: PageApiErrorKind,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

export interface PageReadResponse {
  page: PageDto;
  blocks: BlockDto[];
  state_vector: string;
}

export interface PageDailyResponse {
  page: PageDto;
  created: boolean;
  operation?: PageOperationResponse;
}

export interface PageOperationResponse {
  id: string;
  [key: string]: unknown;
}

export interface PageMutationResponse {
  page: PageDto;
  blocks: BlockDto[];
  operation: PageOperationResponse;
  temp_id_mapping: Record<string, string>;
  idempotent?: boolean;
}

export type PageStructureOperation =
  | { op: "rename_page"; title: string }
  | { op: "set_page_archived"; archived: boolean }
  | {
    op: "create_block";
    temp_id: string;
    parent_id: string | null;
    parent_temp_id?: string | null;
    after_block_id: string | null;
    after_temp_id?: string | null;
    block_type: string;
    text: string;
    properties: Record<string, unknown>;
    collapsed?: boolean;
  }
  | { op: "update_block_text"; block_id: string; text: string }
  | {
    op: "update_block_type_and_properties";
    block_id: string;
    block_type: string;
    properties: Record<string, unknown>;
  }
  | {
    op: "move_block";
    block_id: string;
    parent_id: string | null;
    parent_temp_id?: string | null;
    after_block_id: string | null;
    after_temp_id?: string | null;
  }
  | { op: "delete_block_subtree"; block_id: string }
  | { op: "set_check_state"; block_id: string; checked: boolean };

export interface ApplyPageOperationsInput {
  expectedVersion: number;
  expectedStateVector: Uint8Array;
  idempotencyKey: string;
  reason?: string | null;
  operations: PageStructureOperation[];
}

export interface SetPageStarredInput {
  starred: boolean;
  expectedVersion: number;
  idempotencyKey: string;
  reason?: string | null;
}

export interface PageApiClient {
  listPages(input?: { starred?: boolean; cursor?: string; limit?: number }): Promise<PageListDto>;
  getPage(pageId: string): Promise<PageReadResponse>;
  getDailyPage(date?: string): Promise<PageDailyResponse>;
  applyOperations(pageId: string, input: ApplyPageOperationsInput): Promise<PageMutationResponse>;
  setStarred(pageId: string, input: SetPageStarredInput): Promise<PageMutationResponse>;
}

export function createPageApiClient(options: {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
} = {}): PageApiClient {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("Page API requires a fetch implementation");
  }
  const baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}${path}`, {
        credentials: "same-origin",
        headers: init?.body === undefined
          ? { Accept: "application/json", ...init?.headers }
          : { Accept: "application/json", "Content-Type": "application/json", ...init.headers },
        ...init,
      });
    } catch (error) {
      throw new PageApiError(errorMessage(error, "Page API request failed"), 0, "network");
    }
    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new PageApiError(
        responseMessage(body, response.statusText || `Page API returned ${response.status}`),
        response.status,
        errorKind(response.status),
        body,
      );
    }
    return body as T;
  };

  return {
    listPages: async (input = {}) => {
      const query = new URLSearchParams();
      if (input.starred !== undefined) query.set("starred", String(input.starred));
      if (input.cursor !== undefined) query.set("cursor", input.cursor);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return await request<PageListDto>(`/api/pages${suffix}`);
    },
    getPage: async (pageId) =>
      await request<PageReadResponse>(`/api/pages/${encodeURIComponent(pageId)}`),
    getDailyPage: async (date) => await request<PageDailyResponse>("/api/pages/daily", {
      method: "POST",
      body: JSON.stringify(date === undefined ? {} : { date }),
    }),
    applyOperations: async (pageId, input) =>
      await request<PageMutationResponse>(`/api/pages/${encodeURIComponent(pageId)}/operations`, {
        method: "POST",
        body: JSON.stringify({
          expected_version: input.expectedVersion,
          expected_state_vector: encodeBase64(input.expectedStateVector),
          idempotency_key: input.idempotencyKey,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          operations: input.operations,
        }),
      }),
    setStarred: async (pageId, input) =>
      await request<PageMutationResponse>(`/api/pages/${encodeURIComponent(pageId)}/starred`, {
        method: "PATCH",
        body: JSON.stringify({
          starred: input.starred,
          expected_version: input.expectedVersion,
          idempotency_key: input.idempotencyKey,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }),
      }),
  };
}

function encodeBase64(value: Uint8Array): string {
  if (typeof globalThis.btoa !== "function") {
    throw new Error("Page API requires btoa to encode a Yjs state vector");
  }
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return globalThis.btoa(binary);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body;
  if (body && typeof body === "object") {
    for (const key of ["detail", "message", "error"] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return fallback;
}

function errorKind(status: number): PageApiErrorKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 409) return "conflict";
  if (status >= 500) return "server";
  return "request";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
