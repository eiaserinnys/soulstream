import type {
  PendingAttention,
  PendingAttentionKind,
  Session,
} from '../api/types';
import { isValidIsoDateTime } from './session-feed-activity';

const ATTENTION_KINDS = new Set<PendingAttentionKind>([
  'input_request',
  'permission',
  'tool_approval',
  'exit_plan_mode',
]);
const COMPACT_PAYLOAD_MAX_UTF8_BYTES = 16 * 1024;
const DISPLAY_TEXT_MAX_CODE_POINTS = 200;

export interface PendingAttentionSnapshot {
  pendingAttentions: readonly PendingAttention[];
  attentionRevision: number;
}

export interface PendingAttentionVersionState {
  /** Full snapshot이 확정한 모든 identity의 최소 revision. */
  snapshotBaseline: number;
  /** Snapshot 뒤 관측한 identity별 set/clear revision. tombstone도 남긴다. */
  revisionsById: Readonly<Record<string, number>>;
}

export interface PendingAttentionDeltaResult extends PendingAttentionSnapshot {
  versionState: PendingAttentionVersionState;
}

export function hasPendingAttentionSnapshot(session: Session): boolean {
  return Array.isArray(session.pendingAttentions)
    && Number.isSafeInteger(session.attentionRevision)
    && (session.attentionRevision as number) >= 0;
}

export function mergeSessionAttentionSnapshot(
  existing: Session | undefined,
  incoming: Session,
  versionState: PendingAttentionVersionState | undefined,
): {
  session: Session;
  versionState: PendingAttentionVersionState | null;
} {
  const incomingHasSnapshot = hasPendingAttentionSnapshot(incoming);
  if (!existing) {
    return {
      session: incoming,
      versionState: incomingHasSnapshot
        ? createPendingAttentionVersionState(incoming.attentionRevision ?? 0)
        : null,
    };
  }
  const existingHasSnapshot = hasPendingAttentionSnapshot(existing);
  if (!incomingHasSnapshot) {
    return {
      session: existingHasSnapshot
        ? {
            ...incoming,
            pendingAttentions: existing.pendingAttentions,
            attentionRevision: existing.attentionRevision,
          }
        : incoming,
      versionState: existingHasSnapshot
        ? versionState
          ?? createPendingAttentionVersionState(existing.attentionRevision ?? 0)
        : null,
    };
  }
  if (!existingHasSnapshot) {
    return {
      session: incoming,
      versionState: createPendingAttentionVersionState(
        incoming.attentionRevision ?? 0,
      ),
    };
  }

  const merged = mergePendingAttentionSnapshot(
    existing.pendingAttentions ?? [],
    existing.attentionRevision ?? 0,
    versionState
      ?? createPendingAttentionVersionState(existing.attentionRevision ?? 0),
    {
      pendingAttentions: incoming.pendingAttentions ?? [],
      attentionRevision: incoming.attentionRevision ?? 0,
    },
  );
  return {
    session: {
      ...incoming,
      pendingAttentions: merged.pendingAttentions,
      attentionRevision: merged.attentionRevision,
    },
    versionState: merged.versionState,
  };
}

/**
 * 늦게 끝난 full snapshot과 이미 적용된 live delta를 identity별로 합친다.
 * snapshot baseline 이하인 key는 snapshot이 정본이고, 그 뒤의 key별 set/clear만
 * 로컬 값을 유지한다. 따라서 A=110을 보존하면서 snapshot에만 있던 B=105도 복구한다.
 */
