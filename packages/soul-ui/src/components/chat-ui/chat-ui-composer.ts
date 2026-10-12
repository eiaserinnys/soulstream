export interface ChatUiComposerHandle {
  appendGeneratedText(
    sessionId: string,
    text: string,
  ): { ok: true } | { ok: false; reason: "unavailable" | "sending" };
}

export type RegisterGeneratedTextActions = (handle: ChatUiComposerHandle | null) => void;
