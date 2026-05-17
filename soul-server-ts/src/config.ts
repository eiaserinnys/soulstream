import { z } from "zod";

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
    /**
     * Codex API 키 (Phase B-2). optional — 미설정 시 Codex SDK가 ~/.codex/auth.json
     * (ChatGPT 구독 OAuth) fallback. production strict 미요구 — credential default
     * 박지 않음 (B-1 leak 사고 회로 차단). 실제 turn 실행 시 인증 부재면 Codex SDK가 오류 반환.
     */
    CODEX_API_KEY: z.string().optional(),
    /**
     * PostgreSQL 연결 URL (Phase B-3). Python soul-server와 같은 키 정합.
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
     * B-6 context_builder: atom MCP HTTP API 설정. Python `soul_server.config.atom_*` 정합.
     * 모두 optional — 미설정 시 atom 호출 skip (graceful, turn 진행에 영향 없음).
     */
    ATOM_ENABLED: z
      .union([z.literal("true"), z.literal("false")])
      .transform((v) => v === "true")
      .optional(),
    ATOM_SERVER_URL: z.string().optional(),
    ATOM_API_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // production에서는 AUTH_BEARER_TOKEN 강제. design-principles §4.
    if (env.ENVIRONMENT === "production" && !env.AUTH_BEARER_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_BEARER_TOKEN"],
        message: "AUTH_BEARER_TOKEN is required when ENVIRONMENT=production",
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
