import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useState } from "react";
import { Switch } from "@seosoyoung/soul-ui";
import {
  AntigravityBackendRequestError,
  formatAntigravitySaveError,
  getAntigravityBackend,
  putAntigravityBackend,
  type AntigravityBackendPayload,
} from "../lib/antigravity-backend-api";
import { V3ErrorNotice } from "../v3/V3ErrorNotice";
import { AntigravityConsentDialog } from "./AntigravityConsentDialog";
import "./claude-accounts/claude-account-pool.css";
import "./antigravity-backend-row.css";

const SWITCH_SKELETON_CLASS = "c724-quota-track animate-pulse h-[calc(var(--thumb-size)+2px)]! w-[calc(var(--thumb-size)*2-2px)]! [--thumb-size:--spacing(5)] sm:[--thumb-size:--spacing(4)]";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 「코딩 에이전트 연결」 탭 맨 위의 「Antigravity(agy) 사용」 한 줄.
 * 켜는 동작만 확인 대화상자를 거치고, 끄는 동작은 바로 저장한다. 실패하면 스위치는 원래 값으로 남는다.
 * 저장에 성공하면 `onSaved(켜졌는지)`로 알려, 아래 공급자 패널이 사용량을 다시 읽게 한다.
 * 읽는 중에는 스위치와 같은 크기의 손잡이 없는 뼈대를 놓는다. 켜짐으로도 꺼짐으로도 읽히지 않고, 읽은 뒤에도 줄 높이와 설명 줄 수가 바뀌지 않는다.
 */
export function AntigravityBackendRow({ request, onSaved }: { request: typeof fetch; onSaved?: (enabled: boolean) => void }) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<AntigravityBackendPayload | null>(null);
  const [loadError, setLoadError] = useState<{ cause: unknown } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ cause: unknown } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try { setPayload(await getAntigravityBackend(request)); }
    catch (error) { setLoadError({ cause: error }); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);

  async function save(enabled: boolean) {
    if (!payload) return;
    setSaving(true);
    setSaveError(null);
    try {
      setPayload(await putAntigravityBackend(request, { enabled, expectedVersion: payload.version }));
      setDialogOpen(false);
      onSaved?.(enabled);
    } catch (error) {
      setSaveError({ cause: error });
      if (error instanceof AntigravityBackendRequestError && error.status === 409) {
        try { setPayload(await getAntigravityBackend(request)); } catch { /* 다시 시도하면 다시 읽는다 */ }
      }
    } finally {
      setSaving(false);
    }
  }

  const loadDetail = loadError?.cause instanceof AntigravityBackendRequestError
    ? t("accounts.antigravity.status", { value: loadError.cause.status })
    : loadError && errorText(loadError.cause);
  const saveMessage = saveError && formatAntigravitySaveError(saveError.cause, t);
  const enabled = payload?.value.enabled === true;
  return <div className="agy-backend-row" data-testid="antigravity-backend-row" data-enabled={enabled ? "on" : "off"} aria-busy={!payload && loadError === null}>
    <div className="c724-account-top">
      <div className="agy-backend-text">
        <span className="c724-account-email">{t("accounts.antigravity.use")}</span>
        <p className="agy-backend-description" data-v3-selectable-content="true">{t("accounts.antigravity.terms")}</p>
      </div>
      <div className="c724-account-actions">
        {payload
          ? <span className="c724-switch-wrap">
            <Switch
              checked={enabled}
              disabled={saving}
              aria-label={t("accounts.antigravity.use")}
              data-testid="antigravity-backend-switch"
              onCheckedChange={(checked) => {
                if (saving) return;
                if (checked) { setSaveError(null); setDialogOpen(true); } else void save(false);
              }}
            />
          </span>
          : loadError === null
            ? <span className="c724-switch-wrap"><span className={SWITCH_SKELETON_CLASS} aria-hidden="true" data-testid="antigravity-backend-switch-loading" /></span>
            : null}
      </div>
    </div>
    {loadError !== null && !payload ? <V3ErrorNotice message={t("accounts.antigravity.loadError")} detail={loadDetail} onRetry={() => void load()} retryLabel={t("accounts.common.retry")} /> : null}
    {!dialogOpen && saveMessage ? <p className="c724-pool-error" role="alert" data-v3-selectable-content="true">{saveMessage}</p> : null}
    <AntigravityConsentDialog open={dialogOpen} pending={saving} error={saveMessage} onOpenChange={setDialogOpen} onConfirm={() => void save(true)} />
  </div>;
}
