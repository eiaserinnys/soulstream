import type { PageStructureOperation } from "@seosoyoung/soul-ui/page";

export type ContextPickerSelection =
  | { key: string; kind: "page"; pageId: string; title: string }
  | { key: string; kind: "atom"; nodeId: string; label: string }
  | { key: string; kind: "session"; sessionId: string; label: string; summary?: string | null }
  | { key: string; kind: "guidance"; text: string };

export interface ContextBlockMutation {
  operations: PageStructureOperation[];
  predecessorSessionId: string | null;
}

export function buildContextBlockOperations({
  selections,
  afterBlockId,
  createTempId,
}: {
  selections: readonly ContextPickerSelection[];
  afterBlockId: string | null;
  createTempId(): string;
}): ContextBlockMutation {
  const operations: PageStructureOperation[] = [];
  let previousTempId: string | null = null;
  let predecessorSessionId: string | null = null;

  for (const selection of selections) {
    if (selection.kind === "session") {
      predecessorSessionId = selection.sessionId;
      continue;
    }
    const tempId = createTempId();
    const common = {
      op: "create_block" as const,
      temp_id: tempId,
      parent_id: null,
      after_block_id: previousTempId ? null : afterBlockId,
      ...(previousTempId ? { after_temp_id: previousTempId } : {}),
      collapsed: false,
    };
    if (selection.kind === "page") {
      operations.push({
        ...common,
        block_type: "paragraph",
        text: `[[${selection.title}]]`,
        properties: {},
      });
    } else if (selection.kind === "atom") {
      operations.push({
        ...common,
        block_type: "atom_ref",
        text: "",
        properties: { instance: "atom", nodeId: selection.nodeId, title: selection.label },
      });
    } else {
      operations.push({
        ...common,
        block_type: "guidance",
        text: selection.text,
        properties: { enabled: true, scope: "run" },
      });
    }
    previousTempId = tempId;
  }

  return { operations, predecessorSessionId };
}

export function estimateContextPayload(values: readonly string[]): {
  count: number;
  approximateTokens: number;
  label: string;
} {
  const approximateTokens = Math.ceil(values.reduce((total, value) => total + value.length, 0) / 4);
  const thousands = approximateTokens === 0 ? 0 : Math.max(0.1, approximateTokens / 1_000);
  const compact = Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1);
  return {
    count: values.length,
    approximateTokens,
    label: `~${compact}k tokens`,
  };
}
