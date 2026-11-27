import type { OrchServerEnvironmentConfig } from "../config.js";
import type { ModelCatalogSource } from "../model/model_catalog_source.js";
import {
  findRegisteredAgentProfile,
  type AgentProfileIdentityOverlay,
} from "../node/agent_profile_lookup.js";
import type { InMemoryNodeRegistry } from "../node/registry.js";
import { warnForBlockedChildProcessEnvKeys } from
  "../runtime/child_process_env.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type { RuntimeSessionEventHub } from
  "../runtime/session_event_hub.js";
import type { SessionActionCommandDispatchOptions } from
  "../session/session_action_command_errors.js";
import type { NodeCommandResponse } from "../node/pending_commands.js";
import type { PersistentInstructionsApplyPayload } from
  "@soulstream/wire-schema/persistent-session-instructions";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { resolveCodexCliPath } from "@soulstream/executable-path";
import { CodexExecTurnSummarizer } from
  "./codex_exec_turn_summarizer.js";
import {
  ModelChainTurnSummarizer,
  type ChainAntigravityExecutor,
  type ChainClaudeExecutor,
} from "./turn_summary_model_chain.js";
import { createPersistentInstructionExtractor } from
  "./persistent_instruction_extractor.js";
import {
  TurnSummaryConfigService,
  type TurnSummaryLogger,
} from "./turn_summary_config.js";
import { TurnSummaryPipeline } from "./turn_summary_pipeline.js";
import { createTurnSummaryProviderRouter } from
  "./turn_summary_provider_router.js";
import type { SummarySettingsReader } from "../settings/summary_settings.js";
import { TurnSummaryRepository } from "./turn_summary_repository.js";
import { SessionStoryCompletionSweep } from
  "./session_story_completion_sweep.js";
import { SessionStoryFoldService } from "./session_story_fold_service.js";
import { SessionStoryRepository } from "./session_story_repository.js";
import { TurnSummaryCatchUpSweep } from
  "./turn_summary_catch_up_sweep.js";
import { TurnSummaryCatchUpRepository } from
  "./turn_summary_catch_up_repository.js";

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

export function createPersistentInstructionCommandSender(
  commands: Pick<SessionActionCommandDispatchOptions, "router" | "bridge" | "timeoutMs">,
): (payload: PersistentInstructionsApplyPayload) => Promise<NodeCommandResponse> {
  return async ({ session_id, origin, ops, anchor }) => {
    const routed = await commands.router.routeExistingSessionPendingCommand({
      type: "apply_persistent_session_instructions",
      agentSessionId: session_id,
      origin,
      ops,
      ...(anchor === undefined ? {} : { anchor }),
    }, {
      timeoutMs: commands.timeoutMs,
    });
    return await commands.bridge.sendPendingCommand(routed);
  };
}

export function createLiveTurnSummaryPipeline(options: {
  readonly config: OrchServerEnvironmentConfig;
  readonly configPath: string;
  readonly modelCatalog: ModelCatalogSource;
  readonly summarySettings: SummarySettingsReader;
  readonly sqlResolver: LiveDbSqlResolver;
  readonly registry: InMemoryNodeRegistry;
  readonly agentProfiles?: () => readonly AgentProfileIdentityOverlay[];
  readonly eventHub: Pick<RuntimeSessionEventHub, "publish">;
  readonly commands: Pick<SessionActionCommandDispatchOptions, "router" | "bridge" | "timeoutMs">;
  readonly sessionBroadcaster: Pick<
    InMemorySseReplayBroadcaster<SessionStreamEvent>,
    "append"
  >;
  readonly logger: TurnSummaryLogger;
  readonly warn: (message: string) => void;
  readonly claudeExecutor?: ChainClaudeExecutor;
  readonly antigravityExecutor?: ChainAntigravityExecutor;
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
    options.modelCatalog,
    options.summarySettings,
  );
  const codexPath =
    options.overrides?.turnSummaryCodexPath ??
    resolveCodexCliPath(options.config.codex_cli_path, processEnv)?.path;
  if (codexPath === undefined) {
    options.warn(
      "Codex turn-summary provider disabled: CLI path was not resolved from CODEX_CLI_PATH, PATH, or HOME",
    );
  }
  const codexExec = new CodexExecTurnSummarizer({
    ...(codexPath === undefined ? {} : { codexPath }),
    processEnv,
  });
  const chainDeps = {
    codex: codexExec,
    ...(options.claudeExecutor === undefined ? {} : { claude: options.claudeExecutor }),
    ...(options.antigravityExecutor === undefined
      ? {}
      : { antigravity: options.antigravityExecutor }),
    info: (message: string) => options.logger.info?.(message),
    antigravityEnabled: () => options.registry.isAntigravityEnabled(),
  };
  const codexSummarizer = new ModelChainTurnSummarizer({ ...chainDeps, purpose: "turn" });
  const storyChain = new ModelChainTurnSummarizer({ ...chainDeps, purpose: "session" });
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
    generator: storyChain,
    logger: options.logger,
  });
  const persistentInstructionExtractor = createPersistentInstructionExtractor({
    apiKey: options.config.typesafe_api_key,
    generate: (prompt, config, generationOptions) =>
      codexSummarizer.generate(prompt, config, generationOptions),
  });
  const turnSummaryRepository = new TurnSummaryRepository(options.sqlResolver, {
    resolveAgentName: ({ agentId, nodeId }) => {
      const profile = findRegisteredAgentProfile(
        options.registry,
        agentId,
        nodeId ?? undefined,
        options.agentProfiles?.() ?? [],
      );
      const name = profile?.agent.name;
      return typeof name === "string" && name.trim().length > 0
        ? name.trim()
        : undefined;
    },
  });
  const pipeline = new TurnSummaryPipeline({
    repository: turnSummaryRepository,
    configService,
    summarizer,
    persistentInstructionExtractor,
    eventHub: options.eventHub,
    instructionCommandSender: createPersistentInstructionCommandSender(options.commands),
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
  const catchUpSweep = new TurnSummaryCatchUpSweep({
    repository: new TurnSummaryCatchUpRepository(options.sqlResolver),
    pipeline,
    configService,
    logger: options.logger,
  });
  return {
    accept: (events) => pipeline.accept(events),
    start: () => {
      completionSweep.start();
      catchUpSweep.start();
    },
    drain: async () => {
      completionSweep.stop();
      catchUpSweep.stop();
      await catchUpSweep.drain();
      await pipeline.drain();
      await completionSweep.drain();
    },
  };
}
