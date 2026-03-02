/**
 * @soulstream/serendipity-plugin
 *
 * Soul 블록 렌더링 플러그인 - Serendipity에서 Soul Server 이벤트를 표시합니다.
 *
 * 이 플러그인은 soul:* 네임스페이스의 블록 타입을 렌더링합니다.
 *
 * @example
 * // Serendipity에서 사용하기
 * import { SoulRenderer, getSoulPluginConfig } from '@soulstream/serendipity-plugin'
 * import '@soulstream/serendipity-plugin/styles'
 *
 * // 플러그인 등록 (Serendipity 측에서)
 * registerNodeRenderer(getSoulPluginConfig())
 *
 * @example
 * // 타입 사용하기
 * import { createSoulContent, isSoulContent, type SoulContent } from '@soulstream/serendipity-plugin'
 *
 * const content = createSoulContent('soul:user', {
 *   text: 'Hello!',
 *   timestamp: new Date().toISOString(),
 * })
 */

// Types - Soul 블록 관련 타입들
export * from './types'

// Plugin Types - Serendipity 호환 인터페이스
export type {
  NodeRendererProps,
  NodeRendererPlugin,
  OutlinerNode,
} from './plugin-types'

// Components
export { SoulRenderer } from './SoulRenderer'

// Plugin Configuration
import { SoulRenderer } from './SoulRenderer'
import type { NodeRendererPlugin } from './plugin-types'

/**
 * Soul 플러그인 설정 객체 반환
 *
 * Serendipity의 registerNodeRenderer()에 전달할 설정을 반환합니다.
 *
 * @example
 * import { getSoulPluginConfig } from '@soulstream/serendipity-plugin'
 * import { registerNodeRenderer } from '@serendipity/plugins'
 *
 * registerNodeRenderer(getSoulPluginConfig())
 */
export function getSoulPluginConfig(): NodeRendererPlugin {
  return {
    type: 'soul:*',
    component: SoulRenderer,
    matchPattern: true,
    priority: 10, // 높은 우선순위
  }
}
