#!/usr/bin/env node
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { fetchBootstrap, platformKey, writeConfigGeneration } from "./lib/config.mjs";
import { awaitApproval, defaultNodeId, startPairing, validateNodeId } from "./lib/pairing.mjs";
import {
  alignCheckout,
  assertGit,
  cloneFull,
  cloneWorkspace,
  gitEnv,
  run,
  syncRepo,
  writeCredentialHelper,
} from "./lib/git.mjs";
import {
  ensureAllRuntimes,
  ensureRuntime,
  fetchCurrentRelease,
  installRelease,
  readRuntimeLock,
  runtimePlan,
} from "./lib/release.mjs";
import { ensureCodexLogin, ensurePorts, ensurePythonWrapper, prepareRelease } from "./lib/environment.mjs";
import { ChildSupervisor } from "./lib/supervisor.mjs";

const REENTRY_EXIT_CODE = 75;
const RETRY_DELAY_MS = 30000;

const log = (message) => process.stdout.write(`[portable-node] ${message}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function resolvePortableDir() {
  if (process.env.PORTABLE_NODE_DIR) return resolve(process.env.PORTABLE_NODE_DIR);
  const here = dirname(fileURLToPath(import.meta.url));
  if (basename(here) === "boot") {
    throw new Error("PORTABLE_NODE_DIR가 필요합니다. start.sh 또는 start.cmd로 실행하십시오.");
  }
  return here;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeStateFile(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode });
  if (process.platform !== "win32") await chmod(path, mode);
}

async function ensureStateLayout(stateRoot) {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(stateRoot, 0o700);
  for (const dir of [
    "runtimes",
    "config",
    "releases",
    "common",
    "outbox",
    "cache",
    "incoming",
    "codex",
    "claude-accounts",
    "home",
    "tmp",
    "git",
    "r",
    "bin",
    "runner/releases",
  ]) {
    await mkdir(join(stateRoot, dir), { recursive: true, mode: 0o700 });
  }
}

function checkRunnerStatePath(stateRoot) {
  const limit = process.platform === "darwin" ? 103 : process.platform === "linux" ? 107 : 0;
  if (limit === 0) return;
  const length = Buffer.byteLength(join(stateRoot, "r"), "utf8");
  if (length > limit) {
    throw new Error(
      `state 경로가 너무 깁니다(${length}바이트, 한계 ${limit}). 저장소를 더 짧은 경로에 clone한 뒤 다시 실행하십시오.`,
    );
  }
}

async function loadDefaults(portableDir) {
  const path = process.env.PORTABLE_NODE_DEFAULTS ?? join(portableDir, "defaults.json");
  const defaults = JSON.parse(await readFile(path, "utf8"));
  if (!defaults.upstream) throw new Error("defaults.json에 upstream이 없습니다.");
  return defaults;
}

async function loadLock(portableDir) {
  if (process.env.PORTABLE_NODE_RUNTIME_LOCK) {
    const lock = JSON.parse(await readFile(process.env.PORTABLE_NODE_RUNTIME_LOCK, "utf8"));
    if (lock.schema_version !== 1 || !lock.runtimes) throw new Error("runtime lock 형식이 올바르지 않습니다.");
    return lock;
  }
  return readRuntimeLock(portableDir);
}

async function askQuestions(defaultName) {
  const injected = process.env.PORTABLE_NODE_ANSWERS;
  if (injected) {
    const parsed = JSON.parse(injected);
    return { nodeId: parsed.node_id, companyPc: Boolean(parsed.company_pc) };
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "첫 실행 질문에 답할 터미널이 없습니다. PORTABLE_NODE_ANSWERS 환경변수로 node_id와 company_pc를 주십시오.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`노드 이름 [${defaultName}]: `)).trim();
    const company = (await rl.question("회사 PC입니까? [y/N]: ")).trim().toLowerCase();
    return {
      nodeId: answer.length > 0 ? answer : defaultName,
      companyPc: company === "y" || company === "yes",
    };
  } finally {
    rl.close();
  }
}

async function firstRun({ stateRoot, defaults }) {
  const suggested = defaultNodeId(hostname());
  const answers = await askQuestions(suggested);
  const nodeId = validateNodeId(answers.nodeId);
  log(`참여를 요청합니다: ${nodeId} (${answers.companyPc ? "회사 PC" : "개인 PC"})`);
  const pairing = await startPairing({
    upstream: defaults.upstream,
    nodeId,
    companyPc: answers.companyPc,
    timeoutMs: defaults.json_timeout_ms,
  });
  process.stdout.write(
    [
      "",
      "이 코드를 알려 승인을 요청하세요.",
      "",
      `    ${pairing.userCode}`,
      "",
      `(만료 ${new Date(pairing.expiresAt).toLocaleString()})`,
      "",
    ].join("\n"),
  );
  const approval = await awaitApproval({
    upstream: defaults.upstream,
    deviceCode: pairing.deviceCode,
    expiresAt: pairing.expiresAt,
    intervalSecs: defaults.pairing_poll_interval_secs,
    timeoutMs: defaults.json_timeout_ms,
    onPending: () => log("승인을 기다리는 중입니다…"),
  });
  const node = {
    schema_version: 1,
    node_id: approval.nodeId,
    company_pc: approval.companyPc,
    token: approval.token,
    upstream: defaults.upstream,
    node_ws_url: defaults.node_ws_url,
    paired_at: new Date().toISOString(),
    ports: {},
  };
  await writeStateFile(join(stateRoot, "node.json"), node);
  log("참여가 승인되었습니다.");
  return node;
}

async function waitForCurrent({ defaults, node }) {
  for (;;) {
    try {
      return await fetchCurrentRelease({
        upstream: defaults.upstream,
        token: node.token,
        timeoutMs: defaults.json_timeout_ms,
      });
    } catch (error) {
      if (error.code === "NOT_READY") {
        log(error.message);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
}

async function waitForBootstrap({ defaults, node, sourceCommit }) {
  for (;;) {
    try {
      return await fetchBootstrap({
        upstream: defaults.upstream,
        token: node.token,
        sourceCommit,
        timeoutMs: defaults.json_timeout_ms,
      });
    } catch (error) {
      if (error.code === "TRUST_CLASSIFICATION_PENDING") {
        log(error.message);
        await sleep((error.retryAfterSecs ?? 30) * 1000);
        continue;
      }
      if (error.code === "VERSION_MISMATCH") {
        throw new Error(`${error.message} 실행기를 다시 시작하면 새 판에 맞춥니다.`);
      }
      throw error;
    }
  }
}

async function ensureRepos({ stateRoot, defaults }) {
  const workspaceDir = join(stateRoot, "workspace");
  const commonDir = join(stateRoot, "common");
  const workspaceConfig = defaults.repositories.workspace;
  const commonConfig = defaults.repositories.common;
  if (!existsSync(join(workspaceDir, ".git"))) {
    log("private workspace 리포를 처음 받습니다…");
    await cloneWorkspace({
      stateRoot,
      target: workspaceDir,
      upstream: defaults.upstream,
      proxyPath: workspaceConfig.proxy_path,
      sparsePatterns: workspaceConfig.sparse_patterns,
    });
  } else {
    const sync = await syncRepo({ stateRoot, dir: workspaceDir });
    if (!sync.ok) log(`경고: workspace를 앞으로 보내지 못했습니다. ${sync.message}`);
  }
  if (!existsSync(join(commonDir, ".git"))) {
    log("private common 리포를 처음 받습니다…");
    await cloneFull({
      stateRoot,
      target: commonDir,
      upstream: defaults.upstream,
      proxyPath: commonConfig.proxy_path,
    });
  } else {
    const sync = await syncRepo({ stateRoot, dir: commonDir });
    if (!sync.ok) log(`경고: common을 앞으로 보내지 못했습니다. ${sync.message}`);
  }
}

async function checkoutIsClean(repoRoot, stateRoot) {
  const status = await run("git", ["-C", repoRoot, "status", "--porcelain"], { env: gitEnv(stateRoot) });
  return status.code === 0 && status.stdout.trim() === "";
}

function makeSupervisor({ env, dir, defaults }) {
  return new ChildSupervisor({
    command: process.execPath,
    args: [join(dir, "dist", "main.js")],
    cwd: dir,
    env,
    readyWindowMs: defaults.ready_window_ms,
    restartDelayMs: defaults.restart_delay_ms,
    shutdownGraceMs: defaults.shutdown_grace_ms,
    log,
  });
}

function makeUpdateChecker(context) {
  let switching = false;
  return async () => {
    if (switching || context.updatesDisabled) return;
    switching = true;
    try {
      const current = await fetchCurrentRelease({
        upstream: context.defaults.upstream,
        token: context.node.token,
        timeoutMs: context.defaults.json_timeout_ms,
      });
      if (current.sha256 === context.active.sha256 && current.source_commit === context.active.source_commit) {
        return;
      }
      log("새 판이 있습니다. 준비합니다.");
      if (!(await checkoutIsClean(context.repoRoot, context.stateRoot))) {
        log("경고: 소스 작업 트리에 변경이 있어 판 전환을 보류합니다. 변경을 보존합니다.");
        return;
      }
      const bootstrap = await waitForBootstrap({
        defaults: context.defaults,
        node: context.node,
        sourceCommit: current.source_commit,
      });
      await writeConfigGeneration({
        bootstrap,
        stateRoot: context.stateRoot,
        configRoot: join(context.stateRoot, "config"),
      });
      await installRelease({
        stateRoot: context.stateRoot,
        upstream: context.defaults.upstream,
        token: context.node.token,
        release: current,
        log,
      });
      const alignment = await alignCheckout({
        stateRoot: context.stateRoot,
        root: context.repoRoot,
        sourceCommit: current.source_commit,
      });
      if (!alignment.aligned) {
        log(`경고: 판 전환을 보류합니다. ${alignment.message ?? ""}`);
        return;
      }
      log("child를 정상 종료하고 새 판으로 재진입합니다.");
      await context.supervisor.stop("switch");
      process.exit(REENTRY_EXIT_CODE);
    } finally {
      switching = false;
    }
  };
}

async function startWithRollback({ context, release, installed, runtimes, ports, extraEnv }) {
  const activePath = join(context.stateRoot, "active-release.json");
  const previous = await readJson(activePath);
  const supervisor = makeSupervisor({ env: context.prepared.env, dir: installed.dir, defaults: context.defaults });
  const startResult = await supervisor.start();
  if (startResult.started) {
    await writeStateFile(activePath, {
      source_commit: release.source_commit,
      sha256: release.sha256,
      config_generation: context.configGeneration,
      activated_at: new Date().toISOString(),
    });
    return { supervisor, previous };
  }
  log(`soul-server가 기동하지 못했습니다 (code=${startResult.exit?.code}).`);
  if (!previous || previous.source_commit === release.source_commit) {
    throw new Error("soul-server가 기동하지 못했습니다. 위 오류를 확인하십시오.");
  }
  const previousDir = join(context.stateRoot, "releases", previous.source_commit);
  if (!existsSync(join(previousDir, ".portable-verified.json"))) {
    throw new Error("이전 판 묶음이 없어 되돌릴 수 없습니다. 위 오류를 확인하십시오.");
  }
  log("이전 판으로 한 번 되돌립니다.");
  try {
    const previousPrepared = await prepareRelease({
      stateRoot: context.stateRoot,
      defaults: context.defaults,
      node: context.node,
      configDir: join(context.stateRoot, "config", previous.config_generation ?? context.configGeneration),
      releaseDir: previousDir,
      runtimes,
      ports,
      extraEnv,
    });
    const previousSupervisor = makeSupervisor({
      env: previousPrepared.env,
      dir: previousDir,
      defaults: context.defaults,
    });
    const previousResult = await previousSupervisor.start();
    if (previousResult.started) {
      await writeStateFile(join(context.stateRoot, "rollback.json"), {
        from: release.source_commit,
        to: previous.source_commit,
        at: new Date().toISOString(),
      });
      log("이전 판으로 기동했습니다. 새 판 문제를 확인한 뒤 다시 시작하십시오.");
      return { supervisor: previousSupervisor, previous, rolledBack: true };
    }
  } catch (error) {
    log(`이전 판 복구도 실패했습니다: ${error.message}`);
  }
  throw new Error("soul-server가 기동하지 못했습니다. 위 오류를 확인하십시오.");
}

async function main() {
  const portableDir = resolvePortableDir();
  const stateRoot = process.env.PORTABLE_NODE_STATE_DIR
    ? resolve(process.env.PORTABLE_NODE_STATE_DIR)
    : join(portableDir, ".state");
  const repoRoot = process.env.PORTABLE_NODE_REPO_ROOT
    ? resolve(process.env.PORTABLE_NODE_REPO_ROOT)
    : dirname(portableDir);

  await ensureStateLayout(stateRoot);
  checkRunnerStatePath(stateRoot);
  const defaults = await loadDefaults(portableDir);
  const lock = await loadLock(portableDir);

  let node = await readJson(join(stateRoot, "node.json"));
  if (!node) node = await firstRun({ stateRoot, defaults });

  await assertGit();
  await writeCredentialHelper(stateRoot, { nodePath: process.execPath });

  const release = await waitForCurrent({ defaults, node });
  const alignment = await alignCheckout({ stateRoot, root: repoRoot, sourceCommit: release.source_commit });
  if (alignment.aligned && alignment.changed) {
    log("소스 판을 릴리스에 맞췄습니다. 실행기를 다시 시작합니다.");
    process.exit(REENTRY_EXIT_CODE);
  }
  if (!alignment.aligned) log(`경고: ${alignment.message}`);

  const plan = runtimePlan(lock, platformKey());
  const nodePlan = plan.find((entry) => entry.kind === "node");
  if (process.version !== `v${nodePlan.version}`) {
    await ensureRuntime({ stateRoot, plan, kind: "node", log });
    log(`Node ${nodePlan.version}으로 다시 시작합니다.`);
    process.exit(REENTRY_EXIT_CODE);
  }

  const runtimes = await ensureAllRuntimes({ stateRoot, lock, log });
  const bootstrap = await waitForBootstrap({ defaults, node, sourceCommit: release.source_commit });
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

  await ensureRepos({ stateRoot, defaults });

  const ports = await ensurePorts(stateRoot, node, (updated) =>
    writeStateFile(join(stateRoot, "node.json"), updated),
  );
  await ensurePythonWrapper(stateRoot, runtimes.python.executable);
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
  await ensureCodexLogin({ stateRoot, codexExecutable: runtimes.codex.executable, env: prepared.env });

  const context = {
    stateRoot,
    repoRoot,
    defaults,
    node,
    configGeneration: configGeneration.generation,
    prepared,
    updatesDisabled: false,
  };
  const { supervisor, rolledBack } = await startWithRollback({
    context,
    release,
    installed,
    runtimes,
    ports,
    extraEnv,
  });
  context.updatesDisabled = Boolean(rolledBack);
  log(`soul-server를 시작했습니다 (${release.source_commit.slice(0, 12)}).`);
  log(`Claude 계정 등록은 기존 대시보드의 이 노드(${node.node_id}) 로그인 위치에서 하십시오.`);

  const checkForUpdate = makeUpdateChecker({ ...context, active: { source_commit: release.source_commit, sha256: release.sha256 }, supervisor });
  const timer = setInterval(() => {
    checkForUpdate().catch((error) => log(`갱신 확인 실패: ${error.message}`));
  }, (defaults.check_interval_secs ?? 60) * 1000);
  timer.unref();

  const outcome = await supervisor.run();
  log(`감독을 마쳤습니다 (${outcome.stoppedBy}, 재시작 ${outcome.restarts}회).`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    log(`중단: ${error.message}`);
    process.exitCode = 1;
  });
