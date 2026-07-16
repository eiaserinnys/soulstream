import type {
  BlockDto,
  PageApiClient,
  PageReadResponse,
} from "@seosoyoung/soul-ui/page";

import { HttpResponseError } from "../lib/http-response-error";
import { parseSingleMountTitle } from "./planner-model";
import type { PlannerTaskCreationPort } from "./planner-task-creation";

export class BrowserPlannerMutationPort implements PlannerTaskCreationPort {
  constructor(
    private readonly api: PageApiClient,
    // fetch를 unbound로 저장하면 this.fetchImplementation() 호출 시 this가 인스턴스가 되어
    // "Illegal invocation"이 발생한다 — 반드시 globalThis에 bind한 기본값을 쓴다.
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async createDocument(input: { title: string; sourcePageId: string }) {
    return await this.createMountedPage(input);
  }

  async createTaskIdentity(input: { title: string; description: string; folderId: string }) {
    const response = await this.fetchImplementation("/api/runbooks", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        description: input.description,
        folder_id: input.folderId,
      }),
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      throw new HttpResponseError(
        responseMessage(payload, `업무를 만들지 못했습니다 (${response.status})`),
        response.status,
      );
    }
    const ids = extractTaskIdentityIds(payload);
    if (!ids.id) throw new Error("업무 생성 응답에 ID가 없습니다");
    if (
      (ids.pageId && ids.pageId !== ids.id)
      || (ids.runbookId && ids.runbookId !== ids.id)
      || (ids.pageId && ids.runbookId && ids.pageId !== ids.runbookId)
    ) {
      throw new Error("업무 생성 응답의 ID가 일치하지 않습니다");
    }
    return { id: ids.id };
  }

  async mountPage(input: { sourcePageId: string; title: string }) {
    const snapshot = await this.api.getPage(input.sourcePageId);
    if (snapshot.blocks.some((block) => parseSingleMountTitle(block) === input.title)) return;
    await this.appendBlock(snapshot, {
      blockType: "paragraph",
      text: `[[${input.title}]]`,
      properties: {},
    });
  }

  async saveMemo(input: { pageId: string; blockId: string | null; text: string }) {
    const snapshot = await this.api.getPage(input.pageId);
    if (input.blockId) {
      const block = snapshot.blocks.find((candidate) => candidate.id === input.blockId);
      if (!block) throw new Error("편집할 메모 블록이 사라졌습니다");
      if (block.text === input.text) return;
      await this.api.applyOperations(input.pageId, {
        expectedVersion: snapshot.page.version,
        expectedStateVector: decodeStateVector(snapshot.state_vector),
        idempotencyKey: operationId("memo-update"),
        reason: "v3 planner daily memo update",
        operations: [{ op: "update_block_text", block_id: input.blockId, text: input.text }],
      });
      return;
    }
    if (!input.text.trim()) return;
    await this.appendBlock(snapshot, {
      blockType: "paragraph",
      text: input.text,
      properties: {},
    });
  }

  private async createMountedPage(input: { title: string; sourcePageId: string }) {
    const source = await this.api.getPage(input.sourcePageId);
    const scratchTempId = operationId("page-seed");
    const seeded = await this.api.applyOperations(input.sourcePageId, {
      expectedVersion: source.page.version,
      expectedStateVector: decodeStateVector(source.state_vector),
      idempotencyKey: operationId("page-seed-create"),
      reason: "v3 planner page creation seed",
      operations: [{
        op: "create_block",
        temp_id: scratchTempId,
        parent_id: null,
        after_block_id: lastRootBlockId(source.blocks),
        block_type: "paragraph",
        text: "",
        properties: {},
        collapsed: false,
      }],
    });
    const scratchBlockId = seeded.temp_id_mapping[scratchTempId];
    if (!scratchBlockId) throw new Error("새 페이지 seed 블록 ID를 받지 못했습니다");
    const currentSource = await this.api.getPage(input.sourcePageId);
    const pageId = operationId("page");
    await this.api.transferBlocks({
      source: {
        pageId: input.sourcePageId,
        expectedVersion: currentSource.page.version,
        expectedStateVector: decodeStateVector(currentSource.state_vector),
        blockIds: [scratchBlockId],
      },
      target: { kind: "new", pageId, title: input.title },
      sourceMount: { title: input.title, tempId: operationId("page-mount") },
      idempotencyKey: operationId("page-extract"),
      reason: "v3 planner create page and mount",
    });
    return { pageId };
  }

  private async appendBlock(
    snapshot: PageReadResponse,
    block: { blockType: string; text: string; properties: Record<string, unknown> },
  ) {
    await this.api.applyOperations(snapshot.page.id, {
      expectedVersion: snapshot.page.version,
      expectedStateVector: decodeStateVector(snapshot.state_vector),
      idempotencyKey: operationId("block-create"),
      reason: "v3 planner append block",
      operations: [{
        op: "create_block",
        temp_id: operationId("block"),
        parent_id: null,
        after_block_id: lastRootBlockId(snapshot.blocks),
        block_type: block.blockType,
        text: block.text,
        properties: block.properties,
        collapsed: false,
      }],
    });
  }
}

function lastRootBlockId(blocks: readonly BlockDto[]): string | null {
  return blocks.filter((block) => block.parent_id === null).at(-1)?.id ?? null;
}

function decodeStateVector(value: string): Uint8Array {
  if (typeof globalThis.atob !== "function") {
    throw new Error("브라우저가 페이지 state vector 디코딩을 지원하지 않습니다");
  }
  const binary = globalThis.atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function operationId(prefix: string): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("브라우저 randomUUID 지원이 필요합니다");
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractTaskIdentityIds(payload: unknown): {
  id: string | null;
  pageId: string | null;
  runbookId: string | null;
} {
  if (!payload || typeof payload !== "object") {
    return { id: null, pageId: null, runbookId: null };
  }
  const record = payload as Record<string, unknown>;
  const runbook = objectValue(record.runbook)
    ?? objectValue(objectValue(record.snapshot)?.runbook);
  const runbookId = stringValue(record.runbookId)
    ?? stringValue(record.runbook_id)
    ?? stringValue(runbook?.id);
  const pageId = stringValue(record.pageId) ?? stringValue(record.page_id);
  return {
    id: stringValue(record.id) ?? pageId ?? runbookId,
    pageId,
    runbookId,
  };
}

function responseMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload;
  const record = objectValue(payload);
  const detail = objectValue(record?.detail);
  const error = objectValue(detail?.error) ?? objectValue(record?.error);
  return stringValue(error?.message)
    ?? stringValue(record?.detail)
    ?? stringValue(detail?.message)
    ?? stringValue(record?.message)
    ?? fallback;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
