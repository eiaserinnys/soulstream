import { execFileSync } from "node:child_process";

const LABEL_KEY = "soulstream-test-harness";
const POSTGRES_IMAGE = "postgres:16-alpine";
const POSTGRES_PORT = "5432/tcp";

export const SOULSTREAM_TEST_HARNESS_LABEL = `${LABEL_KEY}=1`;
export const DEFAULT_STALE_CONTAINER_AGE_MS = 2 * 60 * 60 * 1_000;

const activeContainerIds = new Set();
let hooksInstalled = false;

export function startPostgresTestContainer({
  user,
  password,
  database,
  staleAfterMs = DEFAULT_STALE_CONTAINER_AGE_MS,
}) {
  const reapedContainerIds = reapStalePostgresTestContainers({ staleAfterMs });
  const containerId = execFileSync("docker", [
    "run",
    "--rm",
    "-d",
    "--label",
    SOULSTREAM_TEST_HARNESS_LABEL,
    "-e",
    `POSTGRES_USER=${user}`,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_DB=${database}`,
    "-p",
    "127.0.0.1::5432",
    POSTGRES_IMAGE,
  ], { encoding: "utf8" }).trim();

  activeContainerIds.add(containerId);
  installProcessHooks();
  try {
    const port = dockerMappedPort(containerId);
    let stopped = false;
    return {
      containerId,
      port,
      reapedContainerIds,
      stop() {
        if (stopped) return;
        stopped = true;
        stopPostgresTestContainer(containerId);
      },
    };
  } catch (error) {
    stopPostgresTestContainer(containerId);
    throw error;
  }
}

export function reapStalePostgresTestContainers({
  staleAfterMs = DEFAULT_STALE_CONTAINER_AGE_MS,
  nowMs = Date.now(),
} = {}) {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new Error("staleAfterMs must be a non-negative finite number");
  }
  const ids = execFileSync("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=${SOULSTREAM_TEST_HARNESS_LABEL}`,
  ], { encoding: "utf8" })
    .split(/\s+/)
    .filter(Boolean);
  const reaped = [];
  for (const id of ids) {
    let createdAt;
    try {
      createdAt = execFileSync("docker", [
        "inspect",
        "--format",
        "{{.Created}}",
        id,
      ], { encoding: "utf8" }).trim();
    } catch (error) {
      if (isMissingContainerError(error)) continue;
      throw error;
    }
    const createdAtMs = Date.parse(createdAt);
    if (!Number.isFinite(createdAtMs)) {
      throw new Error(`docker returned an invalid creation timestamp for ${id}: ${createdAt}`);
    }
    if (nowMs - createdAtMs < staleAfterMs) continue;
    removeContainer(id);
    reaped.push(id);
  }
  if (reaped.length > 0) {
    process.stderr.write(
      `reaped stale Soulstream PostgreSQL test containers: ${reaped.join(", ")}\n`,
    );
  }
  return reaped;
}

export function stopPostgresTestContainer(containerId) {
  try {
    removeContainer(containerId);
  } finally {
    activeContainerIds.delete(containerId);
    if (activeContainerIds.size === 0) uninstallProcessHooks();
  }
}

function dockerMappedPort(containerId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const output = execFileSync("docker", ["port", containerId, POSTGRES_PORT], {
      encoding: "utf8",
    }).trim();
    const match = output.match(/:(\d+)$/);
    if (match) return match[1];
  }
  throw new Error("docker did not publish a PostgreSQL port");
}

function removeContainer(containerId) {
  try {
    execFileSync("docker", ["rm", "-f", "-v", containerId], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    if (!isMissingContainerError(error)) throw error;
  }
}

function isMissingContainerError(error) {
  const text = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  return /No such (?:object|container)/i.test(text);
}

function installProcessHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", handleExit);
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);
}

function uninstallProcessHooks() {
  if (!hooksInstalled) return;
  hooksInstalled = false;
  process.off("exit", handleExit);
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
}

function handleExit() {
  stopAllContainersBestEffort();
}

function handleSigint() {
  handleSignal("SIGINT");
}

function handleSigterm() {
  handleSignal("SIGTERM");
}

function handleSignal(signal) {
  stopAllContainersBestEffort();
  uninstallProcessHooks();
  process.kill(process.pid, signal);
}

function stopAllContainersBestEffort() {
  for (const containerId of [...activeContainerIds]) {
    try {
      removeContainer(containerId);
    } catch (error) {
      process.stderr.write(
        `failed to remove Soulstream PostgreSQL test container ${containerId}: ${error}\n`,
      );
    } finally {
      activeContainerIds.delete(containerId);
    }
  }
  uninstallProcessHooks();
}
