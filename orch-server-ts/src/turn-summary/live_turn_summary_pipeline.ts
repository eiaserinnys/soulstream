import type { OrchServerEnvironmentConfig } from "../config.js";
import { warnForBlockedChildProcessEnvKeys } from
  "../runtime/child_process_env.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type { RuntimeSessionEventHub } from
  "../runtime/session_event_hub.js";
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

export type LiveTurnSummaryPipeline = Pick<
  TurnSummaryPipeline,
  "accept" | "drain"
>;

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
  readonly eventHub: Pick<RuntimeSessionEventHub, "publish">;
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
  const summarizer = createTurnSummaryProviderRouter({
    codex: new CodexExecTurnSummarizer({
      ...(codexPath === undefined ? {} : { codexPath }),
      processEnv,
    }),
    ...(options.config.turn_summary_openai_key
      ? { openAiApiKey: options.config.turn_summary_openai_key }
      : {}),
    info: (message) => options.logger.info?.(message),
  });
  return new TurnSummaryPipeline({
    repository: new TurnSummaryRepository(options.sqlResolver),
    configService,
    summarizer,
    eventHub: options.eventHub,
    logger: options.logger,
  });
}
