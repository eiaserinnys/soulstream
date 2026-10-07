import type {
  PersistentInstructionRecordedData,
  PersistentInstructionRecordedInstruction,
} from "@shared/types";

export interface PersistentInstructionRecordedDebugEvent {
  type: "debug";
  kind: "persistent_instruction_recorded";
  instructions: PersistentInstructionRecordedInstruction[];
  cap_reached: boolean;
  input_id?: string;
  timestamp: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceTurn(value: unknown): value is string {
  return typeof value === "string" && /^T[0-9]+$/.test(value);
}

function isInstruction(value: unknown): value is PersistentInstructionRecordedInstruction {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.text === "string"
    && value.text.length > 0
    && Array.isArray(value.source_turns)
    && value.source_turns.every(isSourceTurn)
    && (value.action === "added" || value.action === "updated");
}

export function isPersistentInstructionRecordedDebugEvent(
  value: unknown,
): value is PersistentInstructionRecordedDebugEvent {
  return isRecord(value)
    && value.type === "debug"
    && value.kind === "persistent_instruction_recorded"
    && Array.isArray(value.instructions)
    && value.instructions.every(isInstruction)
    && typeof value.cap_reached === "boolean"
    && (value.input_id === undefined || (typeof value.input_id === "string" && value.input_id.length > 0))
    && typeof value.timestamp === "number"
    && Number.isFinite(value.timestamp);
}

export function persistentInstructionRecordedTitle(record: PersistentInstructionRecordedData): string {
  return record.instructions.length === 0 && record.capReached
    ? "📌 지속 지시 상한에 닿았습니다"
    : "📌 지속 지시로 기록했습니다";
}

export function formatPersistentInstructionRecorded(record: PersistentInstructionRecordedData): string[] {
  const lines = record.instructions.map((instruction) => {
    const turns = instruction.source_turns.join(", ");
    return turns ? `${instruction.text} (${turns})` : instruction.text;
  });
  if (record.capReached) lines.push("상한(50)에 닿아 더 기록하지 못했습니다");
  return lines;
}

export interface PersistentInstructionRecordedProjectionItem {
  treeNodeId: string;
  treeNodeType: string;
  role?: string;
  eventId?: number;
  inputId?: string;
  preparedInputId?: string;
}

/** Shows only records whose exact input and reply are present, after that turn's final row. */
export function placePersistentInstructionRecordedAtTurnEnds<
  T extends PersistentInstructionRecordedProjectionItem,
>(items: T[]): T[] {
  const isRecordNode = (item: T) => item.treeNodeType === "persistent_instruction_recorded";
  const timeline = items.filter((item) => !isRecordNode(item));
  const inputIndexById = new Map<string, number>();
  timeline.forEach((item, index) => {
    if ((item.treeNodeType === "user_message" || item.treeNodeType === "intervention")
      && typeof item.inputId === "string" && item.inputId.length > 0) {
      inputIndexById.set(item.inputId, index);
    }
  });

  const after = new Map<number, T[]>();
  for (const item of items) {
    if (!isRecordNode(item)
      || typeof item.preparedInputId !== "string" || item.preparedInputId.length === 0) continue;
    const anchor = inputIndexById.get(item.preparedInputId);
    if (anchor === undefined) continue;

    let turnEnd = -1;
    let hasReply = false;
    for (let index = anchor + 1; index < timeline.length; index += 1) {
      const next = timeline[index]!;
      if (next.treeNodeType === "user_message" || next.treeNodeType === "intervention") break;
      turnEnd = index;
      if (next.role === "assistant" || next.treeNodeType === "complete" || next.treeNodeType === "turn_summary") {
        hasReply = true;
      }
    }
    if (!hasReply || turnEnd < 0) continue;
    const bucket = after.get(turnEnd) ?? [];
    bucket.push(item);
    after.set(turnEnd, bucket);
  }

  for (const bucket of after.values()) bucket.sort((a, b) => (a.eventId ?? 0) - (b.eventId ?? 0));
  return timeline.flatMap((item, index) => [item, ...(after.get(index) ?? [])]);
}
