import dotenv from "dotenv";
import { ZodError } from "zod";

import { loadAgentRegistry } from "./agent_registry.js";
import { FileAttachmentStore } from "./attachments/file_manager.js";
import { CatalogService } from "./catalog/catalog_service.js";
import { parseEnv } from "./config.js";
import { SessionDB } from "./db/session_db.js";
import { EventPersistence } from "./db/event_persistence.js";
import { CodexEngineAdapter } from "./engine/codex_adapter.js";
import { createLogger } from "./logger.js";
import { wsToHttpBase } from "./mcp/orch_proxy.js";
import type { McpRuntime, OrchProxyConfig } from "./mcp/runtime.js";
import { buildServer, startServer } from "./server.js";
import { TaskCompletionNotifier } from "./task/completion_notifier.js";
import { TaskExecutor, type EngineFactory } from "./task/task_executor.js";
import {
  TaskManager,
  type StartExecutionCallback,
} from "./task/task_manager.js";
import { ExecutionContextBuilder } from "./context/context_builder.js";
import { UpstreamAdapter } from "./upstream/adapter.js";
import { SessionBroadcaster } from "./upstream/session_broadcaster.js";

// Haniel cwd는 ./services/soulstream — install.configs.soul-server-ts-env path와 정합.
// `.env`(Python soul-server용)와 *분리* 유지 — SOULSTREAM_NODE_ID 충돌 회피
// (분석 캐시 20260517-0500-phase-b1-hotfix-fastify5-env.md §1.2 D2).
//
// `override: true` — `.env.soul-server-ts`를 단일 정본으로 강제. pm2 god이 부팅 시점
// 셸 env(Python soul-server의 PORT/SOULSTREAM_NODE_ID/LOG_LEVEL 등)를 자식 프로세스에
// 상속시켜도 .env 파일이 마지막에 덮어쓰도록 한다 (design-principles §3 정본 하나).
// 부재 키는 부모 env 그대로 받음 — override는 *.env에 존재하는 키만* 덮어쓴다.
// 회로: 260517 운영 사고(pm2 restart 209회 + EADDRINUSE + nodeId 충돌)를 영구 차단.
const DOTENV_PATH = ".env.soul-server-ts";
const dotenvResult = dotenv.config({ path: DOTENV_PATH, override: true });
if (dotenvResult.error) {
  // logger 생성 *전*이라 console.warn 사용. fail-silent를 깨고 디버깅 가시성 확보.
  // path·cwd 둘 다 노출하여 운영자가 파일명 의심·경로 의심을 한 번에 가를 수 있게 함.
  // 파일 부재 시 후속 zod parseEnv가 필수 키 미정으로 ZodError throw → process.exit(1).
  console.warn(
    `[soul-server-ts] dotenv: "${DOTENV_PATH}" not loaded from cwd=${process.cwd()}: ${dotenvResult.error.message}`,
  );
}

