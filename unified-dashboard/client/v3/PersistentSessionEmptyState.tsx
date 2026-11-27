import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, FrameLoading, FrameNotice } from '@seosoyoung/soul-ui';
import { navigateDashboard } from '../dashboard-navigation';
import type { PersistentCreateDefaults, PersistentSessionsApi } from '../lib/persistent-sessions';

type Bootstrap = { phase: 'idle' } | { phase: 'creating' } | { phase: 'failed'; message: string; retrying: boolean };

/**
 * PAS 창에 영구 세션이 하나도 없을 때의 본문. 세 경우를 가른다.
 * - 서버가 기본 세션을 만들 수 있으면(bootstrap_enabled, 사유 없음) 한 번 부르고 그 세션으로 간다.
 * - 만들 수 있게 켜졌지만 모델이 없으면(사유 있음) 코딩 에이전트 로그인을 안내한다. 사유 문장은 그리지 않는다.
 * - 켜져 있지 않으면 설정창의 생성 양식으로 안내한다.
 */
export function PersistentSessionEmptyState({ api, defaults, isAdmin, onOpenCodingAgents, onCreate }: {
  api: Pick<PersistentSessionsApi, 'bootstrap'>;
  defaults: PersistentCreateDefaults;
  isAdmin: boolean;
  onOpenCodingAgents(): void;
  onCreate(): void;
}) {
  const bootstrapEnabled = defaults.bootstrap_enabled === true;
  const reason = defaults.unavailable_reason;
  const canBootstrap = bootstrapEnabled && !reason;
  const [state, setState] = useState<Bootstrap>({ phase: 'idle' });
  const started = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const run = useCallback(async () => {
    // 실패 안내에서 다시 시도해도 안내와 단추를 그대로 두어 누른 단추의 초점이 사라지지 않게 한다.
    setState((current) => current.phase === 'failed' ? { ...current, retrying: true } : { phase: 'creating' });
    try {
      const { session_id } = await api.bootstrap();
      if (alive.current) navigateDashboard(`/persistent/${encodeURIComponent(session_id)}`, true);
    } catch (caught) {
      if (alive.current) setState({ phase: 'failed', message: caught instanceof Error ? caught.message : String(caught), retrying: false });
    }
  }, [api]);

  // StrictMode가 효과를 두 번 돌려도 요청은 한 번이다. 설정창을 닫고 목록이 바뀐 뒤에는 새 판정으로 다시 선다.
  useEffect(() => {
    if (!canBootstrap || started.current) return;
    started.current = true;
    void run();
  }, [canBootstrap, run]);

  if (canBootstrap) {
    if (state.phase === 'failed') return <FrameNotice data-testid="persistent-empty-bootstrap-failed">
      <div className="persistent-empty-state">
        {state.retrying
          ? <FrameLoading inline label="기본 영구 세션을 다시 만드는 중입니다" data-testid="persistent-empty-retrying" />
          : <p role="alert" data-v3-selectable-content="true">{`기본 영구 세션을 만들지 못했습니다. ${state.message}`}</p>}
        <Button
          className="aria-disabled:pointer-events-none aria-disabled:opacity-64 aria-disabled:shadow-none"
          aria-disabled={state.retrying ? 'true' : undefined}
          onClick={() => { if (!state.retrying) void run(); }}
        >다시 시도</Button>
      </div>
    </FrameNotice>;
    return <FrameLoading label="기본 영구 세션을 만드는 중입니다" data-testid="persistent-empty-creating" />;
  }
  // 서버가 보낸 사유(unavailable_reason)는 기술 문장이라 화면에 그리지 않는다. canBootstrap 판정에만 쓴다.
  if (bootstrapEnabled) return <FrameNotice data-testid="persistent-empty-unavailable">
    <div className="persistent-empty-state persistent-empty-state--steps">
      {isAdmin
        ? <p>기본 영구 세션을 만들기 위해<br />코딩 에이전트에 로그인해주세요.</p>
        : <p>기본 영구 세션을 만들기 위해<br />관리자가 코딩 에이전트에 로그인해야 합니다.</p>}
      {isAdmin ? <>
        <ol className="persistent-empty-steps">
          <li>설정에서 Claude나 Codex 가운데 하나를 연결합니다</li>
          <li>안내대로 로그인하고 설정을 닫습니다</li>
        </ol>
        <Button onClick={onOpenCodingAgents}>코딩 에이전트 연결</Button>
      </> : null}
    </div>
  </FrameNotice>;
  return <FrameNotice data-testid="persistent-empty-manual">
    <div className="persistent-empty-state">
      <p>영구 세션이 없습니다</p>
      <Button onClick={onCreate}>영구 세션 만들기</Button>
    </div>
  </FrameNotice>;
}
