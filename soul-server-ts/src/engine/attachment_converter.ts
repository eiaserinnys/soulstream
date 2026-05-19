/**
 * Codex SDK 첨부 파일 변환기.
 *
 * Python `util/attachment_helpers.py:6-24 build_attachment_context_items` 의미 정합.
 * codex SDK 0.130.0 정적 capability table에 따라 파일 확장자별로 3가지 분기:
 *   - image → `UserInput { type: "local_image", path }` (Codex SDK native 지원)
 *   - text  → prompt 텍스트 인용 (Python attachment_helpers.py 인용 형식 정합)
 *   - 그 외 → rejected + reason (capability 화이트리스트 미포함)
 *
 * 정책 (spec-reviewer Phase 2 보강 1/3):
 *   - 업로드 단계 `fileManager.validateFile`이 확장자 blacklist + 크기 검증을 이미 적용.
 *   - 본 단계의 `rejected`는 "codex가 소비 불가한 형식"만 (.pdf, .docx 등).
 *   - rejected 발생 시 → codex_adapter가 assistant_error emit + turn 전체 abort.
 *     (사용자 명시 첨부 중 일부만 처리하면 의도 어긋남 — design-principles §4 명시 실패).
 *
 * 정본 SDK 버전: `@openai/codex-sdk@0.130.0`
 * 정본 d.ts: `dist/index.d.ts:187-195`
 *   type UserInput = { type: "text"; text: string } | { type: "local_image"; path: string };
 *   type Input = string | UserInput[];
 */

import { extname } from "node:path";
import type { UserInput, Input } from "@openai/codex-sdk";

/** 이미지 확장자 집합 (Codex SDK `local_image` native 지원). */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/**
 * 텍스트 참조 확장자 집합 (Codex `Read` 도구로 디스크에서 읽기 가능 — prompt 경로 인용).
 *
 * Python `attachment_helpers.py`의 claude 흐름과 동일 논리:
 * claude SDK는 native 첨부 input이 없고 prompt 텍스트에 경로 인용 + `Read` 도구로 읽기.
 * codex SDK도 비이미지는 동일하게 처리한다 (codex도 `Read` tool을 사용).
 */
const TEXT_EXTS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".log",
  ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".hpp", ".toml", ".ini", ".conf", ".sh",
  ".html", ".css", ".sql",
]);

/**
 * 단일 첨부 파일의 변환 결과.
 *
 * `path` 필드 — 모든 variant에 포함하여 rejected 이유 메시지·로그에서 경로 인용 가능.
 */
export type AttachmentConversion =
  | { kind: "image"; path: string; userInput: UserInput }
  | { kind: "text-reference"; path: string; quotedText: string }
  | { kind: "rejected"; path: string; reason: string };

/**
 * 단일 파일 경로를 변환 결과로 분류한다.
 *
 * @param absPath - 파일 절대경로 (fileManager.saveFileForSession이 반환한 path)
 */
export function classifyAttachment(absPath: string): AttachmentConversion {
  const ext = extname(absPath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return {
      kind: "image",
      path: absPath,
      userInput: { type: "local_image", path: absPath },
    };
  }
  if (TEXT_EXTS.has(ext)) {
    return {
      kind: "text-reference",
      path: absPath,
      quotedText: `- ${absPath}`,
    };
  }
  return {
    kind: "rejected",
    path: absPath,
    reason: `지원하지 않는 형식: ${ext || "(확장자 없음)"}`,
  };
}

/**
 * prompt와 변환 결과 목록으로 Codex SDK `Input`을 합성한다.
 *
 * 반환 타입:
 * - image 0개 → `string` (기존 동작 유지 — text-reference 있으면 인용 append)
 * - image 1개 이상 → `UserInput[]` (첫 항목: {type:"text", text: prompt+text-refs}, 이어 image들)
 *
 * Python `attachment_helpers.py` 인용 형식 정합:
 *   "다음 파일들이 첨부되었습니다. Read 도구로 내용을 확인하세요:\n- {path1}\n..."
 */
export function composeCodexInput(
  prompt: string,
  conversions: AttachmentConversion[],
): Input {
  const textConvs = conversions.filter(
    (c): c is Extract<AttachmentConversion, { kind: "text-reference" }> =>
      c.kind === "text-reference",
  );
  const imageConvs = conversions.filter(
    (c): c is Extract<AttachmentConversion, { kind: "image" }> =>
      c.kind === "image",
  );

  // 텍스트 인용이 있으면 prompt에 append (Python attachment_helpers.py 형식 정합)
  let combinedText = prompt;
  if (textConvs.length > 0) {
    combinedText =
      `${prompt}\n\n다음 파일들이 첨부되었습니다. Read 도구로 내용을 확인하세요:\n` +
      textConvs.map((c) => c.quotedText).join("\n");
  }

  if (imageConvs.length === 0) {
    // image 없음 → string prompt 반환 (Codex SDK Input의 string branch)
    return combinedText;
  }

  // image 1개 이상 → UserInput[] 반환
  // 첫 항목: {type:"text", text: prompt+text-refs}, 이어 image들
  return [
    { type: "text", text: combinedText },
    ...imageConvs.map((c) => c.userInput),
  ];
}
