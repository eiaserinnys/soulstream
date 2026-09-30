import type { BlockDto, PageApiClient, PageReadResponse } from "@seosoyoung/soul-ui/page";

export class BrowserPlannerMutationPort {
  constructor(
    private readonly api: PageApiClient,
  ) {}

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