async function main(): Promise<void> {
  let env;
  try {
    env = parseEnv(process.env);
  } catch (err) {
    if (err instanceof ZodError) {
      // 명시 실패 (design-principles §4) — 사람이 읽을 수 있는 형태로 stderr.
      console.error("Environment validation failed:");
      for (const issue of err.issues) {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
    } else {
      console.error("Environment parse threw:", err);
    }
    process.exit(1);
  }

  const logger = createLogger(env.LOG_LEVEL);

  // agent_registry yaml 로딩 — 부재 시 명확한 stderr + exit(1)
  // (Haniel 카드 미적용 상태에서 본 PR 머지·기동 시 명확한 오류 메시지 의무)
  let agentRegistry;
  try {
    agentRegistry = loadAgentRegistry(env.AGENTS_CONFIG_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Failed to load agent registry from "${env.AGENTS_CONFIG_PATH}": ${message}`,
    );
    console.error(
      "Hint: AGENTS_CONFIG_PATH env or Haniel install.configs.soul-server-ts-env may be missing.",
    );
    process.exit(1);
  }

  logger.info(
    {
      nodeId: env.SOULSTREAM_NODE_ID,
      upstreamUrl: env.SOULSTREAM_UPSTREAM_URL,
      environment: env.ENVIRONMENT,
      host: env.HOST,
      port: env.PORT,
      agentsConfigPath: env.AGENTS_CONFIG_PATH,
      agentCount: agentRegistry.list().length,
    },
    "soul-server-ts starting (B-3 task lifecycle + DB)",
  );

  // DB 초기화 (postgres.js)
  const db = new SessionDB(env.DATABASE_URL);

  // === wiring (HTTP 서버 시작 *전*에 runtime 의존성 구축) ===
  // SessionBroadcaster는 send 함수가 필요한데 UpstreamAdapter가 그것을 제공.
  // 순환 의존 회피: 두 단계로 구성 — late-bound send를 SessionBroadcaster에 주입.
  let upstreamAdapter: UpstreamAdapter | null = null;
  const send = async (data: unknown): Promise<void> => {
    if (!upstreamAdapter) {
      logger.warn({ data }, "broadcast send called before UpstreamAdapter ready");
      return;
    }
    await upstreamAdapter.sendBroadcast(data);
  };

  const broadcaster = new SessionBroadcaster(send, agentRegistry, env.SOULSTREAM_NODE_ID);
  const persistence = new EventPersistence(db, broadcaster, logger);

  // B-6 context_builder: 신규 task 첫 turn 진입 시 folder_prompt + atom_context + soulstream_item을
  // 합성한 prompt를 codex에 전달. atom env 미설정이면 atom 호출 skip (graceful).
  //
  // Phase A context 정본 진입점 (atom d7a1ad86 차단): TaskManager가 _addInterventionAutoResume에서
  // buildResumeContextItems 호출에 사용. TaskManager 생성 *전*에 wiring하여 의존성 주입.
  const contextBuilder = new ExecutionContextBuilder(
    db,
    agentRegistry,
    {
      nodeId: env.SOULSTREAM_NODE_ID,
      atom: {
        enabled: Boolean(env.ATOM_ENABLED),
        serverUrl: env.ATOM_SERVER_URL ?? "",
        apiKey: env.ATOM_API_KEY ?? "",
      },
    },
    logger,
  );

  const taskManager = new TaskManager(
    env.SOULSTREAM_NODE_ID,
    db,
    broadcaster,
    logger,
    // B-5: intervention_sent 영속화 정본 (Python `task_executor.py:352-389` 정합).
    persistence,
    // Phase A context 정본 진입점: _addInterventionAutoResume이 user_message wire에 context 박음.
    contextBuilder,
    agentRegistry,
  );

  // EngineFactory — backend별 분기. 본 PR은 codex 전용.
  const engineFactory: EngineFactory = (agent) => {
    if (agent.backend === "codex") {
      return new CodexEngineAdapter(
        {
          workspaceDir: agent.workspace_dir,
          apiKey: env.CODEX_API_KEY,
          // process.env 명시 전달 — 어댑터가 빈 OPENAI_API_KEY/CODEX_API_KEY를 sanitize한 뒤
          // SDK의 envOverride로 넘겨 codex CLI 자식의 ~/.codex/auth.json OAuth fallback을 보호한다
          // (분석 캐시 `20260517-1157-codex-ts-oauth-401.md`).
          processEnv: process.env,
        },
        logger,
      );
    }
    throw new Error(
      `Unsupported backend "${agent.backend}" in soul-server-ts (Codex 전담 노드, agent=${agent.id})`,
    );
  };
  // B-7 피위임 완료 회송 wiring (분석 캐시
  // `roselin/.local/artifacts/analysis/20260518-2125-ts-delegation-return.md` §3-3).
  //
  // 순환 해결 — TaskExecutor → CompletionNotifier → onResume 클로저 → TaskExecutor:
  //   - notifier 모듈은 TaskExecutor를 import하지 않음 (컴파일 시점 비순환)
  //   - onResume이 `let taskExecutor`를 lazy capture (런타임 시점 wiring)
  //   - notifier 생성을 taskExecutor 생성보다 먼저 — 생성자 마지막 인자로 주입
  //   - onResume 자체는 *parent가 terminal일 때*(addIntervention auto-resume 분기)만 호출됨.
  //     호출 시점에는 taskExecutor가 이미 초기화되어 있음 (worker 사이클 시작 후)
  //
  // contextBuilder는 PR #70(89b13d9) 머지로 *taskManager 생성 전* L115-127로 이동됨 —
  // 본 wiring은 그 결과를 그대로 사용하고 중복 정의하지 않는다 (design-principles §3 정본 하나).
  let taskExecutor: TaskExecutor;
  const onResume: StartExecutionCallback = (task) => {
    if (!task.profileId) {
      logger.warn(
        { sessionId: task.agentSessionId },
        "onResume: task.profileId 없음 — auto-resume skip",
      );
      return;
    }
    const agent = agentRegistry.get(task.profileId);
    if (!agent) {
      logger.warn(
        { sessionId: task.agentSessionId, profileId: task.profileId },
        "onResume: agentRegistry에서 profile 찾지 못함 — auto-resume skip",
      );
      return;
    }
    taskExecutor.startExecution(task, agent);
  };

  const orchProxyConfig = env.MCP_ENABLED ? buildOrchProxyConfig(env) : undefined;
  const completionNotifier = new TaskCompletionNotifier(
    env.SOULSTREAM_NODE_ID,
    taskManager,
    agentRegistry,
    onResume,
    logger,
    orchProxyConfig,
  );

  taskExecutor = new TaskExecutor(
    engineFactory,
    db,
    persistence,
    broadcaster,
    logger,
    contextBuilder,
    completionNotifier,
  );

  // CatalogService — MCP catalog 도구·set_session_name이 경유.
  // 본 카드(soul-server-ts Streamable HTTP MCP) 신설. dashboard 진입점이 같은 service를
  // 경유하면 정책 정본 단일 (design-principles §3).
  const catalogService = new CatalogService(db, broadcaster);

  // MCP runtime — MCP_ENABLED=true일 때 server.ts가 라우트 등록에 사용.
  const mcpRuntime: McpRuntime = {
    nodeId: env.SOULSTREAM_NODE_ID,
    db,
    taskManager,
    taskExecutor,
    agentRegistry,
    catalogService,
    logger,
    // B-7: completionNotifier가 이미 같은 orchProxyConfig를 보유 — 정본 하나 (design-principles §3)
    orch: orchProxyConfig,
  };

  const attachmentStore = new FileAttachmentStore(env.INCOMING_FILE_DIR);

  // HTTP 서버 시작 (health + 선택적 MCP)
  const server = await buildServer({
    host: env.HOST,
    port: env.PORT,
    nodeId: env.SOULSTREAM_NODE_ID,
    logger,
    mcp: env.MCP_ENABLED
      ? {
          runtime: mcpRuntime,
          path: env.MCP_PATH,
          auth: {
            requireAuth: env.MCP_REQUIRE_AUTH,
            bearerToken: env.AUTH_BEARER_TOKEN,
            allowedHosts: env.MCP_ALLOWED_HOSTS,
          },
        }
      : undefined,
  });
  await startServer(server, env.HOST, env.PORT);
  logger.info(
    {
      host: env.HOST,
      port: env.PORT,
      mcpEnabled: env.MCP_ENABLED,
      mcpPath: env.MCP_ENABLED ? env.MCP_PATH : undefined,
    },
    "HTTP listening",
  );

  // WS reverse adapter — orch에 등록
  upstreamAdapter = new UpstreamAdapter(
    {
      url: env.SOULSTREAM_UPSTREAM_URL,
      nodeId: env.SOULSTREAM_NODE_ID,
      host: env.HOST,
      port: env.PORT,
      authBearerToken: env.AUTH_BEARER_TOKEN,
      userName: env.DASH_USER_NAME,
      isProduction: env.ENVIRONMENT === "production",
    },
    logger,
    { agentRegistry, taskManager, taskExecutor, attachmentStore },
  );

  // 백그라운드 실행 — top-level에서 await 안 함 (재연결 무한 루프이므로)
  upstreamAdapter.run().catch((err) => {
    logger.fatal({ err }, "Upstream adapter terminated unexpectedly");
    process.exit(1);
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    try {
      await taskManager.shutdown();
    } catch (err) {
      logger.warn({ err }, "TaskManager shutdown failed");
    }
    if (upstreamAdapter) {
      await upstreamAdapter.shutdown();
    }
    if (server.closeMcp) {
      try {
        await server.closeMcp();
      } catch (err) {
        logger.warn({ err }, "MCP transports close failed");
      }
    }
    await server.close();
    try {
      await db.close();
    } catch (err) {
      logger.warn({ err }, "DB close failed");
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * MCP multi_node 도구가 사용할 orch HTTP base URL + 인증 헤더 조립.
 *
 * SOULSTREAM_UPSTREAM_URL은 reverse WS 경로(ws[s]://host/ws/...)이므로 scheme/path 변환.
 * AUTH_BEARER_TOKEN이 있으면 Authorization 헤더에 박는다.
 */
function buildOrchProxyConfig(env: {
  SOULSTREAM_UPSTREAM_URL: string;
  AUTH_BEARER_TOKEN: string;
}): OrchProxyConfig {
  const baseUrl = wsToHttpBase(env.SOULSTREAM_UPSTREAM_URL);
  const headers: Record<string, string> = {};
  if (env.AUTH_BEARER_TOKEN) {
    headers["authorization"] = `Bearer ${env.AUTH_BEARER_TOKEN}`;
  }
  return { baseUrl, headers };
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
