import type { PersistentReportEntry } from './persistent_report.js';

export type CardReviewPushData = {
  kind: 'card_review';
  cardId: string;
  folderId: string;
};

export type PersistentReportPushData = {
  kind: 'persistent_report';
  persistentSessionId: string;
  entryKey: string;
  reportKind: PersistentReportEntry['kind'];
  cardId?: string;
  questionId?: string;
  folderId?: string;
};

export type CardQuestionPushData = {
  kind: 'card_question';
  cardId: string;
  questionId: string;
  folderId: string;
};

export type PushNotificationData = CardReviewPushData | PersistentReportPushData | CardQuestionPushData;
