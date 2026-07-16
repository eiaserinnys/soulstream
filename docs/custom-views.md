# Custom view 관행

Custom view는 보드의 `custom_view` 항목에 에이전트가 만든 HTML을 표시하는 sandbox 위젯이다. 별도 board item 타입을 만들지 않고, `create_custom_view`로 만든 HTML 안에서 필요한 화면을 구성한다.

## Pages 문서 임베드

`pages.eiaserinnys.me`에 발행한 문서는 다음처럼 iframe으로 넣는다.

```html
<iframe
  title="작업 보고서"
  src="https://pages.eiaserinnys.me/p/2fe932cbc926/"
  loading="lazy"
  style="width:100%;height:560px;border:0"
></iframe>
```

- `/p/{slug}/`의 끝 슬래시까지 포함한 공개 URL을 사용한다.
- 프레임 허용 정본은 `packages/soul-ui/src/custom-view/CustomViewRenderer.tsx`의 `CUSTOM_VIEW_FRAME_ORIGINS`다. 현재는 `https://pages.eiaserinnys.me` 하나만 허용한다.
- 다른 origin이 필요하면 개별 origin을 정본 목록에 추가하고 실제 문서로 CSP 회귀 테스트를 남긴다. `https:` 전체나 `*`로 넓히지 않는다.
- sandbox는 `allow-scripts`만 사용한다. `allow-same-origin`을 추가하지 않는다.
- Pages 문서의 응답 헤더가 임베드를 별도로 차단하지 않는지도 확인한다.

## 라이브 바인딩

런북·세션의 제한된 값은 기존 `<soul-bind>` 문법을 사용한다. 임의 필드나 토큰은 노출되지 않으며, 허용된 값도 HTML 이스케이프 후 주입된다.
