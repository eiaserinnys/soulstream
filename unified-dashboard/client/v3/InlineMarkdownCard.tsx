import { useTranslation } from "react-i18next";
import type { HTMLAttributes, ReactNode } from "react";
import { DashboardIconCap, DisclosureActionIcon } from "@seosoyoung/soul-ui";
import { LiquidGlassCard } from "@seosoyoung/soul-ui/components/LiquidGlassCard";
import { Pencil } from "lucide-react";
import "./v3-context-menus.css";

/** The inline board's existing document presentation, without data access. */
export function InlineMarkdownCard({ title, expanded, onToggle, onRename, rowProps, renameForm, error, children }: {
  title: string;
  expanded: boolean;
  onToggle(): void;
  onRename(): void;
  rowProps?: HTMLAttributes<HTMLDivElement>;
  renameForm?: ReactNode;
  error?: string;
  children?: ReactNode;
}) {
 const {t}=useTranslation();
  return <LiquidGlassCard webglSurface cornerRadius="floor" className="v3-inline-board-item" data-board-kind="markdown">
    <div className="v3-inline-board-row" tabIndex={0} aria-label={t("cards.documentActions", {title})} {...rowProps}>
      {renameForm ?? <div className="v3-inline-board-label"><span>📄 {title}</span></div>}
      {!renameForm ? <>
        <DashboardIconCap size="small" label={t("cards.toggleDocument", {title,action:expanded?t("cards.collapse"):t("cards.expand")})} className="v3-inline-board-expand"
          aria-expanded={expanded} onClick={onToggle}>
          <DisclosureActionIcon expanded={expanded} className="h-4 w-4" />
        </DashboardIconCap>
        <DashboardIconCap size="small" label={t("cards.renameDocument", {title})} className="v3-inline-board-rename-button" onClick={onRename}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </DashboardIconCap>
      </> : null}
    </div>
    {error ? <p className="v3-inline-board-error" role="alert">{error}</p> : null}
    {children}
  </LiquidGlassCard>;
}
