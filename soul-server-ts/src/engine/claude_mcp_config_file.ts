import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_CONFIG_FLAG = "--mcp-config";

/**
 * claude CLI 인자의 인라인 `--mcp-config` JSON을 본인만 읽는 파일로 옮긴다.
 * 같은 호스트의 다른 계정이 ps로 인증 헤더를 읽지 못하게 하는 것이 목적이다.
 */
export function externalizeClaudeMcpConfig(
  args: readonly string[],
  directory: string | undefined,
): { args: string[]; cleanup: () => void } {
  const externalizedArgs = [...args];
  const flagIndex = externalizedArgs.indexOf(MCP_CONFIG_FLAG);
  const configJson = flagIndex >= 0 ? externalizedArgs[flagIndex + 1] : undefined;
  if (configJson === undefined || !configJson.trimStart().startsWith("{")) {
    return { args: externalizedArgs, cleanup: () => {} };
  }

  let configDirectory: string;
  let ownsDirectory = false;
  if (directory !== undefined) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    configDirectory = directory;
  } else {
    configDirectory = mkdtempSync(join(tmpdir(), "soulstream-claude-mcp-"));
    ownsDirectory = true;
  }

  const configPath = join(
    configDirectory,
    `claude-mcp-config-${randomUUID()}.json`,
  );
  writeFileSync(configPath, configJson, { mode: 0o600, flag: "wx" });
  externalizedArgs[flagIndex + 1] = configPath;

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(configPath, { force: true });
    } catch {
      // 정리 실패는 턴 결과를 바꾸지 않는다.
    }
    if (ownsDirectory) {
      try {
        rmSync(configDirectory, { recursive: true, force: true });
      } catch {
        // 정리 실패는 턴 결과를 바꾸지 않는다.
      }
    }
  };

  return { args: externalizedArgs, cleanup };
}
