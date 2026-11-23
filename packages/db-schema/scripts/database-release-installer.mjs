import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readDatabaseUrl } from "./migration-contract.mjs";

/**
 * Database release authorities.
 *
 * `haniel` is the default for every caller. `linux-systemd-installer` exists
 * only for the one-line Linux installer that runs without Haniel, and only the
 * CLI can choose it: both release files must be the repository's own
 * `install/` pair. Environment variables never select it.
 */
export const HANIEL_DATABASE_AUTHORITY = "haniel";
export const INSTALLER_DATABASE_AUTHORITY = "linux-systemd-installer";

const INSTALLER_COMMANDS = new Set(["preflight", "apply", "verify"]);
const HANIEL_RUNTIME_MARKERS = [
  "HANIEL_DEPLOYMENT_JOURNAL",
  "HANIEL_QUIESCENCE_RECEIPT",
  "HANIEL_NODE_ID",
];
const LOCAL_DATABASE_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const INSTALLER_DATABASE_NAME = "soulstream";
const SYSTEMCTL_PROPERTIES = ["LoadState", "ActiveState", "SubState", "MainPID"];
const SYSTEMCTL_EXECUTABLES = ["/usr/bin/systemctl", "/bin/systemctl"];
const STOPPED_ACTIVE_STATES = new Set(["inactive", "failed"]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function installerContractPaths() {
  return {
    manifest: resolve(repositoryRoot, "install/release-manifest-installer.json"),
    databaseContract: resolve(repositoryRoot, "install/database-release-installer.json"),
  };
}

async function isSameFile(candidate, canonical) {
  if (!candidate) return false;
  try {
    const [actual, expected] = await Promise.all([realpath(candidate), realpath(canonical)]);
    return actual === expected;
  } catch {
    return false;
  }
}

export async function resolveDatabaseReleaseAuthority({
  manifestPath = null,
  databaseContractPath = null,
  contract = null,
} = {}) {
  if (!manifestPath && !databaseContractPath) return HANIEL_DATABASE_AUTHORITY;
  const canonical = installerContractPaths();
  const [manifestIsCanonical, contractIsCanonical] = await Promise.all([
    isSameFile(manifestPath, canonical.manifest),
    isSameFile(databaseContractPath, canonical.databaseContract),
  ]);
  const claimsInstaller = contract?.authority === INSTALLER_DATABASE_AUTHORITY;
  if (manifestIsCanonical && contractIsCanonical) {
    if (!claimsInstaller) {
      throw new Error("JOURNAL_GATE_FAILED: installer database contract authority differs");
    }
    return INSTALLER_DATABASE_AUTHORITY;
  }
  if (manifestIsCanonical || contractIsCanonical) {
    throw new Error(
      "JOURNAL_GATE_FAILED: installer manifest and database contract must both be the repository install/ pair",
    );
  }
  if (claimsInstaller) {
    throw new Error(
      "JOURNAL_GATE_FAILED: linux-systemd-installer authority requires the repository install/ pair",
    );
  }
  return HANIEL_DATABASE_AUTHORITY;
}

export function databaseReleaseAuthority(value) {
  const authority = value ?? HANIEL_DATABASE_AUTHORITY;
  if (authority !== HANIEL_DATABASE_AUTHORITY && authority !== INSTALLER_DATABASE_AUTHORITY) {
    throw new Error("JOURNAL_GATE_FAILED: unknown database release authority");
  }
  return authority;
}

function forbidden(reason) {
  return new Error(`NON_STANDALONE_INSTALLER_FORBIDDEN: ${reason}`);
}

/** Runs on the caller's environment, before any service env file is merged. */
export function assertInstallerInvocation({ command, env, platform }) {
  if (!INSTALLER_COMMANDS.has(command)) {
    throw new Error(
      "JOURNAL_GATE_FAILED: installer authority accepts only preflight, apply and verify",
    );
  }
  if (platform !== "linux") throw forbidden("installer authority requires Linux");
  const marker = HANIEL_RUNTIME_MARKERS.find((name) => (env[name] ?? "") !== "");
  if (marker) throw forbidden(`${marker} marks a Haniel deployment`);
}

function isLocalDatabaseHost(host) {
  if (!host || host.includes(",")) return false;
  return LOCAL_DATABASE_HOSTS.has(host.toLowerCase()) || host.startsWith("/");
}

function isLocalSoulstreamDatabase(value, env) {
  let url;
  let database;
  let host;
  try {
    url = new URL(value);
    database = decodeURIComponent(url.pathname.slice(1));
    host = decodeURIComponent(url.hostname);
  } catch {
    return false;
  }
  // postgres.js connects to PGHOST, then localhost, when the URL has no host.
  if (!host) host = env.PGHOST?.trim() || "localhost";
  return database === INSTALLER_DATABASE_NAME && isLocalDatabaseHost(host);
}

/**
 * The installer dumps the local `soulstream` database through the local
 * socket. Migrations must target that same database. Messages never carry the
 * URL or its password.
 */
export function assertInstallerDatabaseTarget(env) {
  const migrationUrl = env.MIGRATION_DATABASE_URL?.trim();
  if (migrationUrl && migrationUrl !== env.DATABASE_URL?.trim()) {
    throw forbidden("MIGRATION_DATABASE_URL must equal DATABASE_URL");
  }
  if (!isLocalSoulstreamDatabase(readDatabaseUrl(env), env)) {
    throw forbidden("migration target must be the local soulstream database");
  }
}

export function systemctlExecutable(exists = existsSync) {
  return SYSTEMCTL_EXECUTABLES.find((path) => exists(path)) ?? null;
}

export async function showSystemdUnit(unit) {
  const executable = systemctlExecutable();
  if (!executable) throw new Error("systemctl executable is unavailable");
  return await new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      ["show", `--property=${SYSTEMCTL_PROPERTIES.join(",")}`, unit],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
    );
  });
}

function parseSystemctlShow(output) {
  const properties = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return properties;
}

/**
 * Reads each affected unit afresh. A stopped unit is inactive or failed with
 * no main process. Upgrades also require the unit to exist so a host without
 * these units cannot pass empty-handed; a first install creates the units only
 * after the schema, so it also accepts `not-found`.
 */
export async function assertInstallerQuiescence({
  operation,
  services,
  systemctlShow = showSystemdUnit,
}) {
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error("QUIESCENCE_REQUIRED: installer affected services are missing");
  }
  for (const unit of services) {
    let output;
    try {
      output = await systemctlShow(unit);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`QUIESCENCE_REQUIRED: systemctl show failed for ${unit}: ${reason}`);
    }
    const properties = parseSystemctlShow(output);
    const missing = SYSTEMCTL_PROPERTIES.filter((name) => !properties.get(name));
    if (missing.length > 0) {
      throw new Error(`QUIESCENCE_REQUIRED: ${unit} did not report ${missing.join(", ")}`);
    }
    const loadState = properties.get("LoadState");
    const activeState = properties.get("ActiveState");
    const mainPid = properties.get("MainPID");
    const present = loadState === "loaded"
      || (operation === "fresh_install" && loadState === "not-found");
    if (!present || !STOPPED_ACTIVE_STATES.has(activeState) || mainPid !== "0") {
      throw new Error(
        `QUIESCENCE_REQUIRED: ${unit} is not stopped`
          + ` (LoadState=${loadState}, ActiveState=${activeState}, MainPID=${mainPid})`,
      );
    }
  }
}
