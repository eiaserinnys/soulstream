import type { Catalog } from './types';

export type {
  HistoricalMessage,
  MessagesResponse,
  ToolTraceResponse,
} from './historyTypes';

export interface CatalogResponse extends Catalog {
  sessionList?: Array<Record<string, unknown>>;
  total?: number;
}
