import type { SessionEvent } from '../../api/types';
import {
  formatContextUsageText,
  formatTurnCompleteStats,
  TURN_COMPLETE_LABEL,
  TURN_USAGE_SEPARATOR,
} from '../../../../packages/soul-ui/src/lib/turn-usage-format';
import { formatRateLimitNotice } from './rateLimitNotice';

type UnknownRecord = Record<string, unknown>;

const RETRYING_ERROR_HISTORY =
  '응답 연결이 끊겨 같은 작업에 자동 재연결이 발생했습니다.';

const EVENT_LABELS: Partial<Record<string, string>> = {
  session_start: '세션 시작',
  context_usage: '컨텍스트',
  compact: '컴팩션',
  error: '오류',
  history_sync: '히스토리 동기화',
  intervention_sent: '개입',
  session_notification: '완료 알림',
  system: '시스템',
  realtime_status: '음성',
  guardrail_tripwire: '가드레일',
};

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numberField(record: UnknownRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const n = asNumber(record[key]);
    if (n !== null) return n;
  }
  return null;
}

function stringField(record: UnknownRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function extractAssistantText(event: SessionEvent): string {
  const d = event.data as UnknownRecord;
  const direct = stringField(d, 'content', 'text', 'delta', 'output', 'result');
  if (direct) return direct;

  if (Array.isArray(d.content)) {
    return d.content
      .map((block) => {
        const b = asRecord(block);
        return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
      })
      .join('');
  }
  return '';
}

export function extractUserText(event: SessionEvent): string {
  const d = event.data as UnknownRecord;
  const direct = stringField(d, 'text', 'content', 'message');
  if (direct) return direct;
  if (!Array.isArray(d.content)) return '';
  return d.content
    .map((block) => {
      const b = asRecord(block);
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('');
}

export function formatTokenUsage(usage: unknown): string | null {
  const u = asRecord(usage);
  if (!u) return null;

  const input = numberField(u, 'input_tokens', 'inputTokens', 'input');
  const output = numberField(u, 'output_tokens', 'outputTokens', 'output');
  const cached = numberField(u, 'cached_input_tokens', 'cachedInputTokens');
  const reasoning = numberField(
    u,
    'reasoning_output_tokens',
    'reasoningOutputTokens',
  );
  const total =
    input !== null && output !== null
      ? input + output
      : numberField(u, 'total_tokens', 'totalTokens', 'total');

  if (total === null) return null;

  const details: string[] = [];
  if (input !== null) details.push(`${input.toLocaleString()} in`);
  if (output !== null) details.push(`${output.toLocaleString()} out`);
  if (cached) details.push(`${cached.toLocaleString()} cached`);
  if (reasoning) details.push(`${reasoning.toLocaleString()} reasoning`);

  return details.length
    ? `${total.toLocaleString()} tokens (${details.join(' / ')})`
    : `${total.toLocaleString()} tokens`;
}

export function buildSystemEventText(event: SessionEvent): string {
  const d = event.data as UnknownRecord;

  if (event.type === 'complete') {
    const stats = formatTurnCompleteStats({
      usage: d.usage,
      turnCostUsd: d.turn_cost_usd,
      sessionCostUsd: d.session_cost_usd,
      sessionCostPartial: d.session_cost_partial,
    });
    return stats
      ? `${TURN_COMPLETE_LABEL}${TURN_USAGE_SEPARATOR}${stats}`
      : TURN_COMPLETE_LABEL;
  }

  if (event.type === 'context_usage') {
    return formatContextUsageText({
      usedTokens: d.used_tokens,
      maxTokens: d.max_tokens,
      percent: d.percent,
      estimated: d.estimated,
    }) ?? '컨텍스트';
  }

  if (event.type === 'error' && d.will_retry === true) {
    const message = stringField(d, 'message');
    return message
      ? `${RETRYING_ERROR_HISTORY} ${message}`
      : RETRYING_ERROR_HISTORY;
  }

  if (event.type === 'error' && (d.rate_limit_type !== undefined || d.resets_at !== undefined)) {
    return `오류: ${formatRateLimitNotice(
      stringField(d, 'message') || 'An error occurred',
      stringField(d, 'rate_limit_type') || undefined,
      stringField(d, 'resets_at') || undefined,
    )}`;
  }

  const label = EVENT_LABELS[event.type] ?? event.type;
  const msg = stringField(d, 'message', 'status', 'content', 'text', 'output', 'result');
  if (event.type === 'session_notification' && msg) {
    return `${label}: ${formatRateLimitNotice(
      msg,
      stringField(d, 'rate_limit_type') || undefined,
      stringField(d, 'resets_at') || undefined,
    )}`;
  }
  return msg ? `${label}: ${msg}` : label;
}

export function buildEventAddress(sessionId: string, eventId: string): string {
  return `soulstream://sessions/${encodeURIComponent(
    sessionId,
  )}/events/${encodeURIComponent(eventId)}`;
}

export function extractEventCopyText(
  event: SessionEvent,
  resultEvent?: SessionEvent,
): string {
  const d = event.data as UnknownRecord;

  switch (event.type) {
    case 'assistant_message':
    case 'text_delta':
      return extractAssistantText(event);
    case 'user_message':
    case 'intervention_sent':
      return extractUserText(event);
    case 'realtime_transcript':
      return extractAssistantText(event);
    case 'tool_start': {
      const lines = [
        stringField(d, 'tool_name', 'toolName', 'name') || 'tool',
        stringifyValue(d.tool_input ?? d.toolInput ?? d.input ?? {}),
      ];
      if (resultEvent) {
        const rd = resultEvent.data as UnknownRecord;
        lines.push(
          stringifyValue(rd.result ?? rd.output ?? rd.content ?? rd.text ?? ''),
        );
      }
      return lines.filter(Boolean).join('\n\n');
    }
    case 'tool_result':
      return stringifyValue(d.result ?? d.output ?? d.content ?? d.text ?? '');
    case 'input_request':
      if (Array.isArray(d.questions)) {
        return d.questions
          .map((q) => {
            const qr = asRecord(q);
            return typeof qr?.question === 'string' ? qr.question : '';
          })
          .filter(Boolean)
          .join('\n');
      }
      return stringField(d, 'question', 'message', 'content');
    case 'system':
    case 'session_notification':
    case 'error':
    case 'complete':
    case 'result':
    case 'context_usage':
    case 'compact':
      return buildSystemEventText(event);
    default:
      return (
        stringField(d, 'text', 'content', 'message', 'output', 'result') ||
        stringifyValue(d)
      );
  }
}
