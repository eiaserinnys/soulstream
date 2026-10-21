import type { CardDto, CardStatus } from '../api/cardTypes';
import type { PersistentReportEntry } from '../api/types';
import { CARD_ENTRY_KEY_PREFIX, CARD_QUESTION_KEY_PREFIX } from '../../../packages/wire-schema/src/persistent_report';

const cardStatuses: readonly CardStatus[] = ['todo', 'queued', 'blocked', 'running', 'review', 'done', 'cancelled'];

export function isPersistentReportCardExpandable(entry: PersistentReportEntry): boolean {
  return Boolean(entry.card_id) || entry.card_numbers.length === 1;
}

export function isServerCardReport(entry: PersistentReportEntry): boolean {
  return entry.key.startsWith(CARD_ENTRY_KEY_PREFIX) || entry.key.startsWith(CARD_QUESTION_KEY_PREFIX);
}

export function isServerCardAcknowledgement(entry: PersistentReportEntry): boolean {
  return isServerCardReport(entry) && (entry.kind === 'see'
    || (entry.kind === 'ask' && entry.options.length === 0 && entry.state === 'open'));
}

export function persistentReportStatusCard(entry: PersistentReportEntry): CardDto | null {
  if (!entry.card_status || !cardStatuses.includes(entry.card_status as CardStatus)) return null;
  return {
    id: entry.card_id ?? `persistent-report-${entry.key}`,
    status: entry.card_status as CardStatus,
    blockedKind: entry.key.startsWith(CARD_QUESTION_KEY_PREFIX) ? 'question' : null,
  } as CardDto;
}
