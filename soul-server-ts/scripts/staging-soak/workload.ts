import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ResolvedSoakConfig } from "./config.js";
import {
  exportRunnerEvidence,
  writeFixtureCandidates,
} from "./event_evidence.js";
import { SoakProcessController } from "./process_controller.js";
import { SessionSseCollector } from "./sse_collector.js";

interface SoakAction {
  at: string;
  action: string;
  details?: Record<string, unknown>;
}

export interface SoakResult {
  runId: string;
  backend: "claude" | "codex";
  sessionId: string;
  startedAt: string;
  completedAt: string;
  durationMinutes: number;
  runnerPidBeforeRestart: number;
  runnerPidAfterRestart: number;
  runnerSurvivedRestart: boolean;
  finalStatus: string;
  mcpRoundTripObserved: boolean;
  eventTypeCounts: Record<string, number>;
  dropCount: number;
  dropSummaries: Record<string, unknown>[];
  fixtureCandidateCount: number;
  durableEventCount: number;
  ipcJournalCount: number;
  actions: SoakAction[];
}

export async function runSoakWorkload(input: {
  config: ResolvedSoakConfig;
  bearerToken: string;
  controller: SoakProcessController;
  backend: "claude" | "codex";
}): Promise<SoakResult> {
  const { config, bearerToken, controller, backend } = input;
  const runId = `${backend}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const captureDirectory = join(config.paths.captures, runId);
  await mkdir(captureDirectory, { recursive: true, mode: 0o700 });
  const actions: SoakAction[] = [];
  const startedAt = new Date();
  const session = await postJson<{ agentSessionId: string }>(
    `http://${config.host}:${config.orchPort}/api/sessions`,
    bearerToken,
    {
      prompt: initialPrompt(config.restartAfterMinutes, backend),
      profile: backend === "claude" ? config.profile : config.codexProfile,
      model_preset: backend === "claude" ? config.modelPreset : config.codexModelPreset,
      caller_info: { source: "staging_soak", display_name: "Runner staging soak" },
    },
  );
  actions.push({ at: new Date().toISOString(), action: "session_created" });

  const collector = new SessionSseCollector(
    `http://${config.host}:${config.orchPort}`,
    bearerToken,
    join(captureDirectory, "orch-session-sse.jsonl"),
  );
  const collectorAbort = new AbortController();
  const collection = collector.run(session.agentSessionId, collectorAbort.signal);

  const runnerPidBeforeRestart = await waitForRunnerPid(controller, session.agentSessionId, 30_000);
  let runnerPidAfterRestart = runnerPidBeforeRestart;
  let restarted = false;
  let interventionIndex = 0;
  let nextInterventionAt = startedAt.getTime() + config.interventionEveryMinutes * 60_000;
  const restartAt = startedAt.getTime() + config.restartAfterMinutes * 60_000;
  const finishAt = startedAt.getTime() + config.durationMinutes * 60_000;

  while (Date.now() < finishAt) {
    const now = Date.now();
    if (!restarted && now >= restartAt) {
      await controller.restartSoul();
      runnerPidAfterRestart = await waitForRunnerPid(controller, session.agentSessionId, 30_000);
      if (runnerPidAfterRestart !== runnerPidBeforeRestart) {
        throw new Error(
          `runner pid changed across staging soul restart: ${runnerPidBeforeRestart} -> ${runnerPidAfterRestart}`,
        );
      }
      await controller.assertRunnerAlive(session.agentSessionId, runnerPidBeforeRestart);
      restarted = true;
      actions.push({
        at: new Date().toISOString(),
        action: "soul_restarted",
        details: { runnerPidPreserved: true },
      });
    }
    if (now >= nextInterventionAt) {
      interventionIndex += 1;
      await postJson(
        `http://${config.host}:${config.orchPort}/api/sessions/${session.agentSessionId}/intervene`,
        bearerToken,
        { text: interventionPrompt(interventionIndex) },
      );
      actions.push({
        at: new Date().toISOString(),
        action: "intervention",
        details: { index: interventionIndex },
      });
      nextInterventionAt += config.interventionEveryMinutes * 60_000;
    }
    await delay(Math.min(1_000, finishAt - now));
  }

  await postJson(
    `http://${config.host}:${config.orchPort}/api/sessions/${session.agentSessionId}/intervene`,
    bearerToken,
    { text: finalPrompt() },
  );
  actions.push({ at: new Date().toISOString(), action: "final_intervention" });
  const finalStatus = await waitForTerminalStatus(config, bearerToken, session.agentSessionId, 600_000);
  await delay(2_000);
  collectorAbort.abort(new Error("soak workload complete"));
  await collection;

  const evidence = await exportRunnerEvidence({
    sessionId: session.agentSessionId,
    runnerStateDirectory: config.paths.runnerState,
    outputDirectory: captureDirectory,
  });
  const fixtureCandidateCount = await writeFixtureCandidates(
    join(captureDirectory, "fixture-candidates.jsonl"),
    collector.envelopes,
  );
  const dropSummaries = await readDropSummaries(config.paths.soulLog);
  const result: SoakResult = {
    runId,
    backend,
    sessionId: session.agentSessionId,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMinutes: config.durationMinutes,
    runnerPidBeforeRestart,
    runnerPidAfterRestart,
    runnerSurvivedRestart: runnerPidAfterRestart === runnerPidBeforeRestart,
    finalStatus,
    mcpRoundTripObserved: collector.hasMcpToolRoundTrip(),
    eventTypeCounts: collector.eventTypeCounts(),
    dropCount: dropSummaries.length,
    dropSummaries,
    fixtureCandidateCount,
    durableEventCount: evidence.eventCount,
    ipcJournalCount: evidence.journalCount,
    actions,
  };
  if (!result.mcpRoundTripObserved) throw new Error("staging soak did not observe MCP round trip");
  if (!result.runnerSurvivedRestart) throw new Error("staging runner did not survive host restart");
  await writeFile(
    join(captureDirectory, "soak-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    { mode: 0o600 },
  );
  return result;
}

