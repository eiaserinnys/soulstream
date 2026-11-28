import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import {
  Button, Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, Input,
} from "@seosoyoung/soul-ui";
import { ANTIGRAVITY_ACKNOWLEDGEMENT } from "../lib/antigravity-backend-api";
import "./claude-accounts/claude-account-pool.css";
import "./antigravity-backend-row.css";

/** 켜기 전에 약관 경고를 보이고, 확인 문구를 그대로 입력해야 켜기 단추가 살아나는 대화상자. */
export function AntigravityConsentDialog({ open, pending, error, onOpenChange, onConfirm }: {
  open: boolean;
  pending: boolean;
  error: string | null;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  useEffect(() => { if (open) setTyped(""); }, [open]);
  const confirmed = typed.trim() === ANTIGRAVITY_ACKNOWLEDGEMENT;
  return <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <DialogPopup className="approved-dialog max-w-sm" closeProps={{ disabled: pending }}>
      <DialogHeader>
        <DialogTitle>{t("accounts.antigravity.title")}</DialogTitle>
        <DialogDescription>{t("accounts.antigravity.terms")}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="agy-consent-field">
          <label htmlFor="agy-consent-input" className="agy-consent-label">{t("accounts.antigravity.acknowledge", { phrase: ANTIGRAVITY_ACKNOWLEDGEMENT })}</label>
          <Input
            id="agy-consent-input"
            autoComplete="off"
            value={typed}
            disabled={pending}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && confirmed && !pending) onConfirm(); }}
          />
          {error ? <p className="c724-pool-error" role="alert" data-v3-selectable-content="true">{error}</p> : null}
        </div>
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{t("accounts.common.cancel")}</Button>
        <Button type="button" disabled={!confirmed || pending} onClick={onConfirm}>{error ? t("accounts.common.retry") : t("accounts.antigravity.enable")}</Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>;
}
