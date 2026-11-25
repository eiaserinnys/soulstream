import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@seosoyoung/soul-ui";

/**
 * 지연 로드한 카드 패널을 못 받았을 때(청크 오류, 패널 안 예외) 패널 자리에 실패 안내와 닫기를 세운다.
 * 보고 창과 그 입력은 그대로 살아 있다. 닫으면 다음에 열 때 다시 불러온다.
 */
export class PasCardPanelBoundary extends Component<{ children: ReactNode; onClose(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error("카드 패널을 불러오지 못했습니다", error, info.componentStack); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="pas-rt-panel-fallback" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) this.props.onClose(); }}>
      <div className="pas-rt-panel-fallback-box" role="alert" data-testid="pas-rt-panel-error">
        <p>카드 패널을 불러오지 못했습니다. 보고 창은 그대로입니다. 페이지를 새로 고치면 다시 받습니다.</p>
        <Button variant="outline" autoFocus data-testid="pas-rt-panel-error-close" onClick={this.props.onClose}>닫기</Button>
      </div>
    </div>;
  }
}
