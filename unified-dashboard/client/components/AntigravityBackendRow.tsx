import { useCallback, useEffect, useState } from "react";
import { FrameLoading, Switch } from "@seosoyoung/soul-ui";
import {
  AntigravityBackendRequestError,
  getAntigravityBackend,
  putAntigravityBackend,
  type AntigravityBackendPayload,
} from "../lib/antigravity-backend-api";
import { V3ErrorNotice } from "../v3/V3ErrorNotice";
import { ANTIGRAVITY_TERMS_WARNING, AntigravityConsentDialog } from "./AntigravityConsentDialog";
import "./claude-accounts/claude-account-pool.css";
import "./antigravity-backend-row.css";

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 「코딩 에이전트 연결」 탭 맨 위의 「Antigravity(agy) 사용」 한 줄.
 * 켜는 동작만 확인 대화상자를 거치고, 끄는 동작은 바로 저장한다. 실패하면 스위치는 원래 값으로 남는다.
 */
export function AntigravityBackendRow({ request }: { request: typeof fetch }) {
  const [payload, setPayload] = useState<AntigravityBackendPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try { setPayload(await getAntigravityBackend(request)); }
    catch (error) { setLoadError(errorText(error)); }
  }, [request]);
  useEffect(() => { void load(); }, [load]);

  async function save(enabled: boolean) {
    if (!payload) return;
    setSaving(true);
    setSaveError(null);
    try {
      setPayload(await putAntigravityBackend(request, { enabled, expectedVersion: payload.version }));
      setDialogOpen(false);
    } catch (error) {
      setSaveError(errorText(error));
      if (error instanceof AntigravityBackendRequestError && error.status === 409) {
        try { setPayload(await getAntigravityBackend(request)); } catch { /* 다시 시도하면 다시 읽는다 */ }
      }
    } finally {
      setSaving(false);
    }
  }

  const enabled = payload?.value.enabled === true;
  return <div className="agy-backend-row" data-testid="antigravity-backend-row" data-enabled={enabled ? "on" : "off"}>
    <div className="c724-account-top">
      <div className="agy-backend-text">
        <span className="agy-backend-title">Antigravity(agy) 사용</span>
        <p className="agy-backend-description" data-v3-selectable-content="true">{ANTIGRAVITY_TERMS_WARNING}</p>
      </div>
      <div className="c724-account-actions">
        {payload
          ? <span className="c724-switch-wrap">
            <Switch
              checked={enabled}
              disabled={saving}
              aria-label="Antigravity(agy) 사용"
              data-testid="antigravity-backend-switch"
              onCheckedChange={(checked) => {
                if (saving) return;
                if (checked) { setSaveError(null); setDialogOpen(true); } else void save(false);
              }}
            />
          </span>
          : loadError === null ? <FrameLoading inline label="불러오는 중…" /> : null}
      </div>
    </div>
    {loadError !== null && !payload ? <V3ErrorNotice message="Antigravity 설정을 불러오지 못했습니다." detail={loadError} onRetry={() => void load()} retryLabel="다시 시도" /> : null}
    {!dialogOpen && saveError ? <p className="agy-consent-error" role="alert" data-v3-selectable-content="true">{saveError}</p> : null}
    <AntigravityConsentDialog open={dialogOpen} pending={saving} error={saveError} onOpenChange={setDialogOpen} onConfirm={() => void save(true)} />
  </div>;
}