export function mergePendingAttentionSnapshot(
  currentAttentions: readonly PendingAttention[],
  currentAttentionRevision: number,
  versionState: PendingAttentionVersionState,
  incoming: PendingAttentionSnapshot,
): PendingAttentionDeltaResult {
  const currentById = new Map(currentAttentions.map((item) => [item.id, item]));
  const incomingById = new Map(
    incoming.pendingAttentions.map((item) => [item.id, item]),
  );
  const ids = new Set([
    ...currentById.keys(),
    ...incomingById.keys(),
    ...Object.keys(versionState.revisionsById),
  ]);
  const values: PendingAttention[] = [];
  for (const id of ids) {
    const localRevision = versionState.revisionsById[id]
      ?? versionState.snapshotBaseline;
    const value = localRevision > incoming.attentionRevision
      ? currentById.get(id)
      : incomingById.get(id);
    if (value) values.push(value);
  }

  const snapshotBaseline = Math.max(
    versionState.snapshotBaseline,
    incoming.attentionRevision,
  );
  const revisionsById = Object.fromEntries(
    Object.entries(versionState.revisionsById)
      .filter(([, revision]) => revision > snapshotBaseline),
  );
  return {
    pendingAttentions: sortPendingAttentions(values),
    attentionRevision: Math.max(
      isNonNegativeSafeInteger(currentAttentionRevision)
        ? currentAttentionRevision
        : 0,
      incoming.attentionRevision,
    ),
    versionState: { snapshotBaseline, revisionsById },
  };
}

export function normalizePendingAttentionSnapshot(
  rawAttentions: unknown,
  rawRevision: unknown,
  sessionId: string,
): PendingAttentionSnapshot | null {
  if (!Array.isArray(rawAttentions) || !isNonNegativeSafeInteger(rawRevision)) {
    return null;
  }
  const byId = new Map<string, PendingAttention>();
  for (const raw of rawAttentions) {
    const attention = normalizePendingAttention(raw, sessionId);
    if (!attention || attention.sourceEventId > rawRevision) continue;
    const previous = byId.get(attention.id);
    if (!previous || attention.sourceEventId > previous.sourceEventId) {
      byId.set(attention.id, attention);
    }
  }
  return {
    pendingAttentions: sortPendingAttentions([...byId.values()]),
    attentionRevision: rawRevision,
  };
}

export function createPendingAttentionVersionState(
  snapshotBaseline: number,
): PendingAttentionVersionState {
  return {
    snapshotBaseline: isNonNegativeSafeInteger(snapshotBaseline)
      ? snapshotBaseline
      : 0,
    revisionsById: {},
  };
}

/**
 * Global SSE 순서와 별개로 identity별 revision을 적용한다. A=110 뒤 B=105는 유효하지만,
 * 같은 B의 clear=120 뒤 upsert=119는 무효다. clear도 revision tombstone으로 보존한다.
 */
export function applyPendingAttentionDelta(
  currentAttentions: readonly PendingAttention[],
  currentAttentionRevision: number,
  versionState: PendingAttentionVersionState,
  sessionId: string,
  rawDelta: unknown,
  rawAttentionRevision: unknown,
): PendingAttentionDeltaResult {
  if (!isRecord(rawDelta)) {
    return {
      pendingAttentions: currentAttentions,
      attentionRevision: currentAttentionRevision,
      versionState,
    };
  }

  let values: Map<string, PendingAttention> | null = null;
  let revisions: Record<string, number> | null = null;
  let latestRevision = isNonNegativeSafeInteger(currentAttentionRevision)
    ? currentAttentionRevision
    : 0;

  for (const [id, rawEntry] of Object.entries(rawDelta)) {
    if (!id || !isRecord(rawEntry) || !isPositiveSafeInteger(rawEntry.revision)) {
      continue;
    }
    const revision = rawEntry.revision;
    const floor = versionState.revisionsById[id] ?? versionState.snapshotBaseline;
    if (revision <= floor) continue;

    let value: PendingAttention | null;
    if (rawEntry.value === null) {
      value = null;
    } else {
      const normalized = normalizePendingAttention(rawEntry.value, sessionId);
      if (
        !normalized
        || normalized.id !== id
        || normalized.sourceEventId !== revision
      ) {
        continue;
      }
      value = normalized;
    }

    values ??= new Map(currentAttentions.map((item) => [item.id, item]));
    revisions ??= { ...versionState.revisionsById };
    revisions[id] = revision;
    if (value === null) values.delete(id);
    else values.set(id, value);
    latestRevision = Math.max(latestRevision, revision);
  }

  if (revisions === null || values === null) {
    return {
      pendingAttentions: currentAttentions,
      attentionRevision: currentAttentionRevision,
      versionState,
    };
  }
  if (isNonNegativeSafeInteger(rawAttentionRevision)) {
    latestRevision = Math.max(latestRevision, rawAttentionRevision);
  }
  return {
    pendingAttentions: sortPendingAttentions([...values.values()]),
    attentionRevision: latestRevision,
    versionState: {
      snapshotBaseline: versionState.snapshotBaseline,
      revisionsById: revisions,
    },
  };
}

