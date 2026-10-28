import { spawn, type ChildProcess } from "node:child_process";

import type { ClaudeAuthError, ClaudeAuthLoginFlow } from "@soulstream/wire-schema";

import { CLAUDE_OAUTH_TOKEN_ENV } from "../engine/claude_options.js";
import { ANTHROPIC_API_KEY_ENV, ANTHROPIC_BASE_URL_ENV } from "../model_preset_env.js";

const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";
const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

export const MAX_LOGIN_CODE_LENGTH = 2_048;
export const MAX_STDOUT_SCAN_BUFFER_CHARS = 32_768;

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const DELIMITED_URL_PATTERN = /(https?:\/\/[^\s"'<>]+)(?=[\s"'<>])/i;
const TRAILING_URL_PATTERN = /(https?:\/\/[^\s"'<>]+)$/i;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

export type TerminationReason = "cancel" | "timeout" | "shutdown";
export type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

export type ClaudeLoginProfileFetcher = (input: {
  configDir: string;
  env: NodeJS.ProcessEnv;
}) => Promise<unknown>;

export interface InternalLoginFlow {
  readonly loginId: string;
  readonly isRelogin: boolean;
  accountId: string | null;
  configDir: string;
  readonly childEnv: NodeJS.ProcessEnv;
  state: ClaudeAuthLoginFlow["state"];
  authUrl: string | null;
  readonly expiresAt: string;
  error: ClaudeAuthError | null;
  codeSubmitted: boolean;
  pendingSettled: boolean;
  reloginEnded: boolean;
  stdoutBuffer: string;
  urlIdleTimer: NodeJS.Timeout | null;
  timeoutTimer: NodeJS.Timeout | null;
  loginChild: ChildProcess | null;
  loginChildExitPromise: Promise<ChildExit> | null;
  statusChild: ChildProcess | null;
  statusChildExitPromise: Promise<ChildExit> | null;
  terminatingReason: TerminationReason | null;
  terminationPromise: Promise<ClaudeAuthLoginFlow> | null;
}

export function createInternalLoginFlow(input: {
  loginId: string;
  requestedAccountId: string | null;
  configDir: string;
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  expiresAt: string;
}): InternalLoginFlow {
  return {
    loginId: input.loginId,
    isRelogin: input.requestedAccountId !== null,
    accountId: input.requestedAccountId,
    configDir: input.configDir,
    childEnv: buildSanitizedCliEnv(input.baseEnv, input.configDir),
    state: "requested",
    authUrl: null,
    expiresAt: input.expiresAt,
    error: null,
    codeSubmitted: false,
    pendingSettled: false,
    reloginEnded: false,
    stdoutBuffer: "",
    urlIdleTimer: null,
    timeoutTimer: null,
    loginChild: null,
    loginChildExitPromise: null,
    statusChild: null,
    statusChildExitPromise: null,
    terminatingReason: null,
    terminationPromise: null,
  };
}

export function isTerminalState(state: ClaudeAuthLoginFlow["state"]): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}

export function toLoginFlowSnapshot(flow: InternalLoginFlow): ClaudeAuthLoginFlow {
  return {
    login_id: flow.loginId,
    account_id: flow.accountId,
    state: flow.state,
    auth_url: flow.authUrl,
    expires_at: flow.expiresAt,
    error: flow.error ? { ...flow.error } : null,
  };
}

export class ClaudeLoginError extends Error {
  readonly code: string;
  readonly existing_account_id?: string;

  constructor(code: string, message: string, existingAccountId?: string) {
    super(message);
    this.name = "ClaudeLoginError";
    this.code = code;
    if (existingAccountId !== undefined) {
      this.existing_account_id = existingAccountId;
    }
  }

  toAuthError(): ClaudeAuthError {
    return {
      code: this.code,
      message: this.message,
      ...(this.existing_account_id !== undefined
        ? { existing_account_id: this.existing_account_id }
        : {}),
    };
  }
}

export interface ParsedAuthStatus {
  loggedIn: boolean;
  accountUuid: string | null;
  email: string | null;
  plan: string | null;
}

export function buildSanitizedCliEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
  configDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    [CLAUDE_CONFIG_DIR_ENV]: configDir,
  };
  delete env[ANTHROPIC_API_KEY_ENV];
  delete env[ANTHROPIC_AUTH_TOKEN_ENV];
  delete env[CLAUDE_OAUTH_TOKEN_ENV];
  delete env[ANTHROPIC_BASE_URL_ENV];
  return env;
}

export function validateLoginCode(rawCode: unknown): string {
  if (typeof rawCode !== "string" || CONTROL_CHAR_PATTERN.test(rawCode)) {
    throw new ClaudeLoginError(
      "invalid_login_code",
      "Authorization code must be a single-line string without control characters",
    );
  }
  const trimmed = rawCode.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LOGIN_CODE_LENGTH) {
    throw new ClaudeLoginError(
      "invalid_login_code",
      `Authorization code must be between 1 and ${MAX_LOGIN_CODE_LENGTH} characters`,
    );
  }
  return trimmed;
}

