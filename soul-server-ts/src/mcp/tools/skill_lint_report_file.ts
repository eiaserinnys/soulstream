import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import * as path from "node:path";
import { isPathUnderBase } from "../../attachments/file_manager.js";

/** orch 요청 본문 한도(Fastify 기본 1MiB)에 {args, context} 포장이 들어갈 만큼 남긴다. */
export const MAX_SKILL_LINT_REPORT_BYTES = 900 * 1024;

export class SkillLintReportFileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillLintReportFileError";
  }
}

/**
 * register_attachment의 local_path와 같은 경로 규칙: 작업 폴더(워크트리가 붙은 세션은 그 워크트리)나
 * 프로필 작업 폴더 안의 실경로만 읽는다. 상대 경로는 작업 폴더 기준이다.
 */
export async function readSkillLintReportFile(
  reportFile: string,
  execution: { workspaceDir: string; profileWorkspaceDir?: string },
): Promise<Record<string, unknown>> {
  const file = await resolveAllowedFile(reportFile, execution);
  const text = await readRegularFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SkillLintReportFileError("SKILL_LINT_REPORT_NOT_JSON", "린트 보고 파일이 JSON이 아닙니다.");
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).generated_at !== "string" ||
    !Array.isArray((parsed as Record<string, unknown>).skills)
  ) {
    throw new SkillLintReportFileError(
      "SKILL_LINT_REPORT_INVALID",
      "린트 보고는 generated_at 문자열과 skills 배열을 가진 객체여야 합니다.",
    );
  }
  return parsed as Record<string, unknown>;
}

async function resolveAllowedFile(
  reportFile: string,
  execution: { workspaceDir: string; profileWorkspaceDir?: string },
): Promise<string> {
  let file: string;
  try {
    file = await realpath(path.resolve(execution.workspaceDir, reportFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SkillLintReportFileError("SKILL_LINT_REPORT_FILE_NOT_FOUND", "린트 보고 파일을 찾을 수 없습니다.");
    }
    throw error;
  }
  const roots = (await Promise.all([execution.workspaceDir, execution.profileWorkspaceDir].map(async (root) =>
    root === undefined ? null : realpath(root).catch(() => null))))
    .filter((root): root is string => root !== null);
  if (!roots.some((root) => isPathUnderBase(root, file))) {
    throw new SkillLintReportFileError(
      "SKILL_LINT_REPORT_PATH_DENIED",
      `허용된 작업 폴더 밖의 파일은 올릴 수 없습니다. 이 실행에서 읽을 수 있는 위치: ${roots.join(", ")}.`,
    );
  }
  return file;
}

async function readRegularFile(file: string): Promise<string> {
  // O_NONBLOCK keeps open() from waiting on a FIFO; fstat then rejects it.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new SkillLintReportFileError("SKILL_LINT_REPORT_NOT_REGULAR_FILE", "일반 파일만 올릴 수 있습니다.");
    }
    if (info.size > MAX_SKILL_LINT_REPORT_BYTES) {
      throw new SkillLintReportFileError("SKILL_LINT_REPORT_TOO_LARGE", "린트 보고 파일은 900KB 이하여야 합니다.");
    }
    return (await handle.readFile()).toString("utf8");
  } finally {
    await handle.close();
  }
}