function normalizePendingAttention(
  value: unknown,
  sessionId: string,
): PendingAttention | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || !value.id
    || value.sessionId !== sessionId
    || !isPositiveSafeInteger(value.sourceEventId)
    || typeof value.kind !== 'string'
    || !ATTENTION_KINDS.has(value.kind as PendingAttentionKind)
    || !isValidIsoDateTime(value.requestedAt)
    || typeof value.title !== 'string'
    || typeof value.body !== 'string'
    || typeof value.requiresDetail !== 'boolean'
  ) {
    return null;
  }

  const title = boundedText(value.title);
  const body = boundedText(value.body);
  if (!title.text || !body.text) return null;
  const oversized = jsonUtf8Bytes(value) > COMPACT_PAYLOAD_MAX_UTF8_BYTES;
  const requiresDetail = value.requiresDetail || oversized || title.truncated || body.truncated;
  const out: PendingAttention = {
    id: value.id,
    sourceEventId: value.sourceEventId,
    sessionId,
    kind: value.kind as PendingAttentionKind,
    requestedAt: value.requestedAt,
    title: title.text,
    body: body.text,
    requiresDetail,
  };

  if (!oversized) {
    copyOptionalString(value, out, 'requestId');
    copyOptionalString(value, out, 'approvalId');
    copyOptionalString(value, out, 'toolUseId');
    copyOptionalString(value, out, 'toolName');
    if (isPositiveFiniteNumber(value.timeoutSec)) out.timeoutSec = value.timeoutSec;
    if (isValidIsoDateTime(value.expiresAt)) out.expiresAt = value.expiresAt;
    if (Array.isArray(value.questions) && value.questions.every(isRecord)) {
      out.questions = value.questions;
    }
    if (isRecord(value.toolInput)) out.toolInput = value.toolInput;
  }
  return out;
}

function sortPendingAttentions(
  values: PendingAttention[],
): readonly PendingAttention[] {
  return values.sort((left, right) => {
    const time = Date.parse(right.requestedAt) - Date.parse(left.requestedAt);
    if (time !== 0) return time;
    return left.id.localeCompare(right.id);
  });
}

function boundedText(value: string): { text: string; truncated: boolean } {
  const trimmed = value.trim();
  const codePoints = Array.from(trimmed);
  return {
    text: codePoints.slice(0, DISPLAY_TEXT_MAX_CODE_POINTS).join(''),
    truncated: codePoints.length > DISPLAY_TEXT_MAX_CODE_POINTS,
  };
}

function jsonUtf8Bytes(value: unknown): number {
  try {
    let bytes = 0;
    for (const codePoint of JSON.stringify(value)) {
      const point = codePoint.codePointAt(0) ?? 0;
      bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes > COMPACT_PAYLOAD_MAX_UTF8_BYTES) return bytes;
    }
    return bytes;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: PendingAttention,
  key: 'requestId' | 'approvalId' | 'toolUseId' | 'toolName',
): void {
  const value = source[key];
  if (typeof value === 'string' && value.length > 0) target[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
