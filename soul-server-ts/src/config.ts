import { z } from "zod";

import {
  DEFAULT_HARD_TOKEN_THRESHOLD,
  DEFAULT_HANDOVER_MIN_INTERVAL_MS,
  DEFAULT_SOFT_TOKEN_THRESHOLD,
} from "./supervisor/handover_policy.js";

const csvStringList = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

/**
 * 환경 변수 스키마. design-principles §4(명시적 실패) — 필수 키 default 없음.
 * 선택 키는 zod default로 명시. 코드의 `process.env.X ?? "default"` 안티패턴 금지.
 */
export const EnvSchema = z
  .object({
    SOULSTREAM_NODE_ID: z.string().min(1, "SOULSTREAM_NODE_ID required"),
    SOULSTREAM_UPSTREAM_URL: z
      .string()
      .url("SOULSTREAM_UPSTREAM_URL must be a valid URL")
      .refine(
        (u) => u.startsWith("ws://") || u.startsWith("wss://"),
        "SOULSTREAM_UPSTREAM_URL must be ws:// or wss://",
      ),
    AUTH_BEARER_TOKEN: z.string().default(""),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().positive().default(4205),
    ENVIRONMENT: z.enum(["development", "production"]).default("development"),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    DASH_USER_NAME: z.string().default(""),
    DASH_USER_PORTRAIT: z.string().default(""),
    GOOGLE_CLIENT_ID: z.string().optional(),
    JWT_SECRET: z.string().optional(),
    /** LLM proxy provider keys. Optional — route mounts only for configured providers. */
    LLM_OPENAI_API_KEY: z.string().optional(),
    LLM_ANTHROPIC_API_KEY: z.string().optional(),
    /**
     * Codex API 키 (Phase B-2). optional — 미설정 시 Codex SDK가 ~/.codex/auth.json
     * (ChatGPT 구독 OAuth) fallback. production strict 미요구 — credential default
     * 박지 않음 (credential leak 사고 회로 차단). 실제 turn 실행 시 인증 부재면 Codex SDK가 오류 반환.
     */
    CODEX_API_KEY: z.string().optional(),
    /**
     * Codex CLI 실행 파일 절대 경로. optional — 미설정 시 main.ts가 PATH와
     * 사용자 npm 전역 설치 위치를 탐색하고, 그래도 없으면 SDK 기본 경로에 맡긴다.
     */
    CODEX_CLI_PATH: z.string().optional(),
    /**
     * Codex backend adapter 선택. default는 기존 SDK/exec 경로 유지.
     * app-server adapter는 실험 경로라 명시 opt-in에서만 사용한다.
     */
    CODEX_ADAPTER_MODE: z.enum(["sdk", "app-server"]).default("sdk"),
    /**
     * PostgreSQL 연결 URL. worker와 schema helper가 같은 키를 사용한다.
     * design-principles §4 명시 실패 — default 없음. production·development 모두 필수.
     */
    DATABASE_URL: z
      .string()
      .url("DATABASE_URL must be a valid URL")
      .refine(
        (u) => u.startsWith("postgres://") || u.startsWith("postgresql://"),
        "DATABASE_URL must be postgres:// or postgresql://",
      ),
    /**
     * agent_registry yaml 경로 (Phase B-3).
     * Haniel cwd `services/soulstream/` 기준 상대 경로 default — `.env.soul-server-ts`
     * dotenv 로딩과 같은 cwd 협약. 운영에서 변경 시 절대 경로 설정.
     */
    AGENTS_CONFIG_PATH: z.string().default("config/agents.yaml"),
    /**
     * 세션 첨부 파일 저장 디렉토리. orch가 WS reverse-proxy로 파일을 전달하면
     * TS 노드는 이 경로 아래에 저장하고 Codex에게 절대경로를 넘긴다.
     */
    INCOMING_FILE_DIR: z.string().default(".local/incoming"),
    /**
     * Claude auth/profile command storage 정본. Python `.env`나 `~/.claude`를 암묵 공유하지 않는다.
     * Claude backend agent를 광고하는 운영 노드는 main.ts 시작 검증에서 이 값을 필수로 요구한다.
     */
    CLAUDE_AUTH_TOKEN_PATH: z.string().min(1).optional(),
    /**
     * context_builder: atom MCP HTTP API 설정.
     * 모두 optional — 미설정 시 atom 호출 skip (graceful, turn 진행에 영향 없음).
     */
    ATOM_ENABLED: z
      .union([z.literal("true"), z.literal("false")])
      .transform((v) => v === "true")
      .optional(),
    ATOM_SERVER_URL: z.string().optional(),
    ATOM_API_KEY: z.string().optional(),
    /**
     * MCP Streamable HTTP 서버 활성화 플래그. Codex CLI 등 MCP 클라이언트용 진입점.
     * default false — 명시 활성화 필수. Python `/cogito-mcp/sse`와 *별개*(공존).
     */
    MCP_ENABLED: z
      .union([z.literal("true"), z.literal("false")])
      .default("false")
      .transform((v) => v === "true"),
    /**
     * MCP HTTP 라우트 path. POST/GET/DELETE 모두 같은 경로 (Streamable HTTP 스펙).
     */
    MCP_PATH: z.string().default("/mcp"),
    /**
     * MCP tool surface profile. supervisor_readonly is for Supervisor sessions:
     * mutation tools are hidden from listTools and blocked at execution time.
     */
    MCP_TOOL_PROFILE: z
      .enum(["default", "supervisor_readonly"])
      .default("default"),
    /**
     * MCP 호출에 bearer auth 강제. superRefine으로 production + MCP_ENABLED일 때 강제.
     */
    MCP_REQUIRE_AUTH: z
      .union([z.literal("true"), z.literal("false")])
      .default("false")
      .transform((v) => v === "true"),
    /**
     * Host 헤더 검증 허용 리스트. DNS rebinding 방지. csv string을 zod transform 단에서
     * string[]로 변환하여 정본 단일 (design-principles §3) — `mcp/auth.ts`는 string[]만 받음.
     */
    MCP_ALLOWED_HOSTS: z
      .string()
      .default("localhost,127.0.0.1")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    /**
     * Supervisor activation. true면 durable event ingest, supervisor session boot,
     * wake/watchdog consumption을 함께 시작한다.
     */
    SUPERVISOR_ENABLED: z
      .union([z.literal("true"), z.literal("false")])
      .default("false")
      .transform((v) => v === "true"),
    /**
     * Supervisor durable event ingest만 별도 활성화한다. supervisor가 꺼진 동안에도
     * backlog를 쌓아 두고 싶을 때만 opt-in한다.
     */
    SUPERVISOR_EVENT_INGEST_ENABLED: z
      .union([z.literal("true"), z.literal("false")])
      .default("false")
      .transform((v) => v === "true"),
    /**
     * Supervisor role ids. Each value must match an agents.yaml profile id.
     * The DB supervisor_registry role uses the same string as its canonical key.
     */
    SUPERVISOR_ROLES: csvStringList,
    /** Optional target board folder for bootstrapped supervisor sessions. */
    SUPERVISOR_FOLDER_ID: z.string().min(1).optional(),
    SUPERVISOR_WAKE_DEBOUNCE_MS: z.coerce.number().int().positive().default(250),
    SUPERVISOR_WAKE_BATCH_LIMIT: z.coerce.number().int().positive().default(100),
    SUPERVISOR_SOFT_TOKEN_THRESHOLD: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_SOFT_TOKEN_THRESHOLD),
    SUPERVISOR_HARD_TOKEN_THRESHOLD: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_HARD_TOKEN_THRESHOLD),
    SUPERVISOR_HANDOVER_MIN_INTERVAL_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_HANDOVER_MIN_INTERVAL_MS),
    SUPERVISOR_HANDOVER_DRAIN_LIMIT: z.coerce.number().int().positive().default(100),
    SUPERVISOR_HANDOVER_PROMPT_EVENT_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(20),
    SUPERVISOR_WATCHDOG_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    SUPERVISOR_WATCHDOG_MISSING_THRESHOLD_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60_000),
  })
  .superRefine((env, ctx) => {
    // 1) production에서는 AUTH_BEARER_TOKEN 강제 (기존, 유지). design-principles §4.
    if (env.ENVIRONMENT === "production" && !env.AUTH_BEARER_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_BEARER_TOKEN"],
        message: "AUTH_BEARER_TOKEN is required when ENVIRONMENT=production",
      });
    }
    // 2) production + MCP_ENABLED → MCP_REQUIRE_AUTH 강제. (1)과 path 다름 → 중복 발화 없음.
    if (
      env.ENVIRONMENT === "production" &&
      env.MCP_ENABLED &&
      !env.MCP_REQUIRE_AUTH
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_REQUIRE_AUTH"],
        message:
          "MCP_REQUIRE_AUTH must be true when ENVIRONMENT=production and MCP_ENABLED",
      });
    }
    // 3) 비-loopback HOST + MCP_ENABLED → REQUIRE_AUTH 또는 ALLOWED_HOSTS 강제. path 다름.
    const isLoopback = env.HOST === "127.0.0.1" || env.HOST === "localhost";
    if (
      env.MCP_ENABLED &&
      !isLoopback &&
      !env.MCP_REQUIRE_AUTH &&
      env.MCP_ALLOWED_HOSTS.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["MCP_ALLOWED_HOSTS"],
        message:
          "MCP_ALLOWED_HOSTS or MCP_REQUIRE_AUTH required when HOST is non-loopback and MCP_ENABLED",
      });
    }
    if (env.GOOGLE_CLIENT_ID && !env.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["JWT_SECRET"],
        message: "JWT_SECRET is required when GOOGLE_CLIENT_ID enables dashboard auth",
      });
    }
    if (env.SUPERVISOR_ENABLED && env.SUPERVISOR_ROLES.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPERVISOR_ROLES"],
        message: "SUPERVISOR_ROLES is required when SUPERVISOR_ENABLED=true",
      });
    }
    if (env.SUPERVISOR_HARD_TOKEN_THRESHOLD < env.SUPERVISOR_SOFT_TOKEN_THRESHOLD) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPERVISOR_HARD_TOKEN_THRESHOLD"],
        message:
          "SUPERVISOR_HARD_TOKEN_THRESHOLD must be greater than or equal to SUPERVISOR_SOFT_TOKEN_THRESHOLD",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * 환경 변수 파싱. 실패 시 ZodError를 throw하여 main에서 명시 종료.
 *
 * @param raw - 보통 `process.env`. 테스트에서는 임의 객체 주입.
 */
export function parseEnv(raw: NodeJS.ProcessEnv | Record<string, unknown>): Env {
  return EnvSchema.parse(raw);
}
