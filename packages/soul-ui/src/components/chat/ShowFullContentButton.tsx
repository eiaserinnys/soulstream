import { useTranslation } from "react-i18next";
import { memo, type MouseEvent } from "react";

export const ShowFullContentButton = memo(function ShowFullContentButton({
  loading,
  error,
  onClick,
  prefix,
  label,
}: {
  loading?: boolean;
  error?: string | null;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  prefix?: string;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      {prefix && <span>{prefix}</span>}
      {onClick ? (
        <button
          onClick={onClick}
          disabled={loading}
          className="text-accent-blue hover:text-accent-blue/80 inline-flex items-center gap-1 disabled:opacity-50"
        >
          {loading ? (
            <>
              <span className="inline-block w-3 h-3 border border-accent-blue/40 border-t-accent-blue rounded-full animate-spin" />
              {t("ui.common.loading")}
            </>
          ) : (
            label ?? t("ui.chat.showFullContent")
          )}
        </button>
      ) : label ? (
        <span>{label}</span>
      ) : null}
      {error && <span className="ml-2 chat-tone-danger-text">{error}</span>}
    </div>
  );
});
