import { createI18n } from "@soulstream/i18n";

type MessageOptions = Record<string, string | number>;

export type FolderTranslate = (key: string, options?: MessageOptions) => string;

let fallback: FolderTranslate | undefined;

export function translateFolderFallback(key: string, options?: MessageOptions): string {
  fallback ??= createI18n("ko").t;
  return fallback(key, options);
}

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
