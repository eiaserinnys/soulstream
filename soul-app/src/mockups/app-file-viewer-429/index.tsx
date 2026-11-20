// 카드 #429 시안 (보완판): 앱에서 이미지가 아닌 첨부를 누르면 지금의 첨부 미리보기 창 안에서 본다.
//
// - 창은 새로 만들지 않는다. 지금 앱이 파일 행을 누르면 여는 AttachmentPreviewModal과 같은
//   ImageViewerModal(chatRefined, 문서 배치)을 쓴다. 유리 창, 왼쪽 이름과 크기, 오른쪽 닫기,
//   바닥 넘기기와 원본 저장, 네 변 안전 영역, 태블릿의 A 판형 문서 폭이 모두 그대로다.
// - 더하는 것은 틀 안 내용뿐이다. PDF는 쪽을 이어 보이고(기기에서는 WebView가 그린다),
//   텍스트와 로그와 JSON은 웹 pre처럼 고정폭 글자로 보인다. 구현에서는 AttachmentPreviewModal의
//   내용 갈래와 문서 배치 판정에 PDF와 텍스트를 더한다. 시안은 renderAttachment로 그 모양을 보인다.
// - 받는 중, 실패와 다시 시도, 빈 파일, zip 같은 볼 수 없는 형식은 운영 AttachmentPreviewModal을 그대로 띄운다.
// - SVG: 서버가 SVG를 이미지로 주면 격자 썸네일과 이미지 창이 react-native-svg로 그리고, HTML 틀처럼
//   밝은 바탕을 깐다. 지금 앱의 RN Image는 SVG를 그리지 못한다. 시안은 그 모양을 보인다.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { AttachmentFileRow } from '../../components/AttachmentFileRow';
import { AttachmentPreviewModal } from '../../components/AttachmentPreviewModal';
import { ImageViewerModal } from '../../components/ImageViewerModal';
import type { AttachmentView } from '../../lib/attachment-view';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../../theme';
import { LIGHT_COLORS } from '../../theme/colors';
import { MockupShell } from '../MockupShell';

type Scene = 'list' | 'pdf' | 'text' | 'markdown' | 'html' | 'unsupported' | 'loading' | 'failed' | 'empty' | 'svg' | 'bundle';
const SCENES: readonly Scene[] = ['list', 'pdf', 'text', 'markdown', 'html', 'unsupported', 'loading', 'failed', 'empty', 'svg', 'bundle'];

// 받는 중 장면을 캡처할 때 계속 받는 중으로 둔다: ?hold=1
const HOLD = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('hold') === '1';

const PAGES = [require('./pdf-page-1.png'), require('./pdf-page-2.png'), require('./pdf-page-3.png')];
const PAGE_ASPECT = 1240 / 1754;

const SVG_WIDTH = 1600;
const SVG_HEIGHT = 900;
// 바탕을 칠하지 않은 선 그림(웹 시안의 flow-lines.svg와 같다).
const SVG_XML = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="#1d1d1f"/></marker></defs>
<text x="120" y="200" font-family="sans-serif" font-size="72" font-weight="700" fill="#1d1d1f">투명 바탕 SVG</text>
<text x="120" y="270" font-family="sans-serif" font-size="36" fill="#1d1d1f">바탕을 칠하지 않은 선 그림</text>
<g fill="none" stroke="#1d1d1f" stroke-width="6">
<rect x="120" y="420" width="360" height="220" rx="28"/><rect x="620" y="420" width="360" height="220" rx="28"/><rect x="1120" y="420" width="360" height="220" rx="28"/>
<path d="M480 530h130" marker-end="url(#a)"/><path d="M980 530h130" marker-end="url(#a)"/>
</g>
<g font-family="sans-serif" font-size="44" fill="#1d1d1f" text-anchor="middle"><text x="300" y="545">업로드</text><text x="800" y="545">저장소</text><text x="1300" y="545">보기 창</text></g>
</svg>`;

const JSON_TEXT = JSON.stringify({
  session: '7023ea87-37c5-42b5-ae4b-b7c01acd7add',
  node: 'eiaserinnys',
  attachments: [
    { name: 'IMG_0398.PNG', mime: 'image/png', preview: 'image' },
    { name: 'IMG_0412.HEIC', mime: 'image/heic', preview: 'image', render: 'browser-or-decoder' },
    { name: 'flow-lines.svg', mime: 'image/svg+xml', preview: 'image', render: 'img' },
    { name: 'weekly-cards.html', mime: 'text/html', preview: 'text', sandbox: 'allow-scripts' },
    { name: '첨부 보기 정비 계획서.pdf', mime: 'application/pdf', preview: 'document' },
  ],
}, null, 2);

const LOG_TEXT = Array.from({ length: 48 }, (_, i) => {
  const s = String(10 + (i % 50)).padStart(2, '0');
  const warn = i % 9 === 4;
  const msg = warn
    ? `slow download for captures-2611.zip (18.0 MB) from client ${1200 + i}, served in 3 parts with range requests`
    : `attachment ${1200 + i} served preview kind=${['image', 'text', 'document', 'html'][i % 4]} bytes=${(i * 7919) % 90000 + 1024}`;
  return `2026-11-20T16:52:${s}.${String(i * 37 % 1000).padStart(3, '0')}Z ${warn ? 'WARN ' : 'INFO '}[soul-server] ${msg}`;
}).join('\n');

const MARKDOWN = `# 첨부 보기 정비

