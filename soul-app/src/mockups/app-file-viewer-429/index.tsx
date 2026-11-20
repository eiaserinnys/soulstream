// 카드 #429 시안: 앱에서 이미지가 아닌 첨부를 누르면 뜨는 전체 화면 앱 안 보기.
// 머리줄은 지금 첨부 미리보기 창의 부품(GlassButton card, 본문 글자 파일명, 첨부 메타 글자 크기)을 그대로 쓰고
// 배치만 왼쪽 닫기, 가운데 파일명과 크기, 오른쪽 공유로 바꾼다. 웹 시안이라 PDF는 쪽 그림, HTML은 iframe으로 대신한다.
import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useState } from 'react';
import { Image, Platform, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AttachmentFileRow } from '../../components/AttachmentFileRow';
import { GlassButton } from '../../components/GlassSurface';
import { PlannerMarkdownText } from '../../components/planner/PlannerMarkdownText';
import type { AttachmentView } from '../../lib/attachment-view';
import { createSessionVisualRoles, useTokens } from '../../theme';
import { LIGHT_COLORS } from '../../theme/colors';
import { MockupShell } from '../MockupShell';

type Scene = 'pdf' | 'text' | 'markdown' | 'html' | 'unsupported';

const PAGES = [require('./pdf-page-1.png'), require('./pdf-page-2.png'), require('./pdf-page-3.png')];

const LOG_TEXT = [
  '{',
  '  "session": "7023ea87-37c5-42b5-ae4b-b7c01acd7add",',
  '  "node": "eiaserinnys",',
  '  "attachments": [',
  '    { "name": "IMG_0398.PNG", "mime": "image/png", "width": 1170, "height": 7200, "preview": "image" },',
  '    { "name": "IMG_0412.HEIC", "mime": "image/heic", "preview": "image/jpeg", "previewBytes": 412883 },',
  '    { "name": "attachment-flow.svg", "mime": "image/svg+xml", "render": "img", "scripts": "blocked" },',
  '    { "name": "weekly-cards.html", "mime": "text/html", "sandbox": "allow-scripts" }',
  '  ]',
  '}',
  '',
  ...Array.from({ length: 40 }, (_, i) => {
    const s = String(10 + (i % 50)).padStart(2, '0');
    const level = i % 9 === 4 ? 'WARN ' : 'INFO ';
    const msg = i % 9 === 4
      ? 'preview generation took 2.4s for IMG_0412.HEIC (heif decoder cold start), returning cached JPEG next time'
      : `attachment ${1200 + i} served preview kind=${['image', 'text', 'pdf', 'html'][i % 4]} bytes=${(i * 7919) % 90000 + 1024}`;
    return `2026-11-20T16:52:${s}.${String(i * 37 % 1000).padStart(3, '0')}Z ${level}[soul-server] ${msg}`;
  }),
].join('\n');

const MARKDOWN = `# 첨부 보기 정비

앱에서 이미지가 아닌 첨부를 누르면 **공유 시트 대신 앱 안에서** 엽니다.

## 형식별 보기

- PDF: 쪽을 이어서 스크롤
- 텍스트, 로그, JSON: 고정폭 글자, 글자 선택
- 마크다운: 렌더링해서 표시
- HTML: 스크립트만 허용한 제한 보기

## 그대로 두는 것

zip처럼 미리볼 수 없는 파일은 지금처럼 공유 시트로 보냅니다.

> 원본 저장과 공유는 오른쪽 위 단추 하나로 합니다.
`;

const HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:20px;font:15px/1.5 -apple-system,"Noto Sans KR",sans-serif;background:#f6f7fb;color:#1d1d1f}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 16px;color:#6e6e78}ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
li{background:#fff;border:1px solid #e3e4ea;border-radius:14px;padding:14px 16px}li b{display:block;margin-bottom:4px}
.tag{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;background:#eef2ff;color:#3949ab}.done .tag{background:#e6f4ea;color:#1e7b34}
button{margin-top:16px;padding:8px 14px;border-radius:10px;border:1px solid #cfd2dc;background:#fff;font:inherit}</style></head>
<body><h1>이번 주 작업 카드</h1><p>카드 4장</p><ul id="c">
<li><b>긴 캡처 폭 맞춤</b><span class="tag">진행</span></li><li class="done"><b>HEIC 미리보기 생성</b><span class="tag">완료</span></li>
<li><b>앱 안 파일 보기</b><span class="tag">진행</span></li><li><b>SVG를 img로만 표시</b><span class="tag">검수</span></li></ul>
<button id="t" type="button">완료만 보기</button>
<script>let d=false;document.getElementById('t').onclick=e=>{d=!d;for(const li of document.querySelectorAll('#c li'))li.hidden=d&&!li.classList.contains('done');e.target.textContent=d?'모두 보기':'완료만 보기'}</script>
</body></html>`;

function view(key: string, name: string, mimeType: string, byteSize: number, previewKind: AttachmentView['previewKind']): AttachmentView {
  return { key, name, mimeType, byteSize, previewKind, source: { kind: 'ready', attachmentId: key, previewUrl: null, originalUrl: `/mock/${key}` } };
}

const FILES: Record<Exclude<Scene, 'unsupported'>, AttachmentView> = {
  pdf: view('pdf', '첨부 보기 정비 계획서 (2026년 11월 디렉터 검토용 최종본).pdf', 'application/pdf', 1_284_096, 'info'),
  text: view('text', 'soul-server-attachments-2026-11-20.log', 'text/plain', 48_211, 'text'),
  markdown: view('markdown', 'attachment-viewer-plan.md', 'text/markdown', 3_122, 'text'),
  html: view('html', 'weekly-cards.html', 'text/html', 2_150, 'text'),
};
const ZIP = view('zip', 'captures-2611.zip', 'application/zip', 18_874_368, 'info');

function sceneFromUrl(): Scene {
  const requested = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('scene') : null;
  return requested === 'pdf' || requested === 'text' || requested === 'markdown' || requested === 'html' || requested === 'unsupported'
    ? requested : 'pdf';
}

/** 전체 화면 앱 안 보기. 머리줄: 왼쪽 닫기, 가운데 파일명과 크기, 오른쪽 공유(지금 Share 동작). */
function FileViewerScreen({ item, onClose, children }: { item: AttachmentView; onClose(): void; children: React.ReactNode }) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const size = item.byteSize === null ? null : formatSize(item.byteSize);
  return <View testID="attachment-file-viewer" style={{ flex: 1, backgroundColor: t.colors.background, paddingTop: insets.top }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.md, paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm }}>
      <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round} accessibilityLabel="닫기" onPress={onClose}>
        <Ionicons name="close" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
      </GlassButton>
      <View style={{ flex: 1, minWidth: 0, alignItems: 'center' }}>
        <Text numberOfLines={1} ellipsizeMode="middle" style={{ ...t.foundation.typography.body, color: t.colors.textPrimary, maxWidth: '100%' }}>{item.name}</Text>
        {size ? <Text numberOfLines={1} style={{ ...attachment.metadata, color: attachment.textMuted }}>{size}</Text> : null}
      </View>
      <GlassButton iconOnly size="card" borderRadius={t.foundation.radius.round} accessibilityLabel="공유" onPress={() => {}}>
        <Ionicons name="share-outline" size={t.foundation.iconFrame.compact} color={t.colors.textMuted} />
      </GlassButton>
    </View>
    <View style={{ flex: 1, paddingBottom: insets.bottom }}>{children}</View>
  </View>;
}

function formatSize(byteSize: number): string {
  const units = ['KB', 'MB', 'GB'];
  let value = byteSize / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function PdfBody() {
  const t = useTokens();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  // 기기에서는 WebView가 PDF를 그린다. 시안은 같은 쪽 배치를 그림으로 보인다.
  return <ScrollView testID="attachment-file-viewer-pdf" style={{ flex: 1, backgroundColor: attachment.surface }}
    contentContainerStyle={{ padding: t.spacing.md, gap: t.spacing.md }}>
    {PAGES.map((page, index) => <View key={index} style={{ width: '100%', aspectRatio: 1240 / 1754, borderWidth: 1, borderColor: attachment.border, backgroundColor: LIGHT_COLORS.background }}>
      <Image source={page} accessibilityLabel={`${index + 1}쪽`} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
    </View>)}
  </ScrollView>;
}

function TextBody() {
  const t = useTokens();
  return <ScrollView testID="attachment-file-viewer-text" style={{ flex: 1 }} contentContainerStyle={{ padding: t.spacing.md }}>
    <Text selectable style={{
      ...t.foundation.typography.mono,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      color: t.colors.textPrimary,
    }}>{LOG_TEXT}</Text>
  </ScrollView>;
}

function MarkdownBody() {
  const t = useTokens();
  return <ScrollView testID="attachment-file-viewer-markdown" style={{ flex: 1 }} contentContainerStyle={{ padding: t.spacing.md }}>
    <PlannerMarkdownText markdown={MARKDOWN} />
  </ScrollView>;
}

function HtmlBody() {
  // 기기에서는 javaScriptEnabled WebView에 같은 문서를 넣고 앱 저장소와 쿠키에는 닿지 않게 한다.
  return <View style={{ flex: 1, backgroundColor: LIGHT_COLORS.background }}>
    {React.createElement('iframe', {
      title: 'weekly-cards.html',
      srcDoc: HTML,
      sandbox: 'allow-scripts',
      style: { border: 0, width: '100%', height: '100%', display: 'block', colorScheme: 'light' },
    })}
  </View>;
}

/** 채팅의 첨부 칩. 이미지가 아닌 첨부는 앱 안 보기로, zip은 지금처럼 공유 시트로 간다. */
function ChipList({ onOpen }: { onOpen(scene: Exclude<Scene, 'unsupported'>): void }) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  return <ScrollView testID="attachment-file-viewer-chips" style={{ flex: 1, backgroundColor: t.colors.background }}
    contentContainerStyle={{ padding: t.spacing.md, paddingTop: insets.top + t.spacing.md, gap: t.spacing.sm }}>
    {(Object.keys(FILES) as Exclude<Scene, 'unsupported'>[]).map(scene =>
      <AttachmentFileRow key={scene} item={FILES[scene]} onPress={() => onOpen(scene)} />)}
    <AttachmentFileRow item={ZIP} onPress={() => {}} />
  </ScrollView>;
}

function Viewer() {
  const [scene, setScene] = useState<Scene>(sceneFromUrl);
  const go = (next: Scene) => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('scene', next);
      window.history.replaceState(null, '', url);
    }
    setScene(next);
  };
  if (scene === 'unsupported') return <ChipList onOpen={go} />;
  const close = () => go('unsupported');
  return <FileViewerScreen item={FILES[scene]} onClose={close}>
    {scene === 'pdf' ? <PdfBody /> : scene === 'text' ? <TextBody /> : scene === 'markdown' ? <MarkdownBody /> : <HtmlBody />}
  </FileViewerScreen>;
}

export default function AppFileViewer429() {
  return <MockupShell><Viewer /></MockupShell>;
}
