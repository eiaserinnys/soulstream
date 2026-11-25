// 카드 #1871: 폰 화면과 태블릿 겹침이 보고 창에 넘기는 실제 데이터. 이 PAS 판(usePersistentReport)의 장과 완료 훅을 그대로 쓴다.
import { useMemo } from 'react';
import { createApiClient } from '../../api/client';
import { usePersistentSessionScene } from '../../navigation/PersistentSessionContext';
import { useSettingsStore } from '../../store/settingsStore';
import { usePersistentCardCompletion } from '../persistent/usePersistentCardCompletion';
import { usePersistentReport } from '../persistent/usePersistentReport';

export function usePasReportSource() {
  const serverUrl = useSettingsStore(state => state.serverUrl);
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);
  const session = usePersistentSessionScene(state => state.session);
  const completion = usePersistentCardCompletion(api);
  const report = usePersistentReport(session?.session_id, true, api, session?.persistent_report, undefined, completion.filterEntries);
  return { api, entries: report.entries, completion, dismissReport: report.dismiss };
}
