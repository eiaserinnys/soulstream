import type { CardReviewPushData, PersistentReportPushData } from '../../../packages/wire-schema/src/push_notification';

export type NotificationTarget =
  | { kind: 'card'; cardId: string; question: boolean }
  | { kind: 'report'; sessionId: string; entryKey: string }
  | { kind: 'session'; sessionId: string };

type PushFields = Partial<Record<keyof CardReviewPushData | keyof PersistentReportPushData | 'sessionId', unknown>>;

export function parseNotificationTarget(data: unknown): NotificationTarget | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const fields = data as PushFields;
  if (typeof fields.cardId === 'string' && fields.cardId) return {
    kind: 'card', cardId: fields.cardId, question: typeof fields.questionId === 'string' && fields.questionId.length > 0,
  };
  if (fields.kind === 'persistent_report' && typeof fields.persistentSessionId === 'string' && fields.persistentSessionId
    && typeof fields.entryKey === 'string' && fields.entryKey) {
    return { kind: 'report', sessionId: fields.persistentSessionId, entryKey: fields.entryKey };
  }
  if (typeof fields.sessionId === 'string' && fields.sessionId) return { kind: 'session', sessionId: fields.sessionId };
  return null;
}
