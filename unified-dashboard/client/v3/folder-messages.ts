import { createI18n } from "@soulstream/i18n";
import type { useTranslation } from "react-i18next";

export type FolderTranslate = ReturnType<typeof useTranslation>["t"];

let fallback: FolderTranslate | undefined;

export const translateFolderFallback: FolderTranslate = (key, options) => {
  fallback ??= createI18n("ko").t;
  return fallback(key, options);
};

type MessageOptions = Record<string, string | number>;

export class FolderMessageError extends Error {
  constructor(
    private readonly key: string,
    private readonly options?: MessageOptions,
    private readonly detail?: string | null,
  ) {
    super([translateFolderFallback(key, options), detail].filter(Boolean).join("\n"));
  }

  translate(t: FolderTranslate): string {
    return [t(this.key, this.options), this.detail].filter(Boolean).join("\n");
  }
}

export function folderErrorText(t: FolderTranslate, error: unknown): string {
  if (error instanceof FolderMessageError) return error.translate(t);
  return error instanceof Error && error.message ? error.message : String(error);
}
