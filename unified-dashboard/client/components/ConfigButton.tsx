import { useTranslation } from "react-i18next";
import { cn, DashboardIconCap } from "@seosoyoung/soul-ui";
import { SlidersHorizontal } from "lucide-react";

export function ConfigButton({
  onClick,
  variant = "default",
  appearance = "default",
}: {
  onClick: () => void;
  variant?: "default" | "chrome";
  appearance?: "default" | "bare";
}) {
  const { t } = useTranslation();
  if (variant === "chrome") {
    return <ChromeConfigButton onClick={onClick} appearance={appearance} />;
  }

  return (
    <button
      data-testid="config-button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium",
        "border border-border text-muted-foreground hover:bg-input",
        "transition-colors cursor-pointer",
      )}
      title={t("settings.title")}
      aria-label={t("admin.config.open")}
    >
      <span className="text-xs">⚙️</span>
      <span>{t("admin.config.button")}</span>
    </button>
  );
}

function ChromeConfigButton({
  onClick,
  appearance,
}: { onClick: () => void; appearance: "default" | "bare" }) {
  const { t } = useTranslation();
  return (
    <DashboardIconCap
      label={t("settings.title")}
      data-testid="config-button"
      appearance={appearance}
      onClick={onClick}
    >
      {appearance === "bare"
        ? <SlidersHorizontal className="size-5" strokeWidth={1.4} absoluteStrokeWidth aria-hidden="true" />
        : <span aria-hidden="true" className="text-base leading-none">⚙</span>}
    </DashboardIconCap>
  );
}
