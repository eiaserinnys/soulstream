# @soulstream/serendipity-plugin

Serendipity에서 Soul Server 이벤트를 렌더링하기 위한 플러그인 패키지입니다.

## 설치

```bash
npm install @soulstream/serendipity-plugin
```

## 사용법

### Serendipity에서 플러그인 등록

```typescript
import { getSoulPluginConfig } from '@soulstream/serendipity-plugin'
import '@soulstream/serendipity-plugin/styles'
import { registerNodeRenderer } from './plugins/registry'

// 플러그인 등록
registerNodeRenderer(getSoulPluginConfig())
```

### Soul 컨텐츠 생성

```typescript
import { createSoulContent } from '@soulstream/serendipity-plugin'

// 사용자 메시지
const userContent = createSoulContent('soul:user', {
  text: 'Hello!',
  timestamp: new Date().toISOString(),
})

// AI 어시스턴트 응답
const assistantContent = createSoulContent('soul:assistant', {
  text: 'Hi! How can I help you?',
  timestamp: new Date().toISOString(),
  model: 'claude-sonnet-4-20250514',
})

// 도구 호출
const toolUseContent = createSoulContent('soul:tool_use', {
  toolName: 'read_file',
  toolId: 'tool_123',
  input: { path: '/src/index.ts' },
  timestamp: new Date().toISOString(),
})
```

### 타입 가드 사용

```typescript
import { isSoulContent, isSoulUserContent } from '@soulstream/serendipity-plugin'

if (isSoulContent(content)) {
  // content is SoulContent

  if (isSoulUserContent(content)) {
    // content is SoulUserContent
    console.log(content.text)
  }
}
```

## 지원하는 블록 타입

| 타입 | 설명 |
|------|------|
| `soul:user` | 사용자 메시지 |
| `soul:assistant` | AI 어시스턴트 응답 |
| `soul:thinking` | AI 사고 과정 (extended thinking) |
| `soul:tool_use` | 도구 호출 |
| `soul:tool_result` | 도구 실행 결과 |
| `soul:error` | 에러 메시지 |
| `soul:intervention` | 사용자 개입 (세션 중간 추가 메시지) |

## API

### getSoulPluginConfig()

Serendipity의 `registerNodeRenderer()`에 전달할 플러그인 설정을 반환합니다.

```typescript
function getSoulPluginConfig(): NodeRendererPlugin
```

### createSoulContent()

Soul 컨텐츠를 생성하는 팩토리 함수입니다.

```typescript
function createSoulContent(type: SoulBlockType, input: CreateSoulContentInput): SoulContent
```

### Type Guards

- `isSoulContent(value)` - SoulContent 타입 확인
- `isSoulUserContent(value)` - SoulUserContent 타입 확인
- `isSoulAssistantContent(value)` - SoulAssistantContent 타입 확인
- `isSoulThinkingContent(value)` - SoulThinkingContent 타입 확인
- `isSoulToolUseContent(value)` - SoulToolUseContent 타입 확인
- `isSoulToolResultContent(value)` - SoulToolResultContent 타입 확인
- `isSoulErrorContent(value)` - SoulErrorContent 타입 확인
- `isSoulInterventionContent(value)` - SoulInterventionContent 타입 확인

## 스타일 커스터마이징

CSS 변수를 사용하여 스타일을 커스터마이징할 수 있습니다:

```css
.soul-block {
  --soul-bg: #f8f9fa;
  --soul-border: #e9ecef;
  --soul-icon-color: #6c757d;
}
```

각 블록 타입별로 다른 색상이 적용되며, 다크 모드를 자동으로 지원합니다.

## 라이선스

MIT
