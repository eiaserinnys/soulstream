import type { CardStatus } from '../api/cardTypes';
import { exhaustiveList } from './exhaustive';

const allStatuses = exhaustiveList<CardStatus>()([
  'todo', 'queued', 'blocked', 'running', 'awaiting_verification', 'review', 'on_hold', 'done', 'cancelled',
]);
export type AllStatuses = (typeof allStatuses)[number];

// @ts-expect-error - awaiting_verification이 빠졌다
exhaustiveList<CardStatus>()(['todo', 'queued', 'blocked', 'running', 'review', 'on_hold', 'done', 'cancelled']);

// @ts-expect-error - unknown은 CardStatus에 없다
exhaustiveList<CardStatus>()(['todo', 'queued', 'blocked', 'running', 'awaiting_verification', 'review', 'on_hold', 'done', 'cancelled', 'unknown']);
