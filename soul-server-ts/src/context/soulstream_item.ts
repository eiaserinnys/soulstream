/**
 * soulstream 세션 메타데이터 context_item 생성기 — Python `service/context_builder.py
 * build_soulstream_context_item` 정본 그대로 이식.
 *
 * codex 세션의 첫 turn prompt에 prepend되어 codex agent가 *자기 세션 정보·발신자 신원*을
 * 인지하도록 한다. caller_info 운반은 R-2 회로(dashboard owner Google portrait fallback) 차단
 * 정본 — PR #56이 hydration 시점에 task.callerInfo를 복원하고 본 helper가 *prompt에 forward*.
 */

import os from "node:os";
import { hostname } from "node:os";

import type { CallerInfo } from "../task/task_models.js";

import type { ContextItem } from "./prompt_assembler.js";

export interface SoulstreamContainerContext {
  kind: "folder" | "runbook";
  id: string;
  title: string;
}

export interface SoulstreamContextParams {
  agentSessionId: string;
  claudeSessionId?: string | null;
  workspaceDir: string;
  folderName?: string | null;
  nodeId?: string;
  agentId?: string;
  callerInfo?: CallerInfo;
  container?: SoulstreamContainerContext | null;
  sourceRunbookItemId?: string | null;
  runbookGuidance?: string | null;
}

/**
 * 외부 호스트 IP를 best-effort로 추출 (Python `socket.connect("8.8.8.8", 80)` 트릭의 TS 등가).
 * 실패 시 "unknown". codex 세션 prompt 안에서 진단용으로만 사용 — 누락이 turn 진행을 차단하지 않음.
 */
function detectLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const ifaceList of Object.values(interfaces)) {
    if (!ifaceList) continue;
    for (const iface of ifaceList) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "unknown";
}

/**
 * 소울스트림 세션 메타 context_item 생성 (Python L17-69 정본).
 *
 * dict content (key/value):
 *   - agent_session_id, claude_session_id(또는 "(new session)"), workspace_dir
 *   - folder(folder_name 또는 "(unassigned)")
 *   - container (primary board item container가 있으면)
 *   - source_runbook_item_id (runbook item에서 파생된 세션이면)
 *   - runbook_guidance (runbook container면 행동 안내)
 *   - hostname, ip_address, current_node_id
 *   - host_os, os_version, current_time (ISO)
 *   - agent_id (있을 때만)
 *   - caller_info (있을 때만 — R-2 차단)
 */
export function buildSoulstreamContextItem(
  params: SoulstreamContextParams,
): ContextItem {
  const content: Record<string, unknown> = {
    agent_session_id: params.agentSessionId,
    claude_session_id: params.claudeSessionId ?? "(new session)",
    workspace_dir: params.workspaceDir,
    folder: params.folderName ?? "(unassigned)",
    hostname: hostname(),
    ip_address: detectLocalIp(),
    current_node_id: params.nodeId ?? "",
    host_os: os.type(),
    os_version: os.release(),
    current_time: new Date().toISOString(),
  };
  if (params.agentId) {
    content.agent_id = params.agentId;
  }
  if (params.container) {
    content.container = params.container;
  }
  if (params.sourceRunbookItemId) {
    content.source_runbook_item_id = params.sourceRunbookItemId;
  }
  if (params.runbookGuidance) {
    content.runbook_guidance = params.runbookGuidance;
  }
  if (params.callerInfo) {
    // R-2 회로 차단 정본 (PR #56 hydration callerInfo 복원과 짝).
    content.caller_info = params.callerInfo;
  }
  return {
    key: "soulstream_session",
    label: "Soulstream 세션 정보",
    content,
  };
}
