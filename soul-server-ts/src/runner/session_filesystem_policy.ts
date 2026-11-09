import { isAbsolute } from "node:path";

import type { IsolationPreparationInput } from "../security/session_isolation_contract.js";
import { IsolationPreparationPolicyError } from "./session_filesystem_errors.js";

const KNOWN_BACKENDS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "antigravity",
]);

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const EXPECTED_POLICY_LITERALS = {
  sessionWorktreeRelativeRoot: ".projects/.isolated",
  credentialRelativeDirectory: ".local/share/soulstream/credentials/codex",
  isolatedCacheRelativeRoot: ".local/share/soulstream/isolated-cache",
} as const;

/** 정책·입력 계약을 spec 작성 전에 확인한다. 값이 바뀌면 준비를 시작하지 않는다. */
export function validateIsolationPreparationInput(
  input: IsolationPreparationInput,
): void {
  if (input.decision.tier !== "restricted") {
    throw new IsolationPreparationPolicyError(
      "prepareIsolationPlan은 restricted 결정에만 호출합니다",
    );
  }
  if (!SESSION_ID_PATTERN.test(input.decision.sessionId)) {
    throw new IsolationPreparationPolicyError("sessionId 형식이 잘못되었습니다");
  }
  if (!KNOWN_BACKENDS.has(input.backend)) {
    throw new IsolationPreparationPolicyError(
      `알 수 없는 isolation backend입니다: ${String(input.backend)}`,
    );
  }
  if (input.policy.version !== 1) {
    throw new IsolationPreparationPolicyError("지원하지 않는 정책 버전입니다");
  }
  if (typeof input.policyDigest !== "string" || input.policyDigest.length === 0) {
    throw new IsolationPreparationPolicyError("policyDigest가 비어 있습니다");
  }
  for (const [field, expected] of Object.entries(EXPECTED_POLICY_LITERALS)) {
    const value = input.policy.filesystem[
      field as keyof typeof EXPECTED_POLICY_LITERALS
    ];
    if (value !== expected) {
      throw new IsolationPreparationPolicyError(
        `정책 파일 경로 규칙이 바뀌었습니다: ${field}`,
      );
    }
  }
  const writable = input.policy.filesystem.writableWorkspaceRelativeDirectories;
  if (
    writable.length !== 2
    || writable[0] !== ".local/tmp"
    || writable[1] !== ".local/artifacts"
  ) {
    throw new IsolationPreparationPolicyError(
      "정책의 workspace 쓰기 허용 목록이 바뀌었습니다",
    );
  }
  const network = input.policy.network;
  if (network.mode !== "pasta-nft" || network.dnsForward4 !== "192.0.2.53") {
    throw new IsolationPreparationPolicyError("정책 네트워크 설정이 바뀌었습니다");
  }
  for (const root of input.policy.filesystem.additionalSensitiveRoots) {
    requireAbsolute(root, "민감 루트");
  }
  for (const path of input.policy.filesystem.readOnlyReexposedPaths) {
    requireAbsolute(path, "재노출 경로");
  }
  for (const [path, label] of [
    [input.workspaceDir, "workspace"],
    [input.sessionDirectory, "session"],
    [input.hostWorkspaceRoot, "host workspace"],
    [input.homeDirectory, "home"],
    [input.scratchWorkspaceDir, "scratch"],
  ] as const) {
    requireAbsolute(path, label);
  }
}

export function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new IsolationPreparationPolicyError(`${label} 경로가 절대 경로가 아닙니다`);
  }
  return path;
}