function initialPrompt(
  restartAfterMinutes: number,
  backend: "claude" | "codex",
): string {
  const longSleepSeconds = Math.max(120, Math.ceil((restartAfterMinutes + 2) * 60));
  const longSleepTimeoutMs = (longSleepSeconds + 60) * 1_000;
  return [
    "이것은 격리된 Soulstream 러너 스테이징 소크다.",
    "현재 세션 ID로 soulstream MCP의 get_session_name 도구를 반드시 한 번 호출하라.",
    `현재 backend는 ${backend}다.`,
    "그 뒤 셸 명령 도구를 각각 별도 호출로 6번 사용해 pwd, node --version, date, printf SOAK_PRE_1/2/3을 실행하라.",
    `그 다음 셸 명령 도구로 \"sleep ${longSleepSeconds}; printf SOAK_LONG_TURN_DONE\"을 timeout ${longSleepTimeoutMs}ms로 실행하라. 중간 개입이 오면 반영하고 계속하라.`,
    "마지막으로 셸 명령 도구를 4회 더 호출해 printf SOAK_POST_1/2/3 및 git rev-parse --short HEAD를 실행하라.",
    "작업 경로 밖의 파일을 수정하거나 외부 네트워크를 직접 호출하지 마라.",
  ].join("\n");
}

function interventionPrompt(index: number): string {
  return [
    `스테이징 소크 체크포인트 ${index}다.`,
    `셸 명령 도구를 세 번 별도 호출해 printf SOAK_INTERVENTION_${index}_A/B/C를 실행하라.`,
    "soulstream MCP의 get_session_name을 현재 세션 ID로 다시 한 번 호출하라.",
    "이전 장기 작업이 남아 있으면 이어서 완료하라.",
  ].join("\n");
}

function finalPrompt(): string {
  return [
    "스테이징 소크 종료 지시다.",
    "남은 Bash 작업을 완료하고 soulstream MCP get_session_name을 마지막으로 호출하라.",
    "SOAK_COMPLETE 한 줄을 포함해 간단히 결과를 보고한 뒤 턴을 정상 완료하라.",
  ].join("\n");
}

async function postJson<T = unknown>(
  url: string,
  bearerToken: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`staging request failed: HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function waitForRunnerPid(
  controller: SoakProcessController,
  sessionId: string,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { return await controller.readRunnerPid(sessionId); } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error("staging runner pid did not appear", { cause: lastError });
}

async function waitForTerminalStatus(
  config: ResolvedSoakConfig,
  bearerToken: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `http://${config.host}:${config.orchPort}/api/sessions?session_id=${encodeURIComponent(sessionId)}`,
      { headers: { authorization: `Bearer ${bearerToken}` } },
    );
    if (!response.ok) throw new Error(`session status query failed: HTTP ${response.status}`);
    const status = findSessionStatus(await response.json(), sessionId);
    if (["completed", "failed", "error", "interrupted", "cancelled", "killed"].includes(status)) {
      if (status !== "completed") throw new Error(`staging soak session ended as ${status}`);
      return status;
    }
    await delay(1_000);
  }
  throw new Error("staging soak session did not reach completed status");
}

function findSessionStatus(value: unknown, sessionId: string): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = findSessionStatus(item, sessionId);
      if (status) return status;
    }
    return "";
  }
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const id = record.agentSessionId ?? record.agent_session_id ?? record.id;
  if (id === sessionId && typeof record.status === "string") return record.status;
  for (const child of Object.values(record)) {
    const status = findSessionStatus(child, sessionId);
    if (status) return status;
  }
  return "";
}

async function readDropSummaries(logPath: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(logPath, "utf8");
  const drops: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("Invalid observational runner frame dropped")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      drops.push({
        eventType: parsed.eventType ?? null,
        correlationId: parsed.correlationId ?? null,
        dropCount: parsed.dropCount ?? null,
        message: parsed.msg ?? "Invalid observational runner frame dropped",
      });
    } catch {
      drops.push({ message: line.slice(0, 500) });
    }
  }
  return drops;
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
