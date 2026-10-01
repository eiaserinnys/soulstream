export interface HistoricalMessage {
  id: number;
  parent_event_id: number | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface MessagesResponse {
  messages: HistoricalMessage[];
  next_cursor: string | null;
}

export interface ToolTraceResponse {
  type: 'tool_trace';
  timeline_id: string;
  tool_use_id: string;
  tool_name?: string;
  status?: 'running' | 'completed' | 'error';
  is_error?: boolean;
  started_at?: number | null;
  completed_at?: number | null;
  duration_ms?: number | null;
  input?: unknown;
  result?: unknown;
  progress?: HistoricalMessage[];
  events?: HistoricalMessage[];
}
