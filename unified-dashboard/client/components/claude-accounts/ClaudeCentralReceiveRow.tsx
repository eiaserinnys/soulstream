import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Switch, type ClaudeCentralSettings } from "@seosoyoung/soul-ui";
import {
  getClaudeCentralSettings,
  putClaudeCentralReceive,
  requestErrorMessage,
} from "../../lib/claude-auth-api";

export const CLAUDE_CENTRAL_SETTINGS_KEY = ["claude-central-settings"] as const;

/**
 * 노드의 클로드 계정 목록 맨 위에 서는 「중앙 풀 받기」 한 줄.
 *
 * 값은 중앙 설정의 그 노드 `receive`다. 저장하는 동안에는 바뀐 쪽으로 보이되 눌리지 않고,
 * 실패하면 원래 값으로 돌아간 스위치가 제자리에 남는다. 다시 시도는 그 스위치를 다시 누르는
 * 것이고, 오류 글은 줄 아래에 서며 다음 저장을 시작할 때 지운다. 설정을 못 읽어 값을 알 수
 * 없을 때만 스위치 자리가 실패 안내와 「다시 시도」로 바뀐다.
 */
export function ClaudeCentralReceiveRow({ nodeId, request }: { nodeId: string; request: typeof fetch }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: CLAUDE_CENTRAL_SETTINGS_KEY,
    queryFn: () => getClaudeCentralSettings(request),
    retry: false,
    staleTime: Infinity,
  });
  const [saving, setSaving] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const effective = settings.data?.effective.find((entry) => entry.node_id === nodeId)?.receive;
  const current = saving ?? effective ?? settings.data?.default_receive ?? false;

  async function save(value: boolean) {
    setSaving(value);
    setError(null);
    try {
      const next: ClaudeCentralSettings = await putClaudeCentralReceive(request, nodeId, value);
      queryClient.setQueryData(CLAUDE_CENTRAL_SETTINGS_KEY, next);
      // 노드가 새 설정을 이미 받았으므로 그 노드의 계정 목록도 다시 읽어 중앙 계정을 맞춘다.
      void queryClient.invalidateQueries({ queryKey: ["claude-auth-accounts", nodeId] });
    } catch (caught) {
      setError(requestErrorMessage(caught, t));
    } finally {
      setSaving(null);
    }
  }

  const switchValue = current;
  const busy = saving !== null || settings.isPending;

  return <div data-testid="claude-central-receive" data-receive={switchValue ? "on" : "off"}>
    <div className="c724-account-top">
      <div className="c724-account-identity">
        <span className="c724-account-email">{t("accounts.claude.receivePool")}</span>
        {settings.isError
          ? <p className="c724-pool-error" role="alert" data-v3-selectable-content="true">{requestErrorMessage(settings.error, t)}</p>
          : null}
      </div>
      <div className="c724-account-actions">
        {settings.isError
          ? <Button variant="outline" size="sm" disabled={settings.isFetching} onClick={() => void settings.refetch()}>{t("accounts.common.retry")}</Button>
          : <span className="c724-switch-wrap">
            <Switch
              checked={switchValue}
              disabled={busy}
              aria-label={t("accounts.claude.receivePool")}
              data-testid="claude-central-receive-switch"
              onCheckedChange={(checked) => { if (!busy) void save(checked); }}
            />
          </span>}
      </div>
    </div>
    {error ? <p className="c724-pool-error" role="alert" data-v3-selectable-content="true">{error}</p> : null}
  </div>;
}
