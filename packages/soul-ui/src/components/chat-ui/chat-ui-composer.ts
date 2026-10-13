export interface ChatUiComposerHandle {
  focusInput?: () => void;
  appendGeneratedText(
    sessionId: string,
    text: string,
  ): { ok: true } | { ok: false; reason: "unavailable" | "sending" };
}

export type RegisterGeneratedTextActions = (handle: ChatUiComposerHandle | null) => void;
export type ChatUiOperationsHandle = Pick<ChatUiComposerHandle, 'appendGeneratedText'> & { notify: (text: string) => void };
export type RegisterChatUiOperations = (handle: ChatUiOperationsHandle | null) => void;
