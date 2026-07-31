import type { OrchServerEnvironmentConfig } from "../config.js";
import { findRegisteredAgentProfile } from
  "../node/agent_profile_lookup.js";
import type { InMemoryNodeRegistry } from "../node/registry.js";
import { warnForBlockedChildProcessEnvKeys } from
  "../runtime/child_process_env.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type { RuntimeSessionEventHub } from
  "../runtime/session_event_hub.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { resolveCodexCliPath } from "./codex_cli_path.js";
import { CodexExecTurnSummarizer } from
  "./codex_exec_turn_summarizer.js";
import {
  TurnSummaryConfigService,
  type TurnSummaryLogger,
} from "./turn_summary_config.js";
import { TurnSummaryPipeline } from "./turn_summary_pipeline.js";
import { createTurnSummaryProviderRouter } from
  "./turn_summary_provider_router.js";
import { TurnSummaryRepository } from "./turn_summary_repository.js";
import { SessionStoryCompletionSweep } from
  "./session_story_completion_sweep.js";
import { SessionStoryFoldService } from "./session_story_fold_service.js";
import { SessionStoryRepository } from "./session_story_repository.js";

export type LiveTurnSummaryPipeline = Pick<
  TurnSummaryPipeline,
  "accept" | "drain"
> & { readonly start?: () => void };

export type LiveTurnSummaryProductionOverrides = {
  readonly turnSummaryConfigPath?: string;
  readonly turnSummaryCodexPath?: string;
  readonly turnSummaryProcessEnv?: Readonly<Record<string, string | undefined>>;
  readonly turnSummaryPipeline?: LiveTurnSummaryPipeline;
};

export function createLiveTurnSummaryPipeline(options: {
  readonly config: OrchServerEnvironmentConfig;
  readonly configPath: string;
  readonly sqlResolver: LiveDbSqlResolver;
  readonly registry: InMemoryNodeRegistry;
  readonly eventHub: Pick<RuntimeSessionEventHub, "publish">;
  readonly sessionBroadcaster: Pick<
    InMemorySseReplayBroadcaster<SessionStreamEvent>,
    "append"
  >;
  readonly logger: TurnSummaryLogger;
  readonly warn: (message: string) => void;
  readonly overrides?: LiveTurnSummaryProductionOverrides;
}): LiveTurnSummaryPipeline {
  if (options.overrides?.turnSummaryPipeline !== undefined) {
    return options.overrides.turnSummaryPipeline;
  }
  const processEnv = options.overrides?.turnSummaryProcessEnv ?? process.env;
  warnForBlockedChildProcessEnvKeys(processEnv, options.warn);
  const configService = new TurnSummaryConfigService(
    options.configPath,
    options.logger,
  );
  const codexPath =
    options.overrides?.turnSummaryCodexPath ??
    resolveCodexCliPath(processEnv)?.path;
  if (codexPath === undefined) {
    options.warn(
      "Codex turn-summary provider disabled: CLI path was not resolved from CODEX_CLI_PATH, PATH, or HOME",
    );
  }
  const codexSummarizer = new CodexExecTurnSummarizer({
    ...(codexPath === undefined ? {} : { codexPath }),
    processEnv,
  });
  const summarizer = createTurnSummaryProviderRouter({
    codex: codexSummarizer,
    ...(options.config.turn_summary_openai_key
      ? { openAiApiKey: options.config.turn_summary_openai_key }
      : {}),
    info: (message) => options.logger.info?.(message),
  });
  const storyRepository = new SessionStoryRepository(options.sqlResolver);
  const storyFolder = new SessionStoryFoldService({
    repository: storyRepository,
    configService,
    generator: codexSummarizer,
    logger: options.logger,
  });
  const pipeline = new TurnSummaryPipeline({
    repository: new TurnSummaryRepository(options.sqlResolver, {
      resolveAgentName: ({ agentId, nodeId }) => {
        const profile = findRegisteredAgentProfile(
          options.registry,
          agentId,
          nodeId ?? undefined,
        );
        const name = profile?.agent.name;
        return typeof name === "string" && name.trim().length > 0
          ? name.trim()
          : undefined;
      },
    }),
    configService,
    summarizer,
    eventHub: options.eventHub,
    sessionBroadcaster: options.sessionBroadcaster,
    storyFolder,
    logger: options.logger,
  });
  const completionSweep = new SessionStoryCompletionSweep({
    repository: storyRepository,
    folder: storyFolder,
    configService,
    logger: options.logger,
  });
  return {
    accept: (events) => pipeline.accept(events),
    start: () => completionSweep.start(),
    drain: async () => {
      completionSweep.stop();
      await pipeline.drain();
      await completionSweep.drain();
    },
  };
}
