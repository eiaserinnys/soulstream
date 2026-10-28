import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { resolveClaudeExecutableFromPath } from "../engine/claude_executable_path.js";
import { ClaudeAccountStore, ensureProfileSharedSymlinks } from "./store.js";
import type { ClaudeAccountRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const CLAUDE_CODE_EXECPATH_ENV = "CLAUDE_CODE_EXECPATH";

export interface AdoptClaudeAccountOptions {
  profilePath: string;
  accountsDir?: string;
  homeDir?: string;
  claudeCliPath?: string;
  now?: () => number;
  execAuthStatus?: (env: NodeJS.ProcessEnv, claudeCliPath: string) => Promise<string>;
}

function buildSanitizedClaudeEnv(profilePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  // Strip legacy/forbidden API key env var so claude auth status inspects the profile's OAuth session
  const forbiddenKey = ["ANTHROPIC", "API", "KEY"].join("_");
  delete env[forbiddenKey];
  env.CLAUDE_CONFIG_DIR = profilePath;
  return env;
}

async function defaultExecAuthStatus(
  env: NodeJS.ProcessEnv,
  claudeCliPath: string,
): Promise<string> {
  const { stdout } = await execFileAsync(claudeCliPath, ["auth", "status", "--json"], {
    env,
    timeout: 15_000,
  });
  return stdout;
}

export async function adoptClaudeAccountProfile(
  options: AdoptClaudeAccountOptions,
): Promise<ClaudeAccountRecord> {
  const resolvedProfilePath = path.resolve(options.profilePath);
  if (!fs.existsSync(resolvedProfilePath) || !fs.statSync(resolvedProfilePath).isDirectory()) {
    throw new Error(`Profile directory does not exist: ${resolvedProfilePath}`);
  }

  const folderName = path.basename(resolvedProfilePath);
  const parentDir = path.dirname(resolvedProfilePath);
  const inferredAccountsDir =
    path.basename(parentDir) === "profiles"
      ? path.dirname(parentDir)
      : path.join(os.homedir(), ".claude-accounts");

  const accountsDir = path.resolve(options.accountsDir ?? inferredAccountsDir);
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const claudeCliPath =
    options.claudeCliPath?.trim() ||
    process.env[CLAUDE_CODE_EXECPATH_ENV]?.trim() ||
    resolveClaudeExecutableFromPath(process.env, process.platform) ||
    "claude";
  const now = options.now ?? (() => Date.now());

  const expectedProfilePath = path.join(accountsDir, "profiles", folderName);
  if (path.resolve(expectedProfilePath) !== resolvedProfilePath) {
    throw new Error(
      `Profile path "${resolvedProfilePath}" must reside inside "${path.join(accountsDir, "profiles")}/<UUID>".`,
    );
  }

  const sanitizedEnv = buildSanitizedClaudeEnv(resolvedProfilePath);
  const execFn = options.execAuthStatus ?? defaultExecAuthStatus;
  const rawOutput = await execFn(sanitizedEnv, claudeCliPath);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawOutput.trim()) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from "claude auth status --json": ${(err as Error).message}`,
    );
  }

  if (parsed.loggedIn === false) {
    throw new Error(`Profile at "${resolvedProfilePath}" is not logged in.`);
  }

  const accountObj =
    parsed.account && typeof parsed.account === "object"
      ? (parsed.account as Record<string, unknown>)
      : null;

  const accountUuid = String(
    parsed.accountUuid ??
      parsed.account_uuid ??
      parsed.uuid ??
      accountObj?.uuid ??
      accountObj?.id ??
      "",
  ).trim();

  if (!accountUuid) {
    throw new Error(
      `claude auth status --json did not return an accountUuid for "${resolvedProfilePath}".`,
    );
  }

  if (accountUuid !== folderName) {
    throw new Error(
      `Profile folder basename "${folderName}" does not match authenticated accountUuid "${accountUuid}". Rename the directory to "${accountUuid}" first.`,
    );
  }

  const email = String(
    parsed.email ?? accountObj?.email ?? parsed.emailAddress ?? "",
  ).trim();
  const rawPlan = String(
    parsed.subscriptionType ??
      parsed.plan ??
      accountObj?.subscriptionType ??
      accountObj?.plan ??
      "",
  ).trim();
  const plan: string | null = rawPlan ? rawPlan : null;

  // Ensure shared symlinks without touching or reading .credentials.json
  ensureProfileSharedSymlinks(resolvedProfilePath, homeDir);

  const store = new ClaudeAccountStore({ accountsDir, homeDir });
  store.ensureBaseDirs();

  const accounts = store.readAccounts();
  const existingIdx = accounts.findIndex((acc) => acc.id === accountUuid);
  const nowIso = new Date(now()).toISOString();

  const record: ClaudeAccountRecord =
    existingIdx >= 0
      ? {
          ...accounts[existingIdx]!,
          email: email || accounts[existingIdx]!.email,
          plan: plan ?? accounts[existingIdx]!.plan,
        }
      : {
          id: accountUuid,
          email,
          plan,
          enabled: true,
          priority: null,
          created_at: nowIso,
        };

  if (existingIdx >= 0) {
    accounts[existingIdx] = record;
  } else {
    accounts.push(record);
  }

  store.writeAccounts(accounts);
  return record;
}
