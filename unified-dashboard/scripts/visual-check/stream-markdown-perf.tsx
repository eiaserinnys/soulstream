// 카드 #1808 스트리밍 마크다운 성능 측정 표본.
// 2만 자 넘는 한글 마크다운을 64자씩 덧붙이며, 갱신 한 번이 화면에 그려질 때까지의
// 시간을 페이지 안에서 잰다. 계측기는 stream_markdown_perf.py가 부른다.
import "../../client/globals.css";
import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  StreamingMarkdown,
  preloadStreamingMarkdown,
} from "@seosoyoung/soul-ui/components/chat/StreamingMarkdown";

interface StreamPerfResult {
  durations: number[];
  updates: number;
  finalLength: number;
  renderedLength: number;
  wordsRoot: boolean;
}

declare global {
  interface Window {
    __streamPerfReady?: boolean;
    __streamPerfRun?: (markdown: string, step: number) => Promise<StreamPerfResult>;
  }
}

let setContent: ((value: string) => void) | null = null;

function PerfHarness() {
  const [content, update] = useState("");
  setContent = update;
  return (
    <div className="w-full max-w-[720px] bg-background p-3" data-slot="chat-root">
      <div data-sel="streaming">
        <StreamingMarkdown content={content} />
      </div>
    </div>
  );
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

window.__streamPerfRun = async (markdown, step) => {
  await preloadStreamingMarkdown();
  await nextFrame();
  const durations: number[] = [];
  for (let end = step; end <= markdown.length; end += step) {
    const slice = markdown.slice(0, end);
    const start = performance.now();
    flushSync(() => {
      setContent?.(slice);
    });
    // 다음 프레임 콜백은 갱신이 든 프레임이 그려지기 직전에 불린다.
    await nextFrame();
    durations.push(performance.now() - start);
  }
  const body = document.querySelector('[data-sel="streaming"] [data-slot="chat-body"]');
  return {
    durations,
    updates: durations.length,
    finalLength: markdown.length,
    renderedLength: body?.textContent?.length ?? 0,
    wordsRoot: Boolean(document.querySelector('[data-sel="streaming"] [data-markdown="root"]')),
  };
};

createRoot(document.getElementById("root")!).render(<PerfHarness />);
void preloadStreamingMarkdown().then(() => {
  requestAnimationFrame(() => {
    window.__streamPerfReady = true;
  });
});
