import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import type {
  ObserveClaudeBackgroundTaskGenerationParams,
  TerminalizeClaudeBackgroundTaskGenerationParams,
} from "../src/control_plane/repositories/claude_background_task_repository.js";
import {
  ClaudeBackgroundExecutionOwnerConflictError,
  ClaudeBackgroundTaskGenerationRepository,
} from "../src/control_plane/repositories/claude_background_task_generation_repository.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim())
  || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

const SOURCE_NODE = "node-terminal-owner";
const SESSION_ID = "caller-session";
const SDK_SESSION_ID = "sdk-session";
const TASK_ID = "task-terminal-owner";

interface ExecutionOwner {
  registrationId: string;
  commandId: string;
}

const OWNER_ORIGINAL: ExecutionOwner = {
  registrationId: "registration:1111",
  commandId: "command:1111",
};
const OWNER_SAME_REGISTRATION_NEXT_COMMAND: ExecutionOwner = {
  registrationId: "registration:1111",
  commandId: "command:2222",
};
const OWNER_DIFFERENT_REGISTRATION: ExecutionOwner = {
  registrationId: "registration:3333",
  commandId: "command:3333",
};

let harness: FullSchemaPostgresHarness;
let repository: ClaudeBackgroundTaskGenerationRepository;

beforeAll(async () => {
  harness = await createFullSchemaPostgresHarness();
  repository = new ClaudeBackgroundTaskGenerationRepository(
    harness.sql as unknown as SqlClient,
  );
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

function identity(toolUseId: string) {
  return {
    sourceNode: SOURCE_NODE,
    sessionId: SESSION_ID,
    sdkSessionId: SDK_SESSION_ID,
    taskId: TASK_ID,
    initiatingToolUseId: toolUseId,
    generationKey: `generation:${toolUseId}`,
    relationKey: `relation:${toolUseId}`,
    completionId: `completion:${toolUseId}`,
  };
}

function observeParams(
  toolUseId: string,
  owner: ExecutionOwner,
): ObserveClaudeBackgroundTaskGenerationParams {
  return {
    ...identity(toolUseId),
    runnerRegistrationId: owner.registrationId,
    executionCommandId: owner.commandId,
  };
}

function terminalizeParams(
  toolUseId: string,
  owner: ExecutionOwner,
): TerminalizeClaudeBackgroundTaskGenerationParams {
  return {
    ...observeParams(toolUseId, owner),
    observedAt: new Date("2026-11-17T07:07:20.856Z"),
    status: "completed",
    closeReason: "sdk_completed",
    terminalRevision: "revision:2",
    delivery: {
      deliveryId: `delivery:${toolUseId}:revision:2`,
      targetSessionId: null,
      relationKey: identity(toolUseId).relationKey,
      completionId: identity(toolUseId).completionId,
      intent: "runtime_followup",
      source: "claude_runtime_task_followup",
      producerKind: "claude_background_task",
      producerId: TASK_ID,
      producerTerminalRevision: "revision:2",
      payloadHash: `hash:${toolUseId}:revision:2`,
      payload: {
        followup_key: `${SESSION_ID}:generation:${toolUseId}`,
        followup_attempt: 1,
      },
    },
  };
}

async function seedGeneration(options: {
  toolUseId: string;
  status: "running" | "completed";
  owner: ExecutionOwner;
}): Promise<void> {
  const terminal = options.status === "completed";
  await harness.sql`
    INSERT INTO claude_background_task_generations (
      source_node, session_id, sdk_session_id, task_id, initiating_tool_use_id,
      generation_key, relation_key, completion_id,
      runner_registration_id, execution_command_id,
      status, close_reason, description, terminal_revision, terminal_at
    ) VALUES (
      ${SOURCE_NODE}, ${SESSION_ID}, ${SDK_SESSION_ID}, ${TASK_ID}, ${options.toolUseId},
      ${`generation:${options.toolUseId}`}, ${`relation:${options.toolUseId}`},
      ${`completion:${options.toolUseId}`},
      ${options.owner.registrationId}, ${options.owner.commandId},
      ${options.status}, ${terminal ? "sdk_completed" : null}, 'seeded background task',
      ${terminal ? "revision:1" : null},
      ${terminal ? new Date("2026-11-17T07:06:32.119Z") : null}
    )
  `;
}

async function storedOwner(toolUseId: string): Promise<{
  status: string;
  close_reason: string | null;
  runner_registration_id: string | null;
  execution_command_id: string | null;
}> {
  const rows = await harness.sql<Array<{
    status: string;
    close_reason: string | null;
    runner_registration_id: string | null;
    execution_command_id: string | null;
  }>>`
    SELECT status, close_reason, runner_registration_id, execution_command_id
    FROM claude_background_task_generations
    WHERE source_node = ${SOURCE_NODE}
      AND session_id = ${SESSION_ID}
      AND sdk_session_id = ${SDK_SESSION_ID}
      AND task_id = ${TASK_ID}
      AND initiating_tool_use_id = ${toolUseId}
  `;
  return rows[0]!;
}

function expectConflict(error: unknown): void {
  expect(error).toBeInstanceOf(ClaudeBackgroundExecutionOwnerConflictError);
  const conflict = error as ClaudeBackgroundExecutionOwnerConflictError;
  expect(conflict.code).toBe("CLAUDE_BACKGROUND_EXECUTION_OWNER_CONFLICT");
  expect(conflict.statusCode).toBe(409);
}

describePostgres("Claude background generation terminal owner", () => {
  it(
    "accepts a terminal generation whose next turn carries a new command without a false conflict",
    async () => {
      const toolUseId = "toolu_terminal_same_registration";
      await seedGeneration({ toolUseId, status: "completed", owner: OWNER_ORIGINAL });

      const result = await repository.terminalize(
        terminalizeParams(toolUseId, OWNER_SAME_REGISTRATION_NEXT_COMMAND),
      );

      expect(result).toMatchObject({
        accepted: false,
        row: {
          status: "completed",
          close_reason: "sdk_completed",
          runner_registration_id: OWNER_ORIGINAL.registrationId,
          execution_command_id: OWNER_ORIGINAL.commandId,
        },
      });
      await expect(storedOwner(toolUseId)).resolves.toEqual({
        status: "completed",
        close_reason: "sdk_completed",
        runner_registration_id: OWNER_ORIGINAL.registrationId,
        execution_command_id: OWNER_ORIGINAL.commandId,
      });
    },
    30_000,
  );

  it(
    "accepts a terminal generation written with a different registration without a false conflict",
    async () => {
      const toolUseId = "toolu_terminal_different_registration";
      await seedGeneration({ toolUseId, status: "completed", owner: OWNER_ORIGINAL });

      const result = await repository.terminalize(
        terminalizeParams(toolUseId, OWNER_DIFFERENT_REGISTRATION),
      );

      expect(result).toMatchObject({
        accepted: false,
        row: {
          status: "completed",
          close_reason: "sdk_completed",
          runner_registration_id: OWNER_ORIGINAL.registrationId,
          execution_command_id: OWNER_ORIGINAL.commandId,
        },
      });
      await expect(storedOwner(toolUseId)).resolves.toEqual({
        status: "completed",
        close_reason: "sdk_completed",
        runner_registration_id: OWNER_ORIGINAL.registrationId,
        execution_command_id: OWNER_ORIGINAL.commandId,
      });
    },
    30_000,
  );

  it(
    "still rejects a running generation claimed by a new command of the same registration",
    async () => {
      const toolUseId = "toolu_running_same_registration";
      await seedGeneration({ toolUseId, status: "running", owner: OWNER_ORIGINAL });

      const error = await repository
        .terminalize(terminalizeParams(toolUseId, OWNER_SAME_REGISTRATION_NEXT_COMMAND))
        .then(() => null, (thrown: unknown) => thrown);

      expectConflict(error);
      await expect(storedOwner(toolUseId)).resolves.toEqual({
        status: "running",
        close_reason: null,
        runner_registration_id: OWNER_ORIGINAL.registrationId,
        execution_command_id: OWNER_ORIGINAL.commandId,
      });
    },
    30_000,
  );

  it(
    "still rejects observing a terminal generation with another execution owner",
    async () => {
      const toolUseId = "toolu_terminal_observe_other_owner";
      await seedGeneration({ toolUseId, status: "completed", owner: OWNER_ORIGINAL });

      const error = await repository
        .observe(observeParams(toolUseId, OWNER_DIFFERENT_REGISTRATION))
        .then(() => null, (thrown: unknown) => thrown);

      expectConflict(error);
      await expect(storedOwner(toolUseId)).resolves.toEqual({
        status: "completed",
        close_reason: "sdk_completed",
        runner_registration_id: OWNER_ORIGINAL.registrationId,
        execution_command_id: OWNER_ORIGINAL.commandId,
      });
    },
    30_000,
  );
});
