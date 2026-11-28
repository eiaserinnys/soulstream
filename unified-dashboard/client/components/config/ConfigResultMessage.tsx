import { useTranslation } from "react-i18next";
import type { SaveResponse } from "../../hooks/useConfigSettings";

export function ConfigResultMessage({ result }: { result: SaveResponse | null }) {
  const { t } = useTranslation();
  if (!result) return null;

  return (
    <div className="text-xs space-y-1 mb-2">
      {result.applied.length > 0 && (
        <p className="text-success" data-v3-selectable-content="true">
          ✅ {t("admin.config.applied", { count: result.applied.length })}
        </p>
      )}
      {result.restart_required.length > 0 && (
        <p className="text-accent-amber" data-v3-selectable-content="true">
          🔄 {t("admin.config.restartRequired", { count: result.restart_required.length })}
        </p>
      )}
      {result.errors.length > 0 && (
        <p className="text-destructive-foreground" data-v3-selectable-content="true">
          ❌ {result.errors.join(", ")}
        </p>
      )}
    </div>
  );
}
