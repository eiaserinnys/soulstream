/**
 * Soul Dashboard 메모리 베이스라인 측정 스크립트
 *
 * 실행 방법:
 *   pnpm --dir .projects/soulstream/soul-dashboard exec tsx tests/memory/measure-baseline.ts
 *
 * 전제 조건:
 *   - soul-dashboard 서버가 http://localhost:3109 에서 실행 중이어야 함
 *   - Phase 1: /api/debug/memory 엔드포인트가 등록된 상태
 */

import { chromium } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// tests/memory → tests → soul-dashboard → soulstream → .projects → workspace (5단계)
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../../..')
const OUTPUT_DIR = path.join(WORKSPACE_ROOT, '.local/artifacts/analysis')

const DASHBOARD_PORT = process.env.DASHBOARD_PORT ?? '3300'
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`
const MEMORY_API_URL = `${DASHBOARD_URL}/api/debug/memory`

interface ServerMemory {
  heapUsed: number
  heapTotal: number
  rss: number
  external: number
  timestamp: string
}

interface ClientMemory {
  heapUsed: number
  heapTotal: number
}

interface Snapshot {
  scenario: string
  capturedAt: string
  client?: ClientMemory
  server?: ServerMemory
  skipped?: true
}

/** 타임스탬프 기반 출력 파일명 생성 (YYYYMMDD-HHMM) */
function makeOutputPath(): string {
  const now = new Date()
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}`
  return path.join(OUTPUT_DIR, `${datePart}-${timePart}-dashboard-memory-baseline.json`)
}

async function main() {
  console.log('=== Soul Dashboard 메모리 베이스라인 측정 ===')
  console.log(`대상: ${DASHBOARD_URL}`)
  console.log(`출력: ${OUTPUT_DIR}`)
  console.log()

  // 출력 디렉토리 생성
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  // CDP 세션 초기화 및 Runtime 도메인 활성화 (getHeapUsage 호출 전 필수)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Runtime.enable')

  const snapshots: Snapshot[] = []

  /** 현재 시점의 클라이언트+서버 메모리 스냅샷 */
  async function captureSnapshot(scenario: string): Promise<Snapshot> {
    const capturedAt = new Date().toISOString()

    // 클라이언트 힙 측정
    const { usedSize, totalSize } = await cdp.send('Runtime.getHeapUsage')
    const client: ClientMemory = {
      heapUsed: Math.round(usedSize / 1024 / 1024 * 10) / 10,
      heapTotal: Math.round(totalSize / 1024 / 1024 * 10) / 10,
    }

    // 서버 힙 측정 (Phase 1 엔드포인트)
    const serverRes = await page.request.get(MEMORY_API_URL)
    if (!serverRes.ok()) {
      throw new Error(
        `/api/debug/memory returned ${serverRes.status()}. Phase 1 완료 여부를 확인하세요.`
      )
    }
    const server: ServerMemory = await serverRes.json()

    const snapshot: Snapshot = { scenario, capturedAt, client, server }
    console.log(`[${scenario}] client.heapUsed=${client.heapUsed}MB  server.heapUsed=${server.heapUsed}MB  server.rss=${server.rss}MB`)
    return snapshot
  }

  /** skipped 스냅샷 생성 */
  function makeSkipped(scenario: string): Snapshot {
    console.log(`[${scenario}] SKIPPED`)
    return { scenario, capturedAt: new Date().toISOString(), skipped: true }
  }

  try {
    // ─── T0: idle ─────────────────────────────────────────────────────
    console.log('\n[T0] 페이지 로드 중...')
    await page.goto(DASHBOARD_URL, { waitUntil: 'domcontentloaded' })

    // 세션 목록 대기 (SSE 환경: networkidle 대신 selector 대기)
    await page.waitForSelector('[data-testid^="session-item-"]', { timeout: 10000 }).catch(() => {
      console.log('  → 세션 목록 없음 (10초 타임아웃)')
    })

    snapshots.push(await captureSnapshot('T0_idle'))

    // ─── T1/T2/T3/T4: 세션 조작 ───────────────────────────────────────
    const sessions = page.locator('[data-testid^="session-item-"]')
    const sessionCount = await sessions.count()
    console.log(`\n세션 수: ${sessionCount}개`)

    if (sessionCount === 0) {
      console.warn('세션 없음 — T1~T4 스킵')
      snapshots.push(makeSkipped('T1_session'))
      snapshots.push(makeSkipped('T2_5min'))
      snapshots.push(makeSkipped('T3_switch'))
      snapshots.push(makeSkipped('T4_30s'))
    } else {
      // T1: 첫 번째 세션 클릭
      console.log('\n[T1] 첫 번째 세션 클릭...')
      await sessions.first().click()
      snapshots.push(await captureSnapshot('T1_session'))

      // T2: T1 이후 5분 대기 (300,000ms)
      console.log('\n[T2] 5분 대기 중... (300초)')
      await page.waitForTimeout(300_000)
      snapshots.push(await captureSnapshot('T2_5min'))

      // T3: 두 번째 세션으로 전환
      if (sessionCount >= 2) {
        console.log('\n[T3] 두 번째 세션으로 전환...')
        await sessions.nth(1).click()
        snapshots.push(await captureSnapshot('T3_switch'))
      } else {
        console.warn('세션 1개 — T3~T4 스킵')
        snapshots.push(makeSkipped('T3_switch'))
        snapshots.push(makeSkipped('T4_30s'))
      }

      // T4: T3 이후 30초 대기 (GC 수렴 대기)
      if (sessionCount >= 2) {
        console.log('\n[T4] 30초 대기 중... (GC 수렴)')
        await page.waitForTimeout(30_000)
        snapshots.push(await captureSnapshot('T4_30s'))
      }
    }

  } finally {
    await browser.close()
  }

  // ─── 결과 저장 ──────────────────────────────────────────────────────
  const outputPath = makeOutputPath()
  fs.writeFileSync(outputPath, JSON.stringify(snapshots, null, 2), 'utf-8')

  console.log(`\n✅ 결과 저장 완료: ${outputPath}`)
  console.log(`   스냅샷 수: ${snapshots.length}개`)
}

main().catch((err) => {
  console.error('측정 실패:', err)
  process.exit(1)
})
