import { randomUUID } from "node:crypto";
import type {
  Options as ClaudeSdkOptions,
  Query as ClaudeSdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeRunOptions } from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_client_event.js";
import {
  buildClaudeCompactRunOptions,
  consumeClaudeCompact,
  readCompactedContextUsage,
} from "./claude_sdk_compact.js";
import type { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import type { ClaudeSdkQueryFn } from "./claude_sdk_client.js";
import type { ClaudeSdkPersistentSession } from "./claude_sdk_persistent_session.js";
import { buildClaudeSdkOptions } from "./claude_sdk_options.js";
import { createEventQueue } from "./claude_sdk_event_queue.js";
import type { ClaudeSdkToolPermissionController } from "./claude_sdk_tool_permissions.js";
import type { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";
import type { CompactedContextUsage } from "./protocol.js";

export interface ClaudeSdkClientCompactOptions {
  queryFn: ClaudeSdkQueryFn;
  logger: Logger;
  resolveClaudeExecutablePath(): string | undefined;
  eventMapper: ClaudeSdkEventMapper;
  runtimeState: ClaudeRuntimeState;
  toolPermissionController: ClaudeSdkToolPermissionController;
  lastRunOptions(): ClaudeRunOptions | null;
  lastWorkspaceDir(): string | null;
  lastEnv(): Record<string, string> | undefined;
  persistentSession(): ClaudeSdkPersistentSession | null;
  setActiveQuery(query: ClaudeSdkQuery | null): void;
  isActiveQuery(query: ClaudeSdkQuery): boolean;
  trackChildExit(closed: Promise<void>): void;
  waitForChildExit(): Promise<void>;
  closePersistentAndSettle(persistent: ClaudeSdkPersistentSession): Promise<void>;
  normalizeExecutionError(error: unknown, executablePath?: string): Error;
}

export async function compactClaudeSdkSession(
  sessionId: string,
  context: ClaudeSdkClientCompactOptions,
): Promise<CompactedContextUsage | undefined> {
  const previousOptions = context.lastRunOptions();
  const workspaceDir = context.lastWorkspaceDir();
  if (!workspaceDir || !previousOptions) {
    throw new Error("ClaudeSdkClient.compact requires a previous run context");
  }

  const persistentSession = context.persistentSession();
  if (persistentSession?.snapshot().queryLifecycle === "open") {
    const options = buildClaudeCompactRunOptions(
      previousOptions,
      workspaceDir,
      sessionId,
      context.lastEnv(),
    );
    options.inputUuid = randomUUID();
    let observedCompactBoundary = false;
    for await (const event of persistentSession.runTurn(
      options,
      new AbortController().signal,
    )) {
      if (event.type === "compact_completed") observedCompactBoundary = true;
    }
    if (!observedCompactBoundary) {
      throw new Error("Claude compact finished without compact_boundary");
    }
    return await readCompactedContextUsage(persistentSession.query(), context.logger);
  }

  if (persistentSession && previousOptions.trackChildExit) {
    await context.closePersistentAndSettle(persistentSession);
  } else if (previousOptions.trackChildExit) {
    await context.waitForChildExit();
  }

  const controller = new AbortController();
  const output = createEventQueue<ClaudeClientEvent>();
  const queryOptions = buildClaudeSdkOptions({
    options: buildClaudeCompactRunOptions(
      previousOptions,
      workspaceDir,
      sessionId,
      context.lastEnv(),
    ),
    abortController: controller,
    output,
    logger: context.logger,
    resolveClaudeExecutablePath: context.resolveClaudeExecutablePath,
    eventMapper: context.eventMapper,
    runtimeState: context.runtimeState,
    toolPermissionController: context.toolPermissionController,
    ...(previousOptions.trackChildExit
      ? { onChildProcessClosed: (closed) => context.trackChildExit(closed) }
      : {}),
  });
  let query: ClaudeSdkQuery;
  try {
    query = context.queryFn({ prompt: "/compact", options: queryOptions });
  } catch (error) {
    throw context.normalizeExecutionError(error, queryOptions.pathToClaudeCodeExecutable);
  }
  context.setActiveQuery(query);

  try {
    await consumeClaudeCompact(query);
  } catch (error) {
    throw context.normalizeExecutionError(error, queryOptions.pathToClaudeCodeExecutable);
  } finally {
    if (context.isActiveQuery(query)) context.setActiveQuery(null);
    if (previousOptions.trackChildExit) await context.waitForChildExit();
    await previousOptions.onAccountQueryClosed?.();
  }
  return undefined;
}
