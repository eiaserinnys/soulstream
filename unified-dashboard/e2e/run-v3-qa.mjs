#!/usr/bin/env node
/**
 * v3 QA 실행기.
 *
 * 쓰는 법:
 *   corepack pnpm@10.32.1 --dir unified-dashboard build
 *   corepack pnpm@10.32.1 --dir unified-dashboard run qa:v3            # e2e/v3-qa.list 전체
 *   corepack pnpm@10.32.1 --dir unified-dashboard run qa:v3 e2e/v3-list-flush.qa.ts
 *
 * 이미 빌드된 dist로 vite preview를 빈 포트에 띄우고, V3_QA_BASE_URL을 그 주소로
 * 넘긴다. `.qa.ts`는 tsx로, `.e2e.ts`는 playwright test로 돌린다. 실행기는
 * PLAYWRIGHT_MODULE과 PLAYWRIGHT_CHROMIUM_EXECUTABLE을 스스로 해결해 넘기므로
 * 쓰는 사람이 추가 환경변수를 줄 필요가 없다.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dashboardDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const listFile = join(dashboardDir, "e2e", "v3-qa.list");
// 실시간 WebGL 검수(components-feedback)는 공유 호스트에서 테마 네 조합이
// 각각 수 분씩 걸린다. 목록 전체 상한은 기준본 검증의 45분이 잡는다.
const perFileTimeoutMs = 1_500_000;
const apiBase = process.env.VITE_API_BASE || "http://127.0.0.1:5200";

if (!existsSync(join(dashboardDir, "dist", "index.html"))) {
  console.error("dist가 없습니다. 먼저 빌드하세요: corepack pnpm@10.32.1 --dir unified-dashboard build");
  process.exit(1);
}

const requested = process.argv.slice(2);
const files = (requested.length > 0
  ? requested
  : readFileSync(listFile, "utf8").split("\n").map((line) => line.trim()).filter(
    (line) => line.length > 0 && !line.startsWith("#"),
  )).map((file) => isAbsolute(file) ? file : resolve(dashboardDir, file));

if (files.length === 0) {
  console.error("실행할 QA 파일이 없습니다. e2e/v3-qa.list를 확인하세요.");
  process.exit(1);
}

const { tsxCli, playwrightCli, playwrightEntry, chromiumExecutable } = resolveTools();
const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const preview = startPreview(port);

let failed = 0;
const results = [];
try {
  await waitForPreview(baseUrl, preview);
  for (const file of files) {
    const result = await runFile(file);
    results.push(result);
    if (!result.ok) failed += 1;
  }
} finally {
  await stopPreview(preview);
}

const totalMs = results.reduce((sum, result) => sum + result.ms, 0);
console.log("");
for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.file}  ${(result.ms / 1000).toFixed(1)}s`);
}
console.log(`\nqa:v3 · ${results.length - failed} passed, ${failed} failed, ${(totalMs / 1000).toFixed(1)}s`);

process.exitCode = failed > 0 ? 1 : 0;

function resolveTools() {
  const requireFromTest = createRequire(require.resolve("@playwright/test/package.json"));
  const playwrightEntry = requireFromTest.resolve("playwright");
  const playwrightDir = dirname(playwrightEntry);
  const mjsEntry = join(playwrightDir, "index.mjs");
  return {
    tsxCli: packageBin("tsx"),
    playwrightCli: join(dirname(require.resolve("@playwright/test/package.json")), "cli.js"),
    playwrightEntry: existsSync(mjsEntry) ? pathToFileURL(mjsEntry).href : pathToFileURL(playwrightEntry).href,
    chromiumExecutable: chromiumExecutablePath(),
  };
}

function packageBin(name) {
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const bin = packageJson.bin;
  const entry = typeof bin === "string" ? bin : bin?.[name];
  if (!entry) throw new Error(`${name}의 bin 경로를 찾지 못했습니다.`);
  return join(dirname(packageJsonPath), entry);
}

function chromiumExecutablePath() {
  try {
    const requireFromTest = createRequire(require.resolve("@playwright/test/package.json"));
    const { chromium } = requireFromTest("playwright");
    const chrome = chromium.executablePath();
    // 헤드리스 실행은 headless shell이 담당한다. 이 노드의 전체 chrome은
    // crashpad 초기화에 실패해 SIGTRAP으로 죽으므로(261118 실측), 같은
    // 리비전의 headless shell이 있으면 그쪽을 넘긴다.
    const headless = chrome.replace(
      /chromium-(\d+)[/\\]chrome-linux(?:64)?[/\\]chrome$/,
      "chromium_headless_shell-$1/chrome-headless-shell-linux64/chrome-headless-shell",
    );
    return headless !== chrome && existsSync(headless) ? headless : chrome;
  } catch {
    return undefined;
  }
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function startPreview(port) {
  const viteCli = packageBin("vite");
  const child = spawn(
    process.execPath,
    [viteCli, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      cwd: dashboardDir,
      env: { ...process.env, VITE_API_BASE: apiBase },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  const collect = (chunk) => { output = `${output}${chunk.toString()}`.slice(-4_000); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return { child, output: () => output };
}

async function waitForPreview(baseUrl, preview) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (preview.child.exitCode !== null) {
      throw new Error(`vite preview가 시작 전에 끝났습니다.\n${preview.output()}`);
    }
    try {
      const response = await fetch(baseUrl, { method: "GET" });
      if (response.ok) return;
    } catch {
      // 아직 포트가 열리지 않았다.
    }
    await delay(200);
  }
  throw new Error(`vite preview가 60초 안에 응답하지 않았습니다.\n${preview.output()}`);
}

async function stopPreview(preview) {
  if (preview.child.exitCode !== null) return;
  preview.child.kill("SIGTERM");
  const exited = await waitForExit(preview.child, 5_000);
  if (!exited) {
    preview.child.kill("SIGKILL");
    await waitForExit(preview.child, 5_000);
  }
}

function runFile(file) {
  return new Promise((resolveResult) => {
    if (!existsSync(file)) {
      console.error(`파일이 없습니다: ${file}`);
      resolveResult({ file, ok: false, ms: 0 });
      return;
    }
    const relative = file.startsWith(`${dashboardDir}/`) ? file.slice(dashboardDir.length + 1) : file;
    const isQa = file.endsWith(".qa.ts");
    const grep = process.env.V3_QA_GREP;
    const args = isQa
      ? [tsxCli, file]
      : [playwrightCli, "test", "--config", "playwright.config.ts", ...(grep ? ["--grep", grep] : []), relative];
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: dashboardDir,
      env: {
        ...process.env,
        V3_QA_BASE_URL: baseUrl,
        VITE_API_BASE: apiBase,
        PLAYWRIGHT_MODULE: playwrightEntry,
        ...(chromiumExecutable ? { PLAYWRIGHT_CHROMIUM_EXECUTABLE: chromiumExecutable } : {}),
        COMPONENTS_REVIEW_PHASE: process.env.COMPONENTS_REVIEW_PHASE ?? "qa",
      },
      stdio: "inherit",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, perFileTimeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ok = !timedOut && code === 0;
      if (timedOut) console.error(`시간 초과 (${perFileTimeoutMs / 1000}s): ${relative}`);
      else if (!ok) console.error(`종료 코드 ${code ?? signal}: ${relative}`);
      resolveResult({ file: relative, ok, ms: Date.now() - startedAt });
    });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit(true);
      return;
    }
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
