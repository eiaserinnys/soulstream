import { invoke } from "@tauri-apps/api/core";

/**
 * Normalize user input to a valid HTTP(S) URL.
 * - Preserves an explicit `http://` or `https://` scheme
 * - Prepends `https://` if no scheme is present
 * - Validates URL structure
 * @throws if the resulting URL is invalid
 */
export function normalizeUrl(input: string): string {
  let cleaned = input.trim();
  const fullUrl = cleaned.startsWith("https://") || cleaned.startsWith("http://")
    ? cleaned
    : `https://${cleaned}`;
  new URL(fullUrl); // throws TypeError if invalid
  return fullUrl;
}

/** Result of the Rust `check_server` command (`src-tauri/src/server_check.rs`). */
export type ServerCheckResult =
  | { kind: "ok" }
  | { kind: "unreachable" }
  | { kind: "http_status"; status: number }
  | { kind: "not_soulstream" };

export class ServerCheckError extends Error {}

export function describeServerCheck(
  url: string,
  result: ServerCheckResult,
): string | null {
  switch (result.kind) {
    case "ok":
      return null;
    case "unreachable":
      return `${url} 에 연결할 수 없습니다. 주소와 네트워크를 확인하세요.`;
    case "http_status":
      return `${url} 가 ${result.status} 로 응답했습니다. 소울스트림 서버 주소인지 확인하세요.`;
    case "not_soulstream":
      return `${url} 는 소울스트림 서버가 아닙니다. 주소를 확인하세요.`;
  }
}

/** Message to show for an error thrown while checking or entering a server. */
export function describeError(error: unknown): string {
  if (error instanceof ServerCheckError) return error.message;
  return `연결을 준비하지 못했습니다. (${String(error)})`;
}

/**
 * Check that `url` is a Soulstream server.
 * The webview cannot read the status of a cross-origin response unless the server's
 * CORS allow-list contains the app origin, so the Rust `check_server` command calls
 * `GET /api/health` and classifies the answer.
 * @throws ServerCheckError with the user-facing message when the server is not usable
 */
export async function checkReachability(
  url: string,
  timeoutMs: number = 5000,
): Promise<void> {
  let result: ServerCheckResult;
  try {
    result = await invoke<ServerCheckResult>("check_server", {
      url,
      timeoutMs,
    });
  } catch (error) {
    throw new ServerCheckError(
      `서버를 확인하지 못했습니다. (${String(error)})`,
    );
  }
  const message = describeServerCheck(url, result);
  if (message) throw new ServerCheckError(message);
}
