import { existsSync } from "node:fs";
import { join } from "node:path";
import { sanitizeGeneration, writeConfigGeneration } from "./config.mjs";
import { prepareRelease } from "./environment.mjs";
import { ensureRuntime, installRelease, releaseMarkerPath, runtimeInstallDir } from "./release.mjs";
import { ChildSupervisor } from "./supervisor.mjs";
import { readJson, writeStateFile } from "./state.mjs";

/** P3 payload는 main.js를 묶음 루트에 둔다(dist/가 아니다). */
export function makeSupervisor({ env, dir, defaults, log }) {
  return new ChildSupervisor({
    command: process.execPath,
    args: [join(dir, "main.js")],
    cwd: dir,
    env,
    readyWindowMs: defaults.ready_window_ms,
    restartDelayMs: defaults.restart_delay_ms,
    shutdownGraceMs: defaults.shutdown_grace_ms,
    log,
  });
}

/**
 * node는 호출자가 게이트를 먼저 통과시킨다. 여기서는 이미 맞는 Node 폴더를
 * 지우지 않도록 설치 경로만 기록하고, 나머지 런타임을 준비한다.
 */
export async function installRuntimes({ stateRoot, plan, log = () => {} }) {
  const results = {};
  for (const entry of plan) {
    if (entry.kind === "node") {
      const dir = runtimeInstallDir(stateRoot, "node", entry.version);
      results.node = {
        kind: "node",
        dir,
        version: entry.version,
        installed: false,
        executable: join(dir, entry.executable),
      };
      continue;
    }
    results[entry.kind] = await ensureRuntime({ stateRoot, plan, kind: entry.kind, log });
  }
  return results;
}

/** 구성·payload·바인딩을 한 번에 준비한다. child는 아직 건드리지 않는다. */
export async function prepareCandidate({ stateRoot, defaults, node, runtimes, ports, release, bootstrap, log = () => {} }) {
  const configGeneration = await writeConfigGeneration({
    bootstrap,
    stateRoot,
    configRoot: join(stateRoot, "config"),
  });
  const installed = await installRelease({
    stateRoot,
    upstream: defaults.upstream,
    token: node.token,
    release,
    log,
  });
  const extraEnv = (await readJson(configGeneration.files.env)) ?? {};
  const prepared = await prepareRelease({
    stateRoot,
    defaults,
    node,
    configDir: configGeneration.dir,
    releaseDir: installed.dir,
    runtimes,
    ports,
    extraEnv,
  });
  return { configGeneration, installed, prepared };
}

/** 기동에 성공해야만 active-release.json을 바꾼다. */
export async function startCandidate({ stateRoot, defaults, release, candidate, log }) {
  const supervisor = makeSupervisor({ env: candidate.prepared.env, dir: candidate.installed.dir, defaults, log });
  const result = await supervisor.start();
  if (!result.started) {
    throw new Error(`soul-server가 기동하지 못했습니다 (code=${result.exit?.code ?? "?"}).`);
  }
  await writeStateFile(join(stateRoot, "active-release.json"), {
    source_commit: release.source_commit,
    sha256: release.sha256,
    config_generation: candidate.configGeneration.generation,
    activated_at: new Date().toISOString(),
  });
  return supervisor;
}

/**
 * 마지막으로 기동에 성공한 판(active-release.json)으로 되돌린다.
 * bind·start 어느 단계에서 실패해도 여기로 온다.
 */
export async function rollbackToPrevious({
  stateRoot,
  defaults,
  node,
  runtimes,
  ports,
  previous,
  from,
  log,
}) {
  if (!previous || previous.source_commit === from.source_commit) return null;
  const dir = join(stateRoot, "releases", String(previous.source_commit));
  if (!existsSync(dir) || !existsSync(releaseMarkerPath(stateRoot, previous.source_commit))) {
    log("이전 판 묶음이 없어 되돌릴 수 없습니다.");
    return null;
  }
  let configGeneration;
  try {
    configGeneration = sanitizeGeneration(previous.config_generation);
  } catch {
    log("이전 판 구성 세대를 읽지 못해 되돌릴 수 없습니다.");
    return null;
  }
  try {
    const configDir = join(stateRoot, "config", configGeneration);
    const extraEnv = (await readJson(join(configDir, "env.json"))) ?? {};
    const prepared = await prepareRelease({
      stateRoot,
      defaults,
      node,
      configDir,
      releaseDir: dir,
      runtimes,
      ports,
      extraEnv,
    });
    const supervisor = makeSupervisor({ env: prepared.env, dir, defaults, log });
    const result = await supervisor.start();
    if (!result.started) {
      throw new Error(`이전 판이 기동하지 못했습니다 (code=${result.exit?.code ?? "?"}).`);
    }
    await writeStateFile(join(stateRoot, "rollback.json"), {
      from: from.source_commit,
      to: previous.source_commit,
      at: new Date().toISOString(),
    });
    return { supervisor, dir, configGeneration };
  } catch (error) {
    log(`이전 판 복구도 실패했습니다: ${error.message}`);
    return null;
  }
}
