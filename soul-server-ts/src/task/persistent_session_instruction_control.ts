import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import {
  buildPersistentInstructionsMetadataEntry,
  readPersistentInstructions,
  type PersistentInstruction,
  type PersistentInstructionOp,
  type PersistentInstructionOrigin,
} from "@soulstream/wire-schema/persistent-session-instructions";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { Task } from "./task_models.js";

export interface ApplyPersistentInstructionsInput {
  origin: PersistentInstructionOrigin;
  ops: PersistentInstructionOp[];
  anchor?: string;
}

export interface PersistentInstructionOpResult {
  status: "ok" | "cap_reached" | "not_found";
  item?: PersistentInstruction;
}

export interface ApplyPersistentInstructionsResult {
  sessionId: string;
  results: PersistentInstructionOpResult[];
}

const MAX_ACTIVE_PERSISTENT_INSTRUCTIONS = 50;

export class PersistentSessionInstructionControl {
  constructor(
    private readonly resolvePersistentTask: (sessionId: string) => Promise<Task>,
    private readonly persistence?: EventPersistence,
    private readonly logger?: Pick<Logger, "warn">,
  ) {}

  async listPersistentInstructions(sessionId: string): Promise<PersistentInstruction[]> {
    const task = await this.resolvePersistentTask(sessionId);
    return readPersistentInstructions(task.metadata)
      .filter((item) => item.status === "active")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  async applyPersistentInstructions(
    sessionId: string,
    input: ApplyPersistentInstructionsInput,
  ): Promise<ApplyPersistentInstructionsResult> {
    const task = await this.resolvePersistentTask(sessionId);
    if (!this.persistence) throw new Error("Persistent session metadata persistence unavailable");

    const instructions = readPersistentInstructions(task.metadata);
    const results: PersistentInstructionOpResult[] = [];
    const extractedEvents: Array<{
      id: string;
      text: string;
      source_turns: string[];
      action: "added" | "updated";
    }> = [];
    let capReached = false;
    const updatedAt = new Date().toISOString();

    for (const op of input.ops) {
      if (op.op === "add") {
        if (instructions.filter((item) => item.status === "active").length >= MAX_ACTIVE_PERSISTENT_INSTRUCTIONS) {
          capReached = true;
          results.push({ status: "cap_reached" });
          continue;
        }
        const item: PersistentInstruction = {
          id: randomUUID(),
          text: op.text.trim(),
          source_turns: unique(op.source_turns ?? []),
          source_event_ids: unique(op.source_event_ids ?? []),
          created_at: updatedAt,
          updated_at: updatedAt,
          status: "active",
          origin: input.origin,
        };
        instructions.push(item);
        results.push({ status: "ok", item });
        if (input.origin === "extracted") extractedEvents.push(instructionEvent(item, "added"));
        continue;
      }

      const index = instructions.findIndex((item) => item.id === op.id);
      if (index < 0) {
        results.push({ status: "not_found" });
        continue;
      }
      const current = instructions[index]!;
      if (op.op === "touch") {
        const item: PersistentInstruction = {
          ...current,
          source_turns: unique([...current.source_turns, ...op.source_turns]),
          source_event_ids: unique([...current.source_event_ids, ...op.source_event_ids]),
          updated_at: updatedAt,
        };
        instructions[index] = item;
        results.push({ status: "ok", item });
        if (input.origin === "extracted") extractedEvents.push(instructionEvent(item, "updated"));
        continue;
      }

      if (op.status === "active" && current.status === "removed"
        && instructions.filter((item) => item.status === "active").length >= MAX_ACTIVE_PERSISTENT_INSTRUCTIONS) {
        capReached = true;
        results.push({ status: "cap_reached" });
        continue;
      }
      const item: PersistentInstruction = {
        ...current,
        ...(op.text === undefined ? {} : { text: op.text.trim() }),
        ...(op.status === undefined ? {} : { status: op.status }),
        ...(op.remove_source_turns === undefined
          ? {}
          : { source_turns: current.source_turns.filter((turn) => !op.remove_source_turns!.includes(turn)) }),
        ...(op.remove_source_event_ids === undefined
          ? {}
          : { source_event_ids: current.source_event_ids.filter((eventId) => !op.remove_source_event_ids!.includes(eventId)) }),
        updated_at: updatedAt,
      };
      instructions[index] = item;
      results.push({ status: "ok", item });
    }

    if (input.ops.length > 0) {
      const entry = buildPersistentInstructionsMetadataEntry(instructions);
      await this.persistence.enqueueMetadataEffect(sessionId, entry, {
        replaceExistingType: "persistent_instructions",
        waitForAck: true,
      });
      task.metadata = [
        ...(task.metadata ?? []).filter((metadata) => metadata.type !== "persistent_instructions"),
        entry,
      ];
    }

    if (input.origin === "extracted" && (extractedEvents.length > 0 || capReached)) {
      await this.recordExtractedInstructions(sessionId, extractedEvents, capReached, input.anchor);
    }
    return { sessionId, results };
  }

  private async recordExtractedInstructions(
    sessionId: string,
    instructions: Array<{ id: string; text: string; source_turns: string[]; action: "added" | "updated" }>,
    capReached: boolean,
    anchor?: string,
  ): Promise<void> {
    if (!this.persistence?.enqueueEvent) return;
    const event = {
      type: "debug",
      kind: "persistent_instruction_recorded",
      instructions,
      cap_reached: capReached,
      ...(anchor === undefined ? {} : { input_id: anchor }),
      timestamp: Date.now() / 1_000,
    } as unknown as SSEEventPayload;
    try {
      await this.persistence.enqueueEvent(sessionId, event);
    } catch (error) {
      this.logger?.warn({ sessionId, err: error }, "persistent instruction event could not be recorded");
    }
  }
}

function instructionEvent(
  item: PersistentInstruction,
  action: "added" | "updated",
): { id: string; text: string; source_turns: string[]; action: "added" | "updated" } {
  return { id: item.id, text: item.text, source_turns: item.source_turns, action };
}

function unique<T extends string | number>(items: T[]): T[] {
  return [...new Set(items)];
}
