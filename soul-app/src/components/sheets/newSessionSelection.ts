import type { SessionAgentOption } from './optimisticSession';
import type { ModelPresetAvailability } from '../../api/nodeEndpoints';
import {
  buildFolderTreeRows,
  formatFolderDepthLabel,
} from '../../lib/folder-tree';

export interface NewSessionFolder {
  id: string;
  name: string;
  sortOrder: number;
  parentFolderId?: string | null;
}

export interface NewSessionNode {
  nodeId: string;
}

export type NewSessionAgent = SessionAgentOption;

export interface NewSessionActionSheet {
  options: string[];
  cancelButtonIndex: number;
  title: string;
  disabledButtonIndices?: number[];
}

type CancelledSelection = { cancelled: true };
type SelectedFolder = { cancelled: false; folderId: string | null };
type SelectedNode = { cancelled: false; nodeId: string | null };
type SelectedAgent = { cancelled: false; agentId: string | null };
type SelectedModelPreset = { cancelled: false; modelPresetId: string | null };

export function sortNewSessionFolders(
  folders: readonly NewSessionFolder[],
): NewSessionFolder[] {
  return buildFolderTreeRows(folders, { expandAll: true }).map((row) => row.folder);
}

export function buildFolderActionSheet(
  sortedFolders: readonly NewSessionFolder[],
): NewSessionActionSheet {
  const rows = buildFolderTreeRows(sortedFolders, { expandAll: true });
  const options = [
    '폴더 선택 안 함',
    ...rows.map((row) => formatFolderDepthLabel(row.folder.name, row.depth)),
    '취소',
  ];
  return {
    options,
    cancelButtonIndex: options.length - 1,
    title: '폴더 선택',
  };
}

export function resolveFolderActionSheetSelection(
  index: number,
  sortedFolders: readonly NewSessionFolder[],
  cancelButtonIndex: number,
): CancelledSelection | SelectedFolder {
  if (index === cancelButtonIndex) return { cancelled: true };
  if (index === 0) return { cancelled: false, folderId: null };
  return {
    cancelled: false,
    folderId: sortedFolders[index - 1]?.id ?? null,
  };
}

export function buildNodeActionSheet(
  nodes: readonly NewSessionNode[],
): NewSessionActionSheet {
  const options = [
    '자동',
    ...nodes.map((node) => actionSheetLabel(node.nodeId, '(알 수 없는 노드)')),
    '취소',
  ];
  return {
    options,
    cancelButtonIndex: options.length - 1,
    title: '노드 선택',
  };
}

export function resolveNodeActionSheetSelection(
  index: number,
  nodes: readonly NewSessionNode[],
  cancelButtonIndex: number,
): CancelledSelection | SelectedNode {
  if (index === cancelButtonIndex) return { cancelled: true };
  if (index === 0) return { cancelled: false, nodeId: null };
  return {
    cancelled: false,
    nodeId: nodes[index - 1]?.nodeId ?? null,
  };
}

export function buildAgentActionSheet(
  agents: readonly NewSessionAgent[],
): NewSessionActionSheet {
  const options = [
    '자동 선택',
    ...agents.map((agent) => actionSheetLabel(agent.name, '(이름 없는 에이전트)')),
    '취소',
  ];
  return {
    options,
    cancelButtonIndex: options.length - 1,
    title: '에이전트 선택',
  };
}

export function resolveAgentActionSheetSelection(
  index: number,
  agents: readonly NewSessionAgent[],
  cancelButtonIndex: number,
): CancelledSelection | SelectedAgent {
  if (index === cancelButtonIndex) return { cancelled: true };
  if (index === 0) return { cancelled: false, agentId: null };
  return {
    cancelled: false,
    agentId: agents[index - 1]?.id ?? null,
  };
}

export function buildModelPresetActionSheet(
  presets: readonly ModelPresetAvailability[],
): NewSessionActionSheet {
  const options = [
    '자동 선택',
    ...presets.map((preset) => formatModelPresetLabel(preset)),
    '취소',
  ];
  return {
    options,
    cancelButtonIndex: options.length - 1,
    disabledButtonIndices: presets.flatMap((preset, index) =>
      preset.available ? [] : [index + 1]),
    title: '모델 선택',
  };
}

export function resolveModelPresetActionSheetSelection(
  index: number,
  presets: readonly ModelPresetAvailability[],
  cancelButtonIndex: number,
): CancelledSelection | SelectedModelPreset {
  if (index === cancelButtonIndex) return { cancelled: true };
  if (index === 0) return { cancelled: false, modelPresetId: null };
  const preset = presets[index - 1];
  if (!preset?.available) return { cancelled: true };
  return { cancelled: false, modelPresetId: preset.id };
}

export function resolveSelectedFolderName(
  selectedFolderId: string | null,
  sortedFolders: readonly NewSessionFolder[],
): string {
  if (!selectedFolderId) return '폴더 선택 안 함';
  const row = buildFolderTreeRows(sortedFolders, { expandAll: true }).find(
    (item) => item.folder.id === selectedFolderId,
  );
  if (!row) return '(알 수 없음)';
  return formatFolderDepthLabel(row.folder.name, row.depth);
}

export function resolveSelectedAgentName(
  agentId: string | null,
  agents: readonly NewSessionAgent[],
): string {
  if (!agentId) return '자동 선택';
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) return '(알 수 없음)';
  return actionSheetLabel(agent.name, '(이름 없는 에이전트)');
}

export function resolveSelectedNodeName(
  selectedNodeId: string | null,
  settingsNodeId: string | null | undefined,
): string {
  if (!selectedNodeId) {
    return settingsNodeId ? `자동 (${settingsNodeId})` : '자동';
  }
  return selectedNodeId;
}

export function resolveSelectedModelPresetName(
  modelPresetId: string | null,
  presets: readonly ModelPresetAvailability[],
  presetsLoaded: boolean,
  presetsFailed: boolean,
  automatic = false,
): string {
  if (!modelPresetId) return '자동 선택';
  const preset = presets.find((candidate) => candidate.id === modelPresetId);
  if (!preset) {
    if (presetsFailed) return '모델 목록을 불러오지 못했습니다';
    return presetsLoaded ? '모델을 다시 선택해 주세요' : '불러오는 중…';
  }
  const label = formatModelPresetLabel(preset, false);
  return automatic ? `자동 (${label})` : label;
}

export function formatModelPresetLabel(
  preset: ModelPresetAvailability,
  includeUsageWarning = true,
): string {
  const availability = !preset.available && preset.reason_label
    ? `${preset.label} (${preset.reason_label})`
    : preset.label;
  const resetTime = preset.resets_at
    ? formatLocalResetTime(preset.resets_at)
    : null;
  if (resetTime) return `${availability} · ${resetTime} 해제`;
  if (includeUsageWarning && preset.available && preset.usage_warning) {
    return `${availability} (사용량 확인 지연)`;
  }
  return availability;
}

function formatLocalResetTime(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function actionSheetLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}