export function scanStdoutForAuthUrl(
  stdoutBuffer: string,
  allowTrailing: boolean,
): { committedUrl: string | null; hasPendingTrailingUrl: boolean } {
  const clean = stdoutBuffer.replace(ANSI_ESCAPE_PATTERN, "");
  const delimitedMatch = DELIMITED_URL_PATTERN.exec(clean);
  if (delimitedMatch?.[1] && isValidHttpUrl(delimitedMatch[1])) {
    return { committedUrl: delimitedMatch[1], hasPendingTrailingUrl: false };
  }

  const trailingMatch = TRAILING_URL_PATTERN.exec(clean);
  if (trailingMatch?.[1] && isValidHttpUrl(trailingMatch[1])) {
    if (allowTrailing) {
      return { committedUrl: trailingMatch[1], hasPendingTrailingUrl: false };
    }
    return { committedUrl: null, hasPendingTrailingUrl: true };
  }

  return { committedUrl: null, hasPendingTrailingUrl: false };
}

function isValidHttpUrl(candidate: string): boolean {
  try {
    const parsed = new URL(candidate);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

export function waitForChildExit(child: ChildProcess): Promise<ChildExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.once("error", () => finish(127, null));
    child.once("exit", (code, signal) => finish(code, signal));
  });
}

export async function terminateChildProcess(
  child: ChildProcess,
  exitPromise: Promise<ChildExit>,
  killGracePeriodMs: number,
): Promise<void> {
  if (child.stdin && !child.stdin.destroyed) {
    try {
      child.stdin.end();
      child.stdin.destroy();
    } catch {
      // ignore stdin close errors on already-terminated process
    }
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    await exitPromise;
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // ignore if process already exited
  }

  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore if process already exited
      }
    }
  }, killGracePeriodMs);

  try {
    await exitPromise;
  } finally {
    clearTimeout(killTimer);
  }
}

export async function verifyLoggedInIdentity(input: {
  cli: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  fetchProfile?: ClaudeLoginProfileFetcher;
  onSpawnStatus?: (child: ChildProcess, exitPromise: Promise<ChildExit>) => void;
}): Promise<ParsedAuthStatus> {
  const statusResult = await runClaudeAuthStatusProcess({
    cli: input.cli,
    env: input.env,
    onSpawn: input.onSpawnStatus,
  });
  if (!statusResult.loggedIn) {
    return statusResult;
  }

  let { accountUuid, email, plan } = statusResult;
  if (!accountUuid && input.fetchProfile) {
    try {
      const profilePayload = await input.fetchProfile({
        configDir: input.configDir,
        env: input.env,
      });
      const fallback = parseProfileIdentity(profilePayload);
      accountUuid = accountUuid ?? fallback.accountUuid;
      email = email ?? fallback.email;
      plan = plan ?? fallback.plan;
    } catch {
      // Fallback profile failure is handled by caller's missing-UUID check without logging raw payloads.
    }
  }

  return { loggedIn: true, accountUuid, email, plan };
}

export async function runClaudeAuthStatusProcess(input: {
  cli: string;
  env: NodeJS.ProcessEnv;
  onSpawn?: (child: ChildProcess, exitPromise: Promise<ChildExit>) => void;
}): Promise<ParsedAuthStatus> {
  let child: ChildProcess;
  try {
    child = spawn(input.cli, ["auth", "status", "--json"], {
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return { loggedIn: false, accountUuid: null, email: null, plan: null };
  }

  child.stderr?.resume();
  let stdout = "";
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_STDOUT_SCAN_BUFFER_CHARS);
    });
  }

  const exitPromise = waitForChildExit(child);
  input.onSpawn?.(child, exitPromise);

  const exit = await exitPromise;
  if (exit.code !== 0 || exit.signal !== null || !stdout.trim()) {
    return { loggedIn: false, accountUuid: null, email: null, plan: null };
  }

  return parseAuthStatusOutput(stdout);
}

export function parseAuthStatusOutput(rawStdout: string): ParsedAuthStatus {
  try {
    const parsed: unknown = JSON.parse(rawStdout);
    const email = findString(parsed, new Set(["email", "emailAddress", "email_address"]));
    const accountUuid = extractAccountUuid(parsed);
    const plan = findString(
      parsed,
      new Set(["plan", "subscriptionType", "subscription_type", "planType", "plan_type"]),
    );
    const loggedIn =
      findBoolean(parsed, new Set(["loggedIn", "logged_in", "authenticated", "isLoggedIn"])) ??
      Boolean(email);
    return { loggedIn, accountUuid, email, plan };
  } catch {
    return { loggedIn: false, accountUuid: null, email: null, plan: null };
  }
}

export function parseProfileIdentity(payload: unknown): {
  accountUuid: string | null;
  email: string | null;
  plan: string | null;
} {
  return {
    accountUuid: extractAccountUuid(payload),
    email: findString(payload, new Set(["email", "emailAddress", "email_address"])),
    plan: findString(
      payload,
      new Set(["plan", "subscriptionType", "subscription_type", "planType", "plan_type"]),
    ),
  };
}

function extractAccountUuid(value: unknown): string | null {
  if (isRecord(value) && isRecord(value.account) && typeof value.account.uuid === "string") {
    const trimmed = value.account.uuid.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return findString(
    value,
    new Set(["accountUuid", "account_uuid", "uuid", "userUuid", "user_uuid"]),
  );
}

function findString(value: unknown, keys: Set<string>): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, keys);
      if (found) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === "string" && item.trim().length > 0) {
      return item.trim();
    }
  }
  for (const item of Object.values(value)) {
    const found = findString(item, keys);
    if (found) return found;
  }
  return null;
}

function findBoolean(value: unknown, keys: Set<string>): boolean | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBoolean(item, keys);
      if (found !== null) return found;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key) && typeof item === "boolean") return item;
  }
  for (const item of Object.values(value)) {
    const found = findBoolean(item, keys);
    if (found !== null) return found;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