앱에서 이미지가 아닌 첨부를 누르면 **지금의 첨부 미리보기 창 안에서** 엽니다.

## 형식별 보기

- PDF: 쪽을 이어서 스크롤
- 텍스트, 로그, JSON: 고정폭 글자, 글자 선택
- 마크다운: 렌더링해서 표시
- HTML: 스크립트만 허용한 제한 보기

## 그대로 두는 것

zip처럼 볼 수 없는 파일은 지금처럼 창에 형식 이름과 저장 단추를 보입니다.
`;

const HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:20px;font:15px/1.5 -apple-system,"Noto Sans KR",sans-serif;background:#f6f7fb;color:#1d1d1f}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 16px;color:#6e6e78}ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}
li{background:#fff;border:1px solid #e3e4ea;border-radius:14px;padding:14px 16px}li b{display:block;margin-bottom:4px}
.tag{display:inline-block;padding:2px 10px;border-radius:999px;font-size:13px;background:#eef2ff;color:#3949ab}.done .tag{background:#e6f4ea;color:#1e7b34}
button{margin-top:16px;padding:8px 14px;border-radius:10px;border:1px solid #cfd2dc;background:#fff;font:inherit}</style></head>
<body><h1>이번 주 작업 카드</h1><p>카드 4장</p><ul id="c">
<li><b>긴 캡처 폭 맞춤</b><span class="tag">진행</span></li><li class="done"><b>HEIC 해독</b><span class="tag">완료</span></li>
<li><b>앱 안 파일 보기</b><span class="tag">진행</span></li><li><b>SVG 밝은 바탕</b><span class="tag">검수</span></li></ul>
<button id="t" type="button">완료만 보기</button>
<script>let d=false;document.getElementById('t').onclick=e=>{d=!d;for(const li of document.querySelectorAll('#c li'))li.hidden=d&&!li.classList.contains('done');e.target.textContent=d?'모두 보기':'완료만 보기'}</script>
</body></html>`;

function view(key: string, name: string, mimeType: string, byteSize: number, previewKind: AttachmentView['previewKind'], extra?: Partial<AttachmentView>): AttachmentView {
  return {
    key, name, mimeType, byteSize, previewKind,
    readContext: { type: 'owner' } as AttachmentView['readContext'],
    source: { kind: 'ready', attachmentId: key, previewUrl: null, originalUrl: `/mock/${key}` },
    ...extra,
  };
}

const PDF = view('pdf', '첨부 보기 정비 계획서 (2026년 11월 디렉터 검토용 최종본).pdf', 'application/pdf', 1_284_096, 'info');
const LOG = view('log', 'soul-server-attachments-2026-11-20.log', 'text/plain', 48_211, 'text');
const JSON_FILE = view('json', 'attachments.json', 'application/json', JSON_TEXT.length, 'text');
const MD = view('markdown', 'attachment-viewer-plan.md', 'text/markdown', 3_122, 'text');
const HTML_FILE = view('html', 'weekly-cards.html', 'text/html', 2_150, 'text');
const ZIP = view('zip', 'captures-2611.zip', 'application/zip', 18_874_368, 'info');
const SVG = view('svg', 'flow-lines.svg', 'image/svg+xml', 1_022, 'image');
const LOADING = view('loading', 'soul-server-full-2026-11-20.log', 'text/plain', 1_048_576, 'text', {
  loadText: () => new Promise(() => {}),
});
const EMPTY = view('empty', 'notes.txt', 'text/plain', 0, 'text');

function failingLog(): AttachmentView {
  let calls = 0;
  return view('failed', 'soul-server-attachments-2026-11-20.log', 'text/plain', 48_211, 'text', {
    loadText: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject({ kind: 'retryable' })
        : Promise.resolve({ text: LOG_TEXT, truncated: false });
    },
  });
}

