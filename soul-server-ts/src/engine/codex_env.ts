import { sanitizeChildProcessEnv } from "./child_process_env.js";

/** Codex 공통 차단 뒤 빈 CODEX_API_KEY도 제거해 OAuth fallback을 보호한다. */
export function sanitizeCodexEnv(
  input: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const out = sanitizeChildProcessEnv(input);
  if (out.CODEX_API_KEY === "") delete out.CODEX_API_KEY;
  return out;
}
