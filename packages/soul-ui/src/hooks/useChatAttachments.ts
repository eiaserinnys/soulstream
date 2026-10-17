import { useCallback, useEffect, useState } from "react";
import {
  ChatAttachmentRequestError,
  loadChatAttachments,
  projectChatAttachmentItems,
  type ChatAttachmentItem,
} from "../lib/chat-attachment-model";

export interface UseChatAttachmentsResult {
  items: ChatAttachmentItem[];
  loading: boolean;
  error: string | null;
  retryable: boolean;
  reload(): void;
}

export function useChatAttachments(input: {
  sessionId: string;
  eventId: number;
  enabled: boolean;
}): UseChatAttachmentsResult {
  const { sessionId, eventId, enabled } = input;
  const [items, setItems] = useState<ChatAttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const reload = useCallback(() => setReloadVersion((version) => version + 1), []);

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setLoading(false);
      setError(null);
      setRetryable(false);
      return;
    }

    const controller = new AbortController();
    let active = true;
    setItems([]);
    setLoading(true);
    setError(null);
    setRetryable(false);

    void loadChatAttachments({ sessionId, eventId, signal: controller.signal })
      .then((projection) => {
        if (active) setItems(projectChatAttachmentItems(projection));
      })
      .catch((requestError: unknown) => {
        if (active && !controller.signal.aborted) {
          setItems([]);
          setError(errorMessage(requestError));
          setRetryable(requestError instanceof ChatAttachmentRequestError
            ? requestError.networkError || requestError.status >= 500 && requestError.status < 600
            : requestError instanceof TypeError);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, eventId, reloadVersion, sessionId]);

  return { items, loading, error, retryable, reload };
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ChatAttachmentRequestError)) {
    return "첨부 정보를 불러오지 못했습니다. 다시 시도해 주세요.";
  }
  switch (error.status) {
    case 400:
    case 422:
      return "첨부 정보를 확인할 수 없습니다.";
    case 401:
      return "로그인 후 첨부를 확인할 수 있습니다.";
    case 403:
      return "첨부를 읽을 권한이 없습니다.";
    case 404:
      return "첨부를 찾을 수 없거나 읽을 수 없습니다.";
    case 503:
      return "첨부 정보를 불러오지 못했습니다. 다시 시도해 주세요.";
    default:
      return error.status >= 500 && error.status < 600
        ? "첨부 정보를 불러오지 못했습니다. 다시 시도해 주세요."
        : "첨부 정보를 확인할 수 없습니다.";
  }
}
