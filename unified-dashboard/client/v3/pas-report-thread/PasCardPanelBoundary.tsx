import type { useTranslation } from "react-i18next";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@seosoyoung/soul-ui";

/**
 * 지연 로드한 카드 패널을 못 받았을 때(청크 오류, 패널 안 예외) 패널 자리에 실패 안내와 닫기를 세운다.
 * 실패한 동안 보고 창의 나머지는 `onFailed`로 알려 inert로 잠근다(가림막 뒤로 초점이 나가지 않게).
 * 닫고 다시 열어도 같은 실패가 선다: lazy가 거부된 약속을 기억하고 브라우저도 실패한 모듈 주소를 기억하므로
 * 페이지를 새로 고쳐야만 다시 받는다.
 */
export class PasCardPanelBoundary extends Component<{ children: ReactNode; onClose(): void; onFailed?(): void; t: ReturnType<typeof useTranslation>["t"] }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { this.props.onFailed?.(); console.error("Could not load the card panel", error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    const { t } = this.props;
    return <div className="pas-rt-panel-fallback" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) this.props.onClose(); }}>
      <div className="pas-rt-panel-fallback-box" role="alert" data-testid="pas-rt-panel-error">
        <p>{t("persistent.thread.panelError")}</p>
        <Button variant="outline" autoFocus data-testid="pas-rt-panel-error-close" onClick={this.props.onClose}>{t("persistent.close")}</Button>
      </div>
    </div>;
  }
}
