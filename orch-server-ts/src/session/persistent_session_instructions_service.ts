import type { FastifyRequest } from "fastify";
import {
  parsePersistentInstructionsApplyPayload,
  readPersistentInstructions,
  type PersistentInstruction,
  type PersistentInstructionsApplyPayload,
} from "@soulstream/wire-schema/persistent-session-instructions";
import { readPersistentEnabled } from "@soulstream/wire-schema/persistent-session-settings";

import type { ServiceCaller } from "../auth/service_caller.js";
import type { HostSessionRow } from "../control_plane/repositories/session_read_repository.js";
import type { NodeCommandResponse } from "../node/pending_commands.js";
import type { ExistingSessionActionPayload } from "./session_action_command_payloads.js";
import type { SessionActionCommandDispatchOptions } from "./session_action_command_errors.js";
import type { SessionResourceAccessProvider } from "./session_resource_access.js";
import { PersistentSessionApiError } from "./persistent_session_api_error.js";

type CallerRequest = FastifyRequest | ServiceCaller;
type PersistentInstructionsAck = NodeCommandResponse & {
  type: "persistent_session_instructions_applied";
  results: Array<{
    status: "ok" | "cap_reached" | "not_found";
    item?: PersistentInstruction;
  }>;
};
type PersistentInstructionView = Pick<
  PersistentInstruction,
  "id" | "text" | "source_turns" | "created_at" | "updated_at" | "origin"
>;

export type PersistentSessionInstructionsServiceDeps = {
  reads: () => Promise<{ getSession(sessionId: string): Promise<HostSessionRow | null> }>;
  access: Pick<SessionResourceAccessProvider, "requireSessionAccess">;
  commands: Pick<SessionActionCommandDispatchOptions, "router" | "bridge" | "timeoutMs">;
};

export class PersistentSessionInstructionsService {
  constructor(private readonly deps: PersistentSessionInstructionsServiceDeps) {}

  async list(request: CallerRequest, sessionId: string): Promise<{ instructions: PersistentInstructionView[] }> {
    const row = await this.requirePersistentRow(request, sessionId);
    const instructions = readPersistentInstructions(row.metadata)
      .filter((instruction) => instruction.status === "active")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map(({ id, text, source_turns, created_at, updated_at, origin }) => ({
        id, text, source_turns, created_at, updated_at, origin,
      }));
    return { instructions };
  }

  async add(
    request: CallerRequest,
    sessionId: string,
    input: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const payload = parseInstructionAddBody(sessionId, input);
    await this.requirePersistentRow(request, sessionId);
    const result = firstInstructionResult(await this.sendInstructions(payload));
    if (result.status === "cap_reached") return { status: 409, body: { error: "cap_reached" } };
    if (result.status !== "ok" || result.item === undefined) {
      throw new Error(`Unexpected persistent instruction add result: ${result.status}`);
    }
    return { status: 201, body: { instruction: result.item } };
  }

  async update(
    request: CallerRequest,
    sessionId: string,
    instructionId: string,
    input: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const payload = parseInstructionUpdateBody(sessionId, instructionId, input);
    await this.requirePersistentRow(request, sessionId);
    const result = firstInstructionResult(await this.sendInstructions(payload));
    if (result.status === "not_found") return { status: 404, body: { error: "not_found" } };
    if (result.status !== "ok" || result.item === undefined) {
      throw new Error(`Unexpected persistent instruction update result: ${result.status}`);
    }
    return { status: 200, body: { instruction: result.item } };
  }

  private async requirePersistentRow(request: CallerRequest, sessionId: string): Promise<HostSessionRow> {
    await this.deps.access.requireSessionAccess({ request, sessionId });
    const row = await (await this.deps.reads()).getSession(sessionId);
    if (row === null) throw new PersistentSessionApiError(404, "SESSION_NOT_FOUND", "Session not found");
    if (row.session_type === "llm") {
      throw new PersistentSessionApiError(422, "INVALID_REQUEST", "LLM sessions cannot be persistent");
    }
    if (!readPersistentEnabled(row.metadata)) {
      throw new PersistentSessionApiError(409, "NOT_PERSISTENT", "Session is not a persistent agent session");
    }
    return row;
  }

  private async sendInstructions(
    payload: PersistentInstructionsApplyPayload,
  ): Promise<PersistentInstructionsAck["results"]> {
    const command: ExistingSessionActionPayload<"apply_persistent_session_instructions"> = {
      type: "apply_persistent_session_instructions",
      agentSessionId: payload.session_id,
      origin: payload.origin,
      ops: payload.ops,
      ...(payload.anchor === undefined ? {} : { anchor: payload.anchor }),
    };
    const routed = await this.deps.commands.router.routeExistingSessionPendingCommand(command, {
      timeoutMs: this.deps.commands.timeoutMs,
    });
    const response = await this.deps.commands.bridge.sendPendingCommand(routed) as PersistentInstructionsAck;
    if (response.type !== "persistent_session_instructions_applied") {
      throw new Error(`Unexpected persistent instruction response: ${response.type}`);
    }
    return response.results;
  }
}

function parseInstructionAddBody(sessionId: string, input: unknown): PersistentInstructionsApplyPayload {
  const body = requireObjectBody(input);
  rejectInstructionUnknownKeys(body, ["text"]);
  return parseInstructionPayload(sessionId, { op: "add", text: body.text });
}

function parseInstructionUpdateBody(
  sessionId: string,
  instructionId: string,
  input: unknown,
): PersistentInstructionsApplyPayload {
  const body = requireObjectBody(input);
  rejectInstructionUnknownKeys(body, ["text", "status", "remove_source_turns", "remove_source_event_ids"]);
  return parseInstructionPayload(sessionId, {
    op: "update",
    id: instructionId,
    ...(body.text === undefined ? {} : { text: body.text }),
    ...(body.status === undefined ? {} : { status: body.status }),
    ...(body.remove_source_turns === undefined ? {} : { remove_source_turns: body.remove_source_turns }),
    ...(body.remove_source_event_ids === undefined ? {} : { remove_source_event_ids: body.remove_source_event_ids }),
  });
}

function parseInstructionPayload(sessionId: string, op: Record<string, unknown>): PersistentInstructionsApplyPayload {
  const parsed = parsePersistentInstructionsApplyPayload({
    session_id: sessionId,
    origin: "user",
    ops: [op],
  });
  if (!parsed.ok) throw new PersistentSessionApiError(400, "INVALID_REQUEST", parsed.message);
  return parsed.value;
}

function rejectInstructionUnknownKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new PersistentSessionApiError(400, "INVALID_REQUEST", `${unknown} is not supported`);
  }
}

function firstInstructionResult(results: PersistentInstructionsAck["results"]) {
  const result = results[0];
  if (result === undefined) throw new Error("Persistent instruction ACK returned no result");
  return result;
}

function requireObjectBody(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PersistentSessionApiError(400, "INVALID_REQUEST", "Request body must be a JSON object");
  }
  return input as Record<string, unknown>;
}