/** 시안의 viewer 항목은 renderAttachment를 타도록 SVG를 'info'로 넘긴다(구현은 이미지 쪽에 SVG 갈래를 더한다). */
function viewerItem(item: AttachmentView): AttachmentView {
  return item.key === 'svg' ? { ...item, previewKind: 'info' } : item;
}

function sceneFromUrl(): Scene {
  const requested = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('scene') : null;
  return SCENES.find(scene => scene === requested) ?? 'list';
}

const saveNothing = async () => {};

/** 시안 페이지의 코멘트 단추가 바닥 원본 저장을 덮지 않게 왼쪽 아래로 비킨다(시안 페이지만). */
function useReviewButtonAside() {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const apply = () => {
      const root = document.getElementById('pages-review')?.shadowRoot;
      if (!root) return false;
      if (!root.querySelector('style[data-mockup-aside]')) {
        const style = document.createElement('style');
        style.setAttribute('data-mockup-aside', '');
        style.textContent = '#toggle { right: auto; left: 16px; }';
        root.append(style);
      }
      return true;
    };
    if (apply()) return;
    const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);
}

/** PDF: 받는 동안은 지금 창의 로딩 표시, 받은 뒤에는 쪽을 이어 보인다. */
function PdfPages() {
  const t = useTokens();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (HOLD) return;
    const timer = setTimeout(() => setReady(true), 900);
    return () => clearTimeout(timer);
  }, []);
  if (!ready) {
    return <View style={{ flex: 1, width: '100%', padding: t.spacing.md, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={t.colors.accent} />
    </View>;
  }
  return <ScrollView testID="attachment-preview-pdf" style={{ flex: 1, width: '100%' }}
    contentContainerStyle={{ padding: t.spacing.md, gap: t.spacing.md }}>
    {PAGES.map((page, index) => <View key={index} style={{
      width: '100%', aspectRatio: PAGE_ASPECT,
      borderWidth: StyleSheet.hairlineWidth, borderColor: attachment.border, backgroundColor: LIGHT_COLORS.background,
    }}>
      <Image source={page} accessibilityLabel={`${index + 1}쪽`} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
    </View>)}
  </ScrollView>;
}

/** 텍스트, 로그, JSON: 지금 창의 텍스트 배치에 고정폭 글자만 바꾼다. */
function MonoText({ text }: { text: string }) {
  const t = useTokens();
  return <View style={{ flex: 1, width: '100%', padding: t.spacing.md, alignItems: 'center', justifyContent: 'center' }}>
    <ScrollView testID="attachment-preview-text" style={{ flex: 1, width: '100%' }} contentContainerStyle={{ gap: t.spacing.sm }}>
      <Text selectable style={{
        ...t.foundation.typography.mono,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        color: t.colors.textPrimary,
      }}>{text}</Text>
    </ScrollView>
  </View>;
}

/** SVG를 칸 안에 통째로 맞추고, 그림 자리에만 밝은 바탕을 깐다. */
function ContainedSvg({ radius }: { radius?: number }) {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const onLayout = ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    if (layout.width <= 0 || layout.height <= 0) return;
    const scale = Math.min(layout.width / SVG_WIDTH, layout.height / SVG_HEIGHT);
    const next = { width: Math.floor(SVG_WIDTH * scale), height: Math.floor(SVG_HEIGHT * scale) };
    setBox(previous => previous?.width === next.width && previous.height === next.height ? previous : next);
  };
  return <View style={{ flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' }} onLayout={onLayout}>
    {box ? <View accessible accessibilityLabel="flow-lines.svg" style={{
      ...box, backgroundColor: LIGHT_COLORS.background, borderRadius: radius ?? 0, overflow: 'hidden',
    }}>
      <SvgXml xml={SVG_XML} width={box.width} height={box.height} />
    </View> : null}
  </View>;
}

function renderNewContent(item: AttachmentView): React.ReactNode {
  if (item.key === 'pdf') return <PdfPages />;
  if (item.key === 'log') return <MonoText text={LOG_TEXT} />;
  if (item.key === 'json') return <MonoText text={JSON_TEXT} />;
  if (item.key === 'svg') return <ContainedSvg />;
  return null;
}

/** 지금 앱이 파일 행에서 여는 창과 같은 ImageViewerModal 위에 새 내용 갈래만 올린다. */
function ProposedViewer({ items, initialIndex = 0, onClose }: { items: readonly AttachmentView[]; initialIndex?: number; onClose(): void }) {
  const views = items.map(viewerItem);
  const media = items.every(item => item.key === 'svg');
  return <View testID="attachment-preview-modal">
    <ImageViewerModal variant="chatRefined" layout={media ? 'media' : 'document'} items={views} initialIndex={initialIndex}
      onClose={onClose} sources={views.map(() => ({}))} renderAttachment={renderNewContent} onSaveOriginal={saveNothing} />
  </View>;
}

/** 채팅의 첨부 묶음. SVG는 격자 썸네일, 나머지는 지금 파일 행(AttachmentFileRow) 그대로다. */
function AttachmentList({ onOpen }: { onOpen(scene: Scene): void }) {
  const t = useTokens();
  const attachment = createSessionVisualRoles(t).chat.attachment;
  const maxWidth = useDeviceType() === 'phone' ? attachment.phoneAssistantMaxWidth : attachment.assistantMaxWidth;
  const rows: { item: AttachmentView; scene: Scene }[] = [
    { item: PDF, scene: 'pdf' },
    { item: LOG, scene: 'text' },
    { item: JSON_FILE, scene: 'bundle' },
    { item: MD, scene: 'markdown' },
    { item: HTML_FILE, scene: 'html' },
    { item: ZIP, scene: 'unsupported' },
  ];
  return <ScrollView testID="attachment-file-viewer-list" style={{ flex: 1, backgroundColor: t.colors.background }}
    contentContainerStyle={{ padding: t.spacing.md, gap: attachment.gridGap }}>
    <View style={{ width: '100%', maxWidth, gap: attachment.gridGap }}>
      <View>
        <Pressable accessibilityRole="button" accessibilityLabel="flow-lines.svg 크게 보기" onPress={() => onOpen('svg')}
          style={({ pressed }) => ({
            width: '100%', maxWidth: attachment.thumbnailFrameSize.width, maxHeight: attachment.thumbnailFrameSize.height,
            aspectRatio: 1, minHeight: t.hitTarget.min, borderRadius: attachment.radius,
            borderWidth: StyleSheet.hairlineWidth, borderColor: attachment.border, backgroundColor: attachment.surface,
            overflow: 'hidden', opacity: pressed ? 0.82 : 1,
          })}>
          <ContainedSvg radius={attachment.radius} />
        </Pressable>
        <Text numberOfLines={1} ellipsizeMode="tail" style={{
          ...attachment.metadata, color: attachment.textMuted, marginTop: attachment.filenameGap,
          maxWidth: attachment.thumbnailFrameSize.width,
        }}>{SVG.name}</Text>
      </View>
      {rows.map(({ item, scene }) => <AttachmentFileRow key={item.key} item={item} onPress={() => onOpen(scene)} />)}
    </View>
  </ScrollView>;
}

function Viewer() {
  const [scene, setScene] = useState<Scene>(sceneFromUrl);
  const [failing] = useState(failingLog);
  useReviewButtonAside();
  const go = (next: Scene) => {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('scene', next);
      window.history.replaceState(null, '', url);
    }
    setScene(next);
  };
  const close = () => go('list');
  return <>
    <AttachmentList onOpen={go} />
    {scene === 'pdf' ? <ProposedViewer items={[PDF]} onClose={close} /> : null}
    {scene === 'text' ? <ProposedViewer items={[LOG]} onClose={close} /> : null}
    {scene === 'svg' ? <ProposedViewer items={[SVG]} onClose={close} /> : null}
    {scene === 'bundle' ? <ProposedViewer items={[PDF, SVG, JSON_FILE]} initialIndex={2} onClose={close} /> : null}
    {scene === 'markdown' ? <AttachmentPreviewModal item={MD} onClose={close} onSaveOriginal={saveNothing}
      textContent={{ text: MARKDOWN, truncated: false }} /> : null}
    {scene === 'html' ? <AttachmentPreviewModal item={HTML_FILE} onClose={close} onSaveOriginal={saveNothing}
      textContent={{ text: HTML, truncated: false }} /> : null}
    {scene === 'unsupported' ? <AttachmentPreviewModal item={ZIP} onClose={close} onSaveOriginal={saveNothing} /> : null}
    {scene === 'loading' ? <AttachmentPreviewModal item={LOADING} onClose={close} onSaveOriginal={saveNothing} /> : null}
    {scene === 'failed' ? <AttachmentPreviewModal item={failing} onClose={close} onSaveOriginal={saveNothing} /> : null}
    {scene === 'empty' ? <AttachmentPreviewModal item={EMPTY} onClose={close} onSaveOriginal={saveNothing} /> : null}
  </>;
}

export default function AppFileViewer429() {
  return <MockupShell><Viewer /></MockupShell>;
}

