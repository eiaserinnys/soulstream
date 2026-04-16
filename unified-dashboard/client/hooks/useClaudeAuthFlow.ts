import { useState, useEffect, useCallback, useRef } from "react";

const errorMessages: Record<string, string> = {
  missing_code: "코드를 입력해주세요.",
  invalid_code_format:
    "코드 형식이 올바르지 않습니다. (#이 포함된 코드를 붙여넣으세요)",
  invalid_state: "인증 요청이 만료되었습니다. 다시 시도해주세요.",
};

const parseErrorDetail = (detail: string): string => {
  if (errorMessages[detail]) return errorMessages[detail];
  if (detail.startsWith("token_exchange_failed"))
    return "토큰 교환 중 오류가 발생했습니다.";
  if (detail.includes("not connected"))
    return "노드가 연결되지 않았습니다. 연결 상태를 확인해주세요.";
  return detail || "오류가 발생했습니다.";
};

export interface ClaudeAuthFlowParams {
  /** OAuth 엔드포인트 prefix. 예: "/auth/claude" 또는 "/api/nodes/{id}/claude-auth" */
  basePath: string;
  /**
   * 인증 상태 조회 경로 (basePath 기준). 기본값 "/token".
   * NodeClaudeAuthPanel은 "/status"를 사용한다.
   */
  statusPath?: string;
  /** 토큰 보유 상태가 true가 된 직후 호출 (예: profile 로드) */
  onAuthenticated?: () => void;
  /** 토큰이 삭제된 직후 호출 (예: profile/usage 초기화) */
  onTokenDeleted?: () => void;
}

export interface ClaudeAuthFlowState<U> {
  /** 인증 상태 — null이면 아직 미조회 */
  tokenStatus: { has_token: boolean } | null;
  loadingStatus: boolean;
  /** 사용량 데이터 (제네릭) */
  usage: U | null;
  loadingUsage: boolean;
  /** 사용자에게 표시할 에러 메시지 */
  error: string | null;
  /** 코드 입력 UI 표시 여부 */
  showCodeInput: boolean;
  /** 팝업 차단 시 fallback으로 표시할 인증 URL */
  authUrl: string | null;
  /** 코드 입력 textarea 값 */
  codeValue: string;
  setCodeValue: (v: string) => void;
  submitting: boolean;
  /** OAuth 로그인 시작 */
  handleLogin: () => Promise<void>;
  handleSubmitCode: () => Promise<void>;
  handleCancelCode: () => void;
  handleDeleteToken: () => Promise<void>;
  fetchUsage: () => Promise<void>;
  refreshStatus: () => Promise<void>;
}

/**
 * Claude Code OAuth PKCE 플로우 공통 훅.
 *
 * ClaudeAuthTab(로컬 서버)과 NodeClaudeAuthPanel(원격 노드)이 동일한
 * start → popup → code input → submit → status 사이클을 사용하므로 추출.
 *
 * basePath만 다를 뿐 endpoint 구조는 동일하다:
 *   - GET    {basePath}{statusPath}              (status 조회)
 *   - GET    {basePath}/headless/start           (auth URL 발급)
 *   - POST   {basePath}/headless/submit-code     (code 제출)
 *   - GET    {basePath}/usage                    (사용량)
 *   - DELETE {basePath}/token                    (토큰 삭제)
 */
export function useClaudeAuthFlow<U = unknown>(
  params: ClaudeAuthFlowParams,
): ClaudeAuthFlowState<U> {
  const { basePath, statusPath = "/token", onAuthenticated, onTokenDeleted } =
    params;

  const [tokenStatus, setTokenStatus] = useState<{ has_token: boolean } | null>(
    null,
  );
  const [usage, setUsage] = useState<U | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCodeInput, setShowCodeInput] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [codeValue, setCodeValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // popup은 useRef로 관리하여 handleCancelCode에서도 닫을 수 있게 한다.
  const popupRef = useRef<Window | null>(null);

  // onAuthenticated / onTokenDeleted는 매 렌더마다 바뀔 수 있으므로 ref에 보관해
  // fetchStatus / handleDeleteToken의 useCallback 의존성을 안정화한다.
  const onAuthenticatedRef = useRef(onAuthenticated);
  const onTokenDeletedRef = useRef(onTokenDeleted);
  useEffect(() => {
    onAuthenticatedRef.current = onAuthenticated;
    onTokenDeletedRef.current = onTokenDeleted;
  }, [onAuthenticated, onTokenDeleted]);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch(`${basePath}${statusPath}`);
      const data = await res.json();
      setTokenStatus(data);
      if (data?.has_token) {
        onAuthenticatedRef.current?.();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingStatus(false);
    }
  }, [basePath, statusPath]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleLogin = useCallback(async () => {
    setError(null);
    // 팝업 차단 우회: 버튼 클릭 직후 동기 컨텍스트에서 빈 탭을 먼저 열고,
    // fetch 완료 후 authUrl로 navigate한다.
    // iOS Safari는 async 호출 후 window.open()을 차단하지만 동기 호출은 허용한다.
    popupRef.current = window.open("about:blank", "_blank");
    try {
      const res = await fetch(`${basePath}/headless/start`);
      if (!res.ok) {
        popupRef.current?.close();
        popupRef.current = null;
        const data = await res.json().catch(() => null);
        throw new Error(
          data?.detail
            ? parseErrorDetail(data.detail)
            : "인증 URL을 가져오는 중 오류가 발생했습니다.",
        );
      }
      const data = await res.json();
      if (!data.authUrl) {
        popupRef.current?.close();
        popupRef.current = null;
        throw new Error("authUrl 없음");
      }
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.location.href = data.authUrl; // 팝업이 열렸으면 직접 navigate
      } else {
        setAuthUrl(data.authUrl); // 차단된 경우 <a> 링크 fallback
      }
      setShowCodeInput(true);
    } catch (e) {
      popupRef.current?.close();
      popupRef.current = null;
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [basePath]);

  const handleSubmitCode = useCallback(async () => {
    const trimmed = codeValue.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${basePath}/headless/submit-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(parseErrorDetail(data?.detail ?? ""));
        return;
      }
      setShowCodeInput(false);
      setCodeValue("");
      fetchStatus();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSubmitting(false);
    }
  }, [basePath, codeValue, fetchStatus]);

  const handleCancelCode = useCallback(() => {
    popupRef.current?.close();
    popupRef.current = null;
    setShowCodeInput(false);
    setAuthUrl(null);
    setCodeValue("");
    setError(null);
  }, []);

  const handleDeleteToken = useCallback(async () => {
    await fetch(`${basePath}/token`, { method: "DELETE" });
    setTokenStatus({ has_token: false });
    setUsage(null);
    onTokenDeletedRef.current?.();
  }, [basePath]);

  const fetchUsage = useCallback(async () => {
    setLoadingUsage(true);
    setError(null);
    try {
      const res = await fetch(`${basePath}/usage`);
      if (!res.ok) throw new Error(await res.text());
      setUsage((await res.json()) as U);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingUsage(false);
    }
  }, [basePath]);

  return {
    tokenStatus,
    loadingStatus,
    usage,
    loadingUsage,
    error,
    showCodeInput,
    authUrl,
    codeValue,
    setCodeValue,
    submitting,
    handleLogin,
    handleSubmitCode,
    handleCancelCode,
    handleDeleteToken,
    fetchUsage,
    refreshStatus: fetchStatus,
  };
}
